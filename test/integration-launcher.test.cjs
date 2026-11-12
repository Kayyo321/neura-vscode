const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveVSCodeExecutable } = require('./run-integration.cjs');

async function fixture(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-vscode-launcher-'));
  try { await callback(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function executable(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('integration launcher keeps existing executables without inspecting a bundle', async () => {
  await fixture(async directory => {
    const binary = path.join(directory, 'code'); await executable(binary);
    const resolved = await resolveVSCodeExecutable(binary, { platform: 'darwin', bundleExecutable() { throw new Error('unexpected plist read'); } });
    assert.equal(resolved, binary);
  });
});

test('macOS launcher uses CFBundleExecutable when Electron is absent', async () => {
  await fixture(async directory => {
    const bundle = path.join(directory, 'Visual Studio Code.app');
    const guessed = path.join(bundle, 'Contents', 'MacOS', 'Electron');
    const actual = path.join(bundle, 'Contents', 'MacOS', 'Code'); await executable(actual);
    const calls = [];
    const resolved = await resolveVSCodeExecutable(guessed, { platform: 'darwin', bundleExecutable: async plist => { calls.push(plist); return 'Code'; } });
    assert.equal(resolved, actual);
    assert.deepEqual(calls, [path.join(bundle, 'Contents', 'Info.plist')]);
  });
});

test('macOS launcher finds the actual downloaded app when the app name also changed', async () => {
  await fixture(async directory => {
    const guessed = path.join(directory, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
    const bundle = path.join(directory, 'Code.app');
    const actual = path.join(bundle, 'Contents', 'MacOS', 'Code'); await executable(actual);
    await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), 'Code');
    const resolved = await resolveVSCodeExecutable(guessed, { platform: 'darwin', bundleExecutable: plist => fs.readFile(plist, 'utf8') });
    assert.equal(resolved, actual);
  });
});

test('macOS launcher rejects non-basename CFBundleExecutable values', async () => {
  await fixture(async directory => {
    const bundle = path.join(directory, 'Visual Studio Code.app');
    const guessed = path.join(bundle, 'Contents', 'MacOS', 'Electron'); await fs.mkdir(path.dirname(guessed), { recursive: true });
    for (const value of ['../outside', '/outside', 'folder\\Code', '.', '..', '', 'Code\nextra']) {
      await assert.rejects(resolveVSCodeExecutable(guessed, { platform: 'darwin', bundleExecutable: async () => value }), /plain executable basename/);
    }
  });
});

test('macOS launcher requires the declared executable to be a file', async () => {
  await fixture(async directory => {
    const bundle = path.join(directory, 'Visual Studio Code.app');
    const guessed = path.join(bundle, 'Contents', 'MacOS', 'Electron');
    await fs.mkdir(path.join(bundle, 'Contents', 'MacOS', 'Code'), { recursive: true });
    await assert.rejects(resolveVSCodeExecutable(guessed, { platform: 'darwin', bundleExecutable: async () => 'Code' }), /not an executable file/);
  });
});

test('other platforms report missing downloads without macOS fallback', async () => {
  await fixture(async directory => {
    await assert.rejects(resolveVSCodeExecutable(path.join(directory, 'missing-code'), { platform: 'win32', bundleExecutable() { throw new Error('unexpected plist read'); } }), /executable does not exist/);
  });
});
