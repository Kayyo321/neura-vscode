import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { activeFolder, configuration, configuredTargets, resolveTarget, ResolvedTarget } from './configuration';
import { Toolchains } from './toolchain';
import { LanguageServices } from './language';
import { BuildResult, NeuraTaskProvider, TaskRunner } from './tasks';
import { CliDiagnostics } from './diagnostics';
import { createProject, Projects } from './projects';

export type { TargetConfiguration, ResolvedTarget, TargetKind } from './configuration';
export type { Toolchain } from './toolchain';
export type { BuildResult } from './tasks';
export { runProcess, terminateProcess } from './process';
export { supportsCapability } from './language';

export class Runtime implements vscode.Disposable {
    readonly toolchains: Toolchains;
    readonly language: LanguageServices;
    private readonly tasks = new TaskRunner();
    private readonly diagnostics: CliDiagnostics;
    private projects: Projects | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly busy = new Set<string>();
    private readonly running = new Map<string, { target: ResolvedTarget; token: symbol }>();
    private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private registered = false;
    private disposed = false;
    private refreshing: Promise<void> | undefined;
    private refreshAgain = false;
    constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
        this.toolchains = new Toolchains(output); this.diagnostics = new CliDiagnostics(output);
        this.language = new LanguageServices(this.toolchains, output, folder => this.diagnostics.clear(folder));
    }
    register(): void {
        if (this.registered) { return; } this.registered = true;
        this.projects = new Projects();
        const command = (name: string, callback: (...args: unknown[]) => unknown): void => {
            this.disposables.push(vscode.commands.registerCommand(name, (...args: unknown[]) =>
                Promise.resolve().then(() => callback(...args)).catch(error => this.report(error))));
        };
        command('neura.install', () => this.toolchains.install(activeFolder()));
        command('neura.selectToolchain', () => this.toolchains.select(activeFolder()).then(() => this.refresh()));
        command('neura.refreshToolchain', () => this.refresh());
        command('neura.doctor', () => this.toolchains.command('doctor', activeFolder()));
        command('neura.checkUpdates', () => this.toolchains.command('update', activeFolder(), true));
        command('neura.update', () => this.toolchains.command('update', activeFolder()));
        command('neura.reopenInWsl', () => this.toolchains.reopenInWsl());
        command('neura.selectTarget', async argument => { await this.getTarget(await this.document(argument), true); });
        command('neura.build', async argument => { await this.build(await this.document(argument)); });
        command('neura.run', async argument => this.run(await this.document(argument)));
        command('neura.check', async argument => this.check(await this.document(argument)));
        command('neura.clean', async argument => this.clean(await this.document(argument)));
        command('neura.rebuild', async argument => { const document = await this.document(argument); await this.clean(document); await this.build(document); });
        command('neura.runArtifact', () => this.runArtifact());
        command('neura.newProject', () => createProject());
        command('neura.refreshProjects', () => this.projects?.refresh());
        command('neura.restartLanguageServer', async () => {
            const folder = activeFolder(); if (folder) { await this.language.restart(folder); }
        });
        command('neura.showOutput', () => this.output.show());
        this.disposables.push(vscode.tasks.registerTaskProvider('neura', new NeuraTaskProvider(async folder => (await this.toolchains.discover(folder))?.executable)),
            vscode.window.onDidChangeActiveTextEditor(editor => { void this.toolchains.showStatus(activeFolder(editor?.document)); }),
            vscode.workspace.onDidSaveTextDocument(document => { void this.onSave(document); }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('neura')) { void this.refresh(); }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(event => {
                for (const folder of event.removed) { void this.language.stop(folder); this.diagnostics.clear(folder); }
                for (const folder of event.added) { void this.language.start(folder); }
                this.projects?.refresh();
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }));
        void this.refresh();
    }
    dispose(): void {
        this.disposed = true;
        this.language.dispose(); this.tasks.dispose(); this.diagnostics.dispose(); this.toolchains.dispose(); this.projects?.dispose();
        for (const disposable of this.disposables) { disposable.dispose(); } this.disposables.length = 0;
        for (const timer of this.saveTimers.values()) { clearTimeout(timer); } this.saveTimers.clear();
    }
    async getExecutable(folder?: vscode.WorkspaceFolder): Promise<string | undefined> {
        return (await this.toolchains.require(folder))?.executable;
    }
    async getTarget(document?: vscode.TextDocument, pick = false): Promise<ResolvedTarget | undefined> {
        const folder = activeFolder(document);
        if (!folder) { void vscode.window.showInformationMessage('Open a folder to configure and build Neura targets.'); return undefined; }
        const targets = configuredTargets(folder, document?.uri.scheme === 'file' ? document.uri.fsPath : undefined);
        const selectedName = this.context.workspaceState.get<string>(`target:${folder.uri.toString()}`)
            ?? configuration(folder).get<string>('defaultTarget', '');
        if (targets.length) {
            const remembered = targets.find(target => target.name === selectedName);
            if (!pick && (remembered || targets.length === 1)) { return remembered ?? targets[0]; }
            const target = await vscode.window.showQuickPick(targets.map(value => ({ label: value.name,
                description: value.kind, detail: value.inputs.map(input => path.relative(folder.uri.fsPath, input)).join(', '), value })),
            { title: `Neura target (${folder.name})`, placeHolder: 'Choose a build/run target' });
            if (target) { await this.context.workspaceState.update(`target:${folder.uri.toString()}`, target.value.name); }
            return target?.value;
        }
        const current = document ?? vscode.window.activeTextEditor?.document;
        if (!current || current.uri.scheme !== 'file' || !/\.(nra|nir)$/.test(current.uri.fsPath)) {
            void vscode.window.showInformationMessage('Open a Neura source file or configure neura.targets.'); return undefined;
        }
        let kind: 'application' | 'library' = 'application';
        const client = this.language.client(folder);
        if (client && current.languageId === 'neura') {
            try {
                const entries = await client.sendRequest<Array<{ uri?: string }>>('neura/entryPoints', { textDocument: { uri: current.uri.toString() } });
                if (Array.isArray(entries) && !entries.some(entry => entry.uri && vscode.Uri.parse(entry.uri).toString() === current.uri.toString())) { kind = 'library'; }
            } catch { /* A failed optional request leaves strict build diagnostics authoritative. */ }
        }
        return resolveTarget({ name: path.basename(current.uri.fsPath, path.extname(current.uri.fsPath)),
            inputs: [current.uri.fsPath], kind }, folder, current.uri.fsPath);
    }
    async build(document?: vscode.TextDocument): Promise<BuildResult | undefined> {
        const target = await this.getTarget(document); if (!target) { return undefined; }
        return this.buildTarget(target);
    }
    async buildTarget(target: ResolvedTarget): Promise<BuildResult | undefined> {
        const executable = await this.getExecutable(target.folder); if (!executable) { return undefined; }
        if (!(await this.saveSources(target.folder))) { return undefined; }
        const key = `${target.folder.uri.toString()}:${target.name}`;
        if (this.busy.has(key)) { void vscode.window.showInformationMessage(`Neura target ${target.name} is already building.`); return undefined; }
        this.busy.add(key);
        try { return await this.tasks.build(executable, target); }
        finally { this.busy.delete(key); this.projects?.refresh(); }
    }
    async run(document?: vscode.TextDocument): Promise<void> {
        const built = await this.build(document); if (built) { await this.runBuilt(built); }
    }
    async check(document?: vscode.TextDocument): Promise<void> {
        const target = await this.getTarget(document); if (!target) { return; }
        const executable = await this.getExecutable(target.folder); if (!executable) { return; }
        if (!(await this.saveSources(target.folder))) { return; }
        if (this.language.has(target.folder)) {
            await this.tasks.execute(executable, ['check', ...target.sourceRoots.flatMap(root => ['-I', root]), ...target.inputs], target, 'Check');
        } else { await this.diagnostics.check(executable, target); }
    }
    async refresh(): Promise<void> {
        if (this.disposed) { return; }
        if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
        this.refreshing = (async () => {
            do {
                this.refreshAgain = false;
                this.toolchains.invalidate(); this.projects?.refresh();
                await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder => {
                    try { await this.language.restart(folder); }
                    catch (error) { this.output.appendLine(`Refresh ${folder.name}: ${String(error)}`); }
                }));
                if (!this.disposed) { await this.toolchains.showStatus(activeFolder()); }
            } while (this.refreshAgain && !this.disposed);
        })();
        try { await this.refreshing; } finally { this.refreshing = undefined; }
    }
    async saveSources(folder: vscode.WorkspaceFolder): Promise<boolean> {
        const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty && document.languageId === 'neura'
            && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString());
        if (!dirty.length) { return true; }
        if (!configuration(folder).get<boolean>('build.saveBeforeBuild', true)) {
            const choice = await vscode.window.showWarningMessage('Save changed Neura source files before building or running?', 'Save and Continue', 'Cancel');
            if (choice !== 'Save and Continue') { return false; }
        }
        for (const document of dirty) {
            if (!(await document.save())) { void vscode.window.showWarningMessage('Neura operation cancelled because a source file could not be saved.'); return false; }
        }
        return true;
    }
    private async onSave(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'neura' || !vscode.workspace.isTrusted) { return; }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) { return; }
        this.scheduleSavedBuild(document, folder);
        if (this.language.has(folder) || !configuration(folder).get<boolean>('check.onSave', true)) { return; }
        const tool = await this.toolchains.discover(folder); if (!tool) { return; }
        try {
            const target = configuredTargets(folder).find(item => item.inputs.includes(document.uri.fsPath))
                ?? resolveTarget({ name: path.basename(document.uri.fsPath, '.nra'), inputs: [document.uri.fsPath] }, folder);
            await this.diagnostics.check(tool.executable, target);
        } catch (error) { this.output.appendLine(`Saved-file diagnostics: ${String(error)}`); }
    }
    private async runBuilt(built: BuildResult): Promise<void> {
        const key = `${built.target.folder.uri.toString()}:${built.target.name}`;
        const token = Symbol('run');
        this.tasks.stopRun(built.target); this.running.set(key, { target: built.target, token });
        try { await this.tasks.run(built); }
        finally { if (this.running.get(key)?.token === token) { this.running.delete(key); } }
    }
    private scheduleSavedBuild(document: vscode.TextDocument, folder: vscode.WorkspaceFolder): void {
        const build = configuration(folder).get<boolean>('build.onSave', false);
        const restart = configuration(folder).get<boolean>('run.restartOnChange', false);
        if (!build && !restart) { return; }
        const key = folder.uri.toString();
        const old = this.saveTimers.get(key); if (old) { clearTimeout(old); }
        this.saveTimers.set(key, setTimeout(() => {
            this.saveTimers.delete(key);
            void (async () => {
                const running = [...this.running.values()].map(run => run.target).find(target => target.folder.uri.toString() === key);
                const targets = configuredTargets(folder);
                const selected = this.context.workspaceState.get<string>(`target:${key}`) ?? configuration(folder).get<string>('defaultTarget', '');
                const target = running ?? targets.find(item => item.name === selected) ??
                    targets.find(item => item.inputs.includes(document.uri.fsPath)) ?? (targets.length === 1 ? targets[0] : undefined);
                if (!target) { return; }
                if (restart && running) { this.tasks.stopRun(running); }
                const result = await this.buildTarget(target);
                if (result && restart && running) { await this.runBuilt(result); }
            })().catch(error => this.report(error));
        }, 250));
    }
    private async clean(document?: vscode.TextDocument): Promise<void> {
        if (!vscode.workspace.isTrusted) { return; }
        const target = await this.getTarget(document); if (!target) { return; }
        // Delete this exact configured output only, never a directory or an inferred glob.
        try {
            const stat = await fs.lstat(target.output);
            if (!stat.isFile() && !stat.isSymbolicLink()) { throw new Error('The configured output is not a file.'); }
            await fs.unlink(target.output); this.projects?.refresh();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
    private async runArtifact(): Promise<void> {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Neura image': ['nvr'] }, title: 'Run Existing Artifact' });
        if (!files?.[0]) { return; }
        const folder = vscode.workspace.getWorkspaceFolder(files[0]) ?? activeFolder();
        if (!folder) { void vscode.window.showInformationMessage('Open a workspace folder before running an artifact.'); return; }
        const executable = await this.getExecutable(folder); if (!executable) { return; }
        const target = resolveTarget({ name: path.basename(files[0].fsPath), inputs: [files[0].fsPath] }, folder);
        target.output = files[0].fsPath;
        await this.tasks.run({ target, executable, artifact: files[0].fsPath });
    }
    private async document(argument?: unknown): Promise<vscode.TextDocument | undefined> {
        if (argument instanceof vscode.Uri) { return vscode.workspace.openTextDocument(argument); }
        if (typeof argument === 'string') { return vscode.workspace.openTextDocument(vscode.Uri.parse(argument)); }
        return vscode.window.activeTextEditor?.document;
    }
    private report(error: unknown): void {
        if (error instanceof vscode.CancellationError) { return; }
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(message); void vscode.window.showErrorMessage(`Neura: ${message}`);
    }
}

export function createRuntime(context: vscode.ExtensionContext, output: vscode.OutputChannel): Runtime {
    return new Runtime(context, output);
}
