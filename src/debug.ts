import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Runtime } from './runtime';
import { supportsCapability } from './runtime';
import { toolEnvironment } from './runtime/configuration';

export function registerDebugging(context: vscode.ExtensionContext, runtime: Runtime, output: vscode.OutputChannel): void {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('neura', {
    async createDebugAdapterDescriptor(session) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before debugging Neura.');
      const executable = await runtime.getExecutable(session.workspaceFolder);
      if (!executable) throw new Error('Select or install a Neura toolchain first.');
      const toolchain = await runtime.toolchains.discover(session.workspaceFolder);
      if (!toolchain || !supportsCapability(toolchain, 'debugger')) throw new Error('Install a tooling-enabled Neura release to use source debugging.');
      output.appendLine(`Starting Neura debugger on ${vscode.env.remoteName ?? process.platform}.`);
      return new vscode.DebugAdapterExecutable(executable, ['debug', '--stdio'], {
        cwd: session.configuration.cwd ?? session.workspaceFolder?.uri.fsPath,
        env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1', ...toolEnvironment(session.workspaceFolder) }
      });
    }
  }));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('neura', {
    async resolveDebugConfiguration(folder, configuration) {
      if (!vscode.workspace.isTrusted) return undefined;
      if (!configuration.type) configuration = { type: 'neura', request: 'launch', name: 'Debug Neura', program: vscode.window.activeTextEditor?.document.uri.fsPath };
      if (!configuration.program) { void vscode.window.showErrorMessage('Open a Neura source file or set program in launch.json.'); return undefined; }
      configuration.cwd ??= folder?.uri.fsPath ?? path.dirname(configuration.program);
      configuration.stopOnEntry ??= true;
      configuration.env = { ...toolEnvironment(folder), ...configuration.env };
      configuration.sourceRoots ??= vscode.workspace.getConfiguration('neura', folder).get<string[]>('sourceRoots', []);
      if (folder && !await runtime.saveSources(folder)) return undefined;
      return configuration;
    },
    resolveDebugConfigurationWithSubstitutedVariables(folder, configuration) {
      const base = folder?.uri.fsPath ?? process.cwd();
      configuration.cwd = path.resolve(base, configuration.cwd ?? '.');
      configuration.program = path.resolve(configuration.cwd, configuration.program);
      configuration.sourceRoots = (configuration.sourceRoots ?? []).map((root: string) => path.resolve(base, root));
      if (Array.isArray(configuration.files)) configuration.files = configuration.files.map((file: string) => path.resolve(configuration.cwd, file));
      if (Array.isArray(configuration.testFiles)) configuration.testFiles = configuration.testFiles.map((file: string) => path.resolve(configuration.cwd, file));
      return configuration;
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('neura.debug', async (uri?: vscode.Uri | string) => {
    const document = uri ? await vscode.workspace.openTextDocument(typeof uri === 'string' ? vscode.Uri.parse(uri) : uri) : vscode.window.activeTextEditor?.document;
    const target = await runtime.getTarget(document);
    if (!target) return;
    if (target.kind === 'library') { void vscode.window.showInformationMessage('Select an application target or a test to debug.'); return; }
    await vscode.debug.startDebugging(target.folder, { type: 'neura', request: 'launch', name: `Debug ${target.name}`, program: target.inputs[0], files: target.inputs, sourceRoots: target.sourceRoots, cwd: target.cwd, args: target.args, env: target.env, stopOnEntry: true });
  }));
}
