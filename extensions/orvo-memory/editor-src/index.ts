/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Project Memory editor webview. Plain DOM, no libraries: the CSP only allows this bundle.

interface Note {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly tags: readonly string[];
	readonly created: string;
	readonly updated: string;
	readonly sources: readonly string[];
	readonly body: string;
}

interface InboxEntry {
	readonly time: string;
	readonly source: string;
	readonly text: string;
}

interface Data {
	readonly available?: boolean;
	readonly connected?: boolean;
	readonly notes: readonly Note[];
	readonly inbox: readonly InboxEntry[];
	readonly frequency?: string;
	readonly model?: string;
	readonly lastConsolidated?: string;
}

interface Point { x: number; y: number; vx: number; vy: number }
type GraphNode = { readonly id: string; readonly label: string } & ({ readonly kind: 'note'; readonly note: Note } | { readonly kind: 'tag'; readonly tag: string; readonly count: number });
interface GraphLink { readonly source: string; readonly target: string }
type Tab = 'graph' | 'timeline' | 'inbox';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): { tab?: Tab; selected?: string } | undefined;
	setState(state: { tab?: Tab; selected?: string }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const config: { strings: Record<string, string>; types: string[]; frequencies: string[] } = JSON.parse(document.getElementById('strings')?.textContent ?? '{}');
const t = config.strings;
const types = config.types;
const frequencies = config.frequencies;
const SVG = 'http://www.w3.org/2000/svg';

const saved = vscode.getState() ?? {};
const ui: { tab: Tab; selected?: string; editing?: { id?: string }; type: string; tag?: string; query: string } = {
	tab: saved.tab ?? 'graph',
	selected: saved.selected,
	type: 'all',
	query: '',
};
let data: Data = { notes: [], inbox: [] };

const positions = new Map<string, Point>();
let layoutKey = '';
const view = { x: 0, y: 0, scale: 1, centered: false };

// #region DOM helpers

interface ElementOptions {
	readonly class?: string;
	readonly text?: string;
	readonly title?: string;
	readonly attrs?: Record<string, string>;
	readonly on?: Record<string, (event: Event) => void>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}, children: (Node | string | undefined | false)[] = []): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (options.class) {
		node.className = options.class;
	}
	if (options.text !== undefined) {
		node.textContent = options.text;
	}
	if (options.title) {
		node.title = options.title;
	}
	for (const [name, value] of Object.entries(options.attrs ?? {})) {
		node.setAttribute(name, value);
	}
	for (const [name, listener] of Object.entries(options.on ?? {})) {
		node.addEventListener(name, listener);
	}
	for (const child of children) {
		if (child) {
			node.append(child);
		}
	}
	return node;
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG, tag);
	for (const [name, value] of Object.entries(attrs)) {
		node.setAttribute(name, String(value));
	}
	return node;
}

function post(command: string, extra: Record<string, unknown> = {}): void {
	vscode.postMessage({ command, ...extra });
}

function persist(): void {
	vscode.setState({ tab: ui.tab, selected: ui.selected });
}

function typeColor(type: string): string {
	return `var(--${types.includes(type) ? type : 'fact'})`;
}

function dot(color: string): HTMLElement {
	const node = h('span', { class: 'dot' });
	node.style.background = color;
	return node;
}

function valueOf(event: Event): string {
	return (event.target as HTMLInputElement | HTMLSelectElement).value;
}

// #endregion

// #region Markdown (escaped first, so note text can never inject markup)

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text: string): string {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '<u>$1</u>');
}

function renderMarkdown(markdown: string): string {
	const out: string[] = [];
	const lines = markdown.split(/\r?\n/);
	let list: '' | 'ul' | 'ol' = '';
	let paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) {
			out.push(`<p>${inline(paragraph.join(' '))}</p>`);
			paragraph = [];
		}
	};
	const flushList = () => {
		if (list) {
			out.push(`</${list}>`);
			list = '';
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('```')) {
			flushParagraph();
			flushList();
			const code: string[] = [];
			while (++i < lines.length && !lines[i].startsWith('```')) {
				code.push(lines[i]);
			}
			out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
			continue;
		}
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			out.push(`<h4>${inline(heading[1])}</h4>`);
		} else if (bullet || numbered) {
			flushParagraph();
			const kind = bullet ? 'ul' : 'ol';
			if (list !== kind) {
				flushList();
				out.push(`<${kind}>`);
				list = kind;
			}
			out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? '')}</li>`);
		} else if (!line.trim()) {
			flushParagraph();
			flushList();
		} else {
			flushList();
			paragraph.push(line.trim());
		}
	}
	flushParagraph();
	flushList();
	return out.join('');
}

// #endregion

// #region Filtering

function matches(note: Note): boolean {
	if (ui.type !== 'all' && note.type !== ui.type) {
		return false;
	}
	if (ui.tag && !note.tags.includes(ui.tag)) {
		return false;
	}
	if (ui.query) {
		const haystack = `${note.title} ${note.body} ${note.tags.join(' ')}`.toLowerCase();
		return ui.query.split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
	}
	return true;
}

function related(note: Note): Note[] {
	return data.notes
		.filter(other => other.id !== note.id)
		.map(other => ({ other, shared: other.tags.filter(tag => note.tags.includes(tag)).length }))
		.filter(item => item.shared > 0)
		.sort((a, b) => b.shared - a.shared)
		.slice(0, 8)
		.map(item => item.other);
}

function tagCounts(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const note of data.notes) {
		for (const tag of note.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return counts;
}

// #endregion

// #region Graph

function graphModel(): { nodes: GraphNode[]; links: GraphLink[] } {
	const counts = tagCounts();
	const nodes: GraphNode[] = [
		...data.notes.map((note): GraphNode => ({ id: `n:${note.id}`, kind: 'note', note, label: note.title })),
		...[...counts.entries()].map(([tag, count]): GraphNode => ({ id: `t:${tag}`, kind: 'tag', tag, count, label: `#${tag}` })),
	];
	const links = data.notes.flatMap(note => note.tags.map(tag => ({ source: `n:${note.id}`, target: `t:${tag}` })));
	return { nodes, links };
}

/**
 * A small force layout (repulsion, springs on links, pull to the centre), run to rest synchronously: memory graphs are
 * hundreds of nodes at most. Nodes keep their position across refreshes, so the graph doesn't jump.
 */
function layout(nodes: readonly GraphNode[], links: readonly GraphLink[]): void {
	const key = nodes.map(node => node.id).join('|') + '#' + links.map(link => link.source + link.target).join('|');
	if (key === layoutKey) {
		return;
	}
	layoutKey = key;
	const fresh = nodes.filter(node => !positions.has(node.id));
	fresh.forEach((node, i) => {
		const angle = (i / Math.max(1, fresh.length)) * Math.PI * 2;
		const radius = 80 + Math.random() * 120;
		positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
	});
	const ids = new Set(nodes.map(node => node.id));
	for (const id of [...positions.keys()]) {
		if (!ids.has(id)) {
			positions.delete(id);
		}
	}
	const points = nodes.map(node => positions.get(node.id)!);
	const index = new Map(nodes.map((node, i) => [node.id, i]));
	const iterations = fresh.length === nodes.length ? 400 : 150;
	for (let step = 0; step < iterations; step++) {
		const cooling = 1 - step / iterations;
		for (let i = 0; i < points.length; i++) {
			for (let j = i + 1; j < points.length; j++) {
				const a = points[i];
				const b = points[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let distance2 = dx * dx + dy * dy;
				if (distance2 < 0.01) {
					dx = Math.random() - 0.5;
					dy = Math.random() - 0.5;
					distance2 = 0.25;
				}
				const distance = Math.sqrt(distance2);
				const force = 2200 / distance2;
				a.vx += (dx / distance) * force;
				a.vy += (dy / distance) * force;
				b.vx -= (dx / distance) * force;
				b.vy -= (dy / distance) * force;
			}
		}
		for (const link of links) {
			const a = points[index.get(link.source) ?? -1];
			const b = points[index.get(link.target) ?? -1];
			if (!a || !b) {
				continue;
			}
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
			const force = (distance - 70) * 0.04;
			a.vx += (dx / distance) * force;
			a.vy += (dy / distance) * force;
			b.vx -= (dx / distance) * force;
			b.vy -= (dy / distance) * force;
		}
		for (const point of points) {
			point.vx -= point.x * 0.01;
			point.vy -= point.y * 0.01;
			point.x += Math.max(-20, Math.min(20, point.vx)) * cooling;
			point.y += Math.max(-20, Math.min(20, point.vy)) * cooling;
			point.vx *= 0.5;
			point.vy *= 0.5;
		}
	}
}

function renderGraph(container: HTMLElement): void {
	const { nodes, links } = graphModel();
	if (!nodes.length) {
		container.append(h('div', { class: 'empty meta', text: t.empty }));
		return;
	}
	layout(nodes, links);
	const svg = s('svg', { class: 'graph' });
	const scene = s('g');
	svg.append(scene);
	const applyView = () => scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.scale})`);

	const visibleNotes = new Set(data.notes.filter(matches).map(note => `n:${note.id}`));
	const filtering = ui.type !== 'all' || !!ui.tag || !!ui.query;
	const selectedId = ui.selected ? `n:${ui.selected}` : undefined;
	const neighbours = new Set(links.filter(link => link.source === selectedId).map(link => link.target));

	let moved = false;
	let drag: { id?: string; x: number; y: number; ox: number; oy: number } | undefined;
	const startDrag = (event: PointerEvent, id?: string) => {
		event.stopPropagation();
		moved = false;
		const p = id ? positions.get(id) : undefined;
		drag = { id, x: event.clientX, y: event.clientY, ox: p ? p.x : view.x, oy: p ? p.y : view.y };
		// Capture on the element pressed, so the click that follows still reaches a node.
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		if (!id) {
			svg.classList.add('panning');
		}
	};

	const lineElements = links.map(link => {
		const line = s('line');
		const classes = [link.source === selectedId ? 'hot' : '', filtering && !visibleNotes.has(link.source) ? 'dim' : ''];
		line.setAttribute('class', classes.join(' ').trim());
		scene.append(line);
		return { line, link };
	});
	const nodeElements = nodes.map(node => {
		const group = s('g');
		const isNote = node.kind === 'note';
		const dim = filtering && (node.kind === 'note'
			? !visibleNotes.has(node.id)
			: node.tag !== ui.tag && !links.some(link => link.target === node.id && visibleNotes.has(link.source)));
		const selected = node.kind === 'note' ? node.id === selectedId : node.tag === ui.tag;
		group.setAttribute('class', `node ${node.kind}${selected ? ' selected' : ''}${dim ? ' dim' : ''}`);
		const radius = node.kind === 'note' ? 7 + Math.min(6, Math.floor(node.note.body.length / 300)) : 3 + Math.min(5, node.count);
		const circle = s('circle', { r: radius });
		if (node.kind === 'note') {
			circle.setAttribute('fill', typeColor(node.note.type));
		}
		const tooltip = s('title');
		tooltip.textContent = node.kind === 'note' ? `${node.note.title} (${node.note.type})` : `${node.label} · ${node.count}`;
		const label = s('text', { x: radius + 4, y: 4 });
		const text = node.label.length > 34 ? `${node.label.slice(0, 32)}…` : node.label;
		label.textContent = isNote || neighbours.has(node.id) || (node.kind === 'tag' && node.count > 1) ? text : '';
		group.append(circle, tooltip, label);
		group.addEventListener('pointerdown', event => startDrag(event, node.id));
		group.addEventListener('click', event => {
			event.stopPropagation();
			if (moved) {
				return;
			}
			if (node.kind === 'note') {
				select(node.note.id);
			} else {
				ui.tag = ui.tag === node.tag ? undefined : node.tag;
				render();
			}
		});
		scene.append(group);
		return { group, node };
	});

	const draw = () => {
		for (const { line, link } of lineElements) {
			const a = positions.get(link.source);
			const b = positions.get(link.target);
			if (a && b) {
				line.setAttribute('x1', String(a.x));
				line.setAttribute('y1', String(a.y));
				line.setAttribute('x2', String(b.x));
				line.setAttribute('y2', String(b.y));
			}
		}
		for (const { group, node } of nodeElements) {
			const p = positions.get(node.id);
			if (p) {
				group.setAttribute('transform', `translate(${p.x},${p.y})`);
			}
		}
	};

	// Pan the background, drag a node, zoom with the wheel.
	svg.addEventListener('pointerdown', event => startDrag(event));
	svg.addEventListener('pointermove', event => {
		if (!drag) {
			return;
		}
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) {
			moved = true;
		}
		const p = drag.id ? positions.get(drag.id) : undefined;
		if (p) {
			p.x = drag.ox + dx / view.scale;
			p.y = drag.oy + dy / view.scale;
			draw();
		} else if (!drag.id) {
			view.x = drag.ox + dx;
			view.y = drag.oy + dy;
			applyView();
		}
	});
	const endDrag = () => {
		drag = undefined;
		svg.classList.remove('panning');
		setTimeout(() => moved = false, 0);
	};
	svg.addEventListener('pointerup', endDrag);
	svg.addEventListener('pointercancel', endDrag);
	svg.addEventListener('click', () => {
		if (!moved && ui.tag) {
			ui.tag = undefined;
			render();
		}
	});
	svg.addEventListener('wheel', event => {
		event.preventDefault();
		const rect = svg.getBoundingClientRect();
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		const scale = Math.max(0.2, Math.min(4, view.scale * Math.exp(-event.deltaY * 0.0015)));
		view.x = mx - (mx - view.x) * (scale / view.scale);
		view.y = my - (my - view.y) * (scale / view.scale);
		view.scale = scale;
		applyView();
	}, { passive: false });

	container.append(svg);
	if (!view.centered) {
		const rect = container.getBoundingClientRect();
		view.x = rect.width / 2;
		view.y = rect.height / 2;
		view.centered = true;
	}
	applyView();
	draw();

	container.append(
		h('div', { class: 'legend meta' }, types.map(type => h('span', {}, [dot(typeColor(type)), type]))),
		h('div', { class: 'hint meta', text: t.graphHint }),
	);
}

// #endregion

// #region Timeline and inbox

function noteCard(note: Note, details: boolean): HTMLElement {
	const card = h('div', { class: `card${note.id === ui.selected ? ' selected' : ''}`, on: { click: () => select(note.id) } }, [
		h('div', { class: 'title', text: note.title }),
		h('div', { class: 'meta', text: `${note.type}${note.tags.length ? ' · #' + note.tags.join(' #') : ''}` }),
		details && h('div', { class: 'excerpt', text: note.body.replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim() }),
	]);
	card.style.borderLeftColor = typeColor(note.type);
	return card;
}

function renderTimeline(container: HTMLElement): void {
	const notes = data.notes.filter(matches);
	if (!notes.length) {
		container.append(h('div', { class: 'empty meta', text: t.empty }));
		return;
	}
	const list = h('div', { class: 'list' });
	let current = '';
	for (const note of notes) {
		const date = note.updated.slice(0, 10);
		if (date !== current) {
			current = date;
			list.append(h('div', { class: 'day', text: new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) }));
		}
		list.append(noteCard(note, true));
	}
	container.append(list);
}

function renderInbox(container: HTMLElement): void {
	if (!data.inbox.length) {
		container.append(h('div', { class: 'empty meta', text: t.inboxEmpty }));
		return;
	}
	const list = h('div', { class: 'list' }, [h('button', { text: t.consolidate, on: { click: () => post('consolidate') } })]);
	for (const entry of [...data.inbox].reverse()) {
		list.append(h('div', { class: 'entry' }, [
			h('span', { class: 'source', text: `[${entry.source}]` }),
			h('span', { text: entry.text }),
			h('div', { class: 'meta', text: new Date(entry.time).toLocaleString() }),
		]));
	}
	container.append(list);
}

// #endregion

// #region Detail

function toggleTag(tag: string): void {
	ui.tag = ui.tag === tag ? undefined : tag;
	render();
}

function renderDetail(container: HTMLElement): void {
	if (ui.editing) {
		const id = ui.editing.id;
		renderEditForm(container, id ? data.notes.find(note => note.id === id) : undefined);
		return;
	}
	const note = data.notes.find(candidate => candidate.id === ui.selected);
	if (!note) {
		container.append(
			h('div', { class: 'meta', text: t.pick }),
			h('div', { class: 'actions' }, [h('button', { text: t.newNote, on: { click: () => edit(undefined) } })]),
		);
		return;
	}
	const badge = h('span', { class: 'type-badge', text: note.type });
	badge.style.background = typeColor(note.type);
	const body = h('div', { class: 'markdown' });
	body.innerHTML = renderMarkdown(note.body); // renderMarkdown escapes the note text
	const relatedNotes = related(note);
	container.append(h('div', { class: 'detail' }, [
		h('h2', { text: note.title }),
		h('div', { class: 'badges' }, [badge, ...note.tags.map(tag => h('span', { class: `chip${ui.tag === tag ? ' active' : ''}`, text: `#${tag}`, on: { click: () => toggleTag(tag) } }))]),
		h('dl', {}, [
			h('dt', { text: t.updated }), h('dd', { text: new Date(note.updated).toLocaleString() }),
			h('dt', { text: t.created }), h('dd', { text: new Date(note.created).toLocaleString() }),
			h('dt', { text: t.sources }), h('dd', { text: note.sources.join(', ') || '—' }),
		]),
		h('div', { class: 'actions' }, [
			h('button', { text: t.edit, on: { click: () => edit(note.id) } }),
			h('button', { class: 'secondary', text: t.openFile, on: { click: () => post('openNote', { id: note.id }) } }),
			h('button', { class: 'danger', text: t.delete, on: { click: () => post('deleteNote', { id: note.id }) } }),
		]),
		body,
		relatedNotes.length > 0 && h('div', { class: 'related' }, [h('h3', { text: t.related }), ...relatedNotes.map(other => noteCard(other, false))]),
	]));
}

function renderEditForm(container: HTMLElement, note: Note | undefined): void {
	const title = h('input', { attrs: { type: 'text', value: note?.title ?? '' } });
	const type = h('select', {}, types.map(value => h('option', { text: value, attrs: { value } })));
	type.value = note?.type ?? 'fact';
	const tags = h('input', { attrs: { type: 'text', value: (note?.tags ?? []).join(', ') } });
	const body = h('textarea');
	body.value = note?.body ?? '';
	const submit = (event: Event) => {
		event.preventDefault();
		if (!title.value.trim()) {
			title.focus();
			return;
		}
		post('saveNote', { note: { id: note?.id, title: title.value, type: type.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean), body: body.value } });
		ui.editing = undefined;
	};
	const cancel = () => {
		ui.editing = undefined;
		render();
	};
	container.append(h('form', { class: 'edit', on: { submit } }, [
		h('h2', { text: note ? t.edit : t.newNote }),
		h('label', {}, [t.title, title]),
		h('label', {}, [t.type, type]),
		h('label', {}, [t.tags, tags]),
		h('label', {}, [t.body, body]),
		h('div', { class: 'actions' }, [
			h('button', { text: t.save, attrs: { type: 'submit' } }),
			h('button', { class: 'secondary', text: t.cancel, attrs: { type: 'button' }, on: { click: cancel } }),
		]),
	]));
	setTimeout(() => title.focus(), 0);
}

// #endregion

function select(id: string): void {
	ui.selected = id;
	ui.editing = undefined;
	persist();
	render();
}

function edit(id: string | undefined): void {
	ui.editing = { id };
	render();
}

function chip(label: string, active: boolean, onClick: () => void, color?: string): HTMLElement {
	return h('span', { class: `chip${active ? ' active' : ''}`, on: { click: onClick } }, [color !== undefined && dot(color), label]);
}

function render(): void {
	const app = document.getElementById('app');
	if (!app) {
		return;
	}
	const previousSearch = document.getElementById('search') as HTMLInputElement | null;
	const hadFocus = !!previousSearch && document.activeElement === previousSearch;
	const caret = previousSearch?.selectionStart ?? 0;
	app.replaceChildren();
	if (data.available === false) {
		app.append(h('div', { class: 'empty meta', text: t.noFolder }));
		return;
	}

	const frequency = h('select', { on: { change: event => post('setFrequency', { frequency: valueOf(event) }) } }, frequencies.map(value => h('option', { text: value, attrs: { value } })));
	frequency.value = data.frequency ?? 'daily';
	app.append(h('div', { class: 'toolbar' }, [
		h('h1', { text: t.heading }),
		h('div', { class: 'stats meta' }, [
			h('span', { class: 'stat' }, [h('b', { text: String(data.notes.length) }), ` ${t.notes}`]),
			h('span', { class: 'stat' }, [h('b', { text: String(data.inbox.length) }), ` ${t.waiting}`]),
			h('span', { class: 'stat', text: `${t.last}: ${data.lastConsolidated ? new Date(data.lastConsolidated).toLocaleString() : t.never}` }),
		]),
		h('span', { class: 'spacer' }),
		h('span', { class: 'group meta' }, [`${t.learn}:`, frequency]),
		h('span', { class: 'group meta' }, [`${t.model}:`, h('button', { class: 'link', text: data.model ?? '', on: { click: () => post('selectModel') } })]),
		h('span', { class: 'group' }, [
			h('button', { class: 'secondary', text: t.newNote, on: { click: () => edit(undefined) } }),
			h('button', { class: 'secondary', text: t.remember, on: { click: () => post('remember') } }),
			h('button', { text: t.consolidate, on: { click: () => post('consolidate') } }),
		]),
	]));

	const counts = tagCounts();
	const typeCounts = types.map(type => ({ type, count: data.notes.filter(note => note.type === type).length })).filter(item => item.count);
	const searchBox = h('input', {
		attrs: { id: 'search', type: 'search', placeholder: t.search, value: ui.query },
		on: { input: event => { ui.query = valueOf(event).toLowerCase(); render(); } },
	});
	const tabs: [Tab, string][] = [['graph', t.graph], ['timeline', t.timeline], ['inbox', `${t.inbox} (${data.inbox.length})`]];
	const filters = h('div', { class: 'filters' }, [
		h('div', { class: 'row' }, [
			h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: `tab${ui.tab === id ? ' active' : ''}`, text: label, on: { click: () => { ui.tab = id; persist(); render(); } } }))),
			searchBox,
			h('button', { class: 'link', text: t.index, on: { click: () => post('openIndex') } }),
			data.connected === false && h('button', { class: 'link', text: t.connect, on: { click: () => post('connectAgents') } }),
		]),
		h('div', { class: 'chips' }, [
			chip(`${t.all} ${data.notes.length}`, ui.type === 'all', () => { ui.type = 'all'; render(); }),
			...typeCounts.map(({ type, count }) => chip(`${type} ${count}`, ui.type === type, () => { ui.type = ui.type === type ? 'all' : type; render(); }, typeColor(type))),
		]),
		counts.size > 0 && h('div', { class: 'chips' }, [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([tag, count]) => chip(`#${tag} ${count}`, ui.tag === tag, () => toggleTag(tag)))),
	]);

	const content = h('div', { class: 'content' });
	const detail = h('div', { class: 'right' });
	app.append(h('div', { class: 'main' }, [h('div', { class: 'left' }, [filters, content]), detail]));
	if (ui.tab === 'graph') {
		renderGraph(content);
	} else if (ui.tab === 'timeline') {
		renderTimeline(content);
	} else {
		renderInbox(content);
	}
	renderDetail(detail);

	if (hadFocus) {
		searchBox.focus();
		searchBox.setSelectionRange(caret, caret);
	}
}

window.addEventListener('message', (event: MessageEvent<{ type: 'data' } & Data | { type: 'select'; id: string }>) => {
	const message = event.data;
	if (message.type === 'data') {
		data = message;
		if (ui.selected && data.notes.length && !data.notes.some(note => note.id === ui.selected)) {
			ui.selected = undefined;
		}
		if (!ui.editing) {
			render();
		}
	} else if (message.type === 'select') {
		if (ui.tab === 'inbox') {
			ui.tab = 'graph';
		}
		select(message.id);
	}
});
render();
post('ready');
