/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * The URL of the static update feed file for a platform and quality, see `IProductConfiguration.staticUpdateFeed`.
 */
export function createStaticUpdateURL(baseUpdateUrl: string, platform: string, quality: string): string {
	return new URL(`${baseUpdateUrl.replace(/\/+$/, '')}/${platform}-${quality}.json`).toString();
}

function parseProductVersion(version: string | undefined): [number, number, number] | undefined {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * A static update feed always describes the latest build, so unlike the update server it cannot answer
 * "no update" (204). An update from it applies only when it is a different build (commit) with a newer
 * product version, which also prevents downgrades when a feed is rolled back.
 */
export function isNewerStaticFeedUpdate(update: IUpdate | null | undefined, commit: string | undefined, productVersion: string): update is IUpdate {
	if (!update?.version || update.version === commit) {
		return false;
	}

	const candidate = parseProductVersion(update.productVersion);
	const current = parseProductVersion(productVersion);
	if (!candidate || !current) {
		return false;
	}

	for (let i = 0; i < 3; i++) {
		if (candidate[i] !== current[i]) {
			return candidate[i] > current[i];
		}
	}

	return false;
}
