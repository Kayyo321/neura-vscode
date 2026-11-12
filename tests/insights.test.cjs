const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const compiled = { exports: {} };
const code = buildSync({ entryPoints: [path.join(__dirname, '../src/insights.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] }).outputFiles[0].text;
new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? {} : require(id), compiled, compiled.exports);
const insights = compiled.exports;
function image() {
  return { version: 1, format: 'NVR', path: '/workspace/app.nvr', minorVersion: 6, entry: 0,
    graphs: [{ id: 0, neurons: 2, edges: 3, inputLanes: 2, outputLanes: 1 }],
    functions: [{ id: 0, name: 'Main.main', entry: 0, blocks: [{ id: 0, graph: 0, source: { path: 'main.nra', line: 4, column: 1 } }] }], imports: [{ name: 'neura.console.write_line' }], sources: ['main.nra'],
    graph: { id: 0, inputLanes: 2, neurons: [{ id: 0, wire: 2, activation: 'identity', bias: '-9223372036854775808' }, { id: 1, wire: 3, activation: 'relu', bias: '0' }], edges: [{ from: 0, to: 2, weight: '9223372036854775807' }, { from: 1, to: 2, weight: '-3' }, { from: 2, to: 3, weight: '1' }], outputs: [3], totalNeurons: 2, totalEdges: 3, truncated: false } };
}
test('circuit schema preserves exact signed integer weights and distinguishes input/neuronal wires', () => {
  const parsed = insights.parseCircuitImage(JSON.stringify(image()));
  assert.equal(parsed.graph.edges[0].weight, '9223372036854775807');
  assert.equal(parsed.graph.neurons[0].bias, '-9223372036854775808');
  const diagram = insights.circuitDiagram(parsed.graph);
  assert.equal(diagram.neurons, 2); assert.equal(diagram.edges, 3); assert.equal(diagram.truncated, false);
  for (const label of ['Input lane 0', 'Neuron 0; wire 2', 'weight 9223372036854775807', 'weight -3']) assert.ok(diagram.svg.includes(label), label);
  assert.ok(diagram.svg.includes('node relu output'));
});
test('circuit rendering bounds large diagrams and reports truncation', () => {
  const graph = { id: 0, inputLanes: 1, neurons: Array.from({ length: 1000 }, (_, id) => ({ id, wire: id + 1, activation: 'identity', bias: '0' })), edges: Array.from({ length: 1000 }, (_, id) => ({ from: id, to: id + 1, weight: '1' })), outputs: [1000], totalNeurons: 1000, totalEdges: 1000, truncated: false };
  const diagram = insights.circuitDiagram(graph, 10, 5);
  assert.equal(diagram.neurons, 10); assert.equal(diagram.edges, 5); assert.equal(diagram.truncated, true);
  assert.ok(diagram.svg.length < 20000);
});
test('invalid or future circuit schemas fail clearly', () => {
  assert.throws(() => insights.parseCircuitImage(JSON.stringify({ ...image(), version: 2 })));
  const invalid = image(); invalid.graph.edges[0].weight = 9223372036854776000;
  assert.throws(() => insights.parseCircuitImage(JSON.stringify(invalid)));
  const brokenSource = image(); brokenSource.functions[0].blocks[0].source.line = 0;
  assert.throws(() => insights.parseCircuitImage(JSON.stringify(brokenSource)));
});
test('circuit explorer escapes metadata and offers real graph and workspace source actions', () => {
  const data = image(); data.functions[0].name = '</script><img src=x onerror=evil()>'; data.imports[0].name = '<script>evil</script>';
  const rendered = insights.renderCircuitExplorer(data);
  assert.ok(rendered.html.includes('&lt;/script&gt;&lt;img'));
  assert.equal((rendered.html.match(/<script nonce=/g) || []).length, 1);
  assert.ok(!rendered.html.includes('<img src=x'));
  assert.ok(rendered.html.includes('data-graph="0"'));
  assert.equal(rendered.links[0].source.path, 'main.nra');
  assert.ok(rendered.html.includes("default-src 'none'"));
  assert.ok(rendered.html.includes("img-src 'none'"));
  assert.ok(!rendered.html.includes('command:'));
});
test('scheduler trace parsing validates identities, reports malformed lines and limits analysis', () => {
  const lines = [JSON.stringify({ event: 'spawn', tick: 0, task: 0, child: 1, at: 'worker.nra:3:9' }), 'not json', JSON.stringify({ event: 'park', tick: 3, task: 1, reason: 'channel 2' }), JSON.stringify({ event: 'finish', tick: 5, task: 1 })].join('\n');
  const trace = insights.parseTaskTrace(lines, 2);
  assert.equal(trace.events.length, 2); assert.deepEqual(trace.invalidLines, [2]); assert.equal(trace.omitted, 1); assert.equal(trace.totalLines, 4);
  const malformed = insights.parseTaskTrace('{"event":"start","tick":1,"task":-1}\n{"event":"start","tick":9007199254740992,"task":0}');
  assert.equal(malformed.events.length, 0); assert.deepEqual(malformed.invalidLines, [1, 2]);
});
test('task lifetime model includes spawn parentage, waits, completion and incomplete observations', () => {
  const tasks = insights.taskLifetimes([{ event: 'spawn', tick: 1, task: 0, child: 2, at: 'worker.nra:3:9' }, { event: 'start', tick: 2, task: 2 }, { event: 'park', tick: 4, task: 2, reason: 'channel' }, { event: 'wake', tick: 7, task: 2 }, { event: 'finish', tick: 9, task: 2 }]);
  assert.deepEqual(tasks[1], { id: 2, first: 1, last: 9, finished: true, events: 4, waits: 1, parent: 0, site: 'worker.nra:3:9' });
  assert.equal(tasks[0].finished, false);
});
test('trace viewer filters actual events and identifies scheduler ticks rather than wall time', () => {
  const trace = insights.parseTaskTrace([{ event: 'spawn', tick: 0, task: 0, child: 1, at: 'worker.nra:3:9', wall_ns: 1900000000000000000 }, { event: 'park', tick: 4, task: 1, reason: '<script>evil</script>' }, { event: 'finish', tick: 9, task: 1 }].map(JSON.stringify).join('\n'));
  const rendered = insights.renderTaskTrace(trace, '<tasks>', { task: 1, event: 'park' });
  assert.ok(rendered.html.includes('&lt;script&gt;evil&lt;/script&gt;'));
  assert.ok(rendered.html.includes('scheduler decisions, not elapsed time'));
  assert.ok(rendered.html.includes('wall-clock timestamps'));
  assert.ok(rendered.html.includes('value="1" selected'));
  assert.ok(!rendered.html.includes('<td>spawn</td>'));
  assert.ok(rendered.html.includes('<td>park</td>'));
});
test('execution profile parser follows real runner sections without losing large counters', () => {
  const profile = insights.parseExecutionProfile('program output\nprofile: steps by function\n  999  f99  not the final profile\nstats: steps 18014398509481986, peak heap cells 17, host requests 2, graphs 3, neurons 4, edges 5, image bytes 600\ntier: blocks 2, lifted 1\nprofile: steps by function\n  9007199254740993  f0  Main.main\n  9007199254740993  f1  Worker.run\nprofile: tasks by spawn site (steps executed; ticks runnable, on channels, on host I/O)\n  worker.nra:3:9  tasks 2  steps 8  runnable 4  channel 7  host 1\n');
  assert.equal(profile.functions.length, 2); assert.equal(profile.functions[0].steps, '9007199254740993'); assert.equal(profile.functions[0].id, 0);
  assert.equal(profile.stats.steps, '18014398509481986'); assert.equal(profile.stats['peak heap cells'], '17');
  assert.deepEqual(profile.tasks[0], { site: 'worker.nra:3:9', tasks: '2', steps: '8', runnable: '4', channel: '7', host: '1' });
  const rendered = insights.renderExecutionProfile(profile, 'Cost', image(), 134);
  assert.ok(rendered.html.includes('50.00%'));
  assert.ok(rendered.html.includes('9007199254740993'));
  assert.ok(rendered.html.includes('not line-level timings'));
  assert.ok(rendered.html.includes('status 134'));
  assert.ok(rendered.html.includes('<meter min="0" max="100" value="50"'));
  assert.ok(!rendered.html.includes('style="width:'));
  assert.ok(rendered.links.some(link => link.source.path === 'main.nra'));
});
test('source location parsing keeps colon-containing paths and rejects locations without positions', () => {
  assert.deepEqual(insights.parseSourceLocation('src/worker.nra:3:9'), { path: 'src/worker.nra', line: 3, column: 9 });
  assert.deepEqual(insights.parseSourceLocation('C:\\source\\worker.nra:12:5'), { path: 'C:\\source\\worker.nra', line: 12, column: 5 });
  assert.equal(insights.parseSourceLocation('function 2 block 3'), undefined);
  assert.equal(insights.parseSourceLocation('file.nra:0:1'), undefined);
});
test('source navigation uses canonical workspace containment, rejecting traversal and symlink escapes', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-insights-test-'));
  try {
    const root = path.join(temporary, 'workspace'), outside = path.join(temporary, 'outside.nra');
    await fs.mkdir(path.join(root, 'src'), { recursive: true }); await fs.writeFile(path.join(root, 'src/main.nra'), 'let x = 1;'); await fs.writeFile(outside, 'private');
    await fs.symlink(outside, path.join(root, 'escape.nra'));
    const point = { path: 'src/main.nra', line: 1, column: 1 };
    assert.equal(await insights.resolveWorkspaceSource(root, point), await fs.realpath(path.join(root, 'src/main.nra')));
    assert.equal(await insights.resolveWorkspaceSource(root, { ...point, path: 'escape.nra' }), undefined);
    assert.equal(await insights.resolveWorkspaceSource(root, { ...point, path: '../outside.nra' }), undefined);
    assert.equal(await insights.resolveWorkspaceSource(root, { ...point, path: outside }), undefined);
    assert.equal(insights.pathWithinWorkspace(root, root + '-other/file.nra'), false);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
