import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Runtime } from './runtime';
import { supportsCapability } from './runtime';
import { scalarColumnToUtf16 } from './runtime/diagnostics';
import { JsonLineDecoder, runProcess } from './process';
import { toolEnvironment } from './runtime/configuration';
import { discoveryExclusions, excludedSourcePath, mayDeclareTests, testSourceRoots } from './runtime/sources';

interface TestRecord { id: string; file: string; name: string; label?: string; line: number; column: number; }
interface TestData { record: TestRecord; folder: vscode.WorkspaceFolder; file: string; }
interface CoverageStatement { line: number; count: number; }
interface CoverageFile { path: string; statements: CoverageStatement[]; }
interface CoverageReport { version: 1; granularity: 'mapped-block-line'; measurement: 'blockEntries'; files: CoverageFile[]; }
const coverageByteLimit = 8 * 1024 * 1024;

async function coverageDirectory(folder: vscode.WorkspaceFolder): Promise<string> {
  let directory = await fs.realpath(folder.uri.fsPath);
  // Avoid following a workspace-controlled symlink when creating or reading generated reports.
  for (const component of ['.neura-vscode', 'coverage']) {
    directory = path.join(directory, component);
    try { await fs.mkdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Neura coverage directory must be a real directory inside the workspace.');
  }
  return directory;
}

async function readCoverageReport(reportedPath: string, expectedPath: string): Promise<CoverageReport> {
  if (!path.isAbsolute(reportedPath) || path.resolve(reportedPath) !== expectedPath) throw new Error('Neura returned an unexpected coverage report path.');
  const actual = await fs.realpath(reportedPath);
  if (actual !== expectedPath) throw new Error('Neura coverage reports must not be symbolic links.');
  const before = await fs.lstat(actual);
  if (!before.isFile() || before.size > coverageByteLimit) throw new Error('The Neura coverage report exceeds its size limit or is not a regular file.');
  const handle = await fs.open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > coverageByteLimit) throw new Error('The Neura coverage report exceeds its size limit or is not a regular file.');
    const buffer = Buffer.alloc(Math.min(coverageByteLimit + 1, stat.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > coverageByteLimit) throw new Error('The Neura coverage report exceeds its size limit.');
    const report: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!report || typeof report !== 'object') throw new Error('Invalid Neura coverage report.');
    const data = report as CoverageReport;
    if (data.version !== 1 || data.granularity !== 'mapped-block-line' || data.measurement !== 'blockEntries' || !Array.isArray(data.files)) throw new Error('Unsupported Neura coverage report.');
    for (const file of data.files) {
      if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0') || !Array.isArray(file.statements)) throw new Error('Invalid Neura coverage file.');
      for (const statement of file.statements) {
        if (!statement || !Number.isSafeInteger(statement.line) || statement.line < 1 || statement.line > 0x7fffffff ||
          !Number.isSafeInteger(statement.count) || statement.count < 0) throw new Error('Invalid Neura mapped-line coverage count.');
      }
    }
    return data;
  } finally { await handle.close(); }
}

export function registerTesting(context: vscode.ExtensionContext, runtime: Runtime, output: vscode.OutputChannel): void {
  const controller = vscode.tests.createTestController('neura.tests', 'Neura Tests');
  const data = new Map<string, TestData>();
  const files = new Map<string, vscode.TestItem>();
  const schedules = new Map<string, string>();
  const previouslyRun = new Set<string>();
  const observedContent = new Map<string, string>();
  const unsupported = new Set<string>();
  const changedFiles = new Set<string>();
  const coverageDetails = new WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]>();
  let refresh: NodeJS.Timeout | undefined;
  let discovery: vscode.CancellationTokenSource | undefined;
  let executing = 0;
  let disposed = false;

  const walk = (items: vscode.TestItemCollection, visit: (item: vscode.TestItem) => void): void => {
    items.forEach(item => { visit(item); walk(item.children, visit); });
  };
  const discover = async (token?: vscode.CancellationToken): Promise<void> => {
    if (!vscode.workspace.isTrusted || disposed) return;
    discovery?.cancel(); discovery?.dispose();
    const source = new vscode.CancellationTokenSource(); discovery = source;
    const linked = token?.onCancellationRequested(() => source.cancel());
    if (token?.isCancellationRequested) source.cancel();
    const ownToken = source.token;
    const next = new Set<string>();
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (ownToken.isCancellationRequested) return;
        const toolchain = await runtime.toolchains.discover(folder);
        const executable = toolchain?.executable;
        if (!executable || ownToken.isCancellationRequested) {
          for (const [uri, item] of files) if (item.uri && vscode.workspace.getWorkspaceFolder(item.uri)?.uri.toString() === folder.uri.toString()) next.add(uri);
          continue;
        }
        if (!supportsCapability(toolchain!, 'testDiscovery')) {
          const identity = `${toolchain!.executable}:${toolchain!.version}`;
          if (!unsupported.has(identity)) {
            unsupported.add(identity);
            output.appendLine(`Neura ${toolchain!.version} does not provide test discovery. Install a tooling-enabled release to use Test Explorer.`);
          }
          // Preserve existing results when a toolchain is temporarily unavailable or downgraded.
          for (const [uri, item] of files) if (item.uri && vscode.workspace.getWorkspaceFolder(item.uri)?.uri.toString() === folder.uri.toString()) next.add(uri);
          continue;
        }
        const config = vscode.workspace.getConfiguration('neura', folder);
        const patterns = config.get<string[]>('testing.include', ['**/*test*.nra', '**/tests/**/*.nra']);
        const uris = new Map<string, vscode.Uri>();
        for (const pattern of patterns) {
          for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), discoveryExclusions(folder), undefined, ownToken)) {
            if (!excludedSourcePath(path.relative(folder.uri.fsPath, uri.fsPath))) uris.set(uri.toString(), uri);
          }
        }
        let project = controller.items.get(folder.uri.toString());
        if (!project) { project = controller.createTestItem(folder.uri.toString(), folder.name, folder.uri); controller.items.add(project); }
        for (const uri of uris.values()) {
          if (ownToken.isCancellationRequested) return;
          const fileId = uri.toString(); next.add(fileId);
          let file = files.get(fileId);
          try {
            const contents = await fs.readFile(uri.fsPath, 'utf8');
            if (!mayDeclareTests(contents)) {
              project.children.delete(fileId); files.delete(fileId); next.delete(fileId); continue;
            }
            const roots = testSourceRoots(folder, uri.fsPath).flatMap(root => ['-I', root]);
            const result = await runProcess(executable, ['test', '--list', '--format=json', '--workspace-root', folder.uri.fsPath, ...roots, uri.fsPath],
              { cwd: folder.uri.fsPath, env: toolEnvironment(folder), token: ownToken, timeoutMs: 20000 });
            if (result.cancelled || ownToken.isCancellationRequested) return;
            if (result.code !== 0) throw new Error(result.stderr.trim() || `Discovery exited with status ${result.code}.`);
            const index = JSON.parse(result.stdout) as { version: number; tests: TestRecord[] };
            if (index.version !== 1 || !Array.isArray(index.tests)) throw new Error('Unsupported Neura test-discovery protocol.');
            if (!index.tests.length) { project.children.delete(fileId); files.delete(fileId); next.delete(fileId); continue; }
            if (!file) { file = controller.createTestItem(fileId, path.relative(folder.uri.fsPath, uri.fsPath), uri); project.children.add(file); files.set(fileId, file); }
            file.error = undefined;
            const lines = contents.split(/\r\n|\r|\n/);
            const modules = new Map<string, vscode.TestItem>();
            for (const record of index.tests) {
              if (typeof record.id !== 'string' || typeof record.name !== 'string') throw new Error('Invalid Neura test discovery record.');
              const id = `${folder.uri.toString()}::${record.id}`;
              const moduleName = record.name.includes('.') ? record.name.slice(0, record.name.lastIndexOf('.')) : 'Tests';
              let module = modules.get(moduleName);
              if (!module) { module = controller.createTestItem(`${fileId}::module:${moduleName}`, moduleName, uri); modules.set(moduleName, module); }
              const item = controller.createTestItem(id, record.label ?? record.name.slice(record.name.lastIndexOf('.') + 1), uri);
              const line = Math.max(0, record.line - 1);
              const column = scalarColumnToUtf16(lines[line] ?? '', record.column);
              item.range = new vscode.Range(line, column, line, column);
              data.set(id, { record, folder, file: uri.fsPath }); module.children.add(item);
            }
            file.children.replace([...modules.values()]);
          } catch (error) {
            if (ownToken.isCancellationRequested) return;
            if (!file) { file = controller.createTestItem(fileId, path.relative(folder.uri.fsPath, uri.fsPath), uri); project.children.add(file); files.set(fileId, file); }
            file.error = `Neura could not discover this file:\n${String(error)}`;
            output.appendLine(`Neura test discovery ${uri.fsPath}: ${String(error)}`);
          }
        }
      }
      if (!ownToken.isCancellationRequested) {
        for (const [id, item] of files) {
          if (!next.has(id)) { item.parent?.children.delete(id); files.delete(id); }
        }
        const folderIds = new Set((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()));
        controller.items.forEach(item => { if (!folderIds.has(item.id) || !item.children.size) controller.items.delete(item.id); });
        const present = new Set<string>(); walk(controller.items, item => { if (data.has(item.id)) present.add(item.id); });
        for (const id of data.keys()) if (!present.has(id)) { data.delete(id); previouslyRun.delete(id); schedules.delete(id); }
      }
    } finally {
      linked?.dispose();
      if (discovery === source) discovery = undefined;
      source.dispose();
    }
  };

  const selectedTests = (request: vscode.TestRunRequest): vscode.TestItem[] => {
    const excluded = new Set((request.exclude ?? []).map(item => item.id));
    const selected = new Map<string, vscode.TestItem>();
    const visit = (item: vscode.TestItem): void => {
      if (excluded.has(item.id)) return;
      if (data.has(item.id)) selected.set(item.id, item); else item.children.forEach(visit);
    };
    if (request.include) request.include.forEach(visit); else controller.items.forEach(visit);
    return [...selected.values()];
  };

  const execute = async (request: vscode.TestRunRequest, token: vscode.CancellationToken, debug = false, replay?: string, coverage = false): Promise<void> => {
    if (!vscode.workspace.isTrusted || token.isCancellationRequested || disposed) return;
    const selected = selectedTests(request); if (!selected.length) return;
    executing++;
    const finished = new Set<string>();
    const coveredFiles = new Map<string, Map<number, number>>();
    const generatedReports = new Set<string>();
    let run: vscode.TestRun | undefined;
    try {
      const folders = new Map<string, vscode.WorkspaceFolder>();
      for (const item of selected) { const info = data.get(item.id); if (info) folders.set(info.folder.uri.toString(), info.folder); }
      for (const folder of folders.values()) if (!await runtime.saveSources(folder)) return;
      // Files saved as part of this run are already included in it, so their watcher events must not trigger another run.
      for (const document of vscode.workspace.textDocuments) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (document.languageId === 'neura' && folder && folders.has(folder.uri.toString())) {
          observedContent.set(document.uri.toString(), createHash('sha256').update(document.getText()).digest('hex'));
          changedFiles.delete(document.uri.toString());
        }
      }
      if (debug) {
        const first = selected[0], info = data.get(first.id); if (!info) return;
        if (selected.length > 1) void vscode.window.showInformationMessage('Debugging the first selected Neura test.');
        const roots = testSourceRoots(info.folder, info.file);
        await vscode.debug.startDebugging(info.folder, { type: 'neura', request: 'launch', name: `Debug ${info.record.name}`, program: info.file,
          testFiles: [info.file], testFilter: info.record.id, sourceRoots: roots, cwd: info.folder.uri.fsPath, env: toolEnvironment(info.folder), stopOnEntry: true });
        return;
      }
      run = controller.createTestRun(request, replay ? 'Reproduce saved Neura schedule' : 'Neura');
      const groups = new Map<string, vscode.TestItem[]>();
      for (const item of selected) {
        run.enqueued(item); previouslyRun.add(item.id);
        const info = data.get(item.id)!; const key = `${info.folder.uri.toString()}|${info.file}`;
        groups.set(key, [...groups.get(key) ?? [], item]);
      }
      for (const items of groups.values()) {
        if (token.isCancellationRequested) break;
        const info = data.get(items[0].id)!;
        const toolchain = await runtime.toolchains.discover(info.folder);
        if (!toolchain || !supportsCapability(toolchain, 'testReporter') || !supportsCapability(toolchain, 'testFilter')) throw new Error('Install a tooling-enabled Neura release to run individual tests.');
        if (coverage && !supportsCapability(toolchain, 'coverage')) throw new Error('Install a Neura release with mapped source-line coverage to use this profile.');
        const config = vscode.workspace.getConfiguration('neura', info.folder);
        const roots = testSourceRoots(info.folder, info.file).flatMap(root => ['-I', root]);
        const byId = new Map(items.map(item => [data.get(item.id)!.record.id, item]));
        const args = ['test', '--reporter=json', '--error-format=json', '--workspace-root', info.folder.uri.fsPath,
          ...roots, ...items.flatMap(item => ['--filter', data.get(item.id)!.record.id])];
        const coveragePath = coverage ? path.join(await coverageDirectory(info.folder), `${randomUUID()}.json`) : undefined;
        if (coveragePath) { args.push('--coverage', coveragePath); generatedReports.add(coveragePath); }
        const scheduleDir = path.join(info.folder.uri.fsPath, '.neura-vscode', 'schedules');
        if (!replay && config.get<number>('testing.schedules', 1) > 1) await fs.mkdir(scheduleDir, { recursive: true });
        const saved = path.join(scheduleDir, `${createHash('sha256').update(info.file).digest('hex').slice(0, 12)}.schedule`);
        if (replay) args.push('--schedule', replay);
        else {
          if (config.get<boolean>('testing.virtualTime', false)) args.push('--virtual-time');
          const count = config.get<number>('testing.schedules', 1);
          if (count > 1) args.push('--schedules', String(count), '--schedule-seed', String(config.get<number>('testing.scheduleSeed', 0)), '--save-schedule', saved);
        }
        args.push(info.file);
        let protocolError: Error | undefined;
        let reportedCoveragePath: string | undefined;
        const currentRun = run;
        const decoder = new JsonLineDecoder(event => {
          const eventName = String(event.event ?? event.type ?? '');
          const id = String(event.id ?? event.testId ?? ''); const item = byId.get(id);
          if (eventName === 'coverage' && coverage) {
            if (typeof event.path !== 'string') throw new Error('Neura returned a coverage event without a report path.');
            reportedCoveragePath = event.path;
          } else if (eventName === 'testStart' && item) currentRun.started(item);
          else if (eventName === 'output') currentRun.appendOutput(String(event.text ?? event.output ?? '').replace(/\r?\n/g, '\r\n'), undefined, item);
          else if (eventName === 'testResult' && item && !finished.has(item.id)) {
            finished.add(item.id); schedules.delete(item.id);
            const state = String(event.state ?? event.status ?? event.result ?? '');
            const duration = typeof event.duration === 'number' ? event.duration : typeof event.durationMs === 'number' ? event.durationMs : undefined;
            if (state === 'passed' || event.passed === true) currentRun.passed(item, duration);
            else {
              const failure = event.failure && typeof event.failure === 'object' ? event.failure as Record<string, unknown> : event;
              const message = failure.expected !== undefined && failure.actual !== undefined
                ? vscode.TestMessage.diff(String(failure.message ?? 'Assertion failed'), String(failure.expected), String(failure.actual))
                : new vscode.TestMessage(String(failure.message ?? event.message ?? 'Neura test failed.'));
              const location = event.location && typeof event.location === 'object' ? event.location as Record<string, unknown> : failure;
              const filename = typeof location.file === 'string' ? location.file : info.file;
              const line = typeof location.line === 'number' ? Math.max(0, location.line - 1) : item.range?.start.line ?? 0;
              message.location = new vscode.Location(vscode.Uri.file(path.resolve(info.folder.uri.fsPath, filename)), new vscode.Position(line, 0));
              currentRun.failed(item, message, duration);
              if (typeof event.savedSchedule === 'string' && event.savedSchedule) schedules.set(item.id, path.resolve(info.folder.uri.fsPath, event.savedSchedule));
            }
          }
        });
        const result = await runProcess(toolchain.executable, args, { cwd: info.folder.uri.fsPath, env: toolEnvironment(info.folder), token,
          timeoutMs: config.get<number>('testing.timeoutMs', 60000),
          onStdout: chunk => { if (!protocolError) try { decoder.push(chunk); } catch (error) { protocolError = error as Error; throw error; } } });
        if (!protocolError) try { decoder.finish(); } catch (error) { protocolError = error as Error; }
        if (result.stderr) run.appendOutput(result.stderr.replace(/\r?\n/g, '\r\n'));
        if (protocolError) throw protocolError;
        if (coveragePath && !result.cancelled && !token.isCancellationRequested) {
          try {
            if (!reportedCoveragePath) throw new Error('Neura did not emit a mapped source-line coverage report.');
            const report = await readCoverageReport(reportedCoveragePath, coveragePath);
            for (const file of report.files) {
              const counts = coveredFiles.get(file.path) ?? new Map<number, number>();
              for (const statement of file.statements) counts.set(statement.line, Math.min(Number.MAX_SAFE_INTEGER,
                (counts.get(statement.line) ?? 0) + statement.count));
              coveredFiles.set(file.path, counts);
              const statements = [...counts].sort(([left], [right]) => left - right).map(([line, count]) =>
                new vscode.StatementCoverage(count, new vscode.Range(line - 1, 0, line, 0)));
              const fileCoverage = new vscode.FileCoverage(vscode.Uri.file(file.path),
                { covered: statements.filter(statement => statement.executed !== false && statement.executed !== 0).length, total: statements.length });
              coverageDetails.set(fileCoverage, statements); run.addCoverage(fileCoverage);
            }
          } finally { await fs.unlink(coveragePath).catch(() => undefined); generatedReports.delete(coveragePath); }
        }
        for (const item of items) if (!finished.has(item.id)) {
          finished.add(item.id);
          if (result.cancelled || token.isCancellationRequested) run.skipped(item);
          else run.errored(item, new vscode.TestMessage(result.stderr || `Neura exited with status ${result.code} without a result.`));
        }
      }
      for (const item of selected) if (!finished.has(item.id)) { finished.add(item.id); run.skipped(item); }
    } catch (error) {
      for (const item of selected) if (!finished.has(item.id)) {
        finished.add(item.id);
        if (token.isCancellationRequested) run?.skipped(item); else run?.errored(item, new vscode.TestMessage(String(error)));
      }
      output.appendLine(`Neura tests: ${String(error)}`);
      run?.appendOutput(`Neura: ${String(error)}\r\n`);
    } finally {
      for (const report of generatedReports) await fs.unlink(report).catch(() => undefined);
      run?.end(); executing--;
      if (changedFiles.size && !disposed) scheduleRefresh();
    }
  };

  const scheduleRefresh = (): void => {
    if (disposed) return;
    if (refresh) clearTimeout(refresh);
    refresh = setTimeout(() => {
      refresh = undefined;
      if (executing) return; // The run's finally block retries with the retained changes.
      const changed = [...changedFiles]; changedFiles.clear();
      void (async () => {
        await discover();
        const affectedFolders = new Set(changed.map(uri => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri))?.uri.toString()).filter(Boolean));
        const items: vscode.TestItem[] = [];
        walk(controller.items, item => {
          const info = data.get(item.id);
          if (info && previouslyRun.has(item.id) && affectedFolders.has(info.folder.uri.toString()) &&
            vscode.workspace.getConfiguration('neura', info.folder).get<boolean>('testing.watch', false)) items.push(item);
        });
        if (items.length) {
          const source = new vscode.CancellationTokenSource();
          try { await execute(new vscode.TestRunRequest(items), source.token); } finally { source.dispose(); }
        }
      })().catch(error => output.appendLine(`Neura test refresh: ${String(error)}`));
    }, 400);
  };

  controller.resolveHandler = async () => discover(); controller.refreshHandler = discover;
  controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => execute(request, token), true);
  controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => execute(request, token, true), true);
  const coverageProfile = controller.createRunProfile('Coverage (mapped source lines)', vscode.TestRunProfileKind.Coverage,
    (request, token) => execute(request, token, false, undefined, true), true);
  coverageProfile.loadDetailedCoverage = async (_run, fileCoverage, token) => token.isCancellationRequested ? [] : coverageDetails.get(fileCoverage) ?? [];
  context.subscriptions.push(controller,
    vscode.commands.registerCommand('neura.refreshTests', async () => { await discover(); return data.size; }),
    vscode.commands.registerCommand('neura.testFile', async (value?: string | vscode.Uri) => {
      await discover();
      const uri = value ? typeof value === 'string' ? vscode.Uri.parse(value) : value : vscode.window.activeTextEditor?.document.uri;
      const item = uri && files.get(uri.toString());
      if (item) {
        const source = new vscode.CancellationTokenSource();
        try { await execute(new vscode.TestRunRequest([item]), source.token); } finally { source.dispose(); }
      } else void vscode.window.showInformationMessage('No eligible Neura tests found in this file.');
    }),
    vscode.commands.registerCommand('neura.reproduceSchedule', async (item?: vscode.TestItem) => {
      let chosen = item;
      if (!chosen) {
        const picks: { label: string; id: string }[] = [];
        for (const [id] of schedules) { const info = data.get(id); if (info) picks.push({ label: info.record.name, id }); }
        const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a failing schedule to reproduce' });
        if (pick) walk(controller.items, candidate => { if (candidate.id === pick.id) chosen = candidate; });
      }
      const saved = chosen && schedules.get(chosen.id); if (!chosen || !saved) return;
      try { await fs.access(saved); } catch { void vscode.window.showWarningMessage('The saved failing schedule no longer exists.'); return; }
      const source = new vscode.CancellationTokenSource();
      try { await execute(new vscode.TestRunRequest([chosen]), source.token, false, saved); } finally { source.dispose(); }
    }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.nra');
  const changed = async (uri: vscode.Uri, deleted = false): Promise<void> => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (disposed || !vscode.workspace.isTrusted || !folder || excludedSourcePath(path.relative(folder.uri.fsPath, uri.fsPath))) return;
    try {
      const digest = deleted ? '<deleted>' : createHash('sha256').update(await fs.readFile(uri.fsPath)).digest('hex');
      if (observedContent.get(uri.toString()) === digest) return;
      observedContent.set(uri.toString(), digest);
      changedFiles.add(uri.toString()); scheduleRefresh();
    } catch (error) { output.appendLine(`Neura test watcher: ${String(error)}`); }
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(uri => { void changed(uri); }),
    watcher.onDidDelete(uri => { void changed(uri, true); }), watcher.onDidChange(uri => { void changed(uri); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('neura') || event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) scheduleRefresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleRefresh()),
    { dispose() { disposed = true; if (refresh) clearTimeout(refresh); discovery?.cancel(); discovery?.dispose(); } });
}
