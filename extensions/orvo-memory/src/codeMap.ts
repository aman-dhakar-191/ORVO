/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { McpStdioEntry } from './agents';

/** The code map MCP server, bundled next to this file. */
export const CODE_MAP_SERVER = path.join(__dirname, 'depsServer.js');

/**
 * How agents start the code map server for `folder`: ORVO's own executable run as Node, so nothing else needs to be
 * installed. `undefined` for remote folders or when the code map is turned off.
 */
export function codeMapEntry(folder: vscode.WorkspaceFolder | undefined): McpStdioEntry | undefined {
	if (!folder || folder.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('orvoMemory').get<boolean>('codeMap.enabled', true)) {
		return undefined;
	}
	return { type: 'stdio', command: process.execPath, args: [CODE_MAP_SERVER, folder.uri.fsPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
