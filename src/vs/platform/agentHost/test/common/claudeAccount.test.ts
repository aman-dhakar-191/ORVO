/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_ACCOUNT_META_KEY, extractClaudeAuthUrl, isClaudeAuthUrl, readClaudeAccountInfo, readClaudeSignInCode, readClaudeSignInRequest } from '../../common/claudeAccount.js';
import type { RootState } from '../../common/state/protocol/state.js';

/** What `claude auth login` (Claude Code 2.1.304) prints without a terminal. */
const CLI_OUTPUT = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc\nPaste code here if prompted > ';

suite('claudeAccount', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts the sign-in URL from CLI output', () => {
		assert.deepStrictEqual([
			extractClaudeAuthUrl(CLI_OUTPUT),
			extractClaudeAuthUrl('Opening browser to sign in…'),
			extractClaudeAuthUrl('visit: https://evil.example.com/oauth/authorize?x=1'),
		], [
			'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc',
			undefined,
			undefined,
		]);
	});

	test('only accepts Anthropic sign-in pages', () => {
		assert.deepStrictEqual([
			'https://claude.com/cai/oauth/authorize?a=1',
			'https://platform.claude.com/oauth/authorize?a=1',
			'https://claude.ai/oauth/authorize',
			'http://claude.com/cai/oauth/authorize',
			'https://claude.com.evil.io/oauth/authorize',
			'https://claude.com/settings',
			'not a url',
		].map(isClaudeAuthUrl), [true, true, true, false, false, false, false]);
	});

	test('validates requests from the workbench', () => {
		assert.deepStrictEqual([
			readClaudeSignInRequest({ nonce: 'n', method: 'claudeai' }),
			readClaudeSignInRequest({ nonce: 'n', method: 'console' }),
			readClaudeSignInRequest({ nonce: 'n', method: 'other' }),
			readClaudeSignInRequest({ nonce: '', method: 'claudeai' }),
			readClaudeSignInRequest('n'),
			readClaudeSignInCode({ nonce: 'n', code: '  abc#def  ' }),
			readClaudeSignInCode({ nonce: 'n', code: 'abc\nrm -rf' }),
			readClaudeSignInCode({ nonce: 'n', code: '   ' }),
		], [
			{ nonce: 'n', method: 'claudeai' },
			{ nonce: 'n', method: 'console' },
			undefined,
			undefined,
			undefined,
			{ nonce: 'n', code: 'abc#def' },
			undefined,
			undefined,
		]);
	});

	test('reads the published account state', () => {
		const state = (value: unknown) => ({ _meta: { [CLAUDE_ACCOUNT_META_KEY]: value } }) as unknown as RootState;
		assert.deepStrictEqual([
			readClaudeAccountInfo(undefined),
			readClaudeAccountInfo(state({ status: 'awaitingCode', nonce: 'n', authUrl: 'https://claude.com/cai/oauth/authorize?a=1' })),
			readClaudeAccountInfo(state({ status: 'awaitingCode', nonce: 'n', authUrl: 'https://evil.example.com/oauth/authorize' })),
			readClaudeAccountInfo(state({ status: 'bogus' })),
		], [
			{ status: 'idle' },
			{ status: 'awaitingCode', nonce: 'n', authUrl: 'https://claude.com/cai/oauth/authorize?a=1', error: undefined },
			{ status: 'awaitingCode', nonce: 'n', authUrl: undefined, error: undefined },
			{ status: 'idle' },
		]);
	});
});
