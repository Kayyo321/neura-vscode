const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');

const settings = {};
const vscode = {
    workspace: { getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }) },
    CancellationError: class CancellationError extends Error {},
};
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
require.extensions['.ts'] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        fileName: filename,
    }).outputText, filename);
};
const config = require('./configuration.ts');
const diagnostics = require('./diagnostics.ts');
const { runProcess } = require('./process.ts');
const { shellQuote, resolveExecutable } = require('./toolchain.ts');
Module._load = originalLoad;
if (originalTs) { require.extensions['.ts'] = originalTs; } else { delete require.extensions['.ts']; }

const folder = { name: 'project', index: 0, uri: { fsPath: path.resolve(os.tmpdir(), 'neura project') } };

test('target resolution preserves structured shell-sensitive arguments', () => {
    const target = config.resolveTarget({ name: 'hello', inputs: ['src/main.nra'], sourceRoots: ['src'],
        args: ['two words', '$(no-execution)', "it's literal", '; exit 99'], env: { EXAMPLE: 'value' } }, folder);
    const source = path.join(folder.uri.fsPath, 'src', 'main.nra');
    const artifact = path.join(folder.uri.fsPath, '.neura-vscode', 'hello.nvr');
    assert.equal(target.inputs[0], source);
    assert.deepEqual(config.runArguments(target), ['run', artifact, '--',
        'two words', '$(no-execution)', "it's literal", '; exit 99']);
    assert.deepEqual(config.buildArguments(target), ['build', '-I', path.join(folder.uri.fsPath, 'src'),
        source, '-o', artifact]);
    assert.equal(target.env.EXAMPLE, 'value');
});

test('library and native targets map to the real compiler commands', () => {
    const library = config.resolveTarget({ name: 'math', kind: 'library', inputs: ['math.nra'] }, folder);
    assert.equal(config.buildArguments(library)[0], 'emit-ir');
    assert.ok(library.output.endsWith('.nir'));
    const native = config.resolveTarget({ name: 'app', kind: 'native', inputs: ['main.nra'] }, folder);
    assert.deepEqual(config.buildArguments(native).slice(0, 2), ['build', '--native']);
    assert.equal(path.basename(native.output), 'app');
});

test('invalid targets and source-overwriting output are rejected', () => {
    assert.throws(() => config.resolveTarget({ name: 'empty', inputs: [] }, folder), /no inputs/);
    assert.throws(() => config.resolveTarget({ name: 'bad', inputs: ['main.nra'], args: 'words' }, folder), /array of strings/);
    assert.throws(() => config.resolveTarget({ name: 'bad', inputs: ['main.nra'], output: 'main.nra' }, folder), /overwrite/);
    assert.throws(() => config.resolveTarget({ name: 'bad', inputs: ['main.nra'], env: { NUMBER: 1 } }, folder), /string values/);
});

test('compiler UTF-8 bytes and scalar columns convert into UTF-16 positions', () => {
    const text = 'a😀e\u0301\r\nnext';
    assert.equal(diagnostics.utf8OffsetToUtf16(text, 5), 3);
    assert.equal(diagnostics.utf8OffsetToUtf16(text, 8), 5);
    assert.equal(diagnostics.scalarColumnToUtf16(text, 3), 3);
    assert.equal(diagnostics.scalarColumnToUtf16(text, 5), 5);
});

test('POSIX installer quoting does not evaluate shell syntax', () => {
    assert.equal(shellQuote("one'two $(touch bad)"), `'one'"'"'two $(touch bad)'`);
});

test('toolchain command resolves to an absolute executable for stdlib discovery', async () => {
    assert.equal(await resolveExecutable(process.execPath), fs.realpathSync(process.execPath));
    assert.equal(await resolveExecutable('/does/not/exist/neura'), undefined);
});

test('managed process passes arguments literally and captures exit status', async () => {
    const args = ['two words', '$(printf bad)', '; exit 99'];
    const result = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 3', ...args]);
    assert.equal(result.code, 3);
    assert.deepEqual(JSON.parse(result.stdout), args);
});

test('managed process enforces elapsed-time bounds', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 50 }), /timed out/);
});

test('managed process bounds captured output', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxBytes: 128 }), /capture limit/);
});

test('managed process preserves UTF-8 sequences split across output chunks', async () => {
    const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("😀"); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),20)']);
    assert.equal(result.stdout, '😀');
});

test('managed process turns streaming callback errors into a rejected operation', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("data"); setInterval(()=>{},1000)'], {
        onStdout() { throw new Error('invalid protocol'); },
    }), /invalid protocol/);
});
