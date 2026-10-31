/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { rebrandMessage, rebrandPackageNls } from '../rebrand.ts';

const names = { nameShort: 'ORVO', nameLong: 'ORVO Editor' };

suite('rebrand', () => {

	test('replaces the product names', () => {
		assert.deepStrictEqual([
			rebrandMessage('Welcome to VS Code', names),
			rebrandMessage("Restart VS Code's extension host", names),
			rebrandMessage('Thanks for using Visual Studio Code!', names),
			rebrandMessage('VS Code and VS Code again', names),
		], [
			'Welcome to ORVO',
			"Restart ORVO's extension host",
			'Thanks for using ORVO Editor!',
			'ORVO and ORVO again',
		]);
	});

	test('leaves identifiers, URLs, placeholders and other words alone', () => {
		for (const message of [
			'Install the vscode module',
			'See https://code.visualstudio.com/docs for {0}',
			'Open in Code',
			'VSCode settings',
			'Use the vscode.dev link',
		]) {
			assert.strictEqual(rebrandMessage(message, names), message);
		}
	});

	test('does nothing without product names', () => {
		assert.strictEqual(rebrandMessage('Welcome to VS Code', null), 'Welcome to VS Code');
	});

	test('rewrites package.nls.json values but not comments', () => {
		assert.deepStrictEqual(rebrandPackageNls({
			'command.title': 'Reload VS Code',
			'setting.description': { message: 'Controls how VS Code opens files', comment: ['Keep "VS Code" as is'] },
		}, names), {
			'command.title': 'Reload ORVO',
			'setting.description': { message: 'Controls how ORVO opens files', comment: ['Keep "VS Code" as is'] },
		});
	});
});
