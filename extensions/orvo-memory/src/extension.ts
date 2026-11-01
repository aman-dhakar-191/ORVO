/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { applyConsolidation, buildConsolidationPrompt, CommitInfo, ConsolidationFrequency, isConsolidationDue, parseConsolidationResult } from './consolidate';
import { searchNotes } from './notes';
import { MemoryStore } from './store';
import { MemoryEditor } from './editor';
import { MemoryViewProvider } from './view';

const SCHEDULE_CHECK_MS = 15 * 60_000;
const MAX_ENTRIES_PER_RUN = 200;
const MAX_COMMITS_PER_RUN = 50;

interface GitCommit { readonly hash: string; readonly message: string; readonly authorDate?: Date }
interface GitRepository { log(options: { maxEntries: number }): Promise<GitCommit[]> }
interface GitApi { getRepository(uri: vscode.Uri): GitRepository | null }

function config() {
	return vscode.workspace.getConfiguration('orvoMemory');
}

export function activate(context: vscode.ExtensionContext): void {
	const memory = new OrvoMemory(context);
	context.subscriptions.push(memory);
}

class OrvoMemory implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly onDidChange = new vscode.EventEmitter<void>();
	private readonly view: MemoryViewProvider;
	private readonly editor: MemoryEditor;
	private running: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		const actions = {
			consolidate: () => this.consolidate(true),
			selectModel: () => this.selectModel(),
			openNote: (id: string) => this.openNote(id),
			remember: () => this.rememberInteractively(),
		};
		this.editor = new MemoryEditor(context.extensionUri, () => this.store(), this.onDidChange.event, actions, () => this.onDidChange.fire());
		// In the sidebar a note opens in the memory editor; the editor's Open File opens the Markdown file.
		this.view = new MemoryViewProvider(context.extensionUri, () => this.store(), this.onDidChange.event, { ...actions, openNote: async id => this.editor.open(id) });
		this.disposables.push(
			this.onDidChange,
			this.editor,
			vscode.commands.registerCommand('orvoMemory.openEditor', () => this.editor.open()),
			vscode.window.registerWebviewViewProvider(MemoryViewProvider.viewId, this.view),
			vscode.commands.registerCommand('orvoMemory.consolidateNow', () => this.consolidate(true)),
			vscode.commands.registerCommand('orvoMemory.selectModel', () => this.selectModel()),
			vscode.commands.registerCommand('orvoMemory.remember', () => this.rememberInteractively()),
			vscode.commands.registerCommand('orvoMemory.connectAgents', () => this.connectAgents(true)),
			vscode.commands.registerCommand('orvoMemory.openIndex', async () => {
				const store = this.store();
				if (store) {
					await store.ensure();
					await vscode.window.showTextDocument(store.index);
				}
			}),
			vscode.lm.registerTool<{ text: string }>('orvo_memory_remember', {
				prepareInvocation: options => ({ invocationMessage: vscode.l10n.t('Remembering: {0}', options.input.text.slice(0, 80)) }),
				invoke: async options => {
					const store = this.store();
					if (!store || !options.input.text?.trim()) {
						return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No workspace folder is open, or there was nothing to remember.')]);
					}
					await store.remember({ time: new Date().toISOString(), source: 'copilot', text: options.input.text.trim() });
					this.onDidChange.fire();
					return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Saved to the project memory inbox; it will be consolidated into notes.')]);
				},
			}),
			vscode.lm.registerTool<{ query: string }>('orvo_memory_search', {
				invoke: async options => {
					const store = this.store();
					const notes = store ? searchNotes(await store.readNotes(), options.input.query ?? '', 8) : [];
					const text = notes.length
						? notes.map(note => `### ${note.title} (${note.type}; ${note.tags.join(', ')}; updated ${note.updated.slice(0, 10)})\n${note.body}`).join('\n\n')
						: 'No matching project memory.';
					return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
				},
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orvoMemory')) {
					this.onDidChange.fire();
				}
			}),
		);

		const store = this.store();
		if (store) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(store.folder, '.orvo/memory/**'));
			this.disposables.push(watcher, watcher.onDidChange(() => this.onDidChange.fire()), watcher.onDidCreate(() => this.onDidChange.fire()), watcher.onDidDelete(() => this.onDidChange.fire()));
			void this.offerToConnectAgents(store);
		}

		const timer = setInterval(() => void this.consolidateIfDue(), SCHEDULE_CHECK_MS);
		const initial = setTimeout(() => void this.consolidateIfDue(), 30_000);
		this.disposables.push({ dispose: () => { clearInterval(timer); clearTimeout(initial); } });
	}

	/** The memory of the first workspace folder; multi-root workspaces share it. */
	private store(): MemoryStore | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		return folder && config().get<boolean>('enabled', true) ? new MemoryStore(folder) : undefined;
	}

	private async offerToConnectAgents(store: MemoryStore): Promise<void> {
		const mode = config().get<'ask' | 'always' | 'never'>('connectAgents', 'ask');
		if (mode === 'never' || await store.agentsConnected()) {
			return;
		}
		if (mode === 'always') {
			return this.connectAgents(false);
		}
		const key = `orvoMemory.connectAsked:${store.folder.uri.toString()}`;
		if (this.context.workspaceState.get<boolean>(key)) {
			return;
		}
		await this.context.workspaceState.update(key, true);
		const connect = vscode.l10n.t('Connect Agents');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Share project memory with Copilot, Claude and Codex? ORVO Memory adds a short section to CLAUDE.md and AGENTS.md telling agents to read .orvo/memory/MEMORY.md and record what they learn.'),
			connect, vscode.l10n.t('Not Now'));
		if (choice === connect) {
			await this.connectAgents(false);
		}
	}

	private async connectAgents(explicit: boolean): Promise<void> {
		const store = this.store();
		if (!store) {
			return;
		}
		await store.ensure();
		await store.connectAgents();
		if (explicit) {
			void vscode.window.showInformationMessage(vscode.l10n.t('CLAUDE.md and AGENTS.md now point agents at the project memory.'));
		}
		this.onDidChange.fire();
	}

	private async rememberInteractively(): Promise<void> {
		const store = this.store();
		if (!store) {
			return;
		}
		const text = await vscode.window.showInputBox({ prompt: vscode.l10n.t('What should agents and teammates remember about this project?'), ignoreFocusOut: true });
		if (text?.trim()) {
			await store.remember({ time: new Date().toISOString(), source: 'you', text: text.trim() });
			this.onDidChange.fire();
		}
	}

	private async selectModel(): Promise<void> {
		const models = await vscode.lm.selectChatModels({});
		if (!models.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No language models are available. Sign in to Copilot or add a model provider (Chat: Manage Language Models).'));
			return;
		}
		const pick = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.vendor, detail: model.id, model })), {
			placeHolder: vscode.l10n.t('Model that turns raw memories into notes'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (pick) {
			await config().update('model.vendor', pick.model.vendor, vscode.ConfigurationTarget.Global);
			await config().update('model.id', pick.model.id, vscode.ConfigurationTarget.Global);
		}
	}

	private async resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
		const vendor = config().get<string>('model.vendor') || undefined;
		const id = config().get<string>('model.id') || undefined;
		const [configured] = vendor || id ? await vscode.lm.selectChatModels({ vendor, id }) : [];
		return configured ?? (await vscode.lm.selectChatModels({}))[0];
	}

	private async commitsSince(store: MemoryStore, lastCommit: string | undefined): Promise<CommitInfo[]> {
		if (!config().get<boolean>('learnFromCommits', true)) {
			return [];
		}
		try {
			const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
			const api = (git?.isActive ? git.exports : await git?.activate())?.getAPI(1);
			const log = await api?.getRepository(store.folder.uri)?.log({ maxEntries: MAX_COMMITS_PER_RUN }) ?? [];
			const index = lastCommit ? log.findIndex(commit => commit.hash === lastCommit) : -1;
			return (index >= 0 ? log.slice(0, index) : log).map(commit => ({ hash: commit.hash, message: commit.message, date: commit.authorDate?.toISOString() }));
		} catch {
			return [];
		}
	}

	private async consolidateIfDue(): Promise<void> {
		const store = this.store();
		if (!store) {
			return;
		}
		const state = await store.readState();
		if (isConsolidationDue(config().get<ConsolidationFrequency>('frequency', 'daily'), state.lastConsolidated, Date.now())) {
			await this.consolidate(false);
		}
	}

	/** Runs one consolidation (never two at once). Explicit runs report progress and errors; scheduled ones stay quiet. */
	consolidate(explicit: boolean): Promise<void> {
		this.running ??= this.doConsolidate(explicit).finally(() => this.running = undefined);
		return this.running;
	}

	private async doConsolidate(explicit: boolean): Promise<void> {
		const store = this.store();
		if (!store) {
			return;
		}
		try {
			await store.ensure();
			const state = await store.readState();
			const entries = (await store.readInbox()).slice(0, MAX_ENTRIES_PER_RUN);
			const commits = await this.commitsSince(store, state.lastCommit);
			const now = new Date().toISOString();
			if (!entries.length && !commits.length) {
				await store.writeState({ ...state, lastConsolidated: now });
				if (explicit) {
					void vscode.window.showInformationMessage(vscode.l10n.t('Nothing new to consolidate.'));
				}
				return;
			}
			const model = await this.resolveModel();
			if (!model) {
				throw new Error(vscode.l10n.t('No language model is available. Pick one with "ORVO Memory: Select Model".'));
			}
			const notes = await store.readNotes();
			const run = async (token: vscode.CancellationToken) => {
				const response = await model.sendRequest(
					[vscode.LanguageModelChatMessage.User(buildConsolidationPrompt({ notes, entries, commits, now }))],
					{ justification: vscode.l10n.t('ORVO Memory turns raw project memories into notes.') },
					token);
				let reply = '';
				for await (const part of response.text) {
					reply += part;
				}
				return reply;
			};
			const reply = explicit
				? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Consolidating project memory with {0}...', model.name), cancellable: true }, (_progress, token) => run(token))
				: await run(new vscode.CancellationTokenSource().token);
			const result = applyConsolidation(notes, parseConsolidationResult(reply), now);
			for (const note of result.written) {
				await store.writeNote(note);
			}
			for (const id of result.removed) {
				await store.deleteNote(id);
			}
			const nextState = { ...state, lastConsolidated: now, lastCommit: commits[0]?.hash ?? state.lastCommit };
			await store.archiveEntries(entries, now.slice(0, 10));
			await store.writeState(nextState);
			await store.writeIndex(result.notes, nextState);
			this.onDidChange.fire();
			if (explicit) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Project memory updated: {0} notes written, {1} removed.', result.written.length, result.removed.length));
			}
		} catch (error) {
			if (explicit) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Could not consolidate project memory: {0}', error instanceof Error ? error.message : String(error)));
			} else {
				console.warn('[orvo-memory] scheduled consolidation failed', error);
			}
		}
	}

	private async openNote(id: string): Promise<void> {
		const store = this.store();
		if (store && /^[a-z0-9-]+$/.test(id)) {
			await vscode.window.showTextDocument(store.noteUri(id));
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
