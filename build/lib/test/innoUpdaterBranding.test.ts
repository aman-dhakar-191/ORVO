/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';
import { brandInnoUpdater } from '../innoUpdaterBranding.ts';

const exe = path.join(import.meta.dirname, '..', '..', 'win32', 'inno_updater.exe');

suite('brandInnoUpdater', () => {

	test('rewrites every copy of the upstream name in the shipped inno_updater.exe without changing its size', () => {
		const original = fs.readFileSync(exe);
		const { buffer, replacements } = brandInnoUpdater(original, 'ORVO');
		const text = (encoding: 'latin1' | 'utf16le', offset = 0) => buffer.subarray(offset).toString(encoding);
		assert.deepStrictEqual({
			size: buffer.length,
			upstreamUtf8: text('latin1').includes('Visual Studio Code'),
			upstreamUtf16: text('utf16le').includes('Visual Studio Code') || text('utf16le', 1).includes('Visual Studio Code'),
			failureMessage: text('latin1').includes('Failed to install ORVO update.              '),
			progressLabel: text('utf16le').includes('Updating ORVO...') || text('utf16le', 1).includes('Updating ORVO...'),
			atLeastAllKnownStrings: replacements >= 8,
		}, {
			size: original.length,
			upstreamUtf8: false,
			upstreamUtf16: false,
			failureMessage: true,
			progressLabel: true,
			atLeastAllKnownStrings: true,
		});
	});

	test('keeps each string the same length and only touches matching bytes', () => {
		const sample = Buffer.concat([
			Buffer.from([1, 2]), Buffer.from('Updating Visual Studio Code...\0', 'utf16le'), Buffer.from([3]),
			Buffer.from('Visual Studio Code\0tail', 'utf8'),
		]);
		const { buffer } = brandInnoUpdater(sample, 'ORVO');
		assert.deepStrictEqual(buffer, Buffer.concat([
			Buffer.from([1, 2]), Buffer.from('Updating ORVO...              \0', 'utf16le'), Buffer.from([3]),
			Buffer.from('ORVO              \0tail', 'utf8'),
		]));
	});

	test('refuses a product name that does not fit', () => {
		assert.throws(() => brandInnoUpdater(Buffer.alloc(0), 'A Product Name Longer Than Upstream'));
	});
});
