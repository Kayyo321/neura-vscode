import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { buildArguments, configuredTargets, ResolvedTarget, runArguments } from './configuration';
import { terminateProcess } from './process';

export interface BuildResult { target: ResolvedTarget; executable: string; artifact: string; }

export class TaskRunner implements vscode.Disposable {
    private readonly active = new Set<vscode.TaskExecution>();
    private disposed = false;
    dispose(): void {
        this.disposed = true;
        for (const execution of this.active) { execution.terminate(); }
        this.active.clear();
    }
    stopRun(target: ResolvedTarget): void {
        for (const execution of this.active) {
            const scope = execution.task.scope;
            if (execution.task.definition.action === 'run' && execution.task.definition.target === target.name &&
                typeof scope === 'object' && scope.uri.toString() === target.folder.uri.toString()) { execution.terminate(); }
        }
    }
    async execute(executable: string, args: string[], target: ResolvedTarget, action: string): Promise<number> {
        if (this.disposed) { throw new Error('Neura task runner is disposed.'); }
        const task = new vscode.Task({ type: 'neura', action: action.toLowerCase(), target: target.name }, target.folder,
            `${action}: ${target.name}`, 'Neura', new vscode.ProcessExecution(executable, args,
                { cwd: target.cwd, env: { NEURA_NO_UPDATE_CHECK: '1', ...target.env } }), action === 'Build' ? ['$neura'] : []);
        if (action === 'Build') { task.group = vscode.TaskGroup.Build; }
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated, clear: false, focus: action === 'Run' };
        return new Promise<number>((resolve, reject) => {
            let execution: vscode.TaskExecution | undefined;
            let completed = false;
            const endProcess = vscode.tasks.onDidEndTaskProcess(event => {
                if (event.execution !== execution && event.execution.task !== task) { return; }
                finish(event.exitCode ?? 1);
            });
            const endTask = vscode.tasks.onDidEndTask(event => {
                if (event.execution !== execution && event.execution.task !== task) { return; }
                // Some terminal errors have no process event. Give an already queued process event priority.
                setTimeout(() => finish(1), 0);
            });
            const finish = (code: number): void => {
                if (completed) { return; } completed = true;
                endProcess.dispose(); endTask.dispose();
                if (execution) { this.active.delete(execution); }
                resolve(code);
            };
            vscode.tasks.executeTask(task).then(value => {
                execution = value;
                if (!completed) { this.active.add(value); }
            }, error => { endProcess.dispose(); endTask.dispose(); reject(error); });
        });
    }
    async build(executable: string, target: ResolvedTarget): Promise<BuildResult | undefined> {
        if (target.kind === 'native' && (process.platform !== 'linux' || process.arch !== 'x64')) {
            void vscode.window.showErrorMessage('This Neura release supports native executable builds on Linux x86-64.'); return undefined;
        }
        await fs.mkdir(path.dirname(target.output), { recursive: true });
        const code = await this.execute(executable, buildArguments(target), target, 'Build');
        if (code !== 0) { return undefined; }
        try { await fs.access(target.output); }
        catch { throw new Error(`Build succeeded without producing ${target.output}.`); }
        return { target, executable, artifact: target.output };
    }
    async run(result: BuildResult): Promise<void> {
        if (result.target.kind === 'library') {
            void vscode.window.showInformationMessage('Library targets produce .nir modules. Select an application target to run.'); return;
        }
        if (result.target.kind === 'native' && result.target.runArgs.length) {
            throw new Error('Native targets record runtime policy at build time. Move capability and runtime settings from runArgs to buildArgs before running this target.');
        }
        await this.execute(result.target.kind === 'native' ? result.artifact : result.executable,
            result.target.kind === 'native' ? result.target.args : runArguments(result.target), result.target, 'Run');
    }
}

export class NeuraTaskProvider implements vscode.TaskProvider {
    constructor(private readonly getExecutable: (folder: vscode.WorkspaceFolder) => Promise<string | undefined>) { }
    async provideTasks(): Promise<vscode.Task[]> {
        const tasks: vscode.Task[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const executable = await this.getExecutable(folder); if (!executable) { continue; }
            for (const target of configuredTargets(folder)) { tasks.push(this.task(executable, target)); }
        }
        return tasks;
    }
    async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
        if (typeof task.scope !== 'object') { return undefined; }
        const target = configuredTargets(task.scope).find(item => item.name === task.definition.target);
        if (!target) { return undefined; }
        const executable = await this.getExecutable(task.scope);
        return executable ? this.task(executable, target) : undefined;
    }
    private task(executable: string, target: ResolvedTarget): vscode.Task {
        const task = new vscode.Task({ type: 'neura', action: 'build', target: target.name }, target.folder,
            `Build ${target.name}`, 'Neura', new vscode.CustomExecution(async () => new BuildTerminal(executable, target)), ['$neura']);
        task.group = vscode.TaskGroup.Build; return task;
    }
}

class BuildTerminal implements vscode.Pseudoterminal {
    private readonly written = new vscode.EventEmitter<string>();
    private readonly exited = new vscode.EventEmitter<number>();
    readonly onDidWrite = this.written.event;
    readonly onDidClose = this.exited.event;
    private child: cp.ChildProcess | undefined;
    private closed = false;
    constructor(private readonly executable: string, private readonly target: ResolvedTarget) { }
    open(): void { void this.start(); }
    close(): void { this.closed = true; if (this.child) { terminateProcess(this.child); } }
    private async start(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.target.output), { recursive: true });
            if (this.closed) { this.exited.fire(1); return; }
            this.child = cp.spawn(this.executable, buildArguments(this.target), {
                cwd: this.target.cwd, env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1', ...this.target.env },
                shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.child.stdout?.setEncoding('utf8'); this.child.stderr?.setEncoding('utf8');
            const write = (data: Buffer | string): void => this.written.fire(data.toString().replace(/\r?\n/g, '\r\n'));
            this.child.stdout?.on('data', write); this.child.stderr?.on('data', write);
            this.child.on('error', error => { this.written.fire(`${error.message}\r\n`); this.exited.fire(1); });
            this.child.on('close', code => this.exited.fire(code ?? 1));
        } catch (error) { this.written.fire(`${String(error)}\r\n`); this.exited.fire(1); }
    }
}
