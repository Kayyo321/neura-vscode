import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Runtime } from './runtime';
import { runProcess } from './process';

class GeneratedDocuments implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private sequence = 0;
  provideTextDocumentContent(uri: vscode.Uri): string { return this.content.get(uri.toString()) ?? 'This Neura view has expired. Regenerate it from the source or artifact.'; }
  add(name: string, value: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'neura-generated', path: `/${name}`, query: String(++this.sequence) });
    this.content.set(uri.toString(), value);
    while (this.content.size > 40) this.content.delete(this.content.keys().next().value!);
    return uri;
  }
}

export function registerWorkbench(context: vscode.ExtensionContext, runtime: Runtime, output: vscode.OutputChannel): void {
  const generated = new GeneratedDocuments();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('neura-generated', generated));
  const show = async (name: string, text: string, language = 'plaintext') => {
    const document = await vscode.workspace.openTextDocument(generated.add(name, text)); await vscode.languages.setTextDocumentLanguage(document, language); await vscode.window.showTextDocument(document, { preview: true });
  };
  const invoke = async (args: string[], folder: vscode.WorkspaceFolder, title: string, maxOutputBytes = 32 * 1024 * 1024) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running Neura tools.');
    const executable = await runtime.getExecutable(folder); if (!executable) throw new Error('Select a Neura toolchain first.');
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const result = await runProcess(executable, args, { cwd: folder.uri.fsPath, token, timeoutMs: 120000, maxOutputBytes });
      if (result.cancelled) throw new Error('Neura operation cancelled.');
      if (result.code !== 0) throw new Error(result.stderr || `Neura exited with status ${result.code}.`);
      if (result.stderr) output.appendLine(result.stderr);
      return result.stdout;
    });
  };
  const document = async (value?: vscode.Uri | string) => value ? vscode.workspace.openTextDocument(typeof value === 'string' ? vscode.Uri.parse(value) : value) : vscode.window.activeTextEditor?.document;
  const register = (id: string, command: (...args: any[]) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => { try { return await command(...args); } catch (error) { output.appendLine(`${id}: ${String(error)}`); void vscode.window.showErrorMessage(String(error)); return undefined; } }));
  const roots = (values: string[]) => values.flatMap(value => ['-I', value]);
  register('neura.showIR', async (uri?: vscode.Uri | string) => {
    const target = await runtime.getTarget(await document(uri)); if (!target || !await runtime.saveSources(target.folder)) return;
    const text = await invoke(['emit-ir', ...roots(target.sourceRoots), ...target.inputs], target.folder, 'Generate Neura IR'); await show(`${target.name}.ir`, text, 'neurair');
  });
  register('neura.compareIR', async () => {
    const target = await runtime.getTarget(); if (!target || !await runtime.saveSources(target.folder)) return;
    const common = [...roots(target.sourceRoots), ...target.inputs];
    const before = await invoke(['emit-ir', '--no-optimize', ...common], target.folder, 'Generate unoptimized IR');
    const after = await invoke(['emit-ir', ...common], target.folder, 'Generate optimized IR');
    await vscode.commands.executeCommand('vscode.diff', generated.add(`${target.name}-unoptimized.ir`, before), generated.add(`${target.name}-optimized.ir`, after), `${target.name}: IR optimization`);
  });
  const artifact = async (value?: vscode.Uri | string): Promise<{ uri: vscode.Uri; folder: vscode.WorkspaceFolder } | undefined> => {
    let uri = value ? typeof value === 'string' ? vscode.Uri.parse(value) : value : undefined;
    if (!uri && vscode.window.activeTextEditor && /\.(nvr|nir)$/.test(vscode.window.activeTextEditor.document.uri.path)) uri = vscode.window.activeTextEditor.document.uri;
    if (!uri) {
      const candidates = await vscode.workspace.findFiles('**/*.{nvr,nir}', '**/{.git,node_modules}/**', 500);
      const pick = await vscode.window.showQuickPick(candidates.map(candidate => ({ label: path.basename(candidate.fsPath), description: vscode.workspace.asRelativePath(candidate), uri: candidate })), { placeHolder: 'Select a Neura artifact' }); uri = pick?.uri;
    }
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri); return uri && folder ? { uri, folder } : undefined;
  };
  register('neura.inspectArtifact', async (value?: vscode.Uri | string) => {
    const selected = await artifact(value); if (!selected) return;
    const command = selected.uri.path.endsWith('.nir') ? 'emit-ir' : 'disassemble';
    const text = await invoke([command, selected.uri.fsPath], selected.folder, 'Inspect Neura artifact'); await show(`${path.basename(selected.uri.fsPath)}.${command === 'emit-ir' ? 'ir' : 'nvra'}`, text, command === 'emit-ir' ? 'neurair' : 'nvra');
  });
  register('neura.decompile', async (value?: vscode.Uri | string) => {
    const selected = await artifact(value); if (!selected) return;
    if (!selected.uri.path.endsWith('.nvr')) throw new Error('Decompilation requires an .nvr image.');
    const text = await invoke(['decompile', selected.uri.fsPath], selected.folder, 'Decompile Neura image'); await show(`${path.basename(selected.uri.fsPath)}.decompiled`, text);
  });
  register('neura.explainDiagnostic', async (code?: string) => {
    const folder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) || vscode.workspace.workspaceFolders?.[0]; if (!folder) return;
    const selected = code ?? await vscode.window.showInputBox({ prompt: 'Diagnostic code or warning name', placeHolder: 'E0201', validateInput: value => /^[A-Za-z0-9-]+$/.test(value) ? undefined : 'Enter a diagnostic code or warning name.' }); if (!selected) return;
    const text = await invoke(['explain', selected], folder, `Explain ${selected}`); await show(`${selected}.md`, text, 'markdown');
  });
  register('neura.showTags', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) return; await show('neura-tags.txt', await invoke(['tags'], folder, 'Neura tag catalogue'));
  });
  register('neura.exportDoxygen', async (uri?: vscode.Uri | string) => {
    const source = await document(uri); const target = await runtime.getTarget(source); if (!source || !target) return;
    if (source.isDirty && !await source.save()) return;
    await show(`${path.basename(source.uri.fsPath)}.doxygen`, await invoke(['docs', '--doxygen', ...roots(target.sourceRoots), source.uri.fsPath], target.folder, 'Export Doxygen declarations'));
  });
  register('neura.profile', async () => {
    const built = await runtime.build(); if (!built) return;
    if (built.target.kind !== 'application') throw new Error('This command requires an application .nvr target.');
    const task = new vscode.Task({ type: 'neura', command: 'profile' }, built.target.folder, `Profile ${built.target.name}`, 'Neura', new vscode.ProcessExecution(built.executable, ['run', '--stats', '--profile', '--tier-stats', ...built.target.runArgs, built.artifact, '--', ...built.target.args], { cwd: built.target.cwd, env: built.target.env }));
    await vscode.tasks.executeTask(task);
  });
  register('neura.record', async () => {
    const built = await runtime.build(); if (!built) return;
    if (built.target.kind !== 'application') throw new Error('This command requires an application .nvr target.');
    const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(built.target.cwd, 'execution.trace')), filters: { 'Neura trace': ['trace'] } }); if (!destination) return;
    const task = new vscode.Task({ type: 'neura', command: 'record' }, built.target.folder, `Record ${built.target.name}`, 'Neura', new vscode.ProcessExecution(built.executable, ['run', '--record', destination.fsPath, ...built.target.runArgs, built.artifact, '--', ...built.target.args], { cwd: built.target.cwd, env: built.target.env })); await vscode.tasks.executeTask(task);
  });
  register('neura.replay', async () => {
    const built = await runtime.build(); if (!built) return;
    if (built.target.kind !== 'application') throw new Error('This command requires an application .nvr target.');
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Neura trace': ['trace'] } }); if (!selected?.[0]) return;
    const task = new vscode.Task({ type: 'neura', command: 'replay' }, built.target.folder, `Replay ${built.target.name}`, 'Neura', new vscode.ProcessExecution(built.executable, ['run', '--replay', selected[0].fsPath, ...built.target.runArgs, built.artifact, '--', ...built.target.args], { cwd: built.target.cwd, env: built.target.env })); await vscode.tasks.executeTask(task);
  });
  register('neura.taskTrace', async () => {
    const built = await runtime.build(); if (!built) return;
    if (built.target.kind !== 'application') throw new Error('This command requires an application .nvr target.');
    const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(built.target.cwd, 'tasks.jsonl')), filters: { 'Task trace': ['jsonl'] } }); if (!destination) return;
    const task = new vscode.Task({ type: 'neura', command: 'trace' }, built.target.folder, `Trace ${built.target.name}`, 'Neura', new vscode.ProcessExecution(built.executable, ['run', '--trace-events', destination.fsPath, '--task-dump=json', ...built.target.runArgs, built.artifact, '--', ...built.target.args], { cwd: built.target.cwd, env: built.target.env })); await vscode.tasks.executeTask(task);
  });
  register('neura.debugInput', async () => { const session = vscode.debug.activeDebugSession; if (session?.type !== 'neura') return; const text = await vscode.window.showInputBox({ prompt: 'Send input to the Neura program' }); if (text !== undefined) await session.customRequest('neura/input', { text: `${text}\n` }); });
  register('neura.debugInputEof', async () => { const session = vscode.debug.activeDebugSession; if (session?.type === 'neura') await session.customRequest('neura/input', { eof: true }); });
  register('neura.exportDiagnostics', async () => {
    const lines = ['Neura extension diagnostic report', `Extension: ${context.extension.packageJSON.version}`, `Host: ${process.platform}/${process.arch}`, `Remote: ${vscode.env.remoteName ?? 'local'}`, `VS Code: ${vscode.version}`, `Trusted: ${vscode.workspace.isTrusted}`];
    for (const folder of vscode.workspace.workspaceFolders ?? []) { const executable = await runtime.getExecutable(folder); if (executable) { const result = await runProcess(executable, ['--version'], { cwd: folder.uri.fsPath, timeoutMs: 5000 }); lines.push(`Toolchain: ${result.stdout.trim()}`); } }
    lines.push('Workspace paths, environment values, and source contents are omitted.'); await show('neura-diagnostics.txt', lines.join('\n'));
  });
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  const provider: vscode.TreeDataProvider<vscode.Uri> = {
    onDidChangeTreeData: changed.event,
    async getChildren() { return vscode.workspace.findFiles('**/*.{nvr,nir}', '**/{.git,node_modules}/**', 500); },
    getTreeItem(uri) { const item = new vscode.TreeItem(path.basename(uri.fsPath)); item.description = vscode.workspace.asRelativePath(uri); item.resourceUri = uri; item.iconPath = new vscode.ThemeIcon('file-binary'); item.command = { command: 'neura.inspectArtifact', title: 'Inspect', arguments: [uri] }; return item; }
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{nvr,nir}');
  context.subscriptions.push(vscode.window.registerTreeDataProvider('neura.artifacts', provider), watcher, watcher.onDidCreate(() => changed.fire()), watcher.onDidDelete(() => changed.fire()));
  // Stable source identity is also useful to external inspection tools.
  context.subscriptions.push(vscode.commands.registerCommand('neura.sourceFingerprint', async () => { const source = vscode.window.activeTextEditor?.document; if (source) await vscode.env.clipboard.writeText(createHash('sha256').update(source.getText()).digest('hex')); }));
}
