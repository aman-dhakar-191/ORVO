/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The product name compiled into Microsoft's prebuilt inno_updater.exe. */
const UPSTREAM_NAME = 'Visual Studio Code';

/**
 * Whole messages in inno_updater 0.23 that contain {@link UPSTREAM_NAME}. Rewriting a whole message keeps its text
 * readable ("Failed to install ORVO update." rather than "Failed to install ORVO               update.").
 * Anything not listed here still gets the name swapped, with the padding right after it.
 */
const KNOWN_MESSAGES = [
	'Failed to install Visual Studio Code update.',
	'Please verify there are no Visual Studio Code processes still executing.',
	'Visual Studio Code - Updater',
	'Visual Studio Code is updating...',
	'Updating Visual Studio Code...',
];

export interface IInnoUpdaterBrandingResult {
	readonly buffer: Buffer;
	/** How many strings were rewritten. */
	readonly replacements: number;
}

function replaceAll(buffer: Buffer, search: Buffer, replacement: Buffer): number {
	let count = 0;
	for (let index = buffer.indexOf(search); index !== -1; index = buffer.indexOf(search, index + replacement.length)) {
		replacement.copy(buffer, index);
		count++;
	}
	return count;
}

/**
 * Replaces the upstream product name in the strings of inno_updater.exe (window title, dialog text, error messages,
 * version info), in both its UTF-8 (Rust string) and UTF-16 (Win32 resource) copies.
 *
 * Every string keeps its exact byte length, padded with trailing spaces: Rust strings are stored with their length
 * and dialog templates are read field after field up to each null, so a shorter string would corrupt what follows.
 */
export function brandInnoUpdater(input: Buffer, productName: string): IInnoUpdaterBrandingResult {
	if (productName.length > UPSTREAM_NAME.length) {
		throw new Error(`Product name '${productName}' is longer than '${UPSTREAM_NAME}' and cannot replace it in inno_updater.exe`);
	}
	const buffer = Buffer.from(input);
	let replacements = 0;
	for (const encoding of ['utf8', 'utf16le'] as const) {
		for (const message of [...KNOWN_MESSAGES, UPSTREAM_NAME]) {
			const branded = message === UPSTREAM_NAME
				? productName.padEnd(UPSTREAM_NAME.length, ' ')
				: message.replace(UPSTREAM_NAME, productName).padEnd(message.length, ' ');
			replacements += replaceAll(buffer, Buffer.from(message, encoding), Buffer.from(branded, encoding));
		}
	}
	return { buffer, replacements };
}
