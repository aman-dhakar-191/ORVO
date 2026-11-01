/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter, Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IClaudeAccountInfo } from '../../common/claudeAccount.js';
import { claudeAccountArgs, ClaudeSetupTokenProcess, ClaudeSignInProcess, CLAUDE_OAUTH_TOKEN_ENV, extractClaudeOauthToken, findClaudeExecutable, persistClaudeOauthToken, stripTerminalEscapes, summarizeClaudeOutput, type IClaudePty } from '../../node/claude/claudeSignIn.js';

/** Behaves like `claude auth login`: prints the sign-in URL, reads one line, succeeds only for the right code. */
const FAKE_CLI = `
process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\\nPaste code here if prompted > ");
process.stdin.once('data', chunk => {
	const ok = chunk.toString().trim() === 'good-code';
	process.stderr.write(ok ? '' : 'OAuth error: Invalid code\\n');
	process.exit(ok ? 0 : 1);
});
`;

suite('claudeSignIn', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'orvo-claude-signin-')); });
	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	async function run(code: string): Promise<{ reports: IClaudeAccountInfo[]; succeeded: boolean }> {
		const script = join(dir, 'fake-claude.js');
		await fs.writeFile(script, FAKE_CLI);
		const signIn = new ClaudeSignInProcess('n1', 'signedIn');
		const reports: IClaudeAccountInfo[] = [];
		const listener = signIn.onDidReport(info => {
			reports.push(info);
			if (info.status === 'awaitingCode') {
				signIn.submitCode(code);
			}
		});
		const exited = Event.toPromise(signIn.onDidExit);
		signIn.start(process.execPath, [script]);
		const succeeded = await exited;
		listener.dispose();
		return { reports, succeeded };
	}

	test('relays the URL, sends the code, and succeeds', async () => {
		assert.deepStrictEqual(await run('good-code'), {
			succeeded: true,
			reports: [
				{ status: 'awaitingCode', nonce: 'n1', authUrl: 'https://claude.com/cai/oauth/authorize?code=true&state=s' },
				{ status: 'verifying', nonce: 'n1' },
				{ status: 'signedIn', nonce: 'n1' },
			],
		});
	});

	test('reports the CLI error for a wrong code', async () => {
		const { succeeded, reports } = await run('bad-code');
		assert.deepStrictEqual({ succeeded, last: reports.at(-1) }, {
			succeeded: false,
			last: { status: 'error', nonce: 'n1', error: 'OAuth error: Invalid code' },
		});
	});

	test('finds the platform executable inside the SDK', async () => {
		const pkg = join(dir, 'node_modules', '@anthropic-ai');
		await fs.mkdir(join(pkg, 'claude-agent-sdk'), { recursive: true });
		await fs.mkdir(join(pkg, 'claude-agent-sdk-win32-x64'), { recursive: true });
		await fs.writeFile(join(pkg, 'claude-agent-sdk-win32-x64', 'claude.exe'), '');
		assert.deepStrictEqual([
			await findClaudeExecutable(dir, 'win32'),
			await findClaudeExecutable(dir, 'linux'),
			await findClaudeExecutable(join(dir, 'missing'), 'win32'),
		], [join(pkg, 'claude-agent-sdk-win32-x64', 'claude.exe'), undefined, undefined]);
	});

	test('builds the CLI arguments and summarizes output', () => {
		assert.deepStrictEqual([
			claudeAccountArgs('signIn', 'claudeai'),
			claudeAccountArgs('signIn', 'console'),
			claudeAccountArgs('signOut'),
			summarizeClaudeOutput('\x1b[31mone\x1b[0m\n\ntwo\nthree\nfour\n'),
		], [
			['auth', 'login', '--claudeai'],
			['auth', 'login', '--console'],
			['auth', 'logout'],
			'two three four',
		]);
	});

	suite('setup-token', () => {

		const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(40) + '_b-C';
		/** How claude setup-token (2.1.304) draws in a terminal: escapes, an OSC hyperlink, spinner glyphs. */
		const SCREEN = '\x1b[?25l\x1b[1mWelcome to Claude Code\x1b[22m\r\n\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=s\x07Browser didn\'t open? Use the url below\x1b]8;;\x07\r\nhttps://claude.com/cai/oauth/authorize?code=true&state=s\r\n\x1b[2K✻ Paste code here if prompted >';

		class FakePty implements IClaudePty {
			readonly data = new Emitter<string>();
			readonly exit = new Emitter<{ exitCode: number }>();
			readonly onData = this.data.event;
			readonly onExit = this.exit.event;
			readonly written: string[] = [];
			killed = false;
			write(value: string) { this.written.push(value); }
			kill() { this.killed = true; }
			dispose() { this.data.dispose(); this.exit.dispose(); }
		}

		test('strips terminal escapes and finds the token', () => {
			assert.deepStrictEqual([
				stripTerminalEscapes('\x1b[32mok\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07'),
				extractClaudeOauthToken(`\x1b[1mYour OAuth token:\x1b[0m\r\n\x1b[36m${TOKEN}\x1b[39m\r\n`),
				extractClaudeOauthToken('sk-ant-api03-notASubscriptionToken1234567890'),
				extractClaudeOauthToken(`${TOKEN.slice(0, 30)}\x1b[2K\r${TOKEN}\r\n`),
			], ['ok link', TOKEN, undefined, TOKEN]);
		});

		test('reports the URL, relays a code, and settles with the printed token', async () => {
			const pty = new FakePty();
			const run = new ClaudeSetupTokenProcess(pty, 'n2');
			const reports: string[] = [];
			const listener = run.onDidReport(info => reports.push(`${info.status}:${info.authUrl ?? ''}`));
			const exited = Event.toPromise(run.onDidExit);
			pty.data.fire(SCREEN);
			run.submitCode('ab#c');
			await new Promise(resolve => setTimeout(resolve, 350));
			// The token can arrive split across writes: settling on the first part saved a token the API rejects.
			pty.data.fire(`\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\nYour OAuth token (valid for 1 year):\r\n${TOKEN.slice(0, 30)}`);
			pty.data.fire(`${TOKEN.slice(30)}\r\n`);
			const token = await exited;
			listener.dispose();
			pty.dispose();
			assert.deepStrictEqual({ token, reports, written: pty.written, killed: pty.killed }, {
				token: TOKEN,
				reports: ['awaitingCode:https://claude.com/cai/oauth/authorize?code=true&state=s', 'verifying:'],
				written: ['a', 'b', '#', 'c', '\r'],
				killed: true,
			});
		});

		test('fails with the CLI message when it exits without a token', async () => {
			const pty = new FakePty();
			const run = new ClaudeSetupTokenProcess(pty, 'n3');
			const exited = Event.toPromise(run.onDidExit);
			// What the real CLI prints for a wrong code; it then waits instead of exiting.
			pty.data.fire(SCREEN + '\r\n\rOAuth error: Invalid code. Please make sure the full code was copied\r\rPress Enter to retry. \r');
			const token = await exited;
			const error = run.error;
			pty.dispose();
			assert.deepStrictEqual({ token, error, killed: pty.killed }, { token: undefined, error: 'OAuth error: Invalid code. Please make sure the full code was copied', killed: true });
		});

		test('puts the token in the agent host environment (no user-wide write off Windows)', async () => {
			const previous = process.env[CLAUDE_OAUTH_TOKEN_ENV];
			try {
				await persistClaudeOauthToken(TOKEN, 'linux');
				const set = process.env[CLAUDE_OAUTH_TOKEN_ENV];
				await persistClaudeOauthToken(undefined, 'linux');
				assert.deepStrictEqual([set, process.env[CLAUDE_OAUTH_TOKEN_ENV]], [TOKEN, undefined]);
			} finally {
				if (previous === undefined) {
					delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
				} else {
					process.env[CLAUDE_OAUTH_TOKEN_ENV] = previous;
				}
			}
		});
	});
});
