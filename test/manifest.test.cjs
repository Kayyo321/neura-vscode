const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');
test('all contributed assets exist and binary IR is not a text association', () => {
  const contributes = manifest.contributes;
  for (const contribution of [...contributes.grammars, ...contributes.themes, ...contributes.snippets, ...contributes.iconThemes]) assert.ok(fs.existsSync(path.resolve(__dirname, '..', contribution.path)), contribution.path);
  assert.ok(fs.existsSync(path.resolve(__dirname, '..', manifest.icon)));
  assert.ok(!contributes.languages.some(language => language.extensions?.includes('.nir')));
});
test('command and semantic contributions have unique identities', () => {
  for (const [items, key] of [[manifest.contributes.commands, 'command'], [manifest.contributes.semanticTokenTypes, 'id'], [manifest.contributes.semanticTokenModifiers, 'id']]) assert.equal(new Set(items.map(item => item[key])).size, items.length);
  const commands = new Set(manifest.contributes.commands.map(item => item.command));
  for (const menu of Object.values(manifest.contributes.menus)) for (const item of menu) if (item.command) assert.ok(commands.has(item.command), item.command);
});
test('workspace execution is restricted and defaults never auto-run', () => {
  assert.equal(manifest.extensionKind[0], 'workspace'); assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['neura.testing.watch'].default, false); assert.equal(properties['neura.build.onSave'].default, false); assert.equal(properties['neura.run.restartOnChange'].default, false);
});
