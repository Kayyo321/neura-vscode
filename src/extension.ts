import * as vscode from 'vscode';
import { createRuntime } from './runtime';
import { registerTesting } from './testing';
import { registerDebugging } from './debug';
import { registerWorkbench } from './workbench';
import { registerDocumentation } from './documentation';
import { registerInsights } from './insights';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Neura'); context.subscriptions.push(output);
  const runtime = createRuntime(context, output); context.subscriptions.push(runtime); runtime.register();
  registerDebugging(context, runtime, output); registerTesting(context, runtime, output); registerWorkbench(context, runtime, output); registerDocumentation(context, runtime, output); registerInsights(context, runtime, output);
  context.subscriptions.push(vscode.commands.registerCommand('neura.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'Kayyo321.neura-vscode#neura.getStarted', false)), vscode.workspace.onDidGrantWorkspaceTrust(() => { void runtime.refresh(); }));
}

export function deactivate(): void { /* VS Code disposes registered services. */ }
