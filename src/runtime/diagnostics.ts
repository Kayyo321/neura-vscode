import * as vscode from 'vscode';
import * as path from 'node:path';
import { runProcess } from './process';
import { ResolvedTarget } from './configuration';

interface Span { file: string; offset?: number; length?: number; line?: number; column?: number; primary?: boolean; label?: string; }
interface SuggestedEdit extends Span { replacement: string; }
interface Suggestion { message: string; applicability: string; edits: SuggestedEdit[]; }
interface CompilerDiagnostic { code?: string; severity: string; message: string; spans?: Span[]; notes?: string[];
    help?: string[]; suggestions?: Suggestion[]; }
interface FixRecord { diagnostic: vscode.Diagnostic; uri: vscode.Uri; suggestions: Suggestion[]; cwd: string; versions: Map<string, number>; }

export function utf8OffsetToUtf16(text: string, offset: number): number {
    return Buffer.from(text, 'utf8').subarray(0, Math.max(0, offset)).toString('utf8').length;
}

export function scalarColumnToUtf16(line: string, column: number): number {
    return [...line].slice(0, Math.max(0, column - 1)).join('').length;
}

export class CliDiagnostics implements vscode.Disposable, vscode.CodeActionProvider {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('neura-cli');
    private readonly fixes = new Map<string, FixRecord[]>();
    private readonly owned = new Map<string, Set<string>>();
    private readonly pending = new Map<string, vscode.CancellationTokenSource>();
    private readonly registration: vscode.Disposable;
    constructor(private readonly output: vscode.OutputChannel) {
        this.registration = vscode.languages.registerCodeActionsProvider('neura', this,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.SourceFixAll.append('neura')] });
    }
    dispose(): void {
        this.registration.dispose(); this.diagnostics.dispose();
        for (const token of this.pending.values()) { token.cancel(); token.dispose(); }
        this.pending.clear(); this.fixes.clear(); this.owned.clear();
    }
    clear(folder: vscode.WorkspaceFolder): void {
        const key = folder.uri.toString();
        for (const uri of this.owned.get(key) ?? []) { this.diagnostics.delete(vscode.Uri.parse(uri)); this.fixes.delete(uri); }
        this.owned.delete(key);
    }
    async check(executable: string, target: ResolvedTarget): Promise<void> {
        const key = target.folder.uri.toString();
        this.pending.get(key)?.cancel(); this.pending.get(key)?.dispose();
        const source = new vscode.CancellationTokenSource(); this.pending.set(key, source);
        const versions = new Map(vscode.workspace.textDocuments.map(document => [document.uri.toString(), document.version]));
        try {
            const result = await runProcess(executable, ['check', '--error-format=json', '--color=never',
                ...target.sourceRoots.flatMap(root => ['-I', root]), ...target.inputs],
            { cwd: target.cwd, env: target.env, token: source.token, timeout: 60000 });
            if (source.token.isCancellationRequested || vscode.workspace.textDocuments.some(document =>
                versions.has(document.uri.toString()) && versions.get(document.uri.toString()) !== document.version)) { return; }
            const grouped = new Map<string, vscode.Diagnostic[]>();
            const records = new Map<string, FixRecord[]>();
            for (const line of result.stderr.split(/\r?\n/)) {
                if (!line.trim()) { continue; }
                let diagnostic: CompilerDiagnostic;
                try { diagnostic = JSON.parse(line) as CompilerDiagnostic; }
                catch { this.output.appendLine(line); continue; }
                if (!diagnostic.message || !Array.isArray(diagnostic.spans)) { continue; }
                const primary = diagnostic.spans.find(span => span.primary) ?? diagnostic.spans[0];
                if (!primary) { continue; }
                const uri = vscode.Uri.file(path.resolve(target.cwd, primary.file));
                const document = await vscode.workspace.openTextDocument(uri);
                if (versions.has(uri.toString())) {
                    if (versions.get(uri.toString()) !== document.version) { return; }
                } else {
                    if (document.isDirty) { return; }
                    versions.set(uri.toString(), document.version);
                }
                const range = spanRange(document, primary);
                const notes = [...(diagnostic.notes ?? []), ...(diagnostic.help ?? [])].join('\n');
                const item = new vscode.Diagnostic(range, `${diagnostic.message}${notes ? '\n' + notes : ''}`,
                    diagnostic.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
                item.source = 'Neura'; item.code = diagnostic.code;
                item.relatedInformation = await Promise.all(diagnostic.spans.filter(span => span !== primary).map(async span => {
                    const relatedUri = vscode.Uri.file(path.resolve(target.cwd, span.file));
                    const related = await vscode.workspace.openTextDocument(relatedUri);
                    return new vscode.DiagnosticRelatedInformation(new vscode.Location(relatedUri, spanRange(related, span)), span.label ?? diagnostic.message);
                }));
                if (diagnostic.code === 'W0001') { item.tags = [vscode.DiagnosticTag.Deprecated]; }
                const name = uri.toString();
                grouped.set(name, [...(grouped.get(name) ?? []), item]);
                records.set(name, [...(records.get(name) ?? []), { diagnostic: item, uri,
                    suggestions: diagnostic.suggestions ?? [], cwd: target.cwd, versions }]);
            }
            if (source.token.isCancellationRequested || vscode.workspace.textDocuments.some(document =>
                versions.has(document.uri.toString()) && versions.get(document.uri.toString()) !== document.version)) { return; }
            this.clear(target.folder);
            for (const [uri, items] of grouped) { this.diagnostics.set(vscode.Uri.parse(uri), items); }
            for (const [uri, items] of records) { this.fixes.set(uri, items); }
            this.owned.set(key, new Set(grouped.keys()));
        } catch (error) {
            if (!(error instanceof vscode.CancellationError)) { this.output.appendLine(`Check: ${String(error)}`); }
        } finally {
            if (this.pending.get(key) === source) { this.pending.delete(key); }
            source.dispose();
        }
    }
    async provideCodeActions(document: vscode.TextDocument, _range: vscode.Range,
        context: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
        const actions: vscode.CodeAction[] = [];
        const allEdits: Array<{ uri: vscode.Uri; range: vscode.Range; replacement: string }> = [];
        for (const record of this.fixes.get(document.uri.toString()) ?? []) {
            const selected = context.diagnostics.includes(record.diagnostic);
            for (const suggestion of record.suggestions) {
                const edit = new vscode.WorkspaceEdit(); let current = true;
                const replacements: Array<{ uri: vscode.Uri; range: vscode.Range; replacement: string }> = [];
                for (const replacement of suggestion.edits) {
                    const uri = vscode.Uri.file(path.resolve(record.cwd, replacement.file));
                    if (!vscode.workspace.getWorkspaceFolder(uri)) { current = false; break; }
                    const affected = await vscode.workspace.openTextDocument(uri);
                    if ((record.versions.get(uri.toString()) ?? affected.version) !== affected.version) { current = false; break; }
                    const range = spanRange(affected, replacement);
                    edit.replace(uri, range, replacement.replacement);
                    replacements.push({ uri, range, replacement: replacement.replacement });
                }
                if (!current) { continue; }
                if (suggestion.applicability === 'MachineApplicable') { allEdits.push(...replacements); }
                if (!selected) { continue; }
                const action = new vscode.CodeAction(suggestion.message, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [record.diagnostic]; action.edit = edit;
                action.isPreferred = suggestion.applicability === 'MachineApplicable';
                actions.push(action);
            }
            const code = typeof record.diagnostic.code === 'string' ? record.diagnostic.code : undefined;
            if (code && selected) {
                const action = new vscode.CodeAction(`Explain ${code}`, vscode.CodeActionKind.QuickFix);
                action.command = { title: `Explain ${code}`, command: 'neura.explainDiagnostic', arguments: [code] };
                actions.push(action);
            }
        }
        const unique = [...new Map(allEdits.map(edit => [
            `${edit.uri.toString()}:${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}:${edit.replacement}`, edit,
        ])).values()];
        const overlapping = unique.some((left, index) => unique.slice(index + 1).some(right =>
            left.uri.toString() === right.uri.toString() && left.range.intersection(right.range) !== undefined));
        if (unique.length > 0 && !overlapping) {
            const action = new vscode.CodeAction('Fix all machine-applicable Neura suggestions', vscode.CodeActionKind.SourceFixAll.append('neura'));
            action.edit = new vscode.WorkspaceEdit();
            for (const edit of unique) { action.edit.replace(edit.uri, edit.range, edit.replacement); }
            actions.push(action);
        }
        return actions;
    }
}

function spanRange(document: vscode.TextDocument, span: Span): vscode.Range {
    if (span.offset !== undefined) {
        const text = document.getText();
        const start = utf8OffsetToUtf16(text, span.offset);
        return new vscode.Range(document.positionAt(start), document.positionAt(utf8OffsetToUtf16(text, span.offset + (span.length ?? 0))));
    }
    const line = Math.max(0, Math.min(document.lineCount - 1, (span.line ?? 1) - 1));
    const column = scalarColumnToUtf16(document.lineAt(line).text, span.column ?? 1);
    return new vscode.Range(line, column, line, column + 1);
}
