/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IUpdate } from '../../common/update.js';
import { createStaticUpdateURL, isNewerStaticFeedUpdate } from '../../common/staticUpdateFeed.js';

suite('Static update feed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const feed = (version: string, productVersion?: string): IUpdate => ({ version, productVersion, url: 'https://example.com/setup.exe' });

	test('builds the feed file URL from the platform and quality', () => {
		assert.deepStrictEqual([
			createStaticUpdateURL('https://github.com/o/r/releases/download/update-feed', 'win32-x64-user', 'stable'),
			createStaticUpdateURL('https://github.com/o/r/releases/download/update-feed/', 'win32-arm64-user', 'internal'),
		], [
			'https://github.com/o/r/releases/download/update-feed/win32-x64-user-stable.json',
			'https://github.com/o/r/releases/download/update-feed/win32-arm64-user-internal.json',
		]);
	});

	test('accepts a different build with a newer product version', () => {
		assert.deepStrictEqual([
			isNewerStaticFeedUpdate(feed('b', '1.145.12'), 'a', '1.145.11'),
			isNewerStaticFeedUpdate(feed('b', '1.146.1'), 'a', '1.145.99'),
			isNewerStaticFeedUpdate(feed('b', '2.0.0'), 'a', '1.145.11'),
			isNewerStaticFeedUpdate(feed('b', '1.145.12-internal'), 'a', '1.145.9-internal'),
		], [true, true, true, true]);
	});

	test('rejects the same build, older or equal versions, and incomplete feeds', () => {
		assert.deepStrictEqual([
			isNewerStaticFeedUpdate(feed('a', '1.145.12'), 'a', '1.145.11'),
			isNewerStaticFeedUpdate(feed('b', '1.145.11'), 'a', '1.145.11'),
			isNewerStaticFeedUpdate(feed('b', '1.145.10'), 'a', '1.145.11'),
			isNewerStaticFeedUpdate(feed('b', '1.144.50'), 'a', '1.145.1'),
			isNewerStaticFeedUpdate(feed('b'), 'a', '1.145.1'),
			isNewerStaticFeedUpdate(feed('b', 'not-a-version'), 'a', '1.145.1'),
			isNewerStaticFeedUpdate(feed(''), 'a', '1.145.1'),
			isNewerStaticFeedUpdate(null, 'a', '1.145.1'),
		], [false, false, false, false, false, false, false, false]);
	});
});
