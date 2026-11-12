import * as vscode from 'vscode';
import { configuration, configuredTargets, resolvePath } from './configuration';

const generatedDirectories = '.git,.claude,.codex,.worktrees,worktrees,node_modules,build,build-*,cmake-build-*,dist,out,.neura,.neura-vscode';

export function excludedSourcePath(relativePath: string): boolean {
    return /(?:^|\/)(?:\.git|\.claude|\.codex|\.worktrees|worktrees|node_modules|build(?:-[^/]*)?|cmake-build-[^/]*|dist|out|\.neura|\.neura-vscode)(?:\/|$)/
        .test(relativePath.replace(/\\/g, '/'));
}

// Ripgrep versions embedded in VS Code derivatives reject nested brace groups.
// Flatten editor glob alternatives before joining the exclusion union.
function expandAlternatives(pattern: string): string[] {
    let begin = -1, depth = 0, bracket = false;
    const parts: string[] = [];
    let part = 0;
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '\\') { index++; continue; }
        if (character === '[') bracket = true;
        if (character === ']') bracket = false;
        if (bracket) continue;
        if (character === '{') {
            if (!depth) { begin = index; part = index + 1; }
            depth++;
        } else if (character === '}' && depth) {
            if (--depth === 0) {
                parts.push(pattern.slice(part, index));
                return parts.flatMap(value => expandAlternatives(pattern.slice(0, begin) + value + pattern.slice(index + 1)));
            }
        } else if (character === ',' && depth === 1) {
            parts.push(pattern.slice(part, index)); part = index + 1;
        }
    }
    return [pattern];
}

export function discoveryExclusions(folder: vscode.WorkspaceFolder): string {
    const patterns = new Set(generatedDirectories.split(',').map(directory => `**/${directory}/**`));
    // Passing an explicit exclude to findFiles replaces the editor's defaults.
    // Retain the user's exclusions as well as our generated-directory defaults.
    for (const section of ['files', 'search']) {
        const excluded = vscode.workspace.getConfiguration(section, folder.uri).get<Record<string, boolean | object>>('exclude', {});
        for (const [pattern, enabled] of Object.entries(excluded)) if (enabled === true) {
            for (const expanded of expandAlternatives(pattern)) patterns.add(expanded);
        }
    }
    return `{${[...patterns].join(',')}}`;
}

export function testSourceRoots(folder: vscode.WorkspaceFolder, file: string): string[] {
    const roots = configuration(folder).get<string[]>('sourceRoots', []).map(root => resolvePath(root, folder, file));
    // A test target's import roots must be identical during discovery, Run and Debug.
    for (const target of configuredTargets(folder, file)) {
        if (target.inputs.includes(file)) roots.push(...target.sourceRoots);
    }
    return [...new Set(roots)];
}

/** Cheap candidate filter only; compiler discovery remains authoritative. */
export function mayDeclareTests(source: string): boolean {
    const code = source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]?|[^"\\])*(?:"|$)/g, ' ');
    return /\btest_[A-Za-z_0-9]*\s*=\s*func\b/.test(code);
}
