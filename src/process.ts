import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CancellationToken } from 'vscode';

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: CancellationToken;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
export interface ProcessResult { code: number; stdout: string; stderr: string; cancelled: boolean; }

/** Run an executable without a shell, with bounded output and whole-group cleanup. */
export function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.token?.isCancellationRequested) { resolve({ code: -1, stdout: '', stderr: '', cancelled: true }); return; }
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...process.env, NEURA_NO_UPDATE_CHECK: '1', ...options.env }, shell: false, detached: process.platform !== 'win32', windowsHide: true });
    let stdout = '', stderr = '', bytes = 0, cancelled = false, failure: Error | undefined;
    const limit = options.maxOutputBytes ?? 32 * 1024 * 1024;
    const kill = () => {
      cancelled = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* already exited */ }
      const force = setTimeout(() => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } }, 1000);
      force.unref();
      child.once('close', () => clearTimeout(force));
    };
    const subscription = options.token?.onCancellationRequested(kill);
    const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => { failure = new Error(`Neura exceeded the ${options.timeoutMs} ms time limit.`); kill(); }, options.timeoutMs) : undefined;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) { failure = new Error('Neura output exceeded the configured limit.'); kill(); return; }
      const value = decoders[kind].write(chunk);
      try {
        if (kind === 'stdout') { stdout += value; options.onStdout?.(value); }
        else { stderr += value; options.onStderr?.(value); }
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); kill(); }
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', error => { failure = error; });
    child.on('close', code => { if (timer) clearTimeout(timer); subscription?.dispose(); if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr, cancelled }); });
  });
}

/** NDJSON framing keeps partial chunks and rejects protocol contamination. */
export class JsonLineDecoder {
  private pending = '';
  constructor(private readonly receive: (event: Record<string, unknown>) => void, private readonly maxLine = 4 * 1024 * 1024) {}
  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) { const line = this.pending.slice(0, newline).trim(); this.pending = this.pending.slice(newline + 1); if (line) this.parse(line); }
    if (this.pending.length > this.maxLine) throw new Error('Neura protocol line exceeds its size limit.');
  }
  finish(): void { const last = this.pending.trim(); this.pending = ''; if (last) this.parse(last); }
  private parse(line: string): void {
    if (line.length > this.maxLine) throw new Error('Neura protocol line exceeds its size limit.');
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Neura protocol event.');
    this.receive(event as Record<string, unknown>);
  }
}
