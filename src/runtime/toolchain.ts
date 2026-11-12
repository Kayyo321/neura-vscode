import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { configuration, resolvePath, toolEnvironment } from './configuration';
import { runProcess } from './process';

export interface Toolchain {
    executable: string;
    version: string;
    description: string;
    capabilities: Record<string, unknown>;
}

export class Toolchains implements vscode.Disposable {
    private readonly cache = new Map<string, Promise<Toolchain | undefined>>();
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
    constructor(private readonly output: vscode.OutputChannel) {
        this.status.command = 'neura.doctor'; this.status.name = 'Neura toolchain';
        this.status.text = '$(circle-outline) Neura';
    }
    dispose(): void { this.status.dispose(); this.cache.clear(); }
    invalidate(): void { this.cache.clear(); }
    async discover(folder?: vscode.WorkspaceFolder): Promise<Toolchain | undefined> {
        const key = folder?.uri.toString() ?? '';
        let result = this.cache.get(key);
        if (!result) {
            result = this.find(folder).catch(error => { this.output.appendLine(`Toolchain detection: ${String(error)}`); return undefined; });
            this.cache.set(key, result);
        }
        return result;
    }
    async showStatus(folder?: vscode.WorkspaceFolder): Promise<void> {
        const hasNeura = vscode.window.activeTextEditor?.document.languageId === 'neura' || !!folder;
        if (!hasNeura) { this.status.hide(); return; }
        const tool = await this.discover(folder);
        this.status.text = tool ? `$(check) Neura ${tool.version}` : '$(warning) Install Neura';
        this.status.command = tool ? 'neura.doctor' : 'neura.install';
        this.status.tooltip = tool ? `${tool.description}\n${tool.executable}\nHost: ${vscode.env.remoteName ?? process.platform}`
            : 'Install or select a Neura toolchain on this workspace host.';
        this.status.show();
    }
    private async find(folder?: vscode.WorkspaceFolder): Promise<Toolchain | undefined> {
        if (!vscode.workspace.isTrusted) { return undefined; }
        if (process.platform === 'win32' && !vscode.env.remoteName) { return undefined; }
        const configured = configuration(folder).get<string>('toolchain.path', '').trim();
        const candidates = configured ? [folder ? resolvePath(configured, folder) : configured] : [
            'neura', path.join(os.homedir(), '.local', 'bin', 'neura'),
            path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'neura', 'bin', 'neura'),
        ];
        for (const candidate of [...new Set(candidates)]) {
            try {
                const executable = await resolveExecutable(candidate, folder?.uri.fsPath);
                if (!executable) { continue; }
                const result = await runProcess(executable, ['--version'], { cwd: folder?.uri.fsPath, env: toolEnvironment(folder), timeout: 10000 });
                if (result.code !== 0) { continue; }
                const description = result.stdout.trim();
                const match = /^neura\s+([^\s]+)/.exec(description);
                if (!match) { continue; }
                let capabilities: Record<string, unknown> = {};
                try {
                    const probe = await runProcess(executable, ['capabilities', '--json'], { cwd: folder?.uri.fsPath, env: toolEnvironment(folder), timeout: 10000 });
                    if (probe.code === 0) { capabilities = JSON.parse(probe.stdout) as Record<string, unknown>; }
                } catch { /* Older Neura releases have no capability endpoint. */ }
                this.output.appendLine(`Using ${description}: ${executable}`);
                return { executable, version: match[1]!, description, capabilities };
            } catch (error) {
                if (configured) { this.output.appendLine(`Configured toolchain unavailable: ${String(error)}`); }
            }
        }
        return undefined;
    }
    async require(folder?: vscode.WorkspaceFolder): Promise<Toolchain | undefined> {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showInformationMessage('Trust this workspace to run the Neura toolchain.'); return undefined;
        }
        const tool = await this.discover(folder);
        if (tool) { return tool; }
        const action = await vscode.window.showWarningMessage('No usable Neura toolchain was found on this workspace host.',
            'Install Neura', 'Select Executable', ...(process.platform === 'win32' ? ['Reopen in WSL'] : []));
        if (action === 'Install Neura') { await this.install(folder); }
        else if (action === 'Select Executable') { await this.select(folder); }
        else if (action === 'Reopen in WSL') { await this.reopenInWsl(); }
        return undefined;
    }
    async select(folder?: vscode.WorkspaceFolder): Promise<void> {
        const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, title: 'Select the Neura executable on this workspace host' });
        if (!files?.[0]) { return; }
        await configuration(folder).update('toolchain.path', files[0].fsPath,
            folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
        this.invalidate(); await this.showStatus(folder);
    }
    async install(folder?: vscode.WorkspaceFolder): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showInformationMessage('Trust this workspace before installing a toolchain.'); return;
        }
        if (process.platform === 'win32' && !vscode.env.remoteName) { await this.reopenInWsl(); return; }
        const version = await vscode.window.showInputBox({ title: 'Install Neura', prompt:
            'Release version (leave empty for the latest stable release). Installs under your home directory without sudo.',
            value: '', validateInput: value => !value || /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value) ? undefined : 'Use a version such as 0.2.0 or 0.2.1-rc.1.' });
        if (version === undefined) { return; }
        const url = version ? `https://github.com/Kayyo321/neura/releases/download/v${version}/install.sh`
            : 'https://github.com/Kayyo321/neura/releases/latest/download/install.sh';
        const args = ['--proto', '=https', '--tlsv1.2', '-fsSL', url];
        const terminal = vscode.window.createTerminal({ name: 'Install Neura', cwd: folder?.uri.fsPath });
        terminal.show();
        // This intentionally uses the official POSIX installer. Every substituted value is validated above.
        terminal.sendText(`curl ${args.map(shellQuote).join(' ')} | sh${version ? ` -s -- --version ${shellQuote(version)}` : ''}`);
        this.invalidate();
        void vscode.window.showInformationMessage('The installer is running in the terminal. After it finishes, use Neura: Refresh Toolchain.');
    }
    async command(command: 'doctor' | 'update', folder?: vscode.WorkspaceFolder, check = false): Promise<void> {
        const tool = await this.require(folder); if (!tool) { return; }
        const task = new vscode.Task({ type: 'neura', action: command }, folder ?? vscode.TaskScope.Global,
            command === 'doctor' ? 'Doctor' : check ? 'Check for updates' : 'Update toolchain', 'Neura',
            new vscode.ProcessExecution(tool.executable, [command, ...(check ? ['--check'] : [])], { cwd: folder?.uri.fsPath, env: toolEnvironment(folder) }), []);
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
        await vscode.tasks.executeTask(task);
        this.invalidate();
    }
    async reopenInWsl(): Promise<void> {
        const command = 'remote-wsl.reopenInWSL';
        if ((await vscode.commands.getCommands(true)).includes(command)) {
            await vscode.commands.executeCommand(command);
        } else {
            const action = await vscode.window.showInformationMessage('Install Microsoft WSL support, set up a compatible WSL2 distribution, then reopen this folder in WSL.', 'Install WSL Extension', 'WSL Setup Guide');
            if (action === 'Install WSL Extension') { await vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode-remote.remote-wsl'); }
            else if (action === 'WSL Setup Guide') { await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/windows/wsl/install')); }
        }
    }
}

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export async function executableExists(executable: string): Promise<boolean> {
    try { await fs.access(executable); return true; } catch { return false; }
}

export async function resolveExecutable(candidate: string, cwd = process.cwd()): Promise<string | undefined> {
    const paths = path.isAbsolute(candidate) || candidate.includes(path.sep)
        ? [path.resolve(cwd, candidate)]
        : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, candidate));
    for (const file of paths) {
        try {
            await fs.access(file, constants.X_OK);
            const stat = await fs.stat(file);
            if (stat.isFile()) { return await fs.realpath(file); }
        } catch { /* Continue to the next PATH location. */ }
    }
    return undefined;
}
