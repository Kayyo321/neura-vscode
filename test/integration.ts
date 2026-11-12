import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('Kayyo321.neura-vscode'); assert.ok(extension); await extension.activate();
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of ['neura.run', 'neura.build', 'neura.debug', 'neura.refreshTests', 'neura.inspectArtifact', 'neura.install', 'neura.explainDiagnostic']) assert.ok(commands.has(command), command);
  const source = await vscode.workspace.openTextDocument({ language: 'neura', content: 'let identity = func(value: int32) -> int32 { return value; };\n' });
  assert.equal(source.languageId, 'neura');
  const config = vscode.workspace.getConfiguration('neura'); assert.equal(config.get('testing.watch'), false);
  await vscode.window.showTextDocument(source);
  const themes = extension.packageJSON.contributes.themes; assert.equal(themes.length, 4);
  const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
  const typeBody = async (header: string, typed: string, expected: string): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({ language: 'neura', content: header });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(document.positionAt(header.length), document.positionAt(header.length));
    await vscode.commands.executeCommand('type', { text: typed });
    for (let attempt = 0; attempt < 40 && document.getText() !== expected; attempt++) await pause(25);
    assert.equal(document.getText(), expected, `typing ${typed} after ${header}`);
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), header, 'one undo restores delimiter typing and its automatic terminator');
    await vscode.commands.executeCommand('redo');
    assert.equal(document.getText(), expected, 'redo restores the exact grouped edit');
  };
  for (const kind of ['class', 'interface', 'module', 'enum']) {
    await typeBody(`let Sample = ${kind} `, '(', `let Sample = ${kind} ();`);
  }
  await typeBody('let f = func() ', '{', 'let f = func() {};');
  await typeBody('let value: class ', '(', 'let value: class ()');
  await typeBody('if (true) ', '{', 'if (true) {}');
  if (process.env.NEURA_TEST_EXECUTABLE) {
    const executable = process.env.NEURA_TEST_EXECUTABLE;
    await config.update('toolchain.path', executable, vscode.ConfigurationTarget.Global);
    const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
    const directory = await fs.mkdtemp(path.join(workspace.uri.fsPath, 'neura-host-test-'));
    const file = vscode.Uri.file(path.join(directory, 'editor.nra'));
    await fs.writeFile(file.fsPath, 'let Identity=module (\n    export let answer = func(value: int32) -> int32 {\n        return value;\n    };\n);\n');
    try {
      const doc = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('neura.restartLanguageServer');
      let symbols: vscode.DocumentSymbol[] = [];
      for (let attempt = 0; attempt < 120; attempt++) {
        symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', file) ?? [];
        if (symbols.some(symbol => symbol.name === 'Identity')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(symbols.some(symbol => symbol.name === 'Identity'), 'real language-server symbols');
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', file, new vscode.Position(2, 16));
      assert.ok(hover?.length, 'real compiler hover');
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', file, { tabSize: 4, insertSpaces: true });
      assert.ok(Array.isArray(edits), 'real formatter request');
      const replace = async (text: string): Promise<void> => {
        const update = new vscode.WorkspaceEdit();
        update.replace(file, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
        assert.ok(await vscode.workspace.applyEdit(update));
      };
      const labels = async (marked: string, trigger?: string): Promise<string[]> => {
        const offset = marked.indexOf('<cursor>'); assert.ok(offset >= 0);
        await replace(marked.replace('<cursor>', ''));
        const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', file, doc.positionAt(offset), trigger);
        return (result?.items ?? []).filter(item => item.kind !== vscode.CompletionItemKind.Snippet).map(item => typeof item.label === 'string' ? item.label : item.label.label);
      };
      assert.ok((await labels('let.<cursor>')).includes('promote'), 'let. modifier completion reaches the editor');
      const moduleModifiers = await labels('let Base = module (); let App = module:Base (let.<cursor>);');
      assert.ok(moduleModifiers.includes('override'), 'module override modifier');
      assert.deepEqual(await labels('let program = import:Std.Program;\nlet App = module:program.Entry (export let.override <cursor>);'), ['main'], 'only the inherited entry member is overridable');
      assert.deepEqual(await labels('let program = import:Std.Program;\nlet App = module:program.Entry (export let.override <cursor>);', ' '), ['main'], 'space after let.override triggers inherited member completion');
      assert.ok((await labels('let io = import:Std.<cursor>')).includes('Io'), 'standard-library root path completion');
      assert.ok((await labels('let console = import:Std.Io.<cursor>')).includes('Console'), 'standard-library nested path completion');
      assert.ok((await labels('let console = import:Std.Io.Console;\nconsole.<cursor>')).includes('print_line'), 'imported member completion');
      const pointMembers = await labels('let Point = class (export let value: int = 1;); let work = func(point: Point) { point.<cursor> };');
      assert.ok(pointMembers.includes('value'), 'parameter receiver members complete during edits');
      assert.ok((await labels('let.promote _ = import:Std.Time.Duration;\nlet copy = Z<cursor>;')).includes('Zero'), 'promoted exports complete without a qualifier');
      const documented = '/// @brief Doubles a number.\n/// @param value The input.\n/// @return Twice the input.\nlet twice = func(value: int) -> int => value * 2;\nlet answer = twice(2);\n';
      await replace(documented);
      const documentedHover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', file, doc.positionAt(documented.lastIndexOf('twice')));
      const hoverText = (documentedHover ?? []).flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
      assert.ok(hoverText.includes('Doubles a number.')); assert.ok(!hoverText.includes('@brief')); assert.ok(!hoverText.includes('@return'));
      for (const incomplete of ['let App = module (export let.\n);', 'let make = func -> func(int) -> int { return func(value: int) -> int => value; };']) {
        await replace(incomplete);
        const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', file) ?? [];
        const check = (items: vscode.DocumentSymbol[]): void => {
          for (const item of items) { assert.ok(item.name); assert.ok(item.range.contains(item.selectionRange)); check(item.children); }
        };
        check(outline);
      }
      const broken = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', file, { tabSize: 4, insertSpaces: true });
      assert.ok(Array.isArray(broken));
      await replace('let identity = func(value: int) -> int => value;\n');
      assert.ok(await doc.save());
      await config.update('targets', [{ name: 'editor-host-check', inputs: [file.fsPath] }], vscode.ConfigurationTarget.Global);
      const taskDirectory = path.join(workspace.uri.fsPath, '.vscode');
      const tasksFile = path.join(taskDirectory, 'tasks.json');
      let previousTasks: Buffer | undefined;
      try { previousTasks = await fs.readFile(tasksFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.mkdir(taskDirectory, { recursive: true });
      try {
        await fs.writeFile(tasksFile, JSON.stringify({ version: '2.0.0', tasks: [{ type: 'neura', action: 'check', target: 'editor-host-check', label: 'Check editor host' }] }));
        let tasks: vscode.Task[] = [], checkTask: vscode.Task | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
          tasks = await vscode.tasks.fetchTasks({ type: 'neura' });
          checkTask = tasks.find(task => task.definition.target === 'editor-host-check' && task.definition.action === 'check');
          if (checkTask?.execution) break;
          await pause(50);
        }
        assert.ok(tasks.some(task => task.definition.target === 'editor-host-check' && task.definition.action === 'build'), 'configured targets expose build tasks');
        assert.ok(checkTask?.execution, 'tasks.json check action resolves to an executable task');
        let ended: vscode.Disposable | undefined, timer: NodeJS.Timeout | undefined;
        const completed = new Promise<number | undefined>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('The resolved check task did not finish.')), 20000);
          ended = vscode.tasks.onDidEndTaskProcess(event => {
            if (event.execution.task.definition.target === 'editor-host-check' && event.execution.task.definition.action === 'check') resolve(event.exitCode);
          });
        });
        let execution: vscode.TaskExecution | undefined, taskFinished = false;
        try { execution = await vscode.tasks.executeTask(checkTask); const code = await completed; taskFinished = true; assert.equal(code, 0, 'tasks.json check action checks rather than building'); }
        finally { if (timer) clearTimeout(timer); ended?.dispose(); if (!taskFinished) execution?.terminate(); }
      } finally {
        if (previousTasks) await fs.writeFile(tasksFile, previousTasks); else await fs.unlink(tasksFile);
        await fs.rmdir(taskDirectory).catch(() => undefined);
      }
      await fs.writeFile(path.join(directory, 'editor-tests.nra'), 'let HostTests = module (export let test_editor = func {};);\n');
      let discoveredCount = 0;
      for (let attempt = 0; attempt < 40 && !discoveredCount; attempt++) {
        discoveredCount = await vscode.commands.executeCommand<number>('neura.refreshTests') ?? 0;
        if (!discoveredCount) await pause(100);
      }
      assert.ok(discoveredCount >= 1, 'the actual host discovers an eligible test through its file-search exclusions');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  console.log('Neura Extension Development Host integration passed.');
}
