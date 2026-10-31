/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { extractClaudeAuthUrl, type ClaudeSignInMethod, type IClaudeAccountInfo } from '../../common/claudeAccount.js';

/** How long a sign-in may wait for the user (browser + pasted code) before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * The native `claude` executable inside the SDK: `<root>/node_modules/@anthropic-ai/claude-agent-sdk-<target>/claude[.exe]`,
 * the same binary the SDK runs for sessions, so credentials it stores are the ones sessions find.
 */
export async function findClaudeExecutable(sdkRoot: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	const scopeDir = join(sdkRoot, 'node_modules', '@anthropic-ai');
	const binary = platform === 'win32' ? 'claude.exe' : 'claude';
	let entries: string[];
	try {
		entries = await fs.readdir(scopeDir);
	} catch {
		return undefined;
	}
	for (const entry of entries.sort()) {
		if (!entry.startsWith('claude-agent-sdk-')) {
			continue;
		}
		const candidate = join(scopeDir, entry, binary);
		try {
			if ((await fs.stat(candidate)).isFile()) {
				return candidate;
			}
		} catch {
			// not this platform's package
		}
	}
	return undefined;
}

/** Last few lines of process output, for an error the user can act on; what follows the code prompt when there is one. */
export function summarizeClaudeOutput(output: string): string {
	const afterPrompt = output.split(/Paste code here if prompted >/).pop() ?? output;
	const lines = afterPrompt.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	return lines.slice(-3).join(' ').slice(0, 500);
}

export function claudeAccountArgs(kind: 'signIn' | 'signOut', method: ClaudeSignInMethod = 'claudeai'): string[] {
	return kind === 'signOut' ? ['auth', 'logout'] : ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];
}

/**
 * One run of `claude auth login` (or `logout`): reports the sign-in URL once printed, takes the code the browser
 * shows on stdin, and settles with the exit status. The CLI opens the browser itself; the workbench offers the URL
 * again in case it could not.
 */
export class ClaudeSignInProcess extends Disposable {

	private readonly _onDidReport = this._register(new Emitter<IClaudeAccountInfo>());
	/** Progress for the workbench: `awaitingCode` (with the URL), `verifying`, then `signedIn`/`signedOut` or `error`. */
	readonly onDidReport: Event<IClaudeAccountInfo> = this._onDidReport.event;

	private readonly _onDidExit = this._register(new Emitter<boolean>());
	/** Fires once, with whether the command succeeded. */
	readonly onDidExit: Event<boolean> = this._onDidExit.event;

	private _child: ChildProcess | undefined;
	private _output = '';
	private _settled = false;

	constructor(
		private readonly _nonce: string,
		private readonly _successStatus: 'signedIn' | 'signedOut',
	) {
		super();
	}

	/** Starts the process; call after subscribing to the events. */
	start(executable: string, args: readonly string[]): void {
		const child = this._child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
		const timeout = setTimeout(() => this._finish(false, 'Sign-in timed out.'), SIGN_IN_TIMEOUT_MS);
		this._register({ dispose: () => clearTimeout(timeout) });
		const onData = (chunk: Buffer) => {
			const hadUrl = !!extractClaudeAuthUrl(this._output);
			this._output += chunk.toString('utf8');
			const authUrl = extractClaudeAuthUrl(this._output);
			if (authUrl && !hadUrl) {
				this._onDidReport.fire({ status: 'awaitingCode', nonce: this._nonce, authUrl });
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', error => this._finish(false, error.message));
		child.on('exit', code => this._finish(code === 0, code === 0 ? undefined : (summarizeClaudeOutput(this._output) || `claude exited with code ${code}`)));
	}

	submitCode(code: string): void {
		if (this._settled || !this._child?.stdin?.writable) {
			return;
		}
		this._onDidReport.fire({ status: 'verifying', nonce: this._nonce });
		this._child.stdin.write(`${code}\n`);
	}

	private _finish(succeeded: boolean, error?: string): void {
		if (this._settled) {
			return;
		}
		this._settled = true;
		if (this._child && this._child.exitCode === null && !this._child.killed) {
			this._child.kill();
		}
		this._onDidReport.fire(succeeded ? { status: this._successStatus, nonce: this._nonce } : { status: 'error', nonce: this._nonce, error });
		this._onDidExit.fire(succeeded);
		this.dispose();
	}

	override dispose(): void {
		if (!this._settled) {
			this._settled = true;
			this._child?.kill();
		}
		super.dispose();
	}
}
