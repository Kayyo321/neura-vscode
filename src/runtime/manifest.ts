// Reading of a Neura 0.3 project manifest (neura.toml) for the editor: just the project name and the
// targets with their kinds and packages, enough to offer build, dev and package tasks. The SDK's own
// reader validates the manifest; this one never rejects a file and reports nothing.

export type ProjectTargetKind = 'web' | 'server' | 'desktop' | string;

export interface ProjectTarget { name: string; kind: ProjectTargetKind; package?: string; }
export interface ProjectManifest { name?: string; targets: ProjectTarget[]; packages: Map<string, string>; }

/** Actions the SDK's project tools take for a target (docs/design/Projects030.md, Commands). */
export type ProjectAction = 'build' | 'dev' | 'package';

export const projectActions = (target: ProjectTarget): ProjectAction[] =>
    target.kind === 'web' ? ['build', 'dev'] : ['build', 'dev', 'package'];

function key(text: string): string | undefined {
    const trimmed = text.trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
    if (quoted) { return quoted[1]!.replace(/\\(.)/g, '$1'); }
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

function stringValue(text: string): string | undefined {
    const match = /^\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
    return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

/** Split a dotted TOML key such as `targets."my web".http` into its parts. */
function dotted(text: string): string[] | undefined {
    const parts: string[] = [];
    let rest = text.trim();
    while (rest) {
        const match = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*(?:\.\s*|$)/.exec(rest);
        if (!match) { return undefined; }
        const part = key(match[1]!); if (part === undefined) { return undefined; }
        parts.push(part); rest = rest.slice(match[0].length);
    }
    return parts;
}

export function parseManifest(text: string): ProjectManifest {
    const targets = new Map<string, ProjectTarget>();
    const packages = new Map<string, string>();
    let name: string | undefined;
    let table: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, '');
        const header = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
        if (header) {
            table = dotted(header[1]!) ?? [];
            if (table[0] === 'targets' && table.length === 2 && !targets.has(table[1]!)) {
                targets.set(table[1]!, { name: table[1]!, kind: '' });
            }
            continue;
        }
        const assignment = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=(.*)$/.exec(line);
        if (!assignment) { continue; }
        const field = key(assignment[1]!); const value = stringValue(assignment[2]!);
        if (field === undefined || value === undefined) { continue; }
        if (table.length === 1 && table[0] === 'project' && field === 'name') { name = value; }
        if (table.length === 2 && table[0] === 'packages' && field === 'root') { packages.set(table[1]!, value); }
        if (table.length === 2 && table[0] === 'targets') {
            const target = targets.get(table[1]!)!;
            if (field === 'kind') { target.kind = value; }
            if (field === 'package') { target.package = value; }
        }
    }
    return { name, targets: [...targets.values()], packages };
}

/** Command-line arguments of a project action. The manifest path is absolute so that the SDK reports
 * every diagnostic location in a form the problem matchers can resolve. */
export function projectArguments(action: ProjectAction, manifest: string, target: string,
    options: { port?: number; format?: string; updateLock?: boolean } = {}): string[] {
    const args = [action, '--project', manifest, '--target', target];
    if (action === 'build' && options.updateLock) { args.push('--update-lock'); }
    if (action === 'dev' && options.port !== undefined) { args.push('--port', String(options.port)); }
    if (action === 'package' && options.format) { args.push('--format', options.format); }
    return args;
}

/** Templates of `neura new` in the 0.3 SDK. */
export const projectTemplates = [
    { id: 'fullstack', label: 'Full-stack application', detail: 'A web page, a server and a desktop shell over shared contracts' },
    { id: 'web', label: 'Web application', detail: 'A page built into a static web bundle' },
    { id: 'server', label: 'Server application', detail: 'An HTTP server image run by neura-server-host' },
    { id: 'desktop', label: 'Desktop application', detail: 'A native desktop window over a web view' },
] as const;

/** `neura new` accepts lowercase letters, digits and hyphens as a project name. */
export const validProjectName = (name: string): boolean => /^[a-z0-9-]+$/.test(name);
