/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ORVO Code Map: a stdio MCP server that answers questions about the project's import graph. Copilot, Claude and
// Codex all start it (Copilot through the extension's MCP provider, the agents through .mcp.json). Usage:
//   <ORVO executable> (with ELECTRON_RUN_AS_NODE=1) depsServer.js <project root>

import * as path from 'path';
import { buildDepsGraph, dependentsMap, dependentsOf, DepsGraph, findCycles, findFile, folderGraph, overview, shortestPath } from './deps';

const SERVER_NAME = 'orvo-codemap';
const SERVER_VERSION = '1.0.0';
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
/** Rescan at most this often; scans take well under a second for typical projects. */
const CACHE_MS = 15_000;

const root = path.resolve(process.argv[2] || process.cwd());

let cached: { graph: DepsGraph; at: number } | undefined;
let scanning: Promise<DepsGraph> | undefined;

async function graph(force = false): Promise<DepsGraph> {
	if (!force && cached && Date.now() - cached.at < CACHE_MS) {
		return cached.graph;
	}
	scanning ??= buildDepsGraph(root).then(result => {
		cached = { graph: result, at: Date.now() };
		return result;
	}).finally(() => scanning = undefined);
	return scanning;
}

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
	run(args: Record<string, unknown>): Promise<string>;
}

const fileArg = { type: 'string', description: 'A project file: a path relative to the project root, an absolute path, or just a file name.' };

function resolveFile(g: DepsGraph, value: unknown): string {
	const file = typeof value === 'string' ? findFile(g, value) : undefined;
	if (!file) {
		throw new Error(`No TypeScript/JavaScript file matches "${String(value)}". Use deps_find to look files up.`);
	}
	return file;
}

function list(items: readonly string[], empty = '(none)'): string {
	return items.length ? items.map(item => `- ${item}`).join('\n') : empty;
}

const tools: Tool[] = [
	{
		name: 'deps_overview',
		description: 'Map of this project\'s TypeScript/JavaScript imports: file and import counts, the most depended-on files (hubs), entry points (imported by nothing), top packages, cycles. Call it first to orient yourself in an unfamiliar codebase.',
		inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many hubs/entry points/packages to list (default 15).' } } },
		async run(args) {
			const g = await graph();
			const o = overview(g, typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 15);
			const folders = folderGraph(g, 1).folders.sort((a, b) => b.files - a.files).slice(0, 12);
			return [
				`Project: ${g.root}`,
				`${o.files} files, ${o.edges} imports between them, ${o.cycles} import cycles, ${o.unresolved} unresolved relative imports${o.truncated ? ' (scan stopped at the file limit)' : ''}.`,
				'',
				'Top-level folders (files):',
				list(folders.map(folder => `${folder.id} (${folder.files})`)),
				'',
				'Most depended-on files (dependents):',
				list(o.hubs.map(hub => `${hub.file} (${hub.dependents})`)),
				'',
				'Entry points (import others, imported by nothing):',
				list(o.entryPoints),
				'',
				'Most used packages (files):',
				list(o.packages.map(item => `${item.name} (${item.files})`)),
			].join('\n');
		},
	},
	{
		name: 'deps_imports',
		description: 'What a file imports: the project files and the packages it depends on.',
		inputSchema: { type: 'object', properties: { file: fileArg }, required: ['file'] },
		async run(args) {
			const g = await graph();
			const file = resolveFile(g, args.file);
			return [
				`${file} imports ${g.imports[file]?.length ?? 0} project files:`,
				list(g.imports[file] ?? []),
				'',
				'Packages:',
				list(g.packages[file] ?? []),
				...(g.unresolved[file]?.length ? ['', 'Unresolved:', list(g.unresolved[file])] : []),
			].join('\n');
		},
	},
	{
		name: 'deps_dependents',
		description: 'Who uses a file: the files that import it, directly or (with depth > 1) through other files. Use it to judge the impact of changing a file before you edit it.',
		inputSchema: { type: 'object', properties: { file: fileArg, depth: { type: 'number', description: 'How many import hops to follow (default 1 = direct importers, max 10).' } }, required: ['file'] },
		async run(args) {
			const g = await graph();
			const file = resolveFile(g, args.file);
			const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(10, Math.floor(args.depth))) : 1;
			const result = dependentsOf(g, file, depth);
			const shown = result.slice(0, 300);
			return [
				`${result.length} files depend on ${file}${depth > 1 ? ` within ${depth} hops` : ' directly'}:`,
				list(shown.map(item => depth > 1 ? `${item.file} (${item.distance})` : item.file)),
				...(result.length > shown.length ? [`… and ${result.length - shown.length} more`] : []),
			].join('\n');
		},
	},
	{
		name: 'deps_path',
		description: 'How one file reaches another through imports: the shortest chain where `from` imports … imports `to`.',
		inputSchema: { type: 'object', properties: { from: fileArg, to: fileArg }, required: ['from', 'to'] },
		async run(args) {
			const g = await graph();
			const from = resolveFile(g, args.from);
			const to = resolveFile(g, args.to);
			const chain = shortestPath(g, from, to);
			if (chain) {
				return `${chain.length - 1} hops:\n${chain.join('\n  -> ')}`;
			}
			const reverse = shortestPath(g, to, from);
			return reverse ? `${from} does not reach ${to}, but the reverse does (${reverse.length - 1} hops):\n${reverse.join('\n  -> ')}` : `No import chain between ${from} and ${to} in either direction.`;
		},
	},
	{
		name: 'deps_cycles',
		description: 'Groups of files that import each other in a loop (circular dependencies), largest first.',
		inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many cycles to list (default 10).' } } },
		async run(args) {
			const cycles = findCycles(await graph());
			const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 10;
			return cycles.length
				? `${cycles.length} import cycles:\n\n${cycles.slice(0, limit).map((cycle, i) => `${i + 1}. ${cycle.length} files\n${list(cycle.slice(0, 30))}${cycle.length > 30 ? '\n- …' : ''}`).join('\n\n')}`
				: 'No import cycles.';
		},
	},
	{
		name: 'deps_find',
		description: 'Find project files whose path contains the query, with how many files they import and how many import them.',
		inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Part of a path or file name.' } }, required: ['query'] },
		async run(args) {
			const g = await graph();
			const query = String(args.query ?? '').toLowerCase();
			const dependents = dependentsMap(g);
			const matches = g.files.filter(file => file.toLowerCase().includes(query)).slice(0, 50);
			return matches.length
				? list(matches.map(file => `${file} (imports ${g.imports[file]?.length ?? 0}, imported by ${dependents.get(file)?.length ?? 0})`))
				: `No files match "${args.query}".`;
		},
	},
	{
		name: 'deps_rescan',
		description: 'Rescan the project now (the map otherwise refreshes on its own every few seconds).',
		inputSchema: { type: 'object', properties: {} },
		async run() {
			const g = await graph(true);
			return `Rescanned ${g.files.length} files.`;
		},
	},
];

// #region JSON-RPC over stdio (newline-delimited, as MCP's stdio transport specifies)

interface Request {
	readonly jsonrpc: '2.0';
	readonly id?: string | number | null;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

function send(message: object): void {
	process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(request: Request): Promise<unknown> {
	switch (request.method) {
		case 'initialize':
			return {
				protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, title: 'ORVO Code Map', version: SERVER_VERSION },
				instructions: 'Import graph of this project (TypeScript/JavaScript). Use deps_overview to orient, deps_dependents before changing a shared file, deps_path to see how two files connect.',
			};
		case 'ping':
			return {};
		case 'tools/list':
			return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
		case 'tools/call': {
			const tool = tools.find(candidate => candidate.name === request.params?.name);
			if (!tool) {
				throw Object.assign(new Error(`Unknown tool: ${String(request.params?.name)}`), { code: -32602 });
			}
			try {
				const text = await tool.run((request.params?.arguments as Record<string, unknown>) ?? {});
				return { content: [{ type: 'text', text }] };
			} catch (error) {
				return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		}
		default:
			throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
	}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let newline: number;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) {
			continue;
		}
		let request: Request;
		try {
			request = JSON.parse(line);
		} catch {
			send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			continue;
		}
		if (request.id === undefined || request.id === null) {
			continue; // a notification (initialized, cancelled): nothing to answer
		}
		handle(request).then(
			result => send({ jsonrpc: '2.0', id: request.id, result }),
			(error: Error & { code?: number }) => send({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32603, message: error.message } }),
		);
	}
});
process.stdin.on('end', () => process.exit(0));

// Warm the cache so the first tool call is quick.
void graph().catch(() => undefined);

// #endregion
