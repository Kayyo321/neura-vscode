const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const esbuild = require('esbuild');

class Source {
  constructor() {
    this.callbacks = new Set();
    this.token = { isCancellationRequested: false, onCancellationRequested: callback => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; } };
  }
  cancel() { this.token.isCancellationRequested = true; for (const callback of this.callbacks) callback(); }
  dispose() { this.callbacks.clear(); }
}
class Collection {
  constructor(parent) { this.parent = parent; this.values = new Map(); }
  get size() { return this.values.size; }
  add(item) { item.parent = this.parent; this.values.set(item.id, item); }
  get(id) { return this.values.get(id); }
  delete(id) { this.values.delete(id); }
  forEach(callback) { this.values.forEach(callback); }
  replace(items) { this.values.clear(); for (const item of items) this.add(item); }
}
const disposable = () => ({ dispose() {} });
const uriFor = filename => ({ fsPath: filename, path: filename, toString: () => `file://${filename}` });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-testing-'));
  const filename = path.join(directory, 'tests.nra');
  const text = 'let Tests = module (let text = "😀"; export let test_first = func() -> void {}; export let test_second = func() -> void {};);\n';
  await fs.writeFile(filename, text);
  const folder = { name: 'project', index: 0, uri: uriFor(directory) };
  const callbacks = new Map(), profiles = new Map(), profileObjects = new Map(), events = [], messages = [], watchers = {}, covered = [];
  const context = { subscriptions: [] }, savedFolders = [];
  const settings = { 'testing.include': ['**/*.nra'], 'testing.watch': false };
  let controller, calls = 0, failure = false, capabilities = true, executeBehavior, allowSave = true;
  const findRequests = [], processArgs = [], processOptions = [];
  let foundFiles = [uriFor(filename)];
  const exclusions = { files: {}, search: {} };
  const records = [
    { id: 'tests.nra::Tests.test_first', name: 'Tests.test_first', file: filename, line: 1, column: [...text.slice(0, text.indexOf('test_first'))].length + 1 },
    { id: 'tests.nra::Tests.test_second', name: 'Tests.test_second', file: filename, line: 1, column: [...text.slice(0, text.indexOf('test_second'))].length + 1 },
  ];
  const vscode = {
    Uri: { file: uriFor, parse: value => uriFor(value.replace(/^file:\/\//, '')) },
    Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    TestMessage: class { constructor(message) { this.message = message; } static diff(message, expected, actual) { return { message, expected, actual }; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    CancellationTokenSource: Source,
    TestRunRequest: class { constructor(include, exclude) { this.include = include; this.exclude = exclude; } },
    FileCoverage: class { constructor(uri, statementCoverage, branchCoverage, declarationCoverage) { Object.assign(this, { uri, statementCoverage, branchCoverage, declarationCoverage }); } },
    StatementCoverage: class { constructor(executed, location) { Object.assign(this, { executed, location }); } },
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    window: { showInformationMessage: async value => messages.push(value), showWarningMessage: async value => messages.push(value), showQuickPick: async () => undefined },
    commands: { registerCommand: (name, callback) => { callbacks.set(name, callback); return disposable(); } },
    debug: { startDebugging: async () => true },
    workspace: {
      isTrusted: true, workspaceFolders: [folder], textDocuments: [],
      getConfiguration: section => ({ get: (key, fallback) => section === 'neura' ? settings[key] ?? fallback : exclusions[section]?.[key] ?? fallback }),
      getWorkspaceFolder: uri => uri.fsPath.startsWith(directory) ? folder : undefined,
      findFiles: async (...args) => { findRequests.push(args); return foundFiles; },
      onDidChangeWorkspaceFolders: () => disposable(),
      onDidChangeConfiguration: callback => { watchers.configuration = callback; return disposable(); },
      onDidGrantWorkspaceTrust: callback => { watchers.trust = callback; return disposable(); },
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: callback => { watchers.create = callback; return disposable(); },
        onDidDelete: callback => { watchers.delete = callback; return disposable(); }, onDidChange: callback => { watchers.change = callback; return disposable(); } }),
    },
    tests: { createTestController: () => {
      controller = { ...disposable(), items: new Collection(),
        createTestItem: (id, label, uri) => { const item = { id, label, uri }; item.children = new Collection(item); return item; },
        createRunProfile: (name, _kind, callback) => { profiles.set(name, callback); const profile = disposable(); profileObjects.set(name, profile); return profile; },
        createTestRun: () => ({ end: () => events.push(['end']), appendOutput: text => events.push(['output', text]),
          addCoverage: value => covered.push(value),
          ...Object.fromEntries(['enqueued', 'started', 'passed', 'failed', 'skipped', 'errored'].map(method => [method, item => events.push([method, item.id])])) }),
      }; return controller;
    } },
  };
  class Decoder {
    constructor(receive) { this.receive = receive; this.pending = ''; }
    push(chunk) { this.pending += chunk; while (this.pending.includes('\n')) { const index = this.pending.indexOf('\n'); const line = this.pending.slice(0, index); this.pending = this.pending.slice(index + 1); if (line) this.receive(JSON.parse(line)); } }
    finish() { if (this.pending) this.receive(JSON.parse(this.pending)); }
  }
  const runner = async (_executable, args, options) => {
    calls++; processArgs.push(args); processOptions.push(options);
    if (args.includes('--list')) return failure ? { code: 1, stdout: '', stderr: 'source does not type check', cancelled: false }
      : { code: 0, stdout: JSON.stringify({ version: 1, tests: records }), stderr: '', cancelled: false };
    if (executeBehavior) return executeBehavior(options, records, args);
    for (const record of records) options.onStdout(JSON.stringify({ event: 'testResult', id: record.id, state: 'passed' }) + '\n');
    return { code: 0, stdout: '', stderr: '', cancelled: false };
  };
  const stubs = {
    vscode,
    './runtime': { supportsCapability: () => capabilities },
    './runtime/diagnostics': { scalarColumnToUtf16: (line, column) => [...line].slice(0, Math.max(0, column - 1)).join('').length },
    './process': { runProcess: runner, JsonLineDecoder: Decoder },
  };
  const filenameModule = path.resolve(__dirname, '../testing.ts');
  const result = esbuild.buildSync({ entryPoints: [filenameModule], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: Object.keys(stubs) });
  const original = Module._load;
  Module._load = function(request, ...args) { return request in stubs ? stubs[request] : original.call(this, request, ...args); };
  let api;
  try { const loaded = new Module(filenameModule, module); loaded.filename = filenameModule; loaded.paths = module.paths;
    loaded._compile(result.outputFiles[0].text, filenameModule); api = loaded.exports;
  } finally { Module._load = original; }
  const runtime = { toolchains: { discover: async () => ({ executable: '/fake/neura', version: '0.2.1-rc.1', capabilities: {} }) },
    saveSources: async folder => { savedFolders.push(folder.uri.toString()); return allowSave; } };
  api.registerTesting(context, runtime, { appendLine: value => messages.push(value) });
  return { directory, filename, text, records, folder, context, settings, profiles, profileObjects, callbacks, events, messages, watchers, covered, savedFolders,
    controller, findRequests, processArgs, processOptions, exclusions, setFoundFiles: value => foundFiles = value, getCalls: () => calls, setFailure: value => failure = value,
    setCapabilities: value => capabilities = value, setExecute: callback => executeBehavior = callback,
    setSaveResult: value => allowSave = value,
    async dispose() { for (const item of context.subscriptions) item.dispose(); await fs.rm(directory, { recursive: true, force: true }); } };
}

function leaves(h) {
  const result = [];
  const visit = items => items.forEach(item => { if (!item.children.size) result.push(item); else visit(item.children); });
  visit(h.controller.items); return result;
}

test('discovery groups project/file/module and converts scalar columns', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler();
    const project = h.controller.items.get(h.folder.uri.toString());
    assert.ok(project); assert.equal(project.children.size, 1);
    const [first] = leaves(h);
    assert.equal(first.range.start.character, h.text.indexOf('test_first'));
    assert.equal(first.label, 'test_first');
  } finally { await h.dispose(); }
});

test('coverage profile reports real mapped-line totals and detailed counts without branches', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler();
    let generatedPath;
    h.setExecute(async (options, records, args) => {
      const index = args.indexOf('--coverage'); assert.ok(index >= 0); generatedPath = args[index + 1];
      await fs.writeFile(generatedPath, JSON.stringify({ version: 1, granularity: 'mapped-block-line', measurement: 'blockEntries',
        files: [{ path: h.filename, statements: [{ line: 2, count: 4 }, { line: 3, count: 0 }, { line: 5, count: 1 }] }] }));
      for (const record of records) options.onStdout(JSON.stringify({ event: 'testResult', id: record.id, state: 'passed' }) + '\n');
      options.onStdout(JSON.stringify({ event: 'coverage', path: generatedPath }) + '\n');
      return { code: 0, stdout: '', stderr: '', cancelled: false };
    });
    await h.profiles.get('Coverage (mapped source lines)')({}, new Source().token);
    assert.equal(h.covered.length, 1);
    assert.deepEqual(h.covered[0].statementCoverage, { covered: 2, total: 3 });
    assert.equal(h.covered[0].branchCoverage, undefined);
    const details = await h.profileObjects.get('Coverage (mapped source lines)').loadDetailedCoverage({}, h.covered[0], new Source().token);
    assert.deepEqual(details.map(statement => [statement.executed, statement.location.start.line, statement.location.end.line]), [[4, 1, 2], [0, 2, 3], [1, 4, 5]]);
    await assert.rejects(fs.access(generatedPath), /ENOENT/);
  } finally { await h.dispose(); }
});

test('coverage rejects report paths outside its generated workspace directory', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler();
    h.setExecute(async (options, records) => {
      for (const record of records) options.onStdout(JSON.stringify({ event: 'testResult', id: record.id, state: 'passed' }) + '\n');
      options.onStdout(JSON.stringify({ event: 'coverage', path: h.filename }) + '\n');
      return { code: 0, stdout: '', stderr: '', cancelled: false };
    });
    await h.profiles.get('Coverage (mapped source lines)')({}, new Source().token);
    assert.equal(h.covered.length, 0);
    assert.match(h.messages.join('\n'), /unexpected coverage report path/);
    assert.equal(h.events.filter(([event]) => event === 'passed').length, 2, 'coverage failure must preserve test results');
  } finally { await h.dispose(); }
});

test('coverage refuses symlinked generated directories', async () => {
  const h = await harness(); const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-outside-'));
  try {
    await h.controller.refreshHandler();
    await fs.symlink(destination, path.join(h.directory, '.neura-vscode'));
    await h.profiles.get('Coverage (mapped source lines)')({}, new Source().token);
    assert.equal(h.covered.length, 0);
    assert.match(h.messages.join('\n'), /real directory inside the workspace/);
    assert.deepEqual(await fs.readdir(destination), []);
  } finally { await h.dispose(); await fs.rm(destination, { recursive: true, force: true }); }
});

test('coverage validates counts and rejects oversized reports', async () => {
  for (const content of [JSON.stringify({ version: 1, granularity: 'mapped-block-line', measurement: 'blockEntries', files: [{ path: '/source.nra', statements: [{ line: 1, count: -1 }] }] }), ' '.repeat(8 * 1024 * 1024 + 1)]) {
    const h = await harness();
    try {
      await h.controller.refreshHandler();
      h.setExecute(async (options, records, args) => {
        const target = args[args.indexOf('--coverage') + 1]; await fs.writeFile(target, content);
        for (const record of records) options.onStdout(JSON.stringify({ event: 'testResult', id: record.id, state: 'passed' }) + '\n');
        options.onStdout(JSON.stringify({ event: 'coverage', path: target }) + '\n');
        return { code: 0, stdout: '', stderr: '', cancelled: false };
      });
      await h.profiles.get('Coverage (mapped source lines)')({}, new Source().token);
      assert.equal(h.covered.length, 0);
      assert.match(h.messages.join('\n'), /coverage count|size limit/);
    } finally { await h.dispose(); }
  }
});

test('ineligible toolchains never invoke unsupported discovery', async () => {
  const h = await harness();
  try { h.setCapabilities(false); await h.controller.refreshHandler(); assert.equal(h.getCalls(), 0); assert.match(h.messages.join('\n'), /tooling-enabled/); }
  finally { await h.dispose(); }
});

test('test runs save only participating Neura folders and stop when saving is declined', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler(); const calls = h.getCalls(); h.setSaveResult(false);
    await h.profiles.get('Run')({}, new Source().token);
    assert.deepEqual(h.savedFolders, [h.folder.uri.toString()]);
    assert.equal(h.getCalls(), calls, 'declined source save must not execute tests');
    assert.deepEqual(h.events, [], 'declined save must not create a test run');
    h.setSaveResult(true); h.savedFolders.length = 0;
    await h.profiles.get('Run')({}, new Source().token);
    assert.deepEqual(h.savedFolders, [h.folder.uri.toString()], 'one participating folder is saved once even for multiple tests');
  } finally { await h.dispose(); }
});

test('discovery errors preserve previous test children and show a file error', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler(); const previous = leaves(h).map(item => item.id);
    h.setFailure(true); await h.controller.refreshHandler();
    assert.deepEqual(leaves(h).map(item => item.id), previous);
    const project = h.controller.items.get(h.folder.uri.toString());
    assert.match([...project.children.values.values()][0].error, /does not type check/);
  } finally { await h.dispose(); }
});

test('cancellation does not overwrite an already passed test', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler(); const source = new Source();
    h.setExecute(async (options, records) => {
      options.onStdout(JSON.stringify({ event: 'testResult', id: records[0].id, state: 'passed' }) + '\n'); source.cancel();
      return { code: -1, stdout: '', stderr: '', cancelled: true };
    });
    await h.profiles.get('Run')({}, source.token);
    const passed = h.events.find(([event]) => event === 'passed')[1];
    assert.equal(h.events.filter(([event, id]) => id === passed && ['passed', 'skipped', 'errored'].includes(event)).length, 1);
    assert.equal(h.events.filter(([event]) => event === 'skipped').length, 1);
  } finally { await h.dispose(); }
});

test('later process errors do not overwrite completed results', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler();
    h.setExecute(async (options, records) => {
      options.onStdout(JSON.stringify({ event: 'testResult', id: records[0].id, state: 'passed' }) + '\n');
      throw new Error('runner crashed');
    });
    await h.profiles.get('Run')({}, new Source().token);
    assert.equal(h.events.filter(([event]) => event === 'passed').length, 1);
    assert.equal(h.events.filter(([event]) => event === 'errored').length, 1);
  } finally { await h.dispose(); }
});

test('watch reruns previously selected tests after source changes', async () => {
  const h = await harness();
  try {
    await h.controller.refreshHandler(); const first = leaves(h)[0];
    await h.profiles.get('Run')({ include: [first] }, new Source().token);
    h.settings['testing.watch'] = true;
    const before = h.events.filter(([event]) => event === 'end').length;
    await fs.writeFile(h.filename, h.text + '// changed\n'); h.watchers.change(uriFor(h.filename));
    for (let attempt = 0; attempt < 50 && h.events.filter(([event]) => event === 'end').length === before; attempt++) await pause(20);
    assert.equal(h.events.filter(([event]) => event === 'end').length, before + 1);
    await pause(500);
    assert.equal(h.events.filter(([event]) => event === 'end').length, before + 1, 'watch must not loop');
  } finally { await h.dispose(); }
});

test('test discovery excludes nested worktrees and preserves configured editor exclusions', async () => {
  const h = await harness();
  try {
    h.exclusions.files.exclude = { '**/vendor/**': true, '**/included/**': false, '**/{archive,{old,backup}}/**': true };
    h.exclusions.search.exclude = { '**/archived/**': true };
    h.setFoundFiles([uriFor(h.filename), uriFor(path.join(h.directory, '.claude/worktrees/old/tests.nra')),
      uriFor(path.join(h.directory, '.codex/worktrees/old/tests.nra')), uriFor(path.join(h.directory, 'build-release/tests.nra'))]);
    await h.controller.refreshHandler();
    assert.equal(h.getCalls(), 1, 'nested checkouts must never invoke discovery');
    assert.match(h.findRequests[0][1], /\.claude/);
    assert.match(h.findRequests[0][1], /\*\*\/vendor\/\*\*/);
    assert.match(h.findRequests[0][1], /\*\*\/archived\/\*\*/);
    assert.match(h.findRequests[0][1], /\*\*\/backup\/\*\*/);
    assert.equal((h.findRequests[0][1].match(/\{/g) ?? []).length, 1, 'the ripgrep exclusion union must not contain nested alternatives');
    assert.doesNotMatch(h.findRequests[0][1], /included/);
    assert.equal(h.findRequests[0][2], undefined, 'test inputs are not silently truncated');
    const calls = h.getCalls();
    h.watchers.change(uriFor(path.join(h.directory, '.claude/worktrees/old/tests.nra')));
    await pause(500);
    assert.equal(h.getCalls(), calls, 'nested worktree watchers must not trigger rescans');
  } finally { await h.dispose(); }
});

test('test discovery and execution share resolved project and target import roots', async () => {
  const h = await harness();
  try {
    h.settings.sourceRoots = ['${workspaceFolder}/shared'];
    h.settings.targets = [{ name: 'unit-tests', inputs: ['tests.nra'], sourceRoots: ['support'] }];
    await h.controller.refreshHandler();
    await h.profiles.get('Run')({}, new Source().token);
    const expected = ['-I', path.join(h.directory, 'shared'), '-I', path.join(h.directory, 'support')];
    for (const args of h.processArgs) {
      assert.deepEqual(args.slice(args.indexOf('-I'), args.indexOf('-I') + expected.length), expected);
    }
  } finally { await h.dispose(); }
});

test('configuration changes refresh the test tree without reopening the workspace', async () => {
  const h = await harness();
  try {
    h.watchers.configuration({ affectsConfiguration: section => section === 'neura' });
    for (let attempt = 0; attempt < 50 && !h.getCalls(); attempt++) await pause(20);
    assert.equal(h.getCalls(), 1);
  } finally { await h.dispose(); }
});


test('support files and test names in comments or strings are not standalone test inputs', async () => {
  const h = await harness();
  try {
    for (const contents of [
      '/// export let test_example = func() {};\nlet Helper = module ();',
      'let description = "test_example = func()";\nlet test_helper = import:Helper;',
      'let Helpers = module (export let assert_test_result = func() {};);',
    ]) {
      await fs.writeFile(h.filename, contents);
      await h.controller.refreshHandler();
    }
    assert.equal(h.getCalls(), 0);
  } finally { await h.dispose(); }
});


test('test discovery and execution receive configured tool environment', async () => {
  const h = await harness();
  try {
    h.settings.environment = { NEURA_TEST_SETTING: 'literal value' };
    await h.controller.refreshHandler();
    await h.profiles.get('Run')({}, new Source().token);
    assert.equal(h.processOptions.length, 2);
    for (const options of h.processOptions) assert.deepEqual(options.env, h.settings.environment);
  } finally { await h.dispose(); }
});
