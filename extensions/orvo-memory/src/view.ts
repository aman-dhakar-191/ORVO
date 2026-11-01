/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NOTE_TYPES } from './notes';
import { MemoryStore } from './store';

export interface MemoryViewActions {
	consolidate(): Promise<void>;
	selectModel(): Promise<void>;
	openNote(id: string): Promise<void>;
	remember(): Promise<void>;
}

interface ViewMessage {
	readonly command: 'consolidate' | 'selectModel' | 'openNote' | 'remember' | 'openIndex' | 'openEditor' | 'connectAgents' | 'setFrequency' | 'ready';
	readonly id?: string;
	readonly frequency?: string;
}

const FREQUENCIES = ['manual', 'hourly', 'daily', 'weekly'];

/** Sidebar view: a filterable timeline of the project's memory notes plus the consolidation controls. */
export class MemoryViewProvider implements vscode.WebviewViewProvider {

	static readonly viewId = 'orvoMemory.view';

	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: () => MemoryStore | undefined,
		onDidChange: vscode.Event<void>,
		private readonly actions: MemoryViewActions,
	) {
		onDidChange(() => void this.refresh());
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((message: ViewMessage) => this.onMessage(message));
		view.onDidChangeVisibility(() => view.visible && void this.refresh());
		view.onDidDispose(() => this.view = undefined);
	}

	private async onMessage(message: ViewMessage): Promise<void> {
		switch (message.command) {
			case 'ready': return this.refresh();
			case 'consolidate': return this.actions.consolidate();
			case 'selectModel': return this.actions.selectModel();
			case 'remember': return this.actions.remember();
			case 'openIndex': return void vscode.commands.executeCommand('orvoMemory.openIndex');
			case 'openEditor': return void vscode.commands.executeCommand('orvoMemory.openEditor');
			case 'connectAgents': return void vscode.commands.executeCommand('orvoMemory.connectAgents');
			case 'openNote':
				if (message.id) {
					await this.actions.openNote(message.id);
				}
				return;
			case 'setFrequency':
				if (message.frequency && FREQUENCIES.includes(message.frequency)) {
					await vscode.workspace.getConfiguration('orvoMemory').update('frequency', message.frequency, vscode.ConfigurationTarget.Workspace);
				}
				return;
		}
	}

	private async refresh(): Promise<void> {
		if (!this.view?.visible) {
			return;
		}
		const store = this.store();
		const config = vscode.workspace.getConfiguration('orvoMemory');
		const modelId = config.get<string>('model.id');
		const base = {
			frequency: config.get<string>('frequency', 'daily'),
			model: modelId ? `${config.get<string>('model.vendor') ?? ''} / ${modelId}` : vscode.l10n.t('First available model'),
		};
		if (!store) {
			await this.view.webview.postMessage({ ...base, available: false, notes: [], inbox: 0 });
			return;
		}
		const [notes, inbox, state, connected] = await Promise.all([store.readNotes(), store.readInbox(), store.readState(), store.agentsConnected()]);
		await this.view.webview.postMessage({
			...base,
			available: true,
			connected,
			inbox: inbox.length,
			lastConsolidated: state.lastConsolidated,
			notes: notes
				.sort((a, b) => b.updated.localeCompare(a.updated))
				.map(note => ({ id: note.id, title: note.title, type: note.type, tags: note.tags, updated: note.updated, excerpt: note.body.slice(0, 240) })),
		});
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const types = JSON.stringify(['all', ...NOTE_TYPES]);
		const frequencies = JSON.stringify(FREQUENCIES);
		const t = {
			remember: vscode.l10n.t('Remember'),
			consolidate: vscode.l10n.t('Consolidate'),
			model: vscode.l10n.t('Model'),
			frequency: vscode.l10n.t('Learn'),
			search: vscode.l10n.t('Search memory'),
			empty: vscode.l10n.t('No notes yet. Use Remember, or let agents add to .orvo/memory/inbox.md, then Consolidate.'),
			noFolder: vscode.l10n.t('Open a folder to use project memory.'),
			pending: vscode.l10n.t('raw memories waiting'),
			last: vscode.l10n.t('Last consolidated'),
			never: vscode.l10n.t('never'),
			index: vscode.l10n.t('Open MEMORY.md'),
			editor: vscode.l10n.t('Open Memory Editor (graph, timeline, edit)'),
			connect: vscode.l10n.t('Connect agents (CLAUDE.md, AGENTS.md)'),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	body { padding: 0 8px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	.row { display: flex; gap: 6px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; }
	input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; }
	input { flex: 1; min-width: 0; }
	.meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
	.chip { border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; cursor: pointer; font-size: 0.85em; }
	.chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.note { border-left: 3px solid var(--vscode-textLink-foreground); padding: 4px 8px; margin: 8px 0; cursor: pointer; }
	.note:hover { background: var(--vscode-list-hoverBackground); }
	.note.decision { border-color: var(--vscode-charts-purple); }
	.note.convention { border-color: var(--vscode-charts-blue); }
	.note.fact { border-color: var(--vscode-charts-green); }
	.note.gotcha { border-color: var(--vscode-charts-red); }
	.note.todo { border-color: var(--vscode-charts-yellow); }
	.note.context { border-color: var(--vscode-charts-orange); }
	.title { font-weight: 600; }
	.excerpt { white-space: pre-wrap; margin-top: 2px; }
	.hidden { display: none; }
</style>
</head>
<body>
<div id="unavailable" class="meta hidden">${t.noFolder}</div>
<div id="main">
	<div class="row">
		<button id="remember">${t.remember}</button>
		<button id="consolidate" class="secondary">${t.consolidate}</button>
	</div>
	<div class="row meta"><span id="inbox"></span></div>
	<div class="row meta"><span>${t.frequency}:</span><select id="frequency"></select></div>
	<div class="row meta"><span>${t.model}:</span><button id="model" class="link"></button></div>
	<div class="row"><button id="editor">${t.editor}</button></div>
	<div class="row"><button id="index" class="link">${t.index}</button></div>
	<div class="row"><button id="connect" class="link hidden">${t.connect}</button></div>
	<div class="row"><input id="search" type="search" placeholder="${t.search}"></div>
	<div class="chips" id="types"></div>
	<div class="chips" id="tags"></div>
	<div id="notes"></div>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const types = ${types};
	const frequencies = ${frequencies};
	const text = ${JSON.stringify(t)};
	let data = { notes: [], inbox: 0 };
	let filter = { type: 'all', tag: undefined, query: '' };
	const $ = id => document.getElementById(id);
	const el = (tag, cls, content) => { const node = document.createElement(tag); if (cls) { node.className = cls; } if (content !== undefined) { node.textContent = content; } return node; };

	for (const id of ['remember', 'consolidate', 'index', 'connect']) {
		$(id).addEventListener('click', () => vscode.postMessage({ command: id === 'index' ? 'openIndex' : id === 'connect' ? 'connectAgents' : id }));
	}
	$('model').addEventListener('click', () => vscode.postMessage({ command: 'selectModel' }));
	$('editor').addEventListener('click', () => vscode.postMessage({ command: 'openEditor' }));
	for (const f of frequencies) { const option = el('option', undefined, f); option.value = f; $('frequency').appendChild(option); }
	$('frequency').addEventListener('change', event => vscode.postMessage({ command: 'setFrequency', frequency: event.target.value }));
	$('search').addEventListener('input', event => { filter.query = event.target.value.toLowerCase(); render(); });

	function chip(label, active, onClick) {
		const node = el('span', 'chip' + (active ? ' active' : ''), label);
		node.addEventListener('click', onClick);
		return node;
	}

	function render() {
		$('unavailable').classList.toggle('hidden', data.available !== false);
		$('main').classList.toggle('hidden', data.available === false);
		$('inbox').textContent = data.inbox + ' ' + text.pending + ' · ' + text.last + ': ' + (data.lastConsolidated ? new Date(data.lastConsolidated).toLocaleString() : text.never);
		$('frequency').value = data.frequency;
		$('model').textContent = data.model;
		$('connect').classList.toggle('hidden', data.connected !== false);

		const typeChips = $('types');
		typeChips.replaceChildren(...types.map(type => chip(type, filter.type === type, () => { filter.type = type; render(); })));

		const counts = new Map();
		for (const note of data.notes) { for (const tag of note.tags) { counts.set(tag, (counts.get(tag) || 0) + 1); } }
		const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
		$('tags').replaceChildren(...tags.map(([tag, count]) => chip('#' + tag + ' ' + count, filter.tag === tag, () => { filter.tag = filter.tag === tag ? undefined : tag; render(); })));

		const visible = data.notes.filter(note =>
			(filter.type === 'all' || note.type === filter.type)
			&& (!filter.tag || note.tags.includes(filter.tag))
			&& (!filter.query || (note.title + ' ' + note.excerpt + ' ' + note.tags.join(' ')).toLowerCase().includes(filter.query)));
		const list = $('notes');
		if (!visible.length) {
			list.replaceChildren(el('div', 'meta', text.empty));
			return;
		}
		list.replaceChildren(...visible.map(note => {
			const item = el('div', 'note ' + note.type);
			item.appendChild(el('div', 'title', note.title));
			item.appendChild(el('div', 'meta', note.type + ' · ' + note.updated.slice(0, 10) + (note.tags.length ? ' · #' + note.tags.join(' #') : '')));
			item.appendChild(el('div', 'excerpt', note.excerpt));
			item.addEventListener('click', () => vscode.postMessage({ command: 'openNote', id: note.id }));
			return item;
		}));
	}

	window.addEventListener('message', event => { data = event.data; render(); });
	vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
	}
}
