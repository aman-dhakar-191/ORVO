/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The project memory format, as pure functions (no VS Code API) so it can be tested on its own.
 *
 * .orvo/memory/
 *   inbox.md            raw memories, one line each, appended by agents, tools and people
 *   notes/<id>.md       curated notes (YAML-ish front matter + Markdown body)
 *   MEMORY.md           generated index that agents read
 *   archive/<date>.md   inbox entries already consolidated
 *   state.json          when consolidation last ran
 */

export const NOTE_TYPES = ['decision', 'convention', 'fact', 'gotcha', 'todo', 'context'] as const;
export type NoteType = typeof NOTE_TYPES[number];

export interface MemoryNote {
	readonly id: string;
	readonly title: string;
	readonly type: NoteType;
	readonly tags: readonly string[];
	readonly created: string;
	readonly updated: string;
	readonly sources: readonly string[];
	readonly body: string;
}

export interface RawEntry {
	readonly time: string;
	readonly source: string;
	readonly text: string;
}

export interface MemoryState {
	/** ISO time of the last consolidation. */
	lastConsolidated?: string;
	/** Newest commit already learned from. */
	lastCommit?: string;
}

export function slugify(title: string): string {
	const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
	return slug || 'note';
}

function isNoteType(value: string): value is NoteType {
	return (NOTE_TYPES as readonly string[]).includes(value);
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// fall through
		}
	}
	return trimmed;
}

function parseList(value: string): string[] {
	const trimmed = value.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.filter((item): item is string => typeof item === 'string');
			}
		} catch {
			// fall through
		}
	}
	return trimmed ? trimmed.split(',').map(item => unquote(item)).filter(Boolean) : [];
}

export function serializeNote(note: MemoryNote): string {
	return [
		'---',
		`id: ${note.id}`,
		`title: ${quote(note.title)}`,
		`type: ${note.type}`,
		`tags: ${JSON.stringify(note.tags)}`,
		`created: ${note.created}`,
		`updated: ${note.updated}`,
		`sources: ${JSON.stringify(note.sources)}`,
		'---',
		'',
		note.body.trim(),
		'',
	].join('\n');
}

/** Reads a note file; tolerant of hand edits (missing fields get defaults, unknown keys are ignored). */
export function parseNote(text: string, fallbackId: string, now: string): MemoryNote {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	const fields = new Map<string, string>();
	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(':');
			if (index > 0) {
				fields.set(line.slice(0, index).trim(), line.slice(index + 1));
			}
		}
	}
	const body = (match ? match[2] : text).trim();
	const type = unquote(fields.get('type') ?? 'fact');
	const title = unquote(fields.get('title') ?? '') || body.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').slice(0, 80) || fallbackId;
	return {
		id: unquote(fields.get('id') ?? '') || fallbackId,
		title,
		type: isNoteType(type) ? type : 'fact',
		tags: parseList(fields.get('tags') ?? ''),
		created: unquote(fields.get('created') ?? '') || now,
		updated: unquote(fields.get('updated') ?? '') || now,
		sources: parseList(fields.get('sources') ?? ''),
		body,
	};
}

const INBOX_LINE = /^\s*[-*]\s+(\S+)\s+\[([^\]]+)\]\s+(.+?)\s*$/;

export const INBOX_HEADER = [
	'# Memory inbox',
	'',
	'<!-- One memory per line: "- <ISO time> [<who>] <what to remember>". ORVO Memory turns these into notes on a schedule. -->',
	'',
].join('\n');

export function formatInboxEntry(entry: RawEntry): string {
	return `- ${entry.time} [${entry.source.replace(/[\]\r\n]/g, ' ')}] ${entry.text.replace(/\s*\r?\n\s*/g, ' ').trim()}`;
}

/** Splits an inbox into its entries; lines that are not entries (header, comments, blank) are kept as `rest`. */
export function parseInbox(text: string): { entries: RawEntry[]; rest: string[] } {
	const entries: RawEntry[] = [];
	const rest: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(INBOX_LINE);
		if (match) {
			entries.push({ time: match[1], source: match[2], text: match[3] });
		} else {
			rest.push(line);
		}
	}
	return { entries, rest };
}

const TYPE_HEADINGS: Record<NoteType, string> = {
	decision: 'Decisions',
	convention: 'Conventions',
	gotcha: 'Gotchas',
	fact: 'Facts',
	context: 'Context',
	todo: 'Open items',
};

function summaryLine(body: string): string {
	const line = body.split(/\r?\n/).map(part => part.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** MEMORY.md: what agents read first. Grouped by type, newest first, one line per note with a link to it. */
export function renderIndex(notes: readonly MemoryNote[], state: MemoryState): string {
	const lines = [
		'# Project memory',
		'',
		'<!-- Generated by ORVO Memory. Edit the notes in notes/, not this file. -->',
		'',
		`Long-term memory for this project, curated from what agents and people recorded${state.lastConsolidated ? ` (last updated ${state.lastConsolidated.slice(0, 10)})` : ''}.`,
		'To add something, append a line to `.orvo/memory/inbox.md`: `- <ISO time> [<who>] <what to remember>`.',
		'',
	];
	for (const type of ['decision', 'convention', 'gotcha', 'fact', 'context', 'todo'] as const) {
		const group = notes.filter(note => note.type === type).sort((a, b) => b.updated.localeCompare(a.updated));
		if (!group.length) {
			continue;
		}
		lines.push(`## ${TYPE_HEADINGS[type]}`, '');
		for (const note of group) {
			const tags = note.tags.length ? ` _(${note.tags.join(', ')})_` : '';
			lines.push(`- [${note.title}](notes/${note.id}.md): ${summaryLine(note.body)}${tags}`);
		}
		lines.push('');
	}
	if (!notes.length) {
		lines.push('_No notes yet._', '');
	}
	return lines.join('\n');
}

/** Words of the query that appear in a note, weighting the title; for the search tool and the view. */
export function searchNotes(notes: readonly MemoryNote[], query: string, limit = 10): MemoryNote[] {
	const words = query.toLowerCase().split(/\W+/).filter(word => word.length > 1);
	if (!words.length) {
		return [...notes].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit);
	}
	return notes
		.map(note => {
			const title = note.title.toLowerCase();
			const text = `${note.body} ${note.tags.join(' ')}`.toLowerCase();
			const score = words.reduce((total, word) => total + (title.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0);
			return { note, score };
		})
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || b.note.updated.localeCompare(a.note.updated))
		.slice(0, limit)
		.map(item => item.note);
}
