const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const esbuild = require('esbuild');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'integration.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(__dirname, '..', 'out', 'integration.cjs'), external: ['vscode'] });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-vscode-user-'));
  try { await runTests({ version: process.env.VSCODE_TEST_VERSION || 'stable', extensionDevelopmentPath: path.resolve(__dirname, '..'), extensionTestsPath: path.resolve(__dirname, '..', 'out', 'integration.cjs'), launchArgs: [path.resolve(__dirname, '..', 'examples'), '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'] }); }
  finally { await fs.rm(userData, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
