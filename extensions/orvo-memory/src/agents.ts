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
		'',
		'For how files depend on each other, use the `orvo-codemap` MCP tools before searching imports by hand: `deps_overview` to orient, `deps_dependents` before changing a shared file, `deps_imports`, `deps_path`, `deps_cycles`, `deps_find`.',
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

// #region .mcp.json (read by Claude and Codex sessions in ORVO, and by Claude Code)

export const CODE_MAP_SERVER_NAME = 'orvo-codemap';

export interface McpStdioEntry {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

function parseMcpJson(existing: string | undefined): { mcpServers?: Record<string, unknown> } | undefined {
	if (!existing?.trim()) {
		return {};
	}
	try {
		const json = JSON.parse(existing);
		return json && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
	} catch {
		return undefined; // comments or broken JSON: leave the user's file alone
	}
}

/** `.mcp.json` with the code map server added or updated; `undefined` when the file can't be parsed safely. */
export function upsertMcpServer(existing: string | undefined, name: string, entry: McpStdioEntry): string | undefined {
	const json = parseMcpJson(existing);
	if (!json) {
		return undefined;
	}
	const servers = json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {};
	return `${JSON.stringify({ ...json, mcpServers: { ...servers, [name]: entry } }, undefined, '\t')}\n`;
}

/** Whether `.mcp.json` has the server, and (when `entry` is given) with exactly that command line. */
export function hasMcpServer(existing: string | undefined, name: string, entry?: McpStdioEntry): boolean {
	const current = parseMcpJson(existing)?.mcpServers?.[name];
	return !!current && (!entry || JSON.stringify(current) === JSON.stringify(entry));
}

// #endregion
