import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Runtime } from './runtime';
import { runProcess } from './process';
import { escapeHtml } from './documentation';

export interface SourcePoint { path: string; line: number; column: number; }
interface CircuitBlock { id: number; graph: number; source?: SourcePoint; }
interface CircuitFunction { id: number; name: string; entry: number; blocks: CircuitBlock[]; }
interface CircuitGraphSummary { id: number; neurons: number; edges: number; inputLanes: number; outputLanes: number; }
export interface CircuitGraph {
    id: number; inputLanes: number; neurons: { id: number; wire: number; bias: string; activation: string }[];
    edges: { from: number; to: number; weight: string }[]; outputs: number[];
    truncated: boolean; totalNeurons: number; totalEdges: number;
}
export interface CircuitImage {
    version: 1; format: string; path: string; minorVersion: number; entry: number;
    graphs: CircuitGraphSummary[]; functions: CircuitFunction[]; imports: { name: string }[]; sources: string[]; graph?: CircuitGraph;
}
export interface TaskTraceEvent {
    event: string; tick: number; task: number; child?: number; channel?: number; scope?: number; timer?: number;
    request?: number; reason?: string; cause?: string; service?: string; at?: string; wall_ns?: number;
}
export interface TaskTrace { events: TaskTraceEvent[]; totalLines: number; omitted: number; invalidLines: number[]; }
export interface TaskLifetime { id: number; first: number; last: number; finished: boolean; parent?: number; site?: string; events: number; waits: number; }
export interface FunctionCost { id: number; name: string; steps: string; }
export interface TaskCost { site: string; tasks: string; steps: string; runnable: string; channel: string; host: string; }
export interface ExecutionProfile { functions: FunctionCost[]; tasks: TaskCost[]; stats: Record<string, string>; tier: string[]; }
interface SourceLink { label: string; source: SourcePoint; }
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d+$/.test(value);
const count = (value: number): string => value.toLocaleString('en-US');
const sourcePoint = (value: unknown): value is SourcePoint => !!value && typeof value === 'object' && typeof (value as SourcePoint).path === 'string' && (value as SourcePoint).path.length > 0 && integer((value as SourcePoint).line) && (value as SourcePoint).line > 0 && integer((value as SourcePoint).column) && (value as SourcePoint).column > 0;

export function parseCircuitImage(text: string): CircuitImage {
    const image = JSON.parse(text) as CircuitImage;
    if (!image || image.version !== 1 || image.format !== 'NVR' || typeof image.path !== 'string' || !integer(image.minorVersion) || !integer(image.entry) || !Array.isArray(image.graphs) || !Array.isArray(image.functions) || !Array.isArray(image.imports) || !Array.isArray(image.sources)) { throw new Error('Unsupported circuit inspection response. Select a compatible Neura tooling release.'); }
    for (const graph of image.graphs) { if (!integer(graph.id) || !integer(graph.neurons) || !integer(graph.edges) || !integer(graph.inputLanes) || !integer(graph.outputLanes)) { throw new Error('Invalid graph summary.'); } }
    for (const fn of image.functions) {
        if (!integer(fn.id) || typeof fn.name !== 'string' || !Array.isArray(fn.blocks) || !integer(fn.entry)) { throw new Error('Invalid function summary.'); }
        for (const block of fn.blocks) { if (!integer(block.id) || !integer(block.graph) || (block.source !== undefined && !sourcePoint(block.source))) { throw new Error('Invalid source-mapped block.'); } }
    }
    if (image.imports.some(item => typeof item.name !== 'string') || image.sources.some(item => typeof item !== 'string')) { throw new Error('Invalid image source/import table.'); }
    if (image.graph) {
        const graph = image.graph;
        if (!integer(graph.id) || !integer(graph.inputLanes) || !Array.isArray(graph.neurons) || !Array.isArray(graph.edges) || !Array.isArray(graph.outputs) || !integer(graph.totalNeurons) || !integer(graph.totalEdges)) { throw new Error('Invalid selected graph.'); }
        for (const neuron of graph.neurons) { if (!integer(neuron.id) || !integer(neuron.wire) || !decimal(neuron.bias) || !['identity', 'relu'].includes(neuron.activation)) { throw new Error('Invalid neuron record.'); } }
        for (const edge of graph.edges) { if (!integer(edge.from) || !integer(edge.to) || !decimal(edge.weight)) { throw new Error('Invalid circuit edge.'); } }
        if (graph.outputs.some(wire => !integer(wire))) { throw new Error('Invalid graph output.'); }
    }
    return image;
}

/** Layout uses real wire dependencies. Rendering bounds never change the underlying circuit. */
export function circuitDiagram(graph: CircuitGraph, nodeLimit = 180, edgeLimit = 900): { svg: string; neurons: number; edges: number; truncated: boolean } {
    const neurons = graph.neurons.slice(0, Math.max(1, Math.min(500, nodeLimit)));
    const chosen = new Set(neurons.map(neuron => neuron.wire));
    const relevant = graph.edges.filter(edge => chosen.has(edge.to));
    const inputWires = [...new Set(relevant.filter(edge => edge.from < graph.inputLanes).map(edge => edge.from))].sort((a, b) => a - b).slice(0, 48);
    const visible = new Set([...chosen, ...inputWires]);
    const edges = relevant.filter(edge => visible.has(edge.from)).slice(0, Math.max(1, Math.min(2500, edgeLimit)));
    const depth = new Map<number, number>(inputWires.map(wire => [wire, 0]));
    const incoming = new Map<number, number[]>();
    for (const edge of edges) { incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]); }
    for (const neuron of neurons) { depth.set(neuron.wire, 1 + Math.max(0, ...(incoming.get(neuron.wire) ?? []).map(wire => depth.get(wire) ?? 0))); }
    const rows = new Map<number, number>(), positions = new Map<number, { x: number; y: number }>();
    let width = 320, height = 150;
    for (const wire of [...inputWires, ...neurons.map(neuron => neuron.wire)]) {
        const layer = Math.min(depth.get(wire) ?? 0, 10), row = rows.get(layer) ?? 0;
        rows.set(layer, row + 1); const point = { x: 65 + layer * 155, y: 50 + row * 62 };
        positions.set(wire, point); width = Math.max(width, point.x + 90); height = Math.max(height, point.y + 50);
    }
    const strokes = edges.map(edge => {
        const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
        return `<path d="M ${from.x + 27} ${from.y} C ${from.x + 70} ${from.y},${to.x - 70} ${to.y},${to.x - 27} ${to.y}" class="edge${edge.weight.startsWith('-') ? ' negative' : ''}"><title>w${edge.from} → w${edge.to}; weight ${escapeHtml(edge.weight)}</title></path>`;
    }).join('');
    const outputWires = new Set(graph.outputs);
    const nodes = [...inputWires.map(wire => ({ wire, label: `in ${wire}`, title: `Input lane ${wire}`, activation: 'input' })), ...neurons.map(neuron => ({ wire: neuron.wire, label: `n${neuron.id}`, title: `Neuron ${neuron.id}; wire ${neuron.wire}; ${neuron.activation}; bias ${neuron.bias}`, activation: neuron.activation }))].map(neuron => {
        const p = positions.get(neuron.wire)!;
        return `<g class="node ${neuron.activation}${outputWires.has(neuron.wire) ? ' output' : ''}"><title>${escapeHtml(neuron.title)}</title><rect x="${p.x - 27}" y="${p.y - 16}" width="54" height="32" rx="${neuron.activation === 'relu' ? 12 : 4}"/><text x="${p.x}" y="${p.y + 4}" text-anchor="middle">${escapeHtml(neuron.label)}</text></g>`;
    }).join('');
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Circuit wire dependencies" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><title>Graph ${graph.id}: a bounded view of actual neurons and weighted edges</title>${strokes}${nodes}</svg>`, neurons: neurons.length, edges: edges.length, truncated: !!graph.truncated || neurons.length < graph.totalNeurons || edges.length < graph.totalEdges };
}

export function parseTaskTrace(text: string, limit = 100000): TaskTrace {
    const result: TaskTrace = { events: [], totalLines: 0, omitted: 0, invalidLines: [] };
    for (const [line, raw] of text.split(/\r\n|\n|\r/).entries()) {
        if (!raw.trim()) { continue; } result.totalLines++;
        if (result.events.length >= limit) { result.omitted++; continue; }
        try {
            const event = JSON.parse(raw) as TaskTraceEvent;
            if (!event || typeof event.event !== 'string' || !/^[a-z][a-z-]*$/.test(event.event) || !integer(event.tick) || !integer(event.task)) { throw new Error('Invalid event'); }
            for (const key of ['child', 'channel', 'scope', 'timer', 'request'] as const) { if (event[key] !== undefined && !integer(event[key])) { throw new Error('Invalid event identity'); } }
            for (const key of ['reason', 'cause', 'service', 'at'] as const) { if (event[key] !== undefined && typeof event[key] !== 'string') { throw new Error('Invalid event detail'); } }
            result.events.push(event);
        } catch { if (result.invalidLines.length < 100) { result.invalidLines.push(line + 1); } }
    }
    return result;
}

export function taskLifetimes(events: readonly TaskTraceEvent[]): TaskLifetime[] {
    const tasks = new Map<number, TaskLifetime>();
    const get = (id: number, tick: number): TaskLifetime => {
        let task = tasks.get(id); if (!task) { task = { id, first: tick, last: tick, finished: false, events: 0, waits: 0 }; tasks.set(id, task); }
        task.first = Math.min(task.first, tick); task.last = Math.max(task.last, tick); return task;
    };
    for (const event of events) {
        const task = get(event.task, event.tick); task.events++;
        if (event.event === 'spawn' && event.child !== undefined) { const child = get(event.child, event.tick); child.parent = event.task; child.site = event.at; }
        if (event.event === 'finish') { task.finished = true; }
        if (event.event === 'park') { task.waits++; }
    }
    return [...tasks.values()].sort((a, b) => a.id - b.id);
}

export function parseExecutionProfile(text: string): ExecutionProfile {
    const result: ExecutionProfile = { functions: [], tasks: [], stats: {}, tier: [] };
    let section = '';
    for (const line of text.split(/\r\n|\n|\r/)) {
        if (line === 'profile: steps by function') { section = 'functions'; result.functions = []; result.tasks = []; }
        else if (line.startsWith('profile: tasks by spawn site ')) { section = 'tasks'; }
        else if (line.startsWith('stats: ')) {
            result.stats = {};
            for (const part of line.slice(7).split(', ')) { const match = /^(.+?) (\d+)$/.exec(part); if (match) { result.stats[match[1]] = match[2]; } }
        } else if (line.startsWith('tier: ')) { result.tier.push(line.slice(6)); }
        else if (section === 'functions') {
            const match = /^\s{2}(\d+)\s+f(\d+)(?:\s+(.*))?$/.exec(line);
            if (match && integer(Number(match[2]))) { result.functions.push({ steps: match[1], id: Number(match[2]), name: match[3] ?? `f${match[2]}` }); }
        } else if (section === 'tasks') {
            const match = /^\s{2}(.+?)\s+tasks (\d+)\s+steps (\d+)\s+runnable (\d+)\s+channel (\d+)\s+host (\d+)$/.exec(line);
            if (match) { result.tasks.push({ site: match[1], tasks: match[2], steps: match[3], runnable: match[4], channel: match[5], host: match[6] }); }
        }
    }
    return result;
}

export function pathWithinWorkspace(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve symlinks before applying the workspace fence. Imported external source is never opened implicitly. */
export async function resolveWorkspaceSource(root: string, source: SourcePoint, extraRoots: readonly string[] = []): Promise<string | undefined> {
    if (!sourcePoint(source) || source.path.includes('\0')) { return undefined; }
    const canonicalRoot = await fs.realpath(root);
    const candidates = path.isAbsolute(source.path) ? [source.path] : [root, ...extraRoots].map(base => path.resolve(base, source.path));
    for (const candidate of candidates) {
        try { const canonical = await fs.realpath(candidate); if (pathWithinWorkspace(canonicalRoot, canonical) && (await fs.stat(canonical)).isFile()) { return canonical; } } catch { /* Try the next explicit source root. */ }
    }
    return undefined;
}

const script = `const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-source],button[data-graph]');if(!button)return;if(button.dataset.source!==undefined)api.postMessage({type:'source',index:Number(button.dataset.source)});if(button.dataset.graph!==undefined)api.postMessage({type:'graph',id:Number(button.dataset.graph)});});document.querySelector('#graph')?.addEventListener('change',event=>api.postMessage({type:'graph',id:Number(event.target.value)}));for(const select of document.querySelectorAll('[data-trace-filter]'))select.addEventListener('change',()=>api.postMessage({type:'traceFilter',task:document.querySelector('#task').value,event:document.querySelector('#event').value}));`;
const styles = `body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);line-height:1.55;padding:1.25rem 1.75rem}h1,h2,h3{line-height:1.3}small,.muted{color:var(--vscode-descriptionForeground)}button,select{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);padding:.35rem .6rem;border-radius:3px;max-width:100%}button{cursor:pointer}button:hover{border-color:var(--vscode-focusBorder)}:focus{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.controls{display:flex;gap:.8rem;flex-wrap:wrap;align-items:center;margin:1rem 0}.stats{display:flex;gap:.6rem;flex-wrap:wrap}.stat{padding:.5rem .8rem;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border);border-radius:5px}.stat strong{display:block}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;vertical-align:top;padding:.45rem .65rem;border-bottom:1px solid var(--vscode-widget-border)}th{background:var(--vscode-editorGroupHeader-tabsBackground)}td code{overflow-wrap:anywhere}code,pre{font-family:var(--vscode-editor-font-family)}pre{white-space:pre-wrap;padding:1rem;background:var(--vscode-textCodeBlock-background)}.scroll{overflow:auto;max-height:70vh;border:1px solid var(--vscode-widget-border);margin:1rem 0}.edge{fill:none;stroke:var(--vscode-charts-blue);stroke-opacity:.45;stroke-width:1}.edge.negative{stroke:var(--vscode-charts-red)}.node rect{fill:var(--vscode-editor-background);stroke:var(--vscode-charts-blue);stroke-width:1.5}.node.relu rect{stroke:var(--vscode-charts-purple)}.node.input rect{stroke:var(--vscode-charts-green)}.node.output rect{stroke:var(--vscode-charts-orange);stroke-width:3}.node text{font-size:11px;fill:var(--vscode-editor-foreground)}.notice{border-left:3px solid var(--vscode-editorInfo-foreground);padding:.5rem 1rem;background:var(--vscode-textCodeBlock-background)}.warning{border-color:var(--vscode-editorWarning-foreground)}.bar{height:8px;background:var(--vscode-charts-blue);min-width:1px}.bar.wait{background:var(--vscode-charts-orange)}meter{display:block;width:100%;height:12px;accent-color:var(--vscode-charts-blue)}.timeline{fill:var(--vscode-charts-blue)}.timeline.finished{fill:var(--vscode-charts-green)}svg text{fill:var(--vscode-editor-foreground);font-size:11px}.timeline-grid{stroke:var(--vscode-widget-border)}details{margin:1rem 0}summary{cursor:pointer}`;
function page(title: string, body: string): string {
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; base-uri 'none'; form-action 'none';"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${styles}</style></head><body><h1>${escapeHtml(title)}</h1>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}
const sourceButton = (source: SourcePoint, links: SourceLink[], label?: string): string => { const index = links.push({ source, label: label ?? source.path }) - 1; return `<button data-source="${index}" title="Open source inside this workspace">${escapeHtml(label ?? `${source.path}:${source.line}`)}</button>`; };

export function renderCircuitExplorer(image: CircuitImage): { html: string; links: SourceLink[] } {
    const links: SourceLink[] = [], graph = image.graph;
    const totals = image.graphs.reduce((sum, value) => ({ neurons: sum.neurons + value.neurons, edges: sum.edges + value.edges }), { neurons: 0, edges: 0 });
    const overview = `<p class="muted">${escapeHtml(path.basename(image.path))} · NVR 1.${Number(image.minorVersion) || 0} · source metadata is optional</p><div class="stats">${[[image.graphs.length, 'graphs'], [totals.neurons, 'neurons'], [totals.edges, 'weighted edges'], [image.functions.length, 'functions'], [image.imports.length, 'host imports']].map(([value, label]) => `<div class="stat"><strong>${count(Number(value))}</strong>${label}</div>`).join('')}</div>`;
    const selector = `<div class="controls"><label for="graph">Graph</label><select id="graph">${image.graphs.map(value => `<option value="${value.id}"${value.id === graph?.id ? ' selected' : ''}>g${value.id} — ${count(value.neurons)} neurons / ${count(value.edges)} edges</option>`).join('')}</select></div>`;
    let detail = '<p>Select a graph to inspect its circuit.</p>';
    if (graph) {
        const diagram = circuitDiagram(graph);
        detail = `<h2>Graph ${graph.id}</h2><p>${count(graph.inputLanes)} input lanes · ${count(graph.outputs.length)} output lanes. Green outlines mark inputs, purple marks ReLU, orange marks outputs; negative weights use red edges. Hover edges and neurons for exact integer values.</p>${diagram.truncated ? `<p class="notice warning">Bounded view: ${count(diagram.neurons)} of ${count(graph.totalNeurons)} neurons and ${count(diagram.edges)} of ${count(graph.totalEdges)} edges shown. The artifact is unchanged.</p>` : ''}<div class="scroll">${diagram.svg}</div><details><summary>Accessible neuron and weight tables</summary><p class="muted">Showing ${Math.min(graph.neurons.length, 500)} available neuron records and ${Math.min(graph.edges.length, 1500)} available edge records.</p><table><thead><tr><th>Neuron</th><th>Wire</th><th>Activation</th><th>Exact bias</th></tr></thead><tbody>${graph.neurons.slice(0, 500).map(neuron => `<tr><td>n${neuron.id}</td><td>w${neuron.wire}</td><td>${escapeHtml(neuron.activation)}</td><td><code>${escapeHtml(neuron.bias)}</code></td></tr>`).join('')}</tbody></table><table><thead><tr><th>From wire</th><th>To wire</th><th>Exact weight</th></tr></thead><tbody>${graph.edges.slice(0, 1500).map(edge => `<tr><td>w${edge.from}</td><td>w${edge.to}</td><td><code>${escapeHtml(edge.weight)}</code></td></tr>`).join('')}</tbody></table></details>`;
    }
    const functions = `<h2>Functions and source mappings</h2>${image.functions.length > 500 ? '<p class="notice">The first 500 functions are shown.</p>' : ''}<table><thead><tr><th>Function</th><th>Blocks / circuit graphs</th><th>Source</th></tr></thead><tbody>${image.functions.slice(0, 500).map(fn => { const sources = fn.blocks.filter(block => block.source).slice(0, 4); return `<tr><td><code>f${fn.id} ${escapeHtml(fn.name)}</code></td><td>${fn.blocks.slice(0, 20).map(block => `<button data-graph="${block.graph}">b${block.id} → g${block.graph}</button>`).join(' ')}${fn.blocks.length > 20 ? ` +${fn.blocks.length - 20} blocks` : ''}</td><td>${sources.length ? sources.map(block => sourceButton(block.source!, links)).join(' ') : 'No source metadata'}</td></tr>`; }).join('')}</tbody></table>`;
    const imports = `<details><summary>Host imports (${image.imports.length})</summary><ul>${image.imports.map(item => `<li><code>${escapeHtml(item.name)}</code></li>`).join('')}</ul></details>`;
    return { html: page('Neura Circuit Explorer', overview + selector + detail + functions + imports), links };
}

export function renderTaskTrace(trace: TaskTrace, title: string, filter: { task?: number; event?: string } = {}): { html: string; links: SourceLink[] } {
    const links: SourceLink[] = [], lifetimes = taskLifetimes(trace.events), tasks = lifetimes.map(task => task.id), kinds = [...new Set(trace.events.map(event => event.event))].sort();
    const filtered = trace.events.filter(event => (filter.task === undefined || event.task === filter.task || (event.event === 'spawn' && event.child === filter.task)) && (!filter.event || event.event === filter.event));
    const first = trace.events.reduce((value, event) => Math.min(value, event.tick), Infinity), last = trace.events.reduce((value, event) => Math.max(value, event.tick), 0), extent = Math.max(1, last - (Number.isFinite(first) ? first : 0));
    const visibleTasks = lifetimes.filter(task => filter.task === undefined || task.id === filter.task).slice(0, 100);
    const timeline = `<svg role="img" aria-label="Task lifetime timeline in scheduler ticks" viewBox="0 0 1000 ${Math.max(60, visibleTasks.length * 30 + 35)}" width="1000" height="${Math.max(60, visibleTasks.length * 30 + 35)}"><title>Task lifetime by deterministic scheduler tick; not wall-clock time</title>${visibleTasks.map((task, row) => { const x = 100 + (task.first - first) / extent * 850, width = Math.max(2, (task.last - task.first) / extent * 850); return `<text x="5" y="${row * 30 + 22}">task ${task.id}</text><rect class="timeline${task.finished ? ' finished' : ''}" x="${x.toFixed(2)}" y="${row * 30 + 9}" width="${width.toFixed(2)}" height="17"><title>task ${task.id}, ticks ${task.first}–${task.last}; ${task.finished ? 'finished' : 'last observed event, completion not recorded'}</title></rect>`; }).join('')}</svg>`;
    const notices = `${trace.omitted ? `<p class="notice warning">${count(trace.omitted)} lines omitted after the ${count(trace.events.length)}-event analysis limit.</p>` : ''}${trace.invalidLines.length ? `<p class="notice warning">Invalid or unsupported records at lines ${trace.invalidLines.join(', ')}${trace.invalidLines.length >= 100 ? ' (first 100 shown)' : ''}.</p>` : ''}${filtered.length > 2000 ? `<p class="notice">Showing the first 2,000 of ${count(filtered.length)} matching events. Narrow the filters to inspect more.</p>` : ''}`;
    const controls = `<div class="controls"><label for="task">Task</label><select id="task" data-trace-filter><option value="">All tasks</option>${tasks.map(task => `<option value="${task}"${task === filter.task ? ' selected' : ''}>${task}</option>`).join('')}</select><label for="event">Event</label><select id="event" data-trace-filter><option value="">All events</option>${kinds.map(kind => `<option${kind === filter.event ? ' selected' : ''}>${escapeHtml(kind)}</option>`).join('')}</select></div>`;
    const rows = filtered.slice(0, 2000).map(event => { const details: string[] = []; for (const key of ['child', 'channel', 'scope', 'timer', 'request', 'reason', 'cause', 'service'] as const) { if (event[key] !== undefined) { details.push(`${key}: ${event[key]}`); } } const source = event.at && parseSourceLocation(event.at); return `<tr><td>${event.tick}</td><td>${event.task}</td><td>${escapeHtml(event.event)}</td><td>${escapeHtml(details.join(' · '))}</td><td>${source ? sourceButton(source, links) : escapeHtml(event.at ?? '')}</td></tr>`; }).join('');
    const wall = trace.events.some(event => event.wall_ns !== undefined) ? ' This trace also contains recorded wall-clock timestamps; the timeline deliberately uses scheduler ticks.' : '';
    return { html: page(title, `<p>Events from <code>neura run --trace-events</code>. Lifetimes span each task’s first and last recorded event; green means a finish event was observed. Ticks are scheduler decisions, not elapsed time.${wall}</p><div class="stats"><div class="stat"><strong>${count(trace.events.length)}</strong>events</div><div class="stat"><strong>${count(lifetimes.length)}</strong>tasks</div><div class="stat"><strong>${Number.isFinite(first) ? first : 0}–${last}</strong>scheduler ticks</div></div>${notices}${controls}<div class="scroll">${timeline}</div><table><thead><tr><th>Tick</th><th>Task</th><th>Event</th><th>Details</th><th>Spawn/source site</th></tr></thead><tbody>${rows}</tbody></table>`), links };
}

export function parseSourceLocation(value: string): SourcePoint | undefined {
    const match = /^(.*):(\d+):(\d+)$/.exec(value); if (!match) { return undefined; }
    const source = { path: match[1], line: Number(match[2]), column: Number(match[3]) }; return sourcePoint(source) ? source : undefined;
}
function percent(value: string, total: string): number { const denominator = BigInt(total); return denominator === 0n ? 0 : Number(BigInt(value) * 10000n / denominator) / 100; }

export function renderExecutionProfile(profile: ExecutionProfile, title: string, image?: CircuitImage, exitCode = 0): { html: string; links: SourceLink[] } {
    const links: SourceLink[] = [], total = profile.stats.steps ?? profile.functions.reduce((sum, fn) => sum + BigInt(fn.steps), 0n).toString();
    const fnRows = profile.functions.map(fn => { const metadata = image?.functions.find(value => value.id === fn.id); const block = metadata?.blocks.find(value => value.id === metadata.entry && value.source) ?? metadata?.blocks.find(value => value.source); return `<tr><td><code>f${fn.id} ${escapeHtml(fn.name)}</code></td><td>${escapeHtml(fn.steps)}</td><td>${percent(fn.steps, total).toFixed(2)}%<meter min="0" max="100" value="${Math.min(100, percent(fn.steps, total))}" aria-label="Share of execution steps">${percent(fn.steps, total).toFixed(2)}%</meter></td><td>${block?.source ? sourceButton(block.source, links) : 'No source metadata'}</td></tr>`; }).join('');
    const tasks = profile.tasks.length ? `<h2>Task costs by spawn site</h2><p>Wait columns count scheduling decisions while tasks were runnable, on channels/timers, or on host I/O; they are not nanoseconds.</p><table><thead><tr><th>Spawn site</th><th>Tasks</th><th>Steps</th><th>Runnable ticks</th><th>Channel/timer ticks</th><th>Host I/O ticks</th></tr></thead><tbody>${profile.tasks.map(task => { const source = parseSourceLocation(task.site); return `<tr><td>${source ? sourceButton(source, links) : escapeHtml(task.site)}</td><td>${task.tasks}</td><td>${task.steps}</td><td>${task.runnable}</td><td>${task.channel}</td><td>${task.host}</td></tr>`; }).join('')}</tbody></table>` : '';
    return { html: page(title, `<p>Deterministic execution cost from the Neura runner. Function costs are aggregated execution steps, not line-level timings or CPU sampling. The runner lists up to its 25 busiest functions.</p>${exitCode ? `<p class="notice warning">The program exited with status ${exitCode}. These are the costs recorded before it stopped.</p>` : ''}<div class="stats">${Object.entries(profile.stats).map(([label, value]) => `<div class="stat"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join('')}</div><h2>Function cost heatmap</h2><table><thead><tr><th>Function</th><th>Execution steps</th><th>Share of all steps</th><th>Entry source</th></tr></thead><tbody>${fnRows || '<tr><td colspan="4">No function profile was present in the runner output.</td></tr>'}</tbody></table>${tasks}${profile.tier.length ? `<details><summary>Execution tier diagnostics</summary><pre>${escapeHtml(profile.tier.join('\n'))}</pre><p class="muted">Tier proof/search durations are measured diagnostics and can vary across runs.</p></details>` : ''}`), links };
}

export function registerInsights(context: vscode.ExtensionContext, runtime: Runtime, output: vscode.OutputChannel): void {
    const register = (id: string, callback: (value?: vscode.Uri | string) => Promise<void>): void => { context.subscriptions.push(vscode.commands.registerCommand(id, async (value?: vscode.Uri | string) => { try { await callback(value); } catch (error) { if (!(error instanceof vscode.CancellationError)) { output.appendLine(`${id}: ${String(error)}`); void vscode.window.showErrorMessage(`Neura: ${error instanceof Error ? error.message : String(error)}`); } } })); };
    const toUri = (value: vscode.Uri | string): vscode.Uri => typeof value === 'string' ? value.includes('://') ? vscode.Uri.parse(value) : vscode.Uri.file(value) : value;
    const showSource = async (link: SourceLink | undefined, folder: vscode.WorkspaceFolder, roots: string[] = []): Promise<void> => {
        if (!link) { return; } let resolved = await resolveWorkspaceSource(folder.uri.fsPath, link.source, roots);
        if (!resolved && !path.isAbsolute(link.source.path)) {
            const suffix = link.source.path.replace(/\\/g, '/');
            if (!suffix.split('/').includes('..') && !/[\[\]*?{}]/.test(suffix)) {
                const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${suffix}`), '**/{.git,node_modules,.neura-vscode}/**', 2);
                if (matches.length === 1) { resolved = await resolveWorkspaceSource(folder.uri.fsPath, { ...link.source, path: matches[0].fsPath }); }
            }
        }
        if (!resolved) { void vscode.window.showInformationMessage('This source mapping does not resolve uniquely to a file inside the current workspace.'); return; }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved)), line = Math.min(link.source.line - 1, Math.max(0, document.lineCount - 1));
        const character = Array.from(document.lineAt(line).text).slice(0, link.source.column - 1).join('').length;
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, character, line, character), preview: true });
    };
    const inspect = async (executable: string, artifact: vscode.Uri, folder: vscode.WorkspaceFolder, graph?: number, token?: vscode.CancellationToken): Promise<CircuitImage> => {
        const result = await runProcess(executable, ['inspect-image', '--json', artifact.fsPath, ...(graph === undefined ? [] : ['--graph', String(graph), '--limit', '350'])], { cwd: folder.uri.fsPath, token, timeoutMs: 30000, maxOutputBytes: 32 * 1024 * 1024 });
        if (result.cancelled) { throw new vscode.CancellationError(); } if (result.code !== 0) { throw new Error(result.stderr || 'Image inspection requires a compatible Neura tooling release.'); } return parseCircuitImage(result.stdout);
    };
    register('neura.circuitExplorer', async value => {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before inspecting artifacts with Neura.'); }
        let artifact = value ? toUri(value) : undefined;
        if (!artifact && vscode.window.activeTextEditor?.document.uri.path.endsWith('.nvr')) { artifact = vscode.window.activeTextEditor.document.uri; }
        if (!artifact) {
            const files = await vscode.workspace.findFiles('**/*.nvr', '**/{.git,node_modules}/**', 500);
            const selected = await vscode.window.showQuickPick([{ label: 'Build current target', description: 'Build an NVM application and explore its circuit', uri: undefined }, ...files.map(uri => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri }))], { title: 'Neura Circuit Explorer' });
            if (!selected) { return; } artifact = selected.uri;
            if (!artifact) { const built = await runtime.build(); if (!built) { return; } artifact = vscode.Uri.file(built.artifact); }
        }
        if (!artifact.path.endsWith('.nvr')) { throw new Error('Circuit Explorer requires an .nvr image.'); }
        const folder = vscode.workspace.getWorkspaceFolder(artifact) ?? vscode.workspace.workspaceFolders?.[0]; if (!folder) { throw new Error('Open a workspace folder first.'); }
        const executable = await runtime.getExecutable(folder); if (!executable) { return; }
        let image = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Inspect Neura circuit', cancellable: true }, async (_progress, token) => { const summary = await inspect(executable, artifact!, folder, undefined, token); const selected = summary.graphs.reduce<CircuitGraphSummary | undefined>((largest, graph) => !largest || graph.neurons > largest.neurons ? graph : largest, undefined); return selected ? inspect(executable, artifact!, folder, selected.id, token) : summary; });
        const panel = vscode.window.createWebviewPanel('neura.circuit', `Circuit: ${path.basename(artifact.fsPath)}`, vscode.ViewColumn.Beside, { enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
        let rendered = renderCircuitExplorer(image), request = 0; let graphCancellation = new vscode.CancellationTokenSource(); panel.webview.html = rendered.html;
        const receive = panel.webview.onDidReceiveMessage(async (message: unknown) => {
            if (!message || typeof message !== 'object') { return; } const event = message as { type?: string; id?: number; index?: number };
            try {
                if (event.type === 'source' && integer(event.index)) { await showSource(rendered.links[event.index], folder); }
                if (event.type === 'graph' && integer(event.id) && image.graphs.some(graph => graph.id === event.id)) { const current = ++request; graphCancellation.cancel(); graphCancellation.dispose(); graphCancellation = new vscode.CancellationTokenSource(); const next = await inspect(executable, artifact!, folder, event.id, graphCancellation.token); if (current === request) { image = next; rendered = renderCircuitExplorer(image); panel.webview.html = rendered.html; } }
            } catch (error) { if (!(error instanceof vscode.CancellationError)) { output.appendLine(`Circuit Explorer: ${String(error)}`); void vscode.window.showErrorMessage(String(error)); } }
        });
        panel.onDidDispose(() => { request++; graphCancellation.cancel(); graphCancellation.dispose(); receive.dispose(); }); context.subscriptions.push(panel, receive);
    });
    register('neura.openTaskTrace', async value => {
        const uri = value ? toUri(value) : (await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Open Neura scheduler trace', filters: { 'Scheduler events': ['jsonl', 'ndjson'] } }))?.[0]; if (!uri) { return; }
        const stat = await vscode.workspace.fs.stat(uri); if (stat.size > 32 * 1024 * 1024) { throw new Error('This trace exceeds the 32 MiB viewer limit. Capture a shorter trace or inspect it with a streaming tool.'); }
        const trace = parseTaskTrace(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')); if (!trace.events.length) { throw new Error('No scheduler events were found. Open a JSONL file from neura run --trace-events, not a record/replay host trace.'); }
        const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
        const panel = vscode.window.createWebviewPanel('neura.taskTrace', `Tasks: ${path.basename(uri.path)}`, vscode.ViewColumn.Beside, { enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
        let rendered = renderTaskTrace(trace, path.basename(uri.path)); panel.webview.html = rendered.html;
        const taskIds = new Set(taskLifetimes(trace.events).map(task => task.id)), kinds = new Set(trace.events.map(event => event.event));
        const receive = panel.webview.onDidReceiveMessage(async (message: unknown) => {
            if (!message || typeof message !== 'object') { return; } const event = message as { type?: string; index?: number; task?: string; event?: string };
            if (event.type === 'source' && integer(event.index) && folder) { try { await showSource(rendered.links[event.index], folder); } catch (error) { output.appendLine(String(error)); } }
            if (event.type === 'traceFilter' && typeof event.task === 'string' && typeof event.event === 'string') {
                const task = event.task === '' ? undefined : /^\d+$/.test(event.task) ? Number(event.task) : NaN;
                if ((task !== undefined && !taskIds.has(task)) || (event.event !== '' && !kinds.has(event.event))) { return; }
                rendered = renderTaskTrace(trace, path.basename(uri.path), { task, event: event.event || undefined }); panel.webview.html = rendered.html;
            }
        }); panel.onDidDispose(() => receive.dispose()); context.subscriptions.push(panel, receive);
    });
    register('neura.profileView', async () => {
        const built = await runtime.build(); if (!built) { return; } if (!built.artifact.endsWith('.nvr')) { throw new Error('The profile view requires an NVM application target.'); }
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Profile ${built.target.name}`, cancellable: true }, (_progress, token) => runProcess(built.executable, ['run', ...built.target.runArgs, '--profile', '--stats', '--tier-stats', built.artifact, '--', ...built.target.args], { cwd: built.target.cwd, env: built.target.env, token, timeoutMs: 120000, maxOutputBytes: 32 * 1024 * 1024 }));
        if (result.cancelled) { throw new vscode.CancellationError(); } if (result.stdout) { output.appendLine(result.stdout); } output.appendLine(result.stderr);
        const profile = parseExecutionProfile(result.stderr); if (!profile.functions.length && !Object.keys(profile.stats).length) { throw new Error(result.stderr || 'The runner returned no profile.'); }
        let image: CircuitImage | undefined; try { image = await inspect(built.executable, vscode.Uri.file(built.artifact), built.target.folder); } catch { /* Older toolchains still provide a useful unmapped cost profile. */ }
        const panel = vscode.window.createWebviewPanel('neura.profile', `Profile: ${built.target.name}`, vscode.ViewColumn.Beside, { enableScripts: true, enableCommandUris: false, localResourceRoots: [] }), rendered = renderExecutionProfile(profile, built.target.name, image, result.code);
        panel.webview.html = rendered.html;
        const receive = panel.webview.onDidReceiveMessage(async (message: unknown) => { const event = message as { type?: string; index?: number } | undefined; if (event?.type === 'source' && integer(event.index)) { try { await showSource(rendered.links[event.index], built.target.folder, built.target.sourceRoots.concat(built.target.inputs.map(input => path.dirname(input)))); } catch (error) { output.appendLine(String(error)); } } });
        panel.onDidDispose(() => receive.dispose()); context.subscriptions.push(panel, receive);
    });
}
