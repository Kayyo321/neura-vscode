import * as cp from 'node:child_process';
import * as vscode from 'vscode';

export interface ProcessResult { code: number; stdout: string; stderr: string; }
export interface ProcessOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    token?: vscode.CancellationToken;
    timeout?: number;
    maxBytes?: number;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
}

export function terminateProcess(child: cp.ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) { return; }
    if (process.platform === 'win32') {
        const killer = cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
    } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        const force = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
        }, 1500);
        force.unref();
        child.once('exit', () => clearTimeout(force));
    }
}

export function runProcess(executable: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        if (options.token?.isCancellationRequested) { reject(new vscode.CancellationError()); return; }
        const child = cp.spawn(executable, [...args], {
            cwd: options.cwd, env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1', ...options.env },
            detached: process.platform !== 'win32', windowsHide: true, shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
        let stdout = '', stderr = '', bytes = 0;
        let failure: Error | undefined;
        const consume = (data: Buffer | string, stream: 'stdout' | 'stderr'): void => {
            if (failure) { return; }
            const value = data.toString();
            bytes += Buffer.byteLength(value);
            if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
                failure = new Error('Neura output exceeded the configured capture limit. See the terminal for large output.');
                terminateProcess(child); return;
            }
            try {
                if (stream === 'stdout') { stdout += value; options.onStdout?.(value); }
                else { stderr += value; options.onStderr?.(value); }
            } catch (error) {
                failure = error instanceof Error ? error : new Error(String(error)); terminateProcess(child);
            }
        };
        child.stdout?.on('data', data => consume(data, 'stdout'));
        child.stderr?.on('data', data => consume(data, 'stderr'));
        const cancellation = options.token?.onCancellationRequested(() => {
            failure = new vscode.CancellationError(); terminateProcess(child);
        });
        const timer = options.timeout ? setTimeout(() => {
            failure = new Error(`Neura timed out after ${options.timeout} ms.`); terminateProcess(child);
        }, options.timeout) : undefined;
        const cleanup = (): void => { cancellation?.dispose(); if (timer) { clearTimeout(timer); } };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', code => {
            cleanup();
            if (failure) { reject(failure); }
            else { resolve({ code: code ?? 1, stdout, stderr }); }
        });
    });
}
