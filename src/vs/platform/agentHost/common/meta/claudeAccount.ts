/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type { ClaudeAccountStatus, ClaudeSignInMethod, IClaudeAccountInfo, IClaudeSignInCode, IClaudeSignInRequest } from './vscode/claudeAccount.js';
export { CLAUDE_ACCOUNT_META_KEY, CLAUDE_ACCOUNT_NATIVE_KEY, readClaudeNativeSignedIn, CLAUDE_ACCOUNT_SIGN_IN_CODE_KEY, CLAUDE_ACCOUNT_SIGN_IN_REQUEST_KEY, CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY, extractClaudeAuthUrl, isClaudeAuthUrl, readClaudeAccountInfo, readClaudeSignInCode, readClaudeSignInRequest } from './vscode/claudeAccount.js';
