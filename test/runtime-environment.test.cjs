const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function load(relative, stubs) {
  const filename = path.resolve(__dirname, '..', relative);
  const result = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(stubs) });
  const original = Module._load;
  Module._load = function(request, ...args) { return request in stubs ? stubs[request] : original.call(this, request, ...args); };
  try {
    const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
    loaded._compile(result.outputFiles[0].text, filename); return loaded.exports;
  } finally { Module._load = original; }
}
const disposable = () => ({ dispose() {} });
const folder = { name: 'project', index: 0, uri: { fsPath: path.resolve('/tmp', 'neura-env-project'), toString: () => 'file:///neura-env-project' } };
const settings = { environment: { NEURA_TEST_CONFIGURED: 'literal $(no shell); value' } };
const workspace = { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) };

test('language server receives configured tool environment alongside inherited environment', async () => {
  let server;
  class Client {
    constructor(_id, _name, supplied) { server = supplied; }
    onDidChangeState() { return disposable(); }
    async start() {}
    async stop() {}
  }
  const api = load('src/runtime/language.ts', {
    vscode: { workspace },
    'vscode-languageclient/node': { LanguageClient: Client, State: {}, CloseAction: {}, ErrorAction: {} },
  });
  const services = new api.LanguageServices({ discover: async () => ({ executable: '/neura', version: 'rc2', capabilities: { lsp: true } }) }, { appendLine() {} });
  try {
    assert.equal(await services.start(folder), true);
    assert.equal(server.options.env.NEURA_TEST_CONFIGURED, settings.environment.NEURA_TEST_CONFIGURED);
    assert.equal(server.options.env.PATH, process.env.PATH);
    assert.equal(server.options.env.NEURA_NO_UPDATE_CHECK, '1');
  } finally { services.dispose(); }
});

test('debugger process and launch receive tool environment with launch-specific values taking precedence', async () => {
  let descriptorFactory, configurationProvider;
  const api = load('src/debug.ts', {
    vscode: {
      workspace, env: {}, window: {},
      commands: { registerCommand: () => disposable() },
      DebugAdapterExecutable: class { constructor(executable, args, options) { Object.assign(this, { executable, args, options }); } },
      debug: {
        registerDebugAdapterDescriptorFactory(_name, factory) { descriptorFactory = factory; return disposable(); },
        registerDebugConfigurationProvider(_name, provider) { configurationProvider = provider; return disposable(); },
      },
    },
    './runtime': { supportsCapability: () => true },
  });
  api.registerDebugging({ subscriptions: [] }, {
    getExecutable: async () => '/neura', toolchains: { discover: async () => ({}) }, saveSources: async () => true,
  }, { appendLine() {} });
  const descriptor = await descriptorFactory.createDebugAdapterDescriptor({ workspaceFolder: folder, configuration: {} });
  assert.equal(descriptor.options.env.NEURA_TEST_CONFIGURED, settings.environment.NEURA_TEST_CONFIGURED);
  assert.equal(descriptor.options.env.PATH, process.env.PATH);
  assert.equal(descriptor.options.env.NEURA_NO_UPDATE_CHECK, '1');
  const configured = await configurationProvider.resolveDebugConfiguration(folder, { type: 'neura', program: 'main.nra', env: { NEURA_TEST_CONFIGURED: 'program override', EXTRA: 'yes' } });
  assert.equal(configured.env.NEURA_TEST_CONFIGURED, 'program override');
  assert.equal(configured.env.EXTRA, 'yes');
});
