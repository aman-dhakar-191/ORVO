/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IClaudeAccountInfo } from '../../common/claudeAccount.js';
import { claudeAccountArgs, ClaudeSignInProcess, findClaudeExecutable, summarizeClaudeOutput } from '../../node/claude/claudeSignIn.js';

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
});
