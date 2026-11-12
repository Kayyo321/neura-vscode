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
        const diagnosticTask = action === 'Build' || action === 'Check';
        if (diagnosticTask) { args = [args[0]!, '--error-format=short', ...args.slice(1)]; }
        const task = new vscode.Task({ type: 'neura', action: action.toLowerCase(), target: target.name }, target.folder,
            `${action}: ${target.name}`, 'Neura', new vscode.ProcessExecution(executable, args,
                { cwd: target.cwd, env: { NEURA_NO_UPDATE_CHECK: '1', ...target.env } }), diagnosticTask ? ['$neura'] : []);
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
        if (!task.scope || typeof task.scope !== 'object') { return undefined; }
        const action = task.definition.action;
        if (!isTaskAction(action)) { throw new Error(`Unsupported Neura task action: ${String(action)}`); }
        const target = configuredTargets(task.scope).find(item => item.name === task.definition.target);
        if (!target) { return undefined; }
        const executable = await this.getExecutable(task.scope);
        return executable ? this.task(executable, target, action, task.definition) : undefined;
    }
    private task(executable: string, target: ResolvedTarget, action: TaskAction = 'build', definition?: vscode.TaskDefinition): vscode.Task {
        const title = action[0]!.toUpperCase() + action.slice(1);
        const task = new vscode.Task(definition ?? { type: 'neura', action, target: target.name }, target.folder,
            `${title} ${target.name}`, 'Neura', new vscode.CustomExecution(async () => new TargetTerminal(executable, target, action)),
            action === 'clean' ? [] : ['$neura']);
        if (action === 'build') { task.group = vscode.TaskGroup.Build; }
        if (action === 'test') { task.group = vscode.TaskGroup.Test; }
        return task;
    }
}

type TaskAction = 'build' | 'run' | 'check' | 'test' | 'clean';
const isTaskAction = (value: unknown): value is TaskAction =>
    typeof value === 'string' && ['build', 'run', 'check', 'test', 'clean'].includes(value);

class TargetTerminal implements vscode.Pseudoterminal {
    private readonly written = new vscode.EventEmitter<string>();
    private readonly exited = new vscode.EventEmitter<number>();
    readonly onDidWrite = this.written.event;
    readonly onDidClose = this.exited.event;
    private child: cp.ChildProcess | undefined;
    private closed = false;
    private pendingInput = '';
    constructor(private readonly executable: string, private readonly target: ResolvedTarget,
        private readonly action: TaskAction) { }
    open(): void { void this.start(); }
    close(): void { this.closed = true; if (this.child) { terminateProcess(this.child); } }
    handleInput(data: string): void {
        const input = this.child?.stdin;
        if (!input || this.closed) { return; }
        // A pseudoterminal has no operating-system line discipline. Supply
        // ordinary line editing and translate terminal controls for the pipe.
        for (const character of data.replace(/\r\n|\r/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')) {
            if (character === '\x03') { this.pendingInput = ''; this.written.fire('^C\r\n'); this.close(); return; }
            if (character === '\x04') {
                if (this.pendingInput) { input.write(this.pendingInput); this.pendingInput = ''; }
                input.end(); return;
            }
            if (character === '\n') {
                input.write(`${this.pendingInput}\n`); this.pendingInput = ''; this.written.fire('\r\n');
            } else if (character === '\x7f' || character === '\b') {
                if (this.pendingInput) {
                    this.pendingInput = [...this.pendingInput].slice(0, -1).join(''); this.written.fire('\b \b');
                }
            } else if (character >= ' ' || character === '\t') {
                this.pendingInput += character; this.written.fire(character);
            }
        }
    }
    private async start(): Promise<void> {
        try {
            if (this.action === 'clean') {
                if (this.closed) { this.exited.fire(1); return; }
                try {
                    const stat = await fs.lstat(this.target.output);
                    if (!stat.isFile() && !stat.isSymbolicLink()) { throw new Error('The configured output is not a file.'); }
                    if (!this.closed) { await fs.unlink(this.target.output); }
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
                this.exited.fire(this.closed ? 1 : 0); return;
            }
            if (this.action === 'check' || this.action === 'test') {
                const code = await this.spawn(this.executable, [this.action, '--error-format=short',
                    ...this.target.sourceRoots.flatMap(root => ['-I', root]), ...this.target.inputs]);
                this.exited.fire(code); return;
            }
            if (this.target.kind === 'native' && (process.platform !== 'linux' || process.arch !== 'x64')) {
                throw new Error('This Neura release supports native executable builds on Linux x86-64.');
            }
            if (this.action === 'run' && this.target.kind === 'library') {
                throw new Error('Library targets produce .nir modules. Select an application target to run.');
            }
            if (this.action === 'run' && this.target.kind === 'native' && this.target.runArgs.length) {
                throw new Error('Native targets record runtime policy at build time. Move runtime settings from runArgs to buildArgs.');
            }
            await fs.mkdir(path.dirname(this.target.output), { recursive: true });
            const build = buildArguments(this.target);
            let code = await this.spawn(this.executable, [build[0]!, '--error-format=short', ...build.slice(1)]);
            if (code === 0 && !this.closed) {
                try { await fs.access(this.target.output); }
                catch { throw new Error(`Build succeeded without producing ${this.target.output}.`); }
                if (this.action === 'run') {
                    code = await this.spawn(this.target.kind === 'native' ? this.target.output : this.executable,
                        this.target.kind === 'native' ? this.target.args : runArguments(this.target), true);
                }
            }
            this.exited.fire(this.closed ? 1 : code);
        } catch (error) { this.written.fire(`${String(error)}\r\n`); this.exited.fire(1); }
    }
    private spawn(executable: string, args: string[], interactive = false): Promise<number> {
        if (this.closed) { return Promise.resolve(1); }
        return new Promise(resolve => {
            const child = cp.spawn(executable, args, {
                cwd: this.target.cwd, env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1', ...this.target.env },
                shell: false, detached: process.platform !== 'win32', windowsHide: true,
                stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });
            this.child = child;
            child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
            const write = (data: Buffer | string): void => this.written.fire(data.toString().replace(/\r?\n/g, '\r\n'));
            child.stdout?.on('data', write); child.stderr?.on('data', write);
            child.stdin?.on('error', error => { if (!this.closed) { this.written.fire(`${error.message}\r\n`); } });
            child.on('error', error => { this.written.fire(`${error.message}\r\n`); resolve(1); });
            child.on('close', code => { if (this.child === child) { this.child = undefined; } resolve(code ?? 1); });
        });
    }
}
