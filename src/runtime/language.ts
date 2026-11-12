import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient, LanguageClientOptions, ServerOptions, State } from 'vscode-languageclient/node';
import { configuration, resolvePath } from './configuration';
import { Toolchain, Toolchains } from './toolchain';

export function supportsCapability(tool: Toolchain, name: string): boolean {
    const capabilities = tool.capabilities;
    if (capabilities[name] === true) { return true; }
    const features = capabilities.features ?? capabilities.capabilities;
    if (Array.isArray(features)) { return features.includes(name); }
    if (features && typeof features === 'object') { return (features as Record<string, unknown>)[name] === true; }
    return false;
}

export class LanguageServices implements vscode.Disposable {
    private readonly clients = new Map<string, LanguageClient>();
    private readonly starting = new Map<string, Promise<boolean>>();
    private readonly restarts = new Map<string, number[]>();
    private disposed = false;
    constructor(private readonly tools: Toolchains, private readonly output: vscode.OutputChannel,
        private readonly onStarted?: (folder: vscode.WorkspaceFolder) => void) { }
    dispose(): void { this.disposed = true; for (const client of this.clients.values()) { void client.stop(); } this.clients.clear(); }
    has(folder: vscode.WorkspaceFolder): boolean { return this.clients.has(folder.uri.toString()); }
    client(folder: vscode.WorkspaceFolder): LanguageClient | undefined { return this.clients.get(folder.uri.toString()); }
    async start(folder: vscode.WorkspaceFolder): Promise<boolean> {
        if (this.disposed || !vscode.workspace.isTrusted || !configuration(folder).get<boolean>('server.enabled', true)) {
            this.output.appendLine(`Language server skipped for ${folder.name}: ${this.disposed ? 'extension disposed' : !vscode.workspace.isTrusted ? 'workspace not trusted' : 'disabled by neura.server.enabled'}.`);
            return false;
        }
        const key = folder.uri.toString();
        if (this.clients.has(key)) { return true; }
        const pending = this.starting.get(key); if (pending) { return pending; }
        const startup = this.startClient(folder);
        this.starting.set(key, startup);
        try { return await startup; } finally { this.starting.delete(key); }
    }
    async stop(folder: vscode.WorkspaceFolder): Promise<void> {
        await this.starting.get(folder.uri.toString());
        const client = this.clients.get(folder.uri.toString());
        this.clients.delete(folder.uri.toString());
        if (client) { await client.stop(); }
    }
    async restart(folder: vscode.WorkspaceFolder): Promise<boolean> {
        await this.stop(folder); this.restarts.delete(folder.uri.toString()); return this.start(folder);
    }
    private async startClient(folder: vscode.WorkspaceFolder): Promise<boolean> {
        this.output.appendLine(`Discovering language-server toolchain for ${folder.name}.`);
        const tool = await this.tools.discover(folder);
        if (!tool) { this.output.appendLine(`Language server unavailable for ${folder.name}: select or install a toolchain. Saved-file diagnostics remain available when a toolchain is selected.`); return false; }
        // Tooling support is negotiated. Older releases retain the saved-file CLI fallback.
        if (!supportsCapability(tool, 'lsp') && !supportsCapability(tool, 'languageServer')) {
            this.output.appendLine(`Neura ${tool.version} does not advertise language-server support for ${folder.name}; using saved-file CLI diagnostics.`);
            return false;
        }
        const roots = configuration(folder).get<string[]>('sourceRoots', []).map(root => resolvePath(root, folder));
        const server: ServerOptions = { command: tool.executable, args: ['lsp', '--stdio'],
            options: { cwd: folder.uri.fsPath, env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1' } } };
        const options: LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'neura',
                pattern: folder.uri.fsPath.replace(/\\/g, '/').replace(/[\[\]*?{}]/g, value => `[${value}]`) + '/**/*.nra' }],
            workspaceFolder: folder,
            initializationOptions: { workspaceRoot: folder.uri.fsPath, sourceRoots: roots, trusted: true,
                executable: tool.executable,
                ...(configuration(folder).get<string>('toolchain.stdlibPath', '') ?
                    { stdlibPath: resolvePath(configuration(folder).get<string>('toolchain.stdlibPath', ''), folder) } : {}) },
            synchronize: { configurationSection: 'neura' },
            outputChannel: this.output,
            errorHandler: {
                error: (error, _message, count) => {
                    this.output.appendLine(`Language server ${folder.name}: ${error.message}`);
                    return { action: (count ?? 0) < 3 ? ErrorAction.Continue : ErrorAction.Shutdown };
                },
                closed: () => {
                    const now = Date.now();
                    const attempts = (this.restarts.get(folder.uri.toString()) ?? []).filter(time => now - time < 60000);
                    attempts.push(now); this.restarts.set(folder.uri.toString(), attempts);
                    if (attempts.length > 3 || this.disposed || !vscode.workspace.isTrusted) {
                        this.clients.delete(folder.uri.toString());
                        void vscode.window.showWarningMessage(`Neura language server for ${folder.name} stopped repeatedly. Use Restart Language Server after checking the Neura output.`);
                        return { action: CloseAction.DoNotRestart };
                    }
                    return { action: CloseAction.Restart };
                },
            },
        };
        const client = new LanguageClient(`neura-${folder.index}`, `Neura (${folder.name})`, server, options);
        this.output.appendLine(`Starting Neura language server for ${folder.name}: ${tool.executable} lsp --stdio (cwd ${folder.uri.fsPath}).`);
        const state = client.onDidChangeState(event => {
            this.output.appendLine(`Language server ${folder.name}: ${State[event.oldState]} → ${State[event.newState]}.`);
        });
        try {
            await client.start();
            if (this.disposed || !vscode.workspace.isTrusted) { await client.stop(); return false; }
            this.clients.set(folder.uri.toString(), client);
            this.output.appendLine(`Neura language server ready for ${folder.name}.`);
            this.onStarted?.(folder); return true;
        } catch (error) {
            this.output.appendLine(`Language server could not start for ${folder.name}: ${String(error)}`);
            try { await client.stop(); } catch { /* Startup already failed. */ }
            return false;
        } finally { state.dispose(); }
    }
}
