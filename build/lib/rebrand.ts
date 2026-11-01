/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';

export interface IProductNames {
	readonly nameShort: string;
	readonly nameLong: string;
}

const product: Partial<IProductNames> = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'product.json'), 'utf8'));

/**
 * The product names to put in place of "VS Code" / "Visual Studio Code" in user-facing strings, or `null`
 * when product.json keeps the upstream names (nothing to replace).
 */
export const productNames: IProductNames | null = product.nameShort && product.nameLong && product.nameShort !== 'Code - OSS'
	? { nameShort: product.nameShort, nameLong: product.nameLong }
	: null;

/**
 * Replaces the upstream product name in a user-facing message. The sources keep "VS Code" so they merge cleanly
 * with upstream; the build swaps the name in the English messages it ships (core NLS and extension package.nls.json).
 * Lowercase identifiers such as `vscode` and URLs such as code.visualstudio.com are left alone.
 */
export function rebrandMessage(message: string, names: IProductNames | null = productNames): string {
	if (!names || !message.includes('Code')) {
		return message;
	}
	return message
		.replace(/\bVisual Studio Code\b/g, names.nameLong)
		.replace(/\bVS Code\b/g, names.nameShort);
}

/** Applies {@link rebrandMessage} to every string in a parsed package.nls.json (values can be strings or `{ message, comment }`). */
export function rebrandPackageNls(value: unknown, names: IProductNames | null = productNames): unknown {
	if (typeof value === 'string') {
		return rebrandMessage(value, names);
	}
	if (Array.isArray(value)) {
		return value.map(item => rebrandPackageNls(item, names));
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			result[key] = key === 'comment' ? item : rebrandPackageNls(item, names);
		}
		return result;
	}
	return value;
}
