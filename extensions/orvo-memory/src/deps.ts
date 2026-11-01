/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The project's import graph for TypeScript and JavaScript. Shared by the MCP server (agents) and the memory editor;
// it only needs Node, not the VS Code API.

import { promises as fs } from 'fs';
import * as path from 'path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json', '.d.ts'];
/** A `.js` import in TypeScript usually means the `.ts` file next to it. */
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'bower_components', 'vendor', 'target', '__pycache__']);
const MAX_FILES = 20000;
const ASSET_PATTERN = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|html?|md|txt|woff2?|ttf|wasm)(\?.*)?$/i;
const MAX_FILE_BYTES = 1024 * 1024;

export interface DepsGraph {
	/** Absolute path of the folder that was scanned. */
	readonly root: string;
	/** Source files, relative to the root with `/` separators. */
	readonly files: readonly string[];
	/** File -> project files it imports. */
	readonly imports: Readonly<Record<string, readonly string[]>>;
	/** File -> packages it imports (`react`, `@scope/pkg`, `node:fs` as `fs`). */
	readonly packages: Readonly<Record<string, readonly string[]>>;
	/** File -> relative imports that did not resolve to a file. */
	readonly unresolved: Readonly<Record<string, readonly string[]>>;
	/** Whether the scan stopped at the file limit. */
	readonly truncated: boolean;
	readonly scannedAt: string;
}

// #region Parsing

/** Removes comments, keeping strings intact enough for import specifiers to survive. */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The module specifiers a JS/TS file imports: static and dynamic `import`, `export ... from`, `require`. */
export function extractSpecifiers(text: string): string[] {
	const source = stripComments(text);
	const found = new Set<string>();
	const patterns = [
		/\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
		/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
		/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			found.add(match[1]);
		}
	}
	return [...found];
}

/** `@scope/pkg/sub` -> `@scope/pkg`, `lodash/fp` -> `lodash`, `node:fs` -> `fs`. */
export function packageName(specifier: string): string {
	const bare = specifier.replace(/^node:/, '');
	const parts = bare.split('/');
	return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// #endregion

// #region Resolution

export interface PathAliases {
	/** `baseUrl` relative to the root, `/`-separated (`''` for the root itself). */
	readonly baseUrl: string;
	/** tsconfig `paths`: pattern (at most one `*`) -> targets relative to `baseUrl`. */
	readonly paths: readonly (readonly [string, readonly string[]])[];
}

function candidates(base: string): string[] {
	const result = [base];
	const extension = path.posix.extname(base);
	for (const replacement of JS_TO_TS[extension] ?? []) {
		result.push(base.slice(0, -extension.length) + replacement);
	}
	for (const extension of RESOLVE_EXTENSIONS) {
		result.push(base + extension);
	}
	for (const extension of RESOLVE_EXTENSIONS) {
		result.push(`${base}/index${extension}`);
	}
	return result;
}

function firstExisting(base: string, files: ReadonlySet<string>): string | undefined {
	const normalized = path.posix.normalize(base).replace(/^\.\//, '');
	if (normalized.startsWith('../')) {
		return undefined;
	}
	return candidates(normalized).find(candidate => files.has(candidate));
}

/**
 * Resolves one specifier imported by `from`: a project file, a package, or an unresolved relative import.
 * `files` holds every project file (sources and JSON) relative to the root.
 */
/** A package that lives in this project (a monorepo workspace): where it is and the files its entry fields name. */
export interface LocalPackage {
	readonly dir: string;
	readonly entries: readonly string[];
}

/** Files a local package's entry resolves to: its entry fields, built output mapped back to `src/`, then `index`. */
function resolveLocalPackage(pkg: LocalPackage, subpath: string, files: ReadonlySet<string>): string | undefined {
	const join = (relative: string) => path.posix.join(pkg.dir, relative);
	const candidates = subpath
		? [subpath, `src/${subpath}`]
		: [...pkg.entries, ...pkg.entries.map(entry => entry.replace(/^\.?\/?(dist|lib|build|out)\//, 'src/').replace(/\.d\.ts$/, '')), 'src/index', 'index'];
	for (const candidate of candidates) {
		const file = firstExisting(join(candidate.replace(/^\.\//, '')), files);
		if (file) {
			return file;
		}
	}
	return undefined;
}

export function resolveSpecifier(from: string, specifier: string, files: ReadonlySet<string>, aliases?: PathAliases, localPackages?: ReadonlyMap<string, LocalPackage>): { file?: string; package?: string; unresolved?: string } {
	if (ASSET_PATTERN.test(specifier)) {
		return {}; // stylesheets, images, HTML: not part of the code graph
	}
	if (specifier.startsWith('.') || specifier.startsWith('/')) {
		const base = specifier.startsWith('/') ? specifier.slice(1) : path.posix.join(path.posix.dirname(from), specifier);
		const file = firstExisting(base, files);
		return file ? { file } : { unresolved: specifier };
	}
	for (const [pattern, targets] of aliases?.paths ?? []) {
		const star = pattern.indexOf('*');
		const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
		const suffix = star >= 0 ? pattern.slice(star + 1) : '';
		const matched = star >= 0 ? specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length : specifier === pattern;
		if (!matched) {
			continue;
		}
		const rest = star >= 0 ? specifier.slice(prefix.length, specifier.length - suffix.length) : '';
		for (const target of targets) {
			const file = firstExisting(path.posix.join(aliases!.baseUrl, target.replace('*', rest)), files);
			if (file) {
				return { file };
			}
		}
	}
	if (aliases) {
		// With a baseUrl, TypeScript also resolves bare specifiers against it before node_modules.
		const file = firstExisting(path.posix.join(aliases.baseUrl, specifier), files);
		if (file) {
			return { file };
		}
	}
	const name = packageName(specifier);
	const local = localPackages?.get(name);
	if (local) {
		const file = resolveLocalPackage(local, specifier.slice(name.length).replace(/^\//, ''), files);
		if (file) {
			return { file };
		}
	}
	return { package: name };
}

/** `name` -> folder and entry files of every package.json in the project, so workspace imports resolve to files. */
async function readLocalPackages(root: string, files: readonly string[]): Promise<Map<string, LocalPackage>> {
	const result = new Map<string, LocalPackage>();
	for (const file of files.filter(candidate => candidate === 'package.json' || candidate.endsWith('/package.json'))) {
		try {
			const json = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
			if (typeof json?.name !== 'string') {
				continue;
			}
			const dot = typeof json.exports === 'string' ? json.exports : json.exports?.['.'];
			const exported = typeof dot === 'string' ? [dot] : [dot?.source, dot?.types, dot?.import, dot?.require, dot?.default].filter(entry => typeof entry === 'string');
			const entries = [json.source, json.types, json.typings, ...exported, json.module, json.main].filter((entry): entry is string => typeof entry === 'string');
			result.set(json.name, { dir: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), entries });
		} catch {
			// not JSON: skip
		}
	}
	return result;
}

/** Reads `baseUrl` and `paths` from the root tsconfig.json or jsconfig.json, if any. */
async function readAliases(root: string): Promise<PathAliases | undefined> {
	for (const name of ['tsconfig.json', 'jsconfig.json']) {
		let text: string;
		try {
			text = await fs.readFile(path.join(root, name), 'utf8');
		} catch {
			continue;
		}
		try {
			const json = JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'));
			const options = json?.compilerOptions ?? {};
			if (!options.baseUrl && !options.paths) {
				return undefined;
			}
			const baseUrl = path.posix.normalize(String(options.baseUrl ?? '.').replace(/\\/g, '/')).replace(/^\.\/?$/, '').replace(/^\.\//, '');
			const paths = Object.entries<string[]>(options.paths ?? {}).map(([pattern, targets]) => [pattern, Array.isArray(targets) ? targets : []] as const);
			return { baseUrl, paths };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

// #endregion

// #region Scanning

/** Plain names (no wildcards) the root .gitignore excludes, e.g. `generated/` or `.cache`. */
async function readIgnoredNames(root: string): Promise<Set<string>> {
	const names = new Set<string>();
	try {
		for (const line of (await fs.readFile(path.join(root, '.gitignore'), 'utf8')).split(/\r?\n/)) {
			const entry = line.trim().replace(/^\//, '').replace(/\/$/, '');
			if (entry && !entry.startsWith('#') && !entry.startsWith('!') && !/[*?[\]/]/.test(entry)) {
				names.add(entry);
			}
		}
	} catch {
		// no .gitignore
	}
	return names;
}

async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
	const ignored = await readIgnoredNames(root);
	const files: string[] = [];
	const queue = [''];
	while (queue.length) {
		const relative = queue.shift()!;
		let entries;
		try {
			entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name) && !ignored.has(entry.name) && !ignored.has(child)) {
					queue.push(child);
				}
			} else if (entry.isFile() && !ignored.has(entry.name) && (RESOLVE_EXTENSIONS.some(extension => entry.name.endsWith(extension)))) {
				files.push(child);
				if (files.length >= MAX_FILES) {
					return { files, truncated: true };
				}
			}
		}
	}
	return { files, truncated: false };
}

function isSource(file: string): boolean {
	return SOURCE_EXTENSIONS.some(extension => file.endsWith(extension)) && !file.endsWith('.d.ts');
}

/** Scans `root` and builds its import graph. */
export async function buildDepsGraph(root: string): Promise<DepsGraph> {
	const [{ files: all, truncated }, aliases] = await Promise.all([listFiles(root), readAliases(root)]);
	const fileSet = new Set(all);
	const localPackages = await readLocalPackages(root, all);
	const sources = all.filter(isSource).sort();
	const imports: Record<string, string[]> = {};
	const packages: Record<string, string[]> = {};
	const unresolved: Record<string, string[]> = {};
	const read = async (file: string) => {
		try {
			const stat = await fs.stat(path.join(root, file));
			return stat.size > MAX_FILE_BYTES ? '' : await fs.readFile(path.join(root, file), 'utf8');
		} catch {
			return '';
		}
	};
	for (let i = 0; i < sources.length; i += 64) {
		const batch = sources.slice(i, i + 64);
		const texts = await Promise.all(batch.map(read));
		batch.forEach((file, index) => {
			const fileImports = new Set<string>();
			const filePackages = new Set<string>();
			const fileUnresolved = new Set<string>();
			for (const specifier of extractSpecifiers(texts[index])) {
				const resolved = resolveSpecifier(file, specifier, fileSet, aliases, localPackages);
				if (resolved.file && resolved.file !== file) {
					fileImports.add(resolved.file);
				} else if (resolved.package) {
					filePackages.add(resolved.package);
				} else if (resolved.unresolved) {
					fileUnresolved.add(resolved.unresolved);
				}
			}
			imports[file] = [...fileImports].sort();
			if (filePackages.size) {
				packages[file] = [...filePackages].sort();
			}
			if (fileUnresolved.size) {
				unresolved[file] = [...fileUnresolved].sort();
			}
		});
	}
	// JSON and declaration files that are imported count as files too.
	const imported = new Set(Object.values(imports).flat());
	const graphFiles = [...new Set([...sources, ...[...imported].filter(file => !isSource(file))])].sort();
	for (const file of graphFiles) {
		imports[file] ??= [];
	}
	return { root, files: graphFiles, imports, packages, unresolved, truncated, scannedAt: new Date().toISOString() };
}

// #endregion

// #region Queries

export function dependentsMap(graph: DepsGraph): Map<string, string[]> {
	const result = new Map<string, string[]>(graph.files.map(file => [file, []]));
	for (const [file, targets] of Object.entries(graph.imports)) {
		for (const target of targets) {
			result.get(target)?.push(file);
		}
	}
	return result;
}

/** Finds the file an agent meant: an exact relative path, an absolute path, or the best suffix/name match. */
export function findFile(graph: DepsGraph, query: string): string | undefined {
	let wanted = query.trim().replace(/\\/g, '/');
	const root = graph.root.replace(/\\/g, '/').replace(/\/$/, '');
	if (wanted.toLowerCase().startsWith(root.toLowerCase() + '/')) {
		wanted = wanted.slice(root.length + 1);
	}
	wanted = wanted.replace(/^\.\//, '');
	if (graph.imports[wanted]) {
		return wanted;
	}
	const lower = wanted.toLowerCase();
	const bySuffix = graph.files.filter(file => file.toLowerCase().endsWith('/' + lower) || file.toLowerCase() === lower);
	if (bySuffix.length) {
		return bySuffix.sort((a, b) => a.length - b.length)[0];
	}
	const stem = lower.replace(/\.[^./]+$/, '');
	return graph.files.filter(file => file.toLowerCase().replace(/\.[^./]+$/, '').endsWith('/' + stem) || file.toLowerCase().replace(/\.[^./]+$/, '') === stem).sort((a, b) => a.length - b.length)[0];
}

/** Files that (transitively, up to `depth` hops) import `file`, nearest first. */
export function dependentsOf(graph: DepsGraph, file: string, depth = 1, dependents = dependentsMap(graph)): { file: string; distance: number }[] {
	const seen = new Map<string, number>([[file, 0]]);
	let frontier = [file];
	for (let distance = 1; distance <= depth && frontier.length; distance++) {
		const next: string[] = [];
		for (const current of frontier) {
			for (const dependent of dependents.get(current) ?? []) {
				if (!seen.has(dependent)) {
					seen.set(dependent, distance);
					next.push(dependent);
				}
			}
		}
		frontier = next;
	}
	seen.delete(file);
	return [...seen.entries()].map(([dependent, distance]) => ({ file: dependent, distance })).sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
}

/** The shortest import chain from `from` to `to` (`from` imports ... imports `to`), if any. */
export function shortestPath(graph: DepsGraph, from: string, to: string): string[] | undefined {
	const previous = new Map<string, string | undefined>([[from, undefined]]);
	const queue = [from];
	while (queue.length) {
		const current = queue.shift()!;
		if (current === to) {
			const chain = [current];
			for (let step = previous.get(current); step !== undefined; step = previous.get(step)) {
				chain.unshift(step);
			}
			return chain;
		}
		for (const next of graph.imports[current] ?? []) {
			if (!previous.has(next)) {
				previous.set(next, current);
				queue.push(next);
			}
		}
	}
	return undefined;
}

/** Groups of files that import each other in a loop (strongly connected components with more than one file). */
export function findCycles(graph: DepsGraph): string[][] {
	let counter = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const result: string[][] = [];
	for (const start of graph.files) {
		if (index.has(start)) {
			continue;
		}
		// Iterative Tarjan, so deep import chains cannot overflow the call stack.
		const work: { file: string; next: number }[] = [{ file: start, next: 0 }];
		index.set(start, counter);
		low.set(start, counter++);
		stack.push(start);
		onStack.add(start);
		while (work.length) {
			const frame = work[work.length - 1];
			const targets = graph.imports[frame.file] ?? [];
			if (frame.next < targets.length) {
				const target = targets[frame.next++];
				if (!index.has(target)) {
					index.set(target, counter);
					low.set(target, counter++);
					stack.push(target);
					onStack.add(target);
					work.push({ file: target, next: 0 });
				} else if (onStack.has(target)) {
					low.set(frame.file, Math.min(low.get(frame.file)!, index.get(target)!));
				}
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1].file;
				low.set(parent, Math.min(low.get(parent)!, low.get(frame.file)!));
			}
			if (low.get(frame.file) === index.get(frame.file)) {
				const component: string[] = [];
				let member: string;
				do {
					member = stack.pop()!;
					onStack.delete(member);
					component.push(member);
				} while (member !== frame.file);
				if (component.length > 1) {
					result.push(component.sort());
				}
			}
		}
	}
	return result.sort((a, b) => b.length - a.length);
}

export interface DepsOverview {
	readonly files: number;
	readonly edges: number;
	readonly hubs: readonly { file: string; dependents: number }[];
	readonly entryPoints: readonly string[];
	readonly packages: readonly { name: string; files: number }[];
	readonly cycles: number;
	readonly unresolved: number;
	readonly truncated: boolean;
}

export function overview(graph: DepsGraph, limit = 15): DepsOverview {
	const dependents = dependentsMap(graph);
	const packageCounts = new Map<string, number>();
	for (const names of Object.values(graph.packages)) {
		for (const name of names) {
			packageCounts.set(name, (packageCounts.get(name) ?? 0) + 1);
		}
	}
	return {
		files: graph.files.length,
		edges: Object.values(graph.imports).reduce((total, targets) => total + targets.length, 0),
		hubs: [...dependents.entries()].map(([file, list]) => ({ file, dependents: list.length })).filter(item => item.dependents > 0).sort((a, b) => b.dependents - a.dependents || a.file.localeCompare(b.file)).slice(0, limit),
		entryPoints: graph.files.filter(file => !dependents.get(file)?.length && (graph.imports[file]?.length ?? 0) > 0).slice(0, limit),
		packages: [...packageCounts.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, limit),
		cycles: findCycles(graph).length,
		unresolved: Object.values(graph.unresolved).reduce((total, list) => total + list.length, 0),
		truncated: graph.truncated,
	};
}

/** Folder of a file, cut to `depth` segments (`src/a/b/c.ts` at depth 2 -> `src/a`; root files -> `.`). */
export function folderOf(file: string, depth: number): string {
	const parts = file.split('/').slice(0, -1);
	return parts.length ? parts.slice(0, depth).join('/') : '.';
}

/** Folder-level graph for drawing: folders with file counts, and how many imports go between each pair. */
export function folderGraph(graph: DepsGraph, depth: number): { folders: { id: string; files: number }[]; links: { source: string; target: string; count: number }[] } {
	const counts = new Map<string, number>();
	const links = new Map<string, number>();
	for (const file of graph.files) {
		const folder = folderOf(file, depth);
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
		for (const target of graph.imports[file] ?? []) {
			const other = folderOf(target, depth);
			if (other !== folder) {
				const key = `${folder}\n${other}`;
				links.set(key, (links.get(key) ?? 0) + 1);
			}
		}
	}
	return {
		folders: [...counts.entries()].map(([id, files]) => ({ id, files })),
		links: [...links.entries()].map(([key, count]) => {
			const [source, target] = key.split('\n');
			return { source, target, count };
		}),
	};
}

// #endregion
