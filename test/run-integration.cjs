const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

const executeFile = promisify(execFile);

async function isExecutableFile(filename) {
  try {
    if (!(await fs.stat(filename)).isFile()) return false;
    await fs.access(filename, constants.X_OK);
    return true;
  } catch { return false; }
}

async function readBundleExecutable(plist) {
  const result = await executeFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

/** Older test-electron releases assume Electron; newer macOS bundles name their executable in Info.plist. */
async function resolveVSCodeExecutable(guessed, { platform = process.platform, bundleExecutable = readBundleExecutable } = {}) {
  if (await isExecutableFile(guessed)) return guessed;
  if (platform !== 'darwin') throw new Error(`The downloaded VS Code executable does not exist: ${guessed}`);
  let bundle = path.dirname(guessed);
  while (!path.basename(bundle).toLowerCase().endsWith('.app')) {
    const parent = path.dirname(bundle);
    if (parent === bundle) throw new Error(`Cannot locate the downloaded VS Code application bundle from ${guessed}`);
    bundle = parent;
  }
  const directory = path.dirname(bundle);
  const applications = [bundle];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.toLowerCase().endsWith('.app')) {
      const candidate = path.join(directory, entry.name);
      if (!applications.includes(candidate)) applications.push(candidate);
    }
  }
  const failures = [];
  for (const application of applications) {
    try {
      const name = await bundleExecutable(path.join(application, 'Contents', 'Info.plist'));
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || path.basename(name) !== name || /[\x00-\x1f\x7f/\\]/.test(name)) {
        throw new Error('CFBundleExecutable must be a plain executable basename.');
      }
      const executable = path.join(application, 'Contents', 'MacOS', name);
      if (!await isExecutableFile(executable)) throw new Error(`CFBundleExecutable is not an executable file: ${executable}`);
      return executable;
    } catch (error) { failures.push(`${application}: ${error.message ?? String(error)}`); }
  }
  throw new Error(`Cannot resolve the downloaded VS Code macOS executable.\n${failures.join('\n')}`);
}

async function main() {
  const esbuild = require('esbuild');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'integration.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(__dirname, '..', 'out', 'integration.cjs'), external: ['vscode'] });
  const version = process.env.VSCODE_TEST_VERSION || 'stable';
  const development = path.resolve(__dirname, '..');
  const downloaded = await downloadAndUnzipVSCode({ version, extensionDevelopmentPath: development });
  const vscodeExecutablePath = await resolveVSCodeExecutable(downloaded);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-vscode-user-'));
  try { await runTests({ version, vscodeExecutablePath, extensionDevelopmentPath: development, extensionTestsPath: path.resolve(__dirname, '..', 'out', 'integration.cjs'), launchArgs: [path.resolve(__dirname, '..', 'examples'), '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'] }); }
  finally { await fs.rm(userData, { recursive: true, force: true }); }
}

module.exports = { resolveVSCodeExecutable };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
