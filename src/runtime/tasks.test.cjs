const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const esbuild = require('esbuild');

async function harness(raw = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'neura-task-'));
  const folder = { name: 'project', uri: { fsPath: directory, toString: () => `file://${directory}` } };
  const calls = [], exits = [], writes = [], inputs = [];
  let failure = 0, hold = false, terminated = 0, inputClosed = false;
  class Emitter {
    callbacks = new Set();
    event = callback => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; };
    fire = value => { for (const callback of this.callbacks) callback(value); };
  }
  const settings = { targets: [{ name: 'application', inputs: ['main.nra'], sourceRoots: ['support'],
    args: ['two words', '$(literal)'], runArgs: ['--deny-net'], ...raw }] };
  const vscode = {
    EventEmitter: Emitter, TaskGroup: { Build: 'build', Test: 'test' },
    Task: class { constructor(definition, scope, name, source, execution, problemMatchers) { Object.assign(this, { definition, scope, name, source, execution, problemMatchers }); } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) }, window: {},
  };
  const childProcess = { spawn: (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    if (options.stdio[0] === 'pipe') {
      child.stdin = new PassThrough(); child.stdin.on('data', data => inputs.push(data.toString()));
      child.stdin.on('finish', () => { inputClosed = true; });
    }
    child.complete = code => { child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    setImmediate(() => {
      if (hold) return;
      if (!failure && ['build', 'emit-ir'].includes(args[0])) fs.writeFileSync(args[args.indexOf('-o') + 1], 'image');
      child.complete(failure);
    });
    return child;
  } };
  const stubs = { vscode, 'node:child_process': childProcess, './process': { terminateProcess: child => { terminated++; child.complete(1); } } };
  const filename = path.resolve(__dirname, 'tasks.ts');
  const built = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(stubs) });
  const original = Module._load;
  let exported;
  try {
    Module._load = function (request, ...args) { return request in stubs ? stubs[request] : original.call(this, request, ...args); };
    const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
    loaded._compile(built.outputFiles[0].text, filename); exported = loaded.exports;
  } finally { Module._load = original; }
  const provider = new exported.NeuraTaskProvider(async () => '/selected/neura');
  const resolve = (action, definition = { type: 'neura', action, target: 'application' }) => provider.resolveTask({ scope: folder, definition });
  return { directory, folder, calls, exits, writes, inputs, resolve,
    setFailure: code => { failure = code; }, setHold: value => { hold = value; }, get terminated() { return terminated; },
    get inputClosed() { return inputClosed; },
    async terminal(action) {
      const task = await resolve(action); const terminal = await task.execution.callback();
      terminal.onDidWrite(value => writes.push(value)); terminal.onDidClose(code => exits.push(code));
      return { task, terminal, completed: new Promise(resolve => terminal.onDidClose(resolve)) };
    },
    cleanup: () => fsp.rm(directory, { recursive: true, force: true }) };
}

test('tasks.json preserves each supported action and rejects unknown actions', async () => {
  const h = await harness();
  try {
    for (const action of ['build', 'run', 'check', 'test', 'clean']) assert.equal((await h.resolve(action)).definition.action, action);
    await assert.rejects(h.resolve('surprise'), /Unsupported Neura task action/);
  } finally { await h.cleanup(); }
});

test('check and test tasks execute their own commands with configured source roots', async () => {
  for (const action of ['check', 'test']) {
    const h = await harness();
    try {
      const { terminal, completed } = await h.terminal(action); terminal.open(); assert.equal(await completed, 0);
      assert.deepEqual(h.calls[0].args, [action, '--error-format=short', '-I', path.join(h.directory, 'support'), path.join(h.directory, 'main.nra')]);
      assert.equal(h.calls.length, 1);
    } finally { await h.cleanup(); }
  }
});

test('run tasks rebuild first and preserve literal program arguments', async () => {
  const h = await harness();
  try {
    const { terminal, completed } = await h.terminal('run'); terminal.open(); assert.equal(await completed, 0);
    assert.equal(h.calls[0].args[0], 'build');
    assert.ok(h.calls[0].args.includes('--error-format=short'));
    assert.deepEqual(h.calls[1].args, ['run', '--deny-net', path.join(h.directory, '.neura-vscode', 'application.nvr'), '--', 'two words', '$(literal)']);
    assert.equal(h.calls[1].options.shell, false);
    assert.equal(h.calls[1].options.stdio[0], 'pipe');
    assert.deepEqual(h.exits, [0]);
  } finally { await h.cleanup(); }
});

test('a failed build never launches the previous artifact', async () => {
  const h = await harness();
  try {
    await fsp.mkdir(path.join(h.directory, '.neura-vscode'));
    await fsp.writeFile(path.join(h.directory, '.neura-vscode', 'application.nvr'), 'old image');
    h.setFailure(3);
    const { terminal, completed } = await h.terminal('run'); terminal.open(); assert.equal(await completed, 3);
    assert.equal(h.calls.length, 1);
  } finally { await h.cleanup(); }
});

test('clean removes only its output and refuses directories', async () => {
  const h = await harness();
  try {
    const output = path.join(h.directory, '.neura-vscode', 'application.nvr');
    await fsp.mkdir(path.dirname(output)); await fsp.writeFile(output, 'image');
    await fsp.writeFile(path.join(h.directory, 'main.nra'), 'source');
    let operation = await h.terminal('clean'); operation.terminal.open(); assert.equal(await operation.completed, 0);
    assert.equal(fs.existsSync(output), false); assert.equal(fs.readFileSync(path.join(h.directory, 'main.nra'), 'utf8'), 'source');
    assert.equal(h.calls.length, 0);
    await fsp.mkdir(output); operation = await h.terminal('clean'); operation.terminal.open(); assert.equal(await operation.completed, 1);
    assert.equal(fs.statSync(output).isDirectory(), true);
  } finally { await h.cleanup(); }
});

test('closing a running terminal cancels its child and closes once', async () => {
  const h = await harness();
  try {
    h.setHold(true); const { terminal, completed } = await h.terminal('check'); terminal.open();
    await new Promise(resolve => setImmediate(resolve)); terminal.close();
    assert.equal(await completed, 1); assert.equal(h.terminated, 1); assert.deepEqual(h.exits, [1]);
  } finally { await h.cleanup(); }
});

test('run terminal forwards input to the program after a successful build', async () => {
  const h = await harness();
  try {
    const { terminal, completed } = await h.terminal('run'); terminal.open();
    while (h.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    terminal.handleInput('hello\r'); assert.deepEqual(h.inputs, ['hello\n']);
    assert.equal(h.writes.join(''), 'hello\r\n'); assert.equal(await completed, 0);
  } finally { await h.cleanup(); }
});

test('run terminal edits lines and translates Ctrl-D into input EOF', async () => {
  const h = await harness();
  try {
    const { terminal, completed } = await h.terminal('run'); terminal.open();
    while (h.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    terminal.handleInput('hellx\x7fo'); assert.deepEqual(h.inputs, []);
    terminal.handleInput('\r'); assert.deepEqual(h.inputs, ['hello\n']);
    terminal.handleInput('\x04'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.inputClosed, true); assert.equal(await completed, 0);
  } finally { await h.cleanup(); }
});

test('Ctrl-C in a run terminal terminates its program instead of forwarding a byte', async () => {
  const h = await harness();
  try {
    const { terminal, completed } = await h.terminal('run'); terminal.open();
    while (h.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    h.setHold(true); terminal.handleInput('\x03');
    assert.equal(await completed, 1); assert.equal(h.terminated, 1); assert.deepEqual(h.inputs, []);
    assert.deepEqual(h.exits, [1]);
  } finally { await h.cleanup(); }
});


test('resolved tasks preserve the exact TaskDefinition supplied by VS Code', async () => {
  const h = await harness();
  try {
    const definition = { type: 'neura', action: 'check', target: 'application', _key: 'vscode-identity', custom: 'kept' };
    const task = await h.resolve('check', definition);
    assert.equal(task.definition, definition);
    assert.equal(task.definition._key, 'vscode-identity');
    assert.equal(task.definition.custom, 'kept');
  } finally { await h.cleanup(); }
});
