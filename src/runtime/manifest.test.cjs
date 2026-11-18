const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const load = require('../../test/load.cjs');
const { parseManifest, projectActions, projectArguments, validProjectName } = load('src/runtime/manifest.ts');

const stock = `# The project manifest. Build a target with \`neura build --target <name>\`.
schema = 1

[project]
name = "stock"
id = "example.stock"
version = "0.1.0"
language = "0.3"

[packages.contracts]
root = "contracts"

[packages.ui]
root = "ui"
depends = ["contracts"]

[targets.web]
kind = "web"
package = "ui"
entry = "Ui.Main"
styles = ["ui/base.css"]
capabilities = ["ui", "bridge"]

[targets.server]
kind = "server" # a trailing comment
package = "server"

[targets.server.http]
listen = "127.0.0.1:8080"

[targets."my-desktop"]
kind = "desktop"
ui = "web"

[targets.desktop.packaging]
kind = "not a target kind"
`;

test('project manifests list targets with their kinds and packages, ignoring nested tables', () => {
  const manifest = parseManifest(stock);
  assert.equal(manifest.name, 'stock');
  assert.deepEqual(manifest.targets, [
    { name: 'web', kind: 'web', package: 'ui' },
    { name: 'server', kind: 'server', package: 'server' },
    { name: 'my-desktop', kind: 'desktop' },
  ]);
  assert.deepEqual([...manifest.packages], [['contracts', 'contracts'], ['ui', 'ui']]);
  assert.deepEqual(parseManifest('this is [not toml').targets, [], 'malformed text yields no targets and no exception');
});

test('project actions map to the SDK project commands with an absolute manifest', () => {
  assert.deepEqual(projectActions({ name: 'web', kind: 'web' }), ['build', 'dev']);
  assert.deepEqual(projectActions({ name: 'server', kind: 'server' }), ['build', 'dev', 'package']);
  const manifest = path.resolve('/work/stock/neura.toml');
  assert.deepEqual(projectArguments('build', manifest, 'web'), ['build', '--project', manifest, '--target', 'web']);
  assert.deepEqual(projectArguments('build', manifest, 'web', { updateLock: true }), ['build', '--project', manifest, '--target', 'web', '--update-lock']);
  assert.deepEqual(projectArguments('dev', manifest, 'web', { port: 0 }), ['dev', '--project', manifest, '--target', 'web', '--port', '0']);
  assert.deepEqual(projectArguments('package', manifest, 'desktop', { format: 'deb' }), ['package', '--project', manifest, '--target', 'desktop', '--format', 'deb']);
  assert.ok(!projectArguments('build', manifest, 'web').includes('--error-format=short'), 'project builds reject --error-format');
});

test('project names follow neura new', () => {
  assert.ok(validProjectName('stock-2'));
  for (const name of ['Stock', 'my_app', '', 'a b']) assert.ok(!validProjectName(name), name);
});

test('the neura.toml schema follows the SDK manifest reader: closed tables and required keys', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/neura.toml.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false, 'unknown keys are E1020');
  assert.deepEqual(schema.required, ['schema', 'project', 'packages']);
  assert.equal(schema.properties.schema.const, 1);
  assert.equal(schema.properties.project.properties.language.const, '0.3');
  assert.ok(new RegExp(schema.properties.project.properties.name.pattern).test('stock'));
  assert.ok(!new RegExp(schema.properties.project.properties.name.pattern).test('Stock'));
});
