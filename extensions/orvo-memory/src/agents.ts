/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const START = '<!-- orvo-memory:start (managed by ORVO Memory; edits inside are replaced) -->';
const END = '<!-- orvo-memory:end -->';

export type AgentFile = 'CLAUDE.md' | 'AGENTS.md';

/** What each agent file says. Claude Code imports files with `@path`; AGENTS.md (Copilot, Codex) has no imports. */
export function memoryInstructions(file: AgentFile): string {
	return [
		START,
		'## Project memory',
		'',
		file === 'CLAUDE.md'
			? '@.orvo/memory/MEMORY.md'
			: 'Read `.orvo/memory/MEMORY.md` at the start of a task: it is this project\'s long-term memory (decisions, conventions, gotchas), with details in `.orvo/memory/notes/`.',
		'',
		'When you learn something future work should know (a decision and why, a convention, a gotcha, a setup step), append one line to `.orvo/memory/inbox.md`:',
		'`- <ISO 8601 time> [<your name, e.g. claude>] <what to remember>`',
		'Do not edit `MEMORY.md` or the notes directly, and never record secrets. ORVO Memory consolidates the inbox into notes on a schedule.',
		END,
	].join('\n');
}

/** Inserts or replaces the managed block, leaving the rest of the file untouched. */
export function upsertMemoryBlock(existing: string | undefined, block: string): string {
	if (!existing?.trim()) {
		return `${block}\n`;
	}
	const start = existing.indexOf(START);
	const end = existing.indexOf(END);
	if (start >= 0 && end > start) {
		return existing.slice(0, start) + block + existing.slice(end + END.length);
	}
	return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

export function hasMemoryBlock(existing: string | undefined): boolean {
	return !!existing && existing.includes(START) && existing.includes(END);
}
