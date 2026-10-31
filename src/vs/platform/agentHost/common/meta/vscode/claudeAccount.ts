/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RootState } from '../../state/protocol/state.js';

/**
 * In-app Claude sign-in. The Claude Agent SDK has no login control request, so the agent host runs the SDK's own
 * `claude auth login` and the workbench relays the code the browser shows. Requests go workbench to host through
 * root config keys (the host clears them once read); progress comes back as a transient root value.
 */
export const CLAUDE_ACCOUNT_META_KEY = 'vscode.claudeAccount';
export const CLAUDE_ACCOUNT_SIGN_IN_REQUEST_KEY = 'vscode.claudeAccount.signInRequest';
export const CLAUDE_ACCOUNT_SIGN_IN_CODE_KEY = 'vscode.claudeAccount.signInCode';
export const CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY = 'vscode.claudeAccount.signOutRequest';
/** Whether the SDK found the user's own Claude credentials (`{ signedIn: boolean }`), published after each model refresh. */
export const CLAUDE_ACCOUNT_NATIVE_KEY = 'vscode.claudeAccount.native';

/** `claudeai`: Claude Pro/Max subscription. `console`: Anthropic Console account (API usage billing). */
export type ClaudeSignInMethod = 'claudeai' | 'console';

export interface IClaudeSignInRequest {
	readonly nonce: string;
	readonly method: ClaudeSignInMethod;
}

export interface IClaudeSignInCode {
	readonly nonce: string;
	readonly code: string;
}

export type ClaudeAccountStatus = 'idle' | 'starting' | 'awaitingCode' | 'verifying' | 'signedIn' | 'signedOut' | 'error';

export interface IClaudeAccountInfo {
	readonly status: ClaudeAccountStatus;
	/** The sign-in request this update answers. */
	readonly nonce?: string;
	/** The sign-in page, once `claude auth login` has printed it. */
	readonly authUrl?: string;
	readonly error?: string;
}

const STATUSES: readonly ClaudeAccountStatus[] = ['idle', 'starting', 'awaitingCode', 'verifying', 'signedIn', 'signedOut', 'error'];

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

export function readClaudeSignInRequest(value: unknown): IClaudeSignInRequest | undefined {
	if (!isObject(value) || typeof value.nonce !== 'string' || !value.nonce || (value.method !== 'claudeai' && value.method !== 'console')) {
		return undefined;
	}
	return { nonce: value.nonce, method: value.method };
}

export function readClaudeSignInCode(value: unknown): IClaudeSignInCode | undefined {
	if (!isObject(value) || typeof value.nonce !== 'string' || !value.nonce || typeof value.code !== 'string') {
		return undefined;
	}
	// One line only: the code is written to the login process's stdin, so a newline would answer more than one prompt.
	const code = value.code.trim();
	if (!code || /[\r\n]/.test(code) || code.length > 4096) {
		return undefined;
	}
	return { nonce: value.nonce, code };
}

export function readClaudeAccountInfo(state: RootState | undefined): IClaudeAccountInfo {
	const value = state?.config?.values[CLAUDE_ACCOUNT_META_KEY] ?? state?._meta?.[CLAUDE_ACCOUNT_META_KEY];
	if (!isObject(value) || !STATUSES.includes(value.status as ClaudeAccountStatus)) {
		return { status: 'idle' };
	}
	return {
		status: value.status as ClaudeAccountStatus,
		nonce: typeof value.nonce === 'string' ? value.nonce : undefined,
		authUrl: typeof value.authUrl === 'string' && isClaudeAuthUrl(value.authUrl) ? value.authUrl : undefined,
		error: typeof value.error === 'string' ? value.error : undefined,
	};
}

/** Only Anthropic's own sign-in pages are ever opened from what the login process prints. */
export function isClaudeAuthUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const anthropicHost = ['claude.com', 'claude.ai', 'anthropic.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
		return url.protocol === 'https:' && anthropicHost && /\/oauth\/authorize$/.test(url.pathname);
	} catch {
		return false;
	}
}

/** The sign-in URL in `claude auth login` output ("If the browser didn't open, visit: https://...").  */
export function extractClaudeAuthUrl(output: string): string | undefined {
	for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
		if (isClaudeAuthUrl(match[0])) {
			return match[0];
		}
	}
	return undefined;
}

/** Whether the agent host reported the user's own Claude credentials; `undefined` until it has asked the SDK. */
export function readClaudeNativeSignedIn(state: RootState | undefined): boolean | undefined {
	const value = state?.config?.values[CLAUDE_ACCOUNT_NATIVE_KEY] ?? state?._meta?.[CLAUDE_ACCOUNT_NATIVE_KEY];
	return isObject(value) && typeof value.signedIn === 'boolean' ? value.signedIn : undefined;
}
