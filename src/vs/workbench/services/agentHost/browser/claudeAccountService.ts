/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CLAUDE_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { CLAUDE_ACCOUNT_SIGN_IN_CODE_KEY, CLAUDE_ACCOUNT_SIGN_IN_REQUEST_KEY, CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY, isClaudeAuthUrl, readClaudeAccountInfo, type ClaudeSignInMethod, type IClaudeAccountInfo } from '../../../../platform/agentHost/common/claudeAccount.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

export const IClaudeAccountService = createDecorator<IClaudeAccountService>('claudeAccountService');

/**
 * In-app sign-in for the Claude agent (ORVO). The agent host runs the SDK's own `claude auth login`; this service
 * asks which account to use, relays the code the browser shows, and reports the result.
 */
export interface IClaudeAccountService {
	readonly _serviceBrand: undefined;
	/** The agent whose account this service manages. */
	readonly agent: string;
	signIn(): Promise<void>;
	signOut(): Promise<void>;
}

/** How long the host may take to download the SDK (first use) and print the sign-in URL. */
const START_TIMEOUT_MS = 5 * 60_000;
/** How long the host may take to verify a pasted code. */
const VERIFY_TIMEOUT_MS = 2 * 60_000;

interface IMethodPick extends IQuickPickItem {
	readonly method: ClaudeSignInMethod;
}

class ClaudeAccountService extends Disposable implements IClaudeAccountService {
	declare readonly _serviceBrand: undefined;

	readonly agent = CLAUDE_AGENT_PROVIDER_ID;

	private _account: IClaudeAccountInfo = { status: 'idle' };
	private readonly _waiters = new Set<(account: IClaudeAccountInfo) => void>();

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		// The root state belongs to a connection the host replaces on every restart, so re-bind each time.
		const rootStateListeners = this._register(new DisposableStore());
		const bindRootState = () => {
			rootStateListeners.clear();
			rootStateListeners.add(this._agentHostService.rootState.onDidChange(state => this._update(readClaudeAccountInfo(state))));
			const state = this._agentHostService.rootState.value;
			this._update(readClaudeAccountInfo(state instanceof Error ? undefined : state));
		};
		bindRootState();
		this._register(this._agentHostService.onAgentHostStart(bindRootState));
	}

	async signIn(): Promise<void> {
		const pick = await this._quickInputService.pick<IMethodPick>([
			{ method: 'claudeai', label: localize('claude.signIn.subscription', "Claude account"), description: localize('claude.signIn.subscriptionDescription', "Pro, Max, Team or Enterprise subscription") },
			{ method: 'console', label: localize('claude.signIn.console', "Anthropic Console account"), description: localize('claude.signIn.consoleDescription', "Anthropic API, billed per use") },
		], { placeHolder: localize('claude.signIn.placeholder', "Sign in to Claude with") });
		if (!pick) {
			return;
		}

		const nonce = generateUuid();
		this._dispatch(CLAUDE_ACCOUNT_SIGN_IN_REQUEST_KEY, { nonce, method: pick.method });
		const started = await this._waitFor(nonce, account => account.status === 'awaitingCode' || account.status === 'error', START_TIMEOUT_MS);
		if (!started || started.status === 'error' || !started.authUrl) {
			this._showError(started?.error);
			return;
		}

		const code = await this._askForCode(started.authUrl);
		if (!code) {
			// Cancelling still leaves the login process waiting; a new sign-in or the timeout ends it.
			return;
		}
		this._dispatch(CLAUDE_ACCOUNT_SIGN_IN_CODE_KEY, { nonce, code });
		const result = await this._waitFor(nonce, account => account.status === 'signedIn' || account.status === 'error', VERIFY_TIMEOUT_MS);
		if (result?.status === 'signedIn') {
			this._notificationService.info(localize('claude.signIn.done', "Signed in to Claude. Pick a model from the Anthropic group in the Claude agent's model picker."));
		} else {
			this._showError(result?.error);
		}
	}

	async signOut(): Promise<void> {
		const nonce = generateUuid();
		this._dispatch(CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY, nonce);
		const result = await this._waitFor(nonce, account => account.status === 'signedOut' || account.status === 'error', VERIFY_TIMEOUT_MS);
		if (result?.status === 'signedOut') {
			this._notificationService.info(localize('claude.signOut.done', "Signed out of Claude."));
		} else {
			this._showError(result?.error);
		}
	}

	private _askForCode(authUrl: string): Promise<string | undefined> {
		const deferred = new DeferredPromise<string | undefined>();
		const store = new DisposableStore();
		const input = store.add(this._quickInputService.createInputBox());
		const openButton = { iconClass: ThemeIcon.asClassName(Codicon.linkExternal), tooltip: localize('claude.signIn.openPage', "Open the sign-in page") };
		input.title = localize('claude.signIn.title', "Sign in to Claude");
		input.prompt = localize('claude.signIn.prompt', "Sign in in your browser, then paste the code it shows. No browser opened? Use the button above.");
		input.placeholder = localize('claude.signIn.codePlaceholder', "Code from the browser");
		input.ignoreFocusOut = true;
		input.buttons = [openButton];
		const open = () => {
			if (isClaudeAuthUrl(authUrl)) {
				void this._openerService.open(authUrl, { openExternal: true });
			}
		};
		store.add(input.onDidTriggerButton(() => open()));
		store.add(input.onDidAccept(() => {
			const value = input.value.trim();
			if (value) {
				void deferred.complete(value);
				input.hide();
			}
		}));
		store.add(input.onDidHide(() => {
			if (!deferred.isSettled) {
				void deferred.complete(undefined);
			}
			store.dispose();
		}));
		input.show();
		return deferred.p;
	}

	private _dispatch(key: string, value: unknown): void {
		this._agentHostService.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: { [key]: value } });
	}

	private _update(account: IClaudeAccountInfo): void {
		this._account = account;
		for (const waiter of [...this._waiters]) {
			waiter(account);
		}
	}

	private _waitFor(nonce: string, done: (account: IClaudeAccountInfo) => boolean, timeoutMs: number): Promise<IClaudeAccountInfo | undefined> {
		const deferred = new DeferredPromise<IClaudeAccountInfo>();
		const waiter = (account: IClaudeAccountInfo) => {
			if (account.nonce === nonce && done(account)) {
				void deferred.complete(account);
			}
		};
		this._waiters.add(waiter);
		waiter(this._account);
		return raceTimeout(deferred.p, timeoutMs).finally(() => this._waiters.delete(waiter));
	}

	private _showError(error: string | undefined): void {
		this._notificationService.notify({
			severity: Severity.Error,
			message: error
				? localize('claude.signIn.failedWithReason', "Claude sign-in failed: {0}", error)
				: localize('claude.signIn.failed', "Claude sign-in did not finish. Try again from the Claude agent's setup banner or the Command Palette."),
		});
	}
}

registerSingleton(IClaudeAccountService, ClaudeAccountService, InstantiationType.Delayed);
