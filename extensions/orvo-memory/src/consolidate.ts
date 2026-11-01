/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MemoryNote, NOTE_TYPES, NoteType, RawEntry, slugify } from './notes';

export interface CommitInfo {
	readonly hash: string;
	readonly message: string;
	readonly date?: string;
}

export interface ConsolidationInput {
	readonly notes: readonly MemoryNote[];
	readonly entries: readonly RawEntry[];
	readonly commits: readonly CommitInfo[];
	readonly now: string;
}

export interface NoteChange {
	readonly id?: string;
	readonly title: string;
	readonly type: NoteType;
	readonly tags: readonly string[];
	readonly body: string;
	readonly sources: readonly string[];
}

export interface ConsolidationResult {
	readonly upsert: readonly NoteChange[];
	readonly remove: readonly string[];
}

const MAX_NOTE_CHARS = 1500;

/** The instructions and data the model gets. Existing notes are included so it updates them instead of duplicating. */
export function buildConsolidationPrompt(input: ConsolidationInput): string {
	const notes = input.notes.map(note => ({ id: note.id, title: note.title, type: note.type, tags: note.tags, body: note.body.slice(0, MAX_NOTE_CHARS) }));
	return [
		'You maintain the long-term memory of a software project. It is read by coding agents (GitHub Copilot, Claude, Codex) and by the team.',
		'',
		'Turn the NEW RAW MEMORIES and RECENT COMMITS into durable, useful notes:',
		'- Keep only what will still matter later: decisions and their reasons, conventions, architecture facts, gotchas, setup steps, open items.',
		'- Drop chit-chat, one-off status updates and anything already captured.',
		'- Prefer updating an existing note (reuse its "id") over creating a near-duplicate. Merge related memories into one note.',
		'- Remove notes that the new information makes wrong or obsolete (list their ids in "remove").',
		'- Each note: a short specific title, a type, 1-5 lowercase tags, and a concise Markdown body (what, why, where in the code).',
		'- Never include secrets, tokens, passwords or personal data, even if they appear in the input.',
		'',
		`Types: ${NOTE_TYPES.join(', ')}.`,
		'',
		'Reply with JSON only, no prose, in this shape:',
		'{"upsert":[{"id":"existing-id-or-omit-for-new","title":"...","type":"decision","tags":["..."],"body":"...","sources":["inbox 2026-11-01","commit abc1234"]}],"remove":["obsolete-id"]}',
		'Return only notes that are new or changed. If nothing is worth keeping, reply {"upsert":[],"remove":[]}.',
		'',
		'EXISTING NOTES:',
		JSON.stringify(notes),
		'',
		'NEW RAW MEMORIES:',
		JSON.stringify(input.entries),
		'',
		'RECENT COMMITS:',
		JSON.stringify(input.commits.map(commit => ({ hash: commit.hash.slice(0, 10), date: commit.date, message: commit.message.slice(0, 500) }))),
		'',
		`Current time: ${input.now}`,
	].join('\n');
}

function asStringArray(value: unknown, max: number): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, max) : [];
}

/** Parses the model's reply, tolerating code fences and prose around the JSON; invalid items are dropped. */
export function parseConsolidationResult(reply: string): ConsolidationResult {
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start < 0 || end <= start) {
		throw new Error('The model did not return JSON.');
	}
	const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('The model returned an unexpected shape.');
	}
	const { upsert, remove } = parsed as { upsert?: unknown; remove?: unknown };
	const changes: NoteChange[] = [];
	for (const item of Array.isArray(upsert) ? upsert : []) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const { id, title, type, tags, body, sources } = item as Record<string, unknown>;
		if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
			continue;
		}
		changes.push({
			id: typeof id === 'string' && id.trim() ? slugify(id) : undefined,
			title: title.trim().slice(0, 120),
			type: typeof type === 'string' && (NOTE_TYPES as readonly string[]).includes(type) ? type as NoteType : 'fact',
			tags: asStringArray(tags, 5).map(tag => tag.toLowerCase()),
			body: body.trim(),
			sources: asStringArray(sources, 10),
		});
	}
	return { upsert: changes, remove: asStringArray(remove, 100).map(id => slugify(id)) };
}

/** Applies a result to the current notes: updates keep `created` and merge sources; new ids never overwrite another note. */
export function applyConsolidation(notes: readonly MemoryNote[], result: ConsolidationResult, now: string): { notes: MemoryNote[]; written: MemoryNote[]; removed: string[] } {
	const byId = new Map(notes.map(note => [note.id, note]));
	const written: MemoryNote[] = [];
	const removed = result.remove.filter(id => byId.delete(id));
	for (const change of result.upsert) {
		const existing = change.id ? byId.get(change.id) : undefined;
		let id = existing?.id ?? change.id ?? slugify(change.title);
		if (!existing) {
			for (let suffix = 2; byId.has(id); suffix++) {
				id = `${change.id ?? slugify(change.title)}-${suffix}`;
			}
		}
		const note: MemoryNote = {
			id,
			title: change.title,
			type: change.type,
			tags: change.tags,
			created: existing?.created ?? now,
			updated: now,
			sources: [...new Set([...(existing?.sources ?? []), ...change.sources])].slice(-20),
			body: change.body,
		};
		byId.set(id, note);
		written.push(note);
	}
	return { notes: [...byId.values()], written, removed };
}

export type ConsolidationFrequency = 'manual' | 'hourly' | 'daily' | 'weekly';

const FREQUENCY_MS: Record<Exclude<ConsolidationFrequency, 'manual'>, number> = {
	hourly: 60 * 60_000,
	daily: 24 * 60 * 60_000,
	weekly: 7 * 24 * 60 * 60_000,
};

/** Whether a scheduled consolidation is due. */
export function isConsolidationDue(frequency: ConsolidationFrequency, lastConsolidated: string | undefined, now: number): boolean {
	if (frequency === 'manual') {
		return false;
	}
	const last = lastConsolidated ? Date.parse(lastConsolidated) : NaN;
	return Number.isNaN(last) || now - last >= FREQUENCY_MS[frequency];
}
