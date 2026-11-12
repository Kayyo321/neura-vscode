import * as vscode from 'vscode';
import * as path from 'node:path';

export type TargetKind = 'application' | 'library' | 'native';

export interface TargetConfiguration {
    name: string;
    kind?: TargetKind;
    inputs: string[];
    sourceRoots?: string[];
    output?: string;
    cwd?: string;
    args?: string[];
    env?: Record<string, string>;
    buildArgs?: string[];
    runArgs?: string[];
}

export interface ResolvedTarget {
    name: string;
    kind: TargetKind;
    folder: vscode.WorkspaceFolder;
    inputs: string[];
    sourceRoots: string[];
    output: string;
    cwd: string;
    args: string[];
    env: Record<string, string>;
    buildArgs: string[];
    runArgs: string[];
}

export const configuration = (folder?: vscode.WorkspaceFolder): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration('neura', folder?.uri);

export function resolvePath(value: string, folder: vscode.WorkspaceFolder, activeFile?: string): string {
    if (value.includes('${file}') && !activeFile) { throw new Error('Open a saved source file to resolve ${file} in a Neura target.'); }
    const expanded = value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath)
        .replace(/\$\{file\}/g, activeFile ?? '')
        .replace(/\$\{env:([^}]+)\}/g, (_match, key: string) => process.env[key] ?? '');
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(folder.uri.fsPath, expanded);
}

function strings(value: unknown, field: string): string[] {
    if (value === undefined) { return []; }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`Neura target ${field} must be an array of strings.`);
    }
    return value as string[];
}

export function resolveTarget(raw: TargetConfiguration, folder: vscode.WorkspaceFolder,
    activeFile?: string): ResolvedTarget {
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) {
        throw new Error('Each Neura target needs a nonempty name.');
    }
    const inputs = strings(raw.inputs, 'inputs');
    if (inputs.length === 0) { throw new Error(`Neura target ${raw.name} has no inputs.`); }
    const kind = raw.kind ?? 'application';
    if (!['application', 'library', 'native'].includes(kind)) {
        throw new Error(`Unknown Neura target kind: ${kind}`);
    }
    const roots = [...configuration(folder).get<string[]>('sourceRoots', []), ...strings(raw.sourceRoots, 'sourceRoots')];
    const outputDirectory = configuration(folder).get<string>('build.outputDirectory', '.neura-vscode');
    const suffix = kind === 'library' ? '.nir' : kind === 'native' ? '' : '.nvr';
    const output = raw.output ?? path.join(outputDirectory, `${raw.name.replace(/[^\w.-]/g, '-')}${suffix}`);
    if (raw.env !== undefined && (typeof raw.env !== 'object' || raw.env === null ||
        Object.values(raw.env).some(value => typeof value !== 'string'))) {
        throw new Error(`Neura target ${raw.name} env must contain string values.`);
    }
    const resolvedInputs = inputs.map(input => resolvePath(input, folder, activeFile));
    const resolvedOutput = resolvePath(output, folder, activeFile);
    if (resolvedInputs.includes(resolvedOutput)) { throw new Error(`Neura target ${raw.name} output must not overwrite an input file.`); }
    return {
        name: raw.name, kind, folder,
        inputs: resolvedInputs,
        sourceRoots: [...new Set(roots.map(root => resolvePath(root, folder, activeFile)))],
        output: resolvedOutput,
        cwd: resolvePath(raw.cwd ?? '.', folder, activeFile),
        args: strings(raw.args, 'args'),
        env: { ...configuration(folder).get<Record<string, string>>('environment', {}), ...raw.env },
        buildArgs: strings(raw.buildArgs, 'buildArgs'),
        runArgs: strings(raw.runArgs, 'runArgs'),
    };
}

export function configuredTargets(folder: vscode.WorkspaceFolder,
    activeFile = vscode.window?.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri.fsPath : undefined): ResolvedTarget[] {
    const targets = configuration(folder).get<TargetConfiguration[]>('targets', []);
    if (!Array.isArray(targets)) { throw new Error('neura.targets must be an array.'); }
    const resolved = targets.map(target => resolveTarget(target, folder, activeFile));
    if (new Set(resolved.map(target => target.name)).size !== resolved.length) {
        throw new Error('Neura target names must be unique within a workspace folder.');
    }
    return resolved;
}

export function buildArguments(target: ResolvedTarget): string[] {
    const command = target.kind === 'library' ? 'emit-ir' : 'build';
    return [command, ...(target.kind === 'native' ? ['--native'] : []),
        ...target.sourceRoots.flatMap(root => ['-I', root]), ...target.buildArgs,
        ...target.inputs, '-o', target.output];
}

export function runArguments(target: ResolvedTarget): string[] {
    return ['run', ...target.runArgs, target.output, '--', ...target.args];
}

export function activeFolder(document?: vscode.TextDocument): vscode.WorkspaceFolder | undefined {
    const current = document ?? vscode.window.activeTextEditor?.document;
    return (current && vscode.workspace.getWorkspaceFolder(current.uri)) ?? vscode.workspace.workspaceFolders?.[0];
}
