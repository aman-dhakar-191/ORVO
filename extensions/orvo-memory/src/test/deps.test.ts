/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: npm run compile in this extension, then `node --test out/test/deps.test.js` (Node's built-in runner).

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { hasMcpServer, McpStdioEntry, upsertMcpServer } from '../agents';
import { buildDepsGraph, dependentsOf, findCycles, findFile, shortestPath } from '../deps';

describe('ORVO Code Map', () => {

	test('builds the import graph of a small project', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orvo-deps-'));
		const write = async (file: string, text: string) => {
			await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await fs.writeFile(path.join(root, file), text);
		};
		await write('tsconfig.json', '{\n\t// comment\n\t"compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },\n}');
		await write('src/index.ts', [
			'import { a } from "./lib/a.js";',
			'import type { T } from "@/lib/types";',
			'export * from "./lib/b";',
			'import "./styles.css";',
			'const r = require("react");',
			'// import "./commented";',
			'import("./lazy");',
			'import fs from "node:fs";',
			'import x from "@scope/pkg/deep";',
		].join('\n'));
		await write('src/lib/a.ts', 'import { b } from "./b";');
		await write('src/lib/b.ts', 'import { a } from "./a";\nimport "./missing";');
		await write('src/lib/types.ts', 'export type T = 1;');
		await write('src/lazy/index.js', 'export default 1;');
		await write('node_modules/x/index.js', '');
		await write('dist/out.js', '');
		await write('packages/core/package.json', '{"name": "@acme/core", "main": "dist/index.js"}');
		await write('packages/core/src/index.ts', 'export const core = 1;');
		await write('packages/core/src/util.ts', 'export const util = 1;');
		await write('packages/app/main.ts', 'import { core } from "@acme/core";\nimport { util } from "@acme/core/util";\nimport lodash from "lodash";');
		try {
			const graph = await buildDepsGraph(root);
			assert.deepStrictEqual(graph.files, ['packages/app/main.ts', 'packages/core/src/index.ts', 'packages/core/src/util.ts', 'src/index.ts', 'src/lazy/index.js', 'src/lib/a.ts', 'src/lib/b.ts', 'src/lib/types.ts']);
			// Workspace packages resolve to their files (main's dist/ mapped back to src/); others stay packages.
			assert.deepStrictEqual(graph.imports['packages/app/main.ts'], ['packages/core/src/index.ts', 'packages/core/src/util.ts']);
			assert.deepStrictEqual(graph.packages['packages/app/main.ts'], ['lodash']);
			assert.deepStrictEqual(graph.imports['src/index.ts'], ['src/lazy/index.js', 'src/lib/a.ts', 'src/lib/b.ts', 'src/lib/types.ts']);
			assert.deepStrictEqual(graph.packages['src/index.ts'], ['@scope/pkg', 'fs', 'react']);
			assert.deepStrictEqual(graph.unresolved, { 'src/lib/b.ts': ['./missing'] });
			assert.deepStrictEqual(findCycles(graph), [['src/lib/a.ts', 'src/lib/b.ts']]);
			assert.deepStrictEqual(dependentsOf(graph, 'src/lib/a.ts').map(item => item.file), ['src/index.ts', 'src/lib/b.ts']);
			assert.deepStrictEqual(shortestPath(graph, 'src/index.ts', 'src/lib/a.ts'), ['src/index.ts', 'src/lib/a.ts']);
			assert.strictEqual(findFile(graph, 'b.ts'), 'src/lib/b.ts');
			assert.strictEqual(findFile(graph, path.join(root, 'src/lib/types.ts')), 'src/lib/types.ts');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('adds the server to .mcp.json, keeping other servers and refusing files with comments', () => {
		const entry: McpStdioEntry = { type: 'stdio', command: '/orvo', args: ['server.js', '/project'], env: { ELECTRON_RUN_AS_NODE: '1' } };
		const updated = upsertMcpServer('{"mcpServers":{"other":{"command":"x"}}}', 'orvo-codemap', entry)!;
		assert.ok(hasMcpServer(updated, 'orvo-codemap', entry));
		assert.ok(JSON.parse(updated).mcpServers.other);
		assert.ok(!hasMcpServer(updated, 'orvo-codemap', { ...entry, command: '/elsewhere' }));
		assert.strictEqual(upsertMcpServer('// comment\n{}', 'orvo-codemap', entry), undefined);
	});
});
