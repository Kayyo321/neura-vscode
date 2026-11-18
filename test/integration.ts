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
    await language030(workspace.uri.fsPath, pause);
    await project030(executable, workspace.uri.fsPath, pause);
    await debugger030(workspace.uri.fsPath, pause);
  }
  console.log('Neura Extension Development Host integration passed.');
}

// Neura 0.3.0: semantic tokens with the server's legend, and diagnostics, hover, completion and
// formatting over the 0.3.0 forms.
async function language030(root: string, pause: (milliseconds: number) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(root, 'neura-030-language-'));
  const file = vscode.Uri.file(path.join(directory, 'forms.nra'));
  const source = [
    'let console = import:Std.Io.Console;',
    'let User = record (id: int64, name: string);',
    'let squares = iterator(count: int32) -> int32 {',
    '    for (let index in 0 ..= count) {',
    '        yield index * index;',
    '    }',
    '};',
    'let describe = func(value: any) -> string {',
    '    return match.is (value) {',
    '        text: string => "text " .. text,',
    '        _ => "other",',
    '    };',
    '};',
    'let report = func(user: User, total: int32 = 0) -> string {',
    '    let copy = new with(user) { name: "Grace" };',
    '    return $"{copy.name}: {total:>4} {nameof(User)}";',
    '};',
    '',
  ].join('\n');
  await fs.writeFile(file.fsPath, source);
  try {
    const doc = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(doc);
    let errors: vscode.Diagnostic[] = [];
    let hover: vscode.Hover[] = [];
    for (let attempt = 0; attempt < 120; attempt++) {
      hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', file, new vscode.Position(1, 5)) ?? [];
      if (hover.length) break;
      await pause(250);
    }
    const hoverText = hover.flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
    assert.ok(hoverText.includes('User'), `record hover: ${hoverText}`);
    errors = vscode.languages.getDiagnostics(file).filter(item => item.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(errors.map(item => item.message), [], '0.3.0 forms check without errors');
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', file);
    assert.ok(legend, 'the server advertises a semantic token legend');
    const standard = new Set(['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'label']);
    const standardModifiers = new Set(['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary']);
    const contributes = vscode.extensions.getExtension('Kayyo321.neura-vscode')!.packageJSON.contributes;
    const types = new Set<string>(contributes.semanticTokenTypes.map((item: { id: string }) => item.id));
    const modifiers = new Set<string>(contributes.semanticTokenModifiers.map((item: { id: string }) => item.id));
    for (const type of legend.tokenTypes) assert.ok(standard.has(type) || types.has(type), `server token type ${type} is contributed`);
    for (const modifier of legend.tokenModifiers) assert.ok(standardModifiers.has(modifier) || modifiers.has(modifier), `server token modifier ${modifier} is contributed`);
    for (const type of types) assert.ok(legend.tokenTypes.includes(type), `contributed token type ${type} is in the server legend`);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', file);
    assert.ok(tokens && tokens.data.length > 0, 'semantic tokens for 0.3.0 forms');
    const setText = async (text: string): Promise<void> => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
      assert.ok(await vscode.workspace.applyEdit(edit));
    };
    const offset = source.indexOf('name: "Grace"');
    await setText(source.replace('name: "Grace"', ''));
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', file, doc.positionAt(offset));
    const labels = (completion?.items ?? []).map(item => typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(labels.some(label => label.startsWith('name')), `copy completion offers record fields: ${labels.slice(0, 20).join(', ')}`);
    await setText(source);
    const format = async (): Promise<vscode.TextEdit[]> =>
      await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', file, { tabSize: 4, insertSpaces: true }) ?? [];
    assert.equal((await format()).length, 0, 'formatted 0.3.0 source is stable');
    await setText(source.replace('let User = record (id: int64, name: string);', 'let User=record(id:int64,name:string);'));
    assert.ok((await format()).length > 0, 'the formatter lays out a record declaration');
    await setText(source);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

// Neura 0.3.0 projects: a project from `neura new`, its tasks, and a project build through the task.
async function project030(executable: string, root: string, pause: (milliseconds: number) => Promise<void>): Promise<void> {
  const parent = await fs.mkdtemp(path.join(root, 'neura-030-project-'));
  const directory = path.join(parent, 'probe');
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(executable, ['new', directory, '--template', 'web'], { env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1' } });
    const manifest = path.join(directory, 'neura.toml');
    let tasks: vscode.Task[] = [];
    let build: vscode.Task | undefined;
    for (let attempt = 0; attempt < 40 && !build; attempt++) {
      tasks = await vscode.tasks.fetchTasks({ type: 'neura-project' });
      build = tasks.find(task => task.definition.action === 'build' && task.definition.target === 'web' && String(task.definition.project ?? '').endsWith('probe/neura.toml'));
      if (!build) await pause(100);
    }
    assert.ok(build, `project build task: ${tasks.map(task => task.name).join(', ')}`);
    assert.ok(tasks.some(task => task.definition.action === 'dev' && task.definition.target === 'web'), 'project dev task');
    assert.ok(!tasks.some(task => task.definition.action === 'package' && task.definition.target === 'web'), 'web targets are not packaged');
    const execution = build.execution as vscode.ProcessExecution;
    assert.deepEqual(execution.args, ['build', '--project', manifest, '--target', 'web']);
    let ended: vscode.Disposable | undefined;
    const done = new Promise<number | undefined>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The project build task did not finish.')), 120000);
      ended = vscode.tasks.onDidEndTaskProcess(event => {
        if (event.execution.task.definition.type === 'neura-project') { clearTimeout(timer); resolve(event.exitCode); }
      });
    });
    await vscode.tasks.executeTask(build);
    try { assert.equal(await done, 0, 'neura build --target web through the task'); } finally { ended?.dispose(); }
    await fs.access(path.join(directory, 'dist', 'web', 'bundle.json'));
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
}

// `neura debug --stdio` launched by the extension stops at a source breakpoint and reports the frame.
async function debugger030(root: string, pause: (milliseconds: number) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(root, 'neura-030-debug-'));
  const file = path.join(directory, 'app.nra');
  await fs.writeFile(file, [
    'let console = import:Std.Io.Console;',
    'let program = import:Std.Program;',
    'let User = record (id: int64, name: string);',
    'let App = module:program.Entry (',
    '    export let.override main = func(args: string[]) -> program.ExitCode {',
    '        let user = new User(7, "Ada");',
    '        let total = 0;',
    '        for (let index in 0 ..= 3) {',
    '            total += index;',
    '        }',
    '        console.print_line($"{user.name} {total}");',
    '        return program.ExitCode.Ok;',
    '    };',
    ');',
    '',
  ].join('\n'));
  const events: string[] = [];
  let stopped: { reason?: string } | undefined;
  const stops: { reason?: string; description?: string; text?: string }[] = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('neura', { createDebugAdapterTracker: () => ({
    onDidSendMessage: (message: { type?: string; event?: string; body?: { reason?: string } }) => {
      if (message.type === 'event' && message.event) {
        events.push(message.event);
        if (message.event === 'stopped') { stopped ??= message.body; stops.push(message.body ?? {}); }
      }
    },
  }) });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(10, 8)));
  vscode.debug.addBreakpoints([breakpoint]);
  try {
    const folder = vscode.workspace.workspaceFolders![0]!;
    assert.ok(await vscode.debug.startDebugging(folder, { type: 'neura', request: 'launch', name: 'Debug 0.3.0', program: file, cwd: directory, stopOnEntry: false }), 'debug session starts');
    for (let attempt = 0; attempt < 200 && !stopped; attempt++) await pause(100);
    assert.equal(stopped?.reason, 'breakpoint', `stopped at the breakpoint (events: ${events.join(', ')})`);
    const session = vscode.debug.activeDebugSession; assert.ok(session);
    const threads = await session.customRequest('threads') as { threads: { id: number }[] };
    const trace = await session.customRequest('stackTrace', { threadId: threads.threads[0]!.id }) as { stackFrames: { line: number; source?: { path?: string } }[] };
    assert.equal(trace.stackFrames[0]?.line, 11, 'the top frame is the breakpoint line');
    const scopes = await session.customRequest('scopes', { frameId: (trace.stackFrames[0] as unknown as { id: number }).id }) as { scopes: { variablesReference: number }[] };
    const variables = await session.customRequest('variables', { variablesReference: scopes.scopes[0]!.variablesReference }) as { variables: { name: string; value: string }[] };
    assert.ok(variables.variables.some(variable => variable.name === 'total' && variable.value === '6'), `frame locals: ${JSON.stringify(variables.variables)}`);
    const ended = new Promise<void>(resolve => { const listener = vscode.debug.onDidTerminateDebugSession(() => { listener.dispose(); resolve(); }); });
    const before = stops.length;
    await session.customRequest('next', { threadId: threads.threads[0]!.id });
    for (let attempt = 0; attempt < 100 && stops.length === before; attempt++) await pause(100);
    assert.ok(['step', 'breakpoint'].includes(stops[before]?.reason ?? ''), `a step stops again: ${JSON.stringify(stops)}`);
    let finished = false; void ended.then(() => { finished = true; });
    for (let resumes = 0; resumes < 5 && !finished && !events.includes('terminated'); resumes++) {
      const count = stops.length;
      try { await session.customRequest('continue', { threadId: threads.threads[0]!.id }); }
      catch (error) { if (finished || events.includes('terminated') || events.includes('exited')) break; throw error; }
      for (let attempt = 0; attempt < 100 && stops.length === count && !finished && !events.includes('terminated'); attempt++) await pause(100);
    }
    assert.ok(finished || events.includes('terminated') || events.includes('exited'),
      `the program ran to completion (events: ${events.join(', ')}; stops: ${JSON.stringify(stops)})`);
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]); tracker.dispose();
    console.log(`Neura debug events: ${events.join(', ')}; stops: ${JSON.stringify(stops)}`);
    // A session that is already ending refuses a second stop with Canceled.
    if (vscode.debug.activeDebugSession) await Promise.resolve(vscode.debug.stopDebugging()).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
}
