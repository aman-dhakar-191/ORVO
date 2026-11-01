/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentFile, CODE_MAP_SERVER_NAME, hasMcpServer, hasMemoryBlock, McpStdioEntry, memoryInstructions, upsertMcpServer, upsertMemoryBlock } from './agents';
import { formatInboxEntry, INBOX_HEADER, MemoryNote, MemoryState, parseInbox, parseNote, RawEntry, renderIndex, serializeNote } from './notes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One workspace folder's `.orvo/memory`, read and written through the VS Code file system (works remotely too). */
export class MemoryStore {

	readonly root: vscode.Uri;
	readonly notesDir: vscode.Uri;
	readonly inbox: vscode.Uri;
	readonly index: vscode.Uri;
	readonly archiveDir: vscode.Uri;
	readonly stateFile: vscode.Uri;

	constructor(readonly folder: vscode.WorkspaceFolder) {
		this.root = vscode.Uri.joinPath(folder.uri, '.orvo', 'memory');
		this.notesDir = vscode.Uri.joinPath(this.root, 'notes');
		this.inbox = vscode.Uri.joinPath(this.root, 'inbox.md');
		this.index = vscode.Uri.joinPath(this.root, 'MEMORY.md');
		this.archiveDir = vscode.Uri.joinPath(this.root, 'archive');
		this.stateFile = vscode.Uri.joinPath(this.root, 'state.json');
	}

	private async read(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return decoder.decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return undefined;
		}
	}

	private write(uri: vscode.Uri, text: string): Thenable<void> {
		return vscode.workspace.fs.writeFile(uri, encoder.encode(text));
	}

	/** Creates the folder layout (and an empty index) the first time memory is used in this project. */
	async ensure(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.notesDir);
		if (await this.read(this.inbox) === undefined) {
			await this.write(this.inbox, INBOX_HEADER);
		}
		if (await this.read(this.index) === undefined) {
			await this.write(this.index, renderIndex([], {}));
		}
	}

	async readNotes(): Promise<MemoryNote[]> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(this.notesDir);
		} catch {
			return [];
		}
		const now = new Date().toISOString();
		const notes: MemoryNote[] = [];
		for (const [name, type] of entries) {
			if (type === vscode.FileType.File && name.endsWith('.md')) {
				const text = await this.read(vscode.Uri.joinPath(this.notesDir, name));
				if (text !== undefined) {
					notes.push(parseNote(text, name.slice(0, -3), now));
				}
			}
		}
		return notes;
	}

	noteUri(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.notesDir, `${id}.md`);
	}

	async writeNote(note: MemoryNote): Promise<void> {
		await this.write(this.noteUri(note.id), serializeNote(note));
	}

	async deleteNote(id: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(this.noteUri(id));
		} catch {
			// already gone
		}
	}

	async readInbox(): Promise<RawEntry[]> {
		return parseInbox(await this.read(this.inbox) ?? '').entries;
	}

	async remember(entry: RawEntry): Promise<void> {
		await this.ensure();
		const current = await this.read(this.inbox) ?? INBOX_HEADER;
		await this.write(this.inbox, `${current.replace(/\s*$/, '')}\n${formatInboxEntry(entry)}\n`);
	}

	/**
	 * Moves consolidated entries to `archive/<date>.md` and keeps the rest of the inbox, including entries an agent
	 * appended while the model was working.
	 */
	async archiveEntries(consolidated: readonly RawEntry[], date: string): Promise<void> {
		if (!consolidated.length) {
			return;
		}
		const done = new Set(consolidated.map(formatInboxEntry));
		const { entries, rest } = parseInbox(await this.read(this.inbox) ?? '');
		const remaining = entries.filter(entry => !done.has(formatInboxEntry(entry)));
		const header = rest.join('\n').replace(/\s*$/, '') || INBOX_HEADER.trim();
		await this.write(this.inbox, `${header}\n${remaining.map(formatInboxEntry).join('\n')}${remaining.length ? '\n' : ''}`);
		await vscode.workspace.fs.createDirectory(this.archiveDir);
		const archive = vscode.Uri.joinPath(this.archiveDir, `${date}.md`);
		const existing = await this.read(archive) ?? `# Consolidated ${date}\n`;
		await this.write(archive, `${existing.replace(/\s*$/, '')}\n${consolidated.map(formatInboxEntry).join('\n')}\n`);
	}

	async readState(): Promise<MemoryState> {
		try {
			return JSON.parse(await this.read(this.stateFile) ?? '{}');
		} catch {
			return {};
		}
	}

	async writeState(state: MemoryState): Promise<void> {
		await this.write(this.stateFile, `${JSON.stringify(state, undefined, '\t')}\n`);
	}

	async writeIndex(notes: readonly MemoryNote[], state: MemoryState): Promise<void> {
		await this.write(this.index, renderIndex(notes, state));
	}

	get mcpJson(): vscode.Uri {
		return vscode.Uri.joinPath(this.folder.uri, '.mcp.json');
	}

	/** Whether CLAUDE.md and AGENTS.md point agents at the memory (and, given a code map entry, .mcp.json has it). */
	async agentsConnected(codeMap?: McpStdioEntry): Promise<boolean> {
		for (const file of ['CLAUDE.md', 'AGENTS.md'] as const) {
			if (!hasMemoryBlock(await this.read(vscode.Uri.joinPath(this.folder.uri, file)))) {
				return false;
			}
		}
		return !codeMap || hasMcpServer(await this.read(this.mcpJson), CODE_MAP_SERVER_NAME);
	}

	/**
	 * Adds (or refreshes) the managed memory section in CLAUDE.md and AGENTS.md, creating them if needed, and the code
	 * map server in .mcp.json. Returns false when .mcp.json exists but isn't plain JSON (it is then left alone).
	 */
	async connectAgents(codeMap?: McpStdioEntry): Promise<boolean> {
		for (const file of ['CLAUDE.md', 'AGENTS.md'] as AgentFile[]) {
			const uri = vscode.Uri.joinPath(this.folder.uri, file);
			await this.write(uri, upsertMemoryBlock(await this.read(uri), memoryInstructions(file)));
		}
		return codeMap ? this.writeCodeMapEntry(codeMap) : true;
	}

	/** Points the code map entry in .mcp.json at this ORVO install, if it is there with another path (ORVO moved). */
	async refreshCodeMapEntry(codeMap: McpStdioEntry): Promise<void> {
		const current = await this.read(this.mcpJson);
		if (hasMcpServer(current, CODE_MAP_SERVER_NAME) && !hasMcpServer(current, CODE_MAP_SERVER_NAME, codeMap)) {
			await this.writeCodeMapEntry(codeMap);
		}
	}

	private async writeCodeMapEntry(codeMap: McpStdioEntry): Promise<boolean> {
		const updated = upsertMcpServer(await this.read(this.mcpJson), CODE_MAP_SERVER_NAME, codeMap);
		if (updated === undefined) {
			return false;
		}
		await this.write(this.mcpJson, updated);
		return true;
	}
}
