/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MemoryNote, NOTE_TYPES, NoteType, slugify } from './notes';
import { MemoryStore } from './store';
import { MemoryViewActions } from './view';

interface EditorMessage {
	readonly command: 'ready' | 'consolidate' | 'selectModel' | 'remember' | 'openIndex' | 'openNote' | 'saveNote' | 'deleteNote' | 'setFrequency' | 'connectAgents';
	readonly id?: string;
	readonly frequency?: string;
	readonly note?: { readonly id?: string; readonly title: string; readonly type: string; readonly tags: readonly string[]; readonly body: string };
}

const FREQUENCIES = ['manual', 'hourly', 'daily', 'weekly'];

/** The memory in an editor tab: graph, timeline and inbox on the left, the selected note (editable) on the right. */
export class MemoryEditor implements vscode.Disposable {

	static readonly viewType = 'orvoMemory.editor';

	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: () => MemoryStore | undefined,
		onDidChange: vscode.Event<void>,
		private readonly actions: MemoryViewActions,
		private readonly onDidWrite: () => void,
	) {
		this.disposables.push(onDidChange(() => void this.refresh()));
	}

	open(selectId?: string): void {
		if (this.panel) {
			this.panel.reveal();
		} else {
			const media = vscode.Uri.joinPath(this.extensionUri, 'media');
			this.panel = vscode.window.createWebviewPanel(MemoryEditor.viewType, vscode.l10n.t('Project Memory'), vscode.ViewColumn.Active, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [media],
			});
			this.panel.iconPath = vscode.Uri.joinPath(media, 'memory.svg');
			this.panel.webview.html = this.html(this.panel.webview, media);
			this.panel.webview.onDidReceiveMessage((message: EditorMessage) => this.onMessage(message), undefined, this.disposables);
			this.panel.onDidDispose(() => this.panel = undefined, undefined, this.disposables);
		}
		if (selectId) {
			void this.panel.webview.postMessage({ type: 'select', id: selectId });
		}
	}

	private async onMessage(message: EditorMessage): Promise<void> {
		try {
			switch (message.command) {
				case 'ready': return await this.refresh();
				case 'consolidate': return await this.actions.consolidate();
				case 'selectModel': return await this.actions.selectModel();
				case 'remember': return await this.actions.remember();
				case 'openIndex': return void vscode.commands.executeCommand('orvoMemory.openIndex');
				case 'connectAgents': return void vscode.commands.executeCommand('orvoMemory.connectAgents');
				case 'openNote': return message.id ? await this.actions.openNote(message.id) : undefined;
				case 'setFrequency':
					if (message.frequency && FREQUENCIES.includes(message.frequency)) {
						await vscode.workspace.getConfiguration('orvoMemory').update('frequency', message.frequency, vscode.ConfigurationTarget.Workspace);
					}
					return;
				case 'saveNote': return message.note ? await this.saveNote(message.note) : undefined;
				case 'deleteNote': return message.id ? await this.deleteNote(message.id) : undefined;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('ORVO Memory: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	private async saveNote(input: NonNullable<EditorMessage['note']>): Promise<void> {
		const store = this.store();
		const title = input.title.trim();
		if (!store || !title) {
			return;
		}
		await store.ensure();
		const notes = await store.readNotes();
		const now = new Date().toISOString();
		const existing = input.id ? notes.find(note => note.id === input.id) : undefined;
		let id = existing?.id;
		if (!id) {
			const base = slugify(title);
			id = base;
			for (let n = 2; notes.some(note => note.id === id); n++) {
				id = `${base}-${n}`;
			}
		}
		const type: NoteType = (NOTE_TYPES as readonly string[]).includes(input.type) ? input.type as NoteType : 'fact';
		const note: MemoryNote = {
			id,
			title,
			type,
			tags: [...new Set(input.tags.map(tag => slugify(tag)).filter(tag => tag !== 'note'))],
			created: existing?.created ?? now,
			updated: now,
			sources: existing ? [...new Set([...existing.sources, 'you'])] : ['you'],
			body: input.body.trim(),
		};
		await store.writeNote(note);
		await store.writeIndex([...notes.filter(other => other.id !== id), note], await store.readState());
		this.onDidWrite();
		void this.panel?.webview.postMessage({ type: 'select', id });
	}

	private async deleteNote(id: string): Promise<void> {
		const store = this.store();
		const notes = await store?.readNotes() ?? [];
		const note = notes.find(candidate => candidate.id === id);
		if (!store || !note) {
			return;
		}
		const remove = vscode.l10n.t('Delete');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete the memory note "{0}"?', note.title), { modal: true }, remove) !== remove) {
			return;
		}
		await store.deleteNote(id);
		await store.writeIndex(notes.filter(other => other.id !== id), await store.readState());
		this.onDidWrite();
	}

	private async refresh(): Promise<void> {
		if (!this.panel) {
			return;
		}
		const store = this.store();
		const config = vscode.workspace.getConfiguration('orvoMemory');
		const modelId = config.get<string>('model.id');
		const base = {
			type: 'data',
			frequency: config.get<string>('frequency', 'daily'),
			model: modelId ? `${config.get<string>('model.vendor') ?? ''} / ${modelId}` : vscode.l10n.t('First available model'),
		};
		if (!store) {
			await this.panel.webview.postMessage({ ...base, available: false, notes: [], inbox: [] });
			return;
		}
		const [notes, inbox, state, connected] = await Promise.all([store.readNotes(), store.readInbox(), store.readState(), store.agentsConnected()]);
		await this.panel.webview.postMessage({
			...base,
			available: true,
			connected,
			lastConsolidated: state.lastConsolidated,
			inbox,
			notes: notes.sort((a, b) => b.updated.localeCompare(a.updated)),
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
		const strings = {
			heading: vscode.l10n.t('Project Memory'),
			all: vscode.l10n.t('all'),
			graphHint: vscode.l10n.t('Scroll to zoom · drag to pan or move a node · click a tag to filter'),
			remember: vscode.l10n.t('Remember'),
			consolidate: vscode.l10n.t('Consolidate'),
			newNote: vscode.l10n.t('New Note'),
			graph: vscode.l10n.t('Graph'),
			timeline: vscode.l10n.t('Timeline'),
			inbox: vscode.l10n.t('Inbox'),
			search: vscode.l10n.t('Search memory'),
			notes: vscode.l10n.t('notes'),
			waiting: vscode.l10n.t('raw memories waiting'),
			last: vscode.l10n.t('Last consolidated'),
			never: vscode.l10n.t('never'),
			learn: vscode.l10n.t('Learn'),
			model: vscode.l10n.t('Model'),
			index: vscode.l10n.t('Open MEMORY.md'),
			connect: vscode.l10n.t('Connect agents'),
			edit: vscode.l10n.t('Edit'),
			save: vscode.l10n.t('Save'),
			cancel: vscode.l10n.t('Cancel'),
			delete: vscode.l10n.t('Delete'),
			openFile: vscode.l10n.t('Open File'),
			title: vscode.l10n.t('Title'),
			type: vscode.l10n.t('Type'),
			tags: vscode.l10n.t('Tags (comma separated)'),
			body: vscode.l10n.t('Note (Markdown)'),
			created: vscode.l10n.t('Created'),
			updated: vscode.l10n.t('Updated'),
			sources: vscode.l10n.t('From'),
			related: vscode.l10n.t('Related'),
			pick: vscode.l10n.t('Select a note in the graph or timeline, or create one.'),
			empty: vscode.l10n.t('No notes yet. Use Remember, let agents add to the inbox, then Consolidate. Or create a note directly.'),
			inboxEmpty: vscode.l10n.t('The inbox is empty. Agents and Remember add raw memories here; Consolidate turns them into notes.'),
			noFolder: vscode.l10n.t('Open a folder to use project memory.'),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${strings.graph}</title>
</head>
<body>
<script nonce="${nonce}" id="strings" type="application/json">${JSON.stringify({ strings, types: NOTE_TYPES, frequencies: FREQUENCIES }).replace(/</g, '\\u003c')}</script>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
