import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Runtime } from './runtime';
import { runProcess } from './process';
import { toolEnvironment } from './runtime/configuration';
import { testSourceRoots } from './runtime/sources';

export interface DocumentationRange { line: number; column: number; offset: number; length: number; }
export interface DocumentationTag { command: string; subject?: string; direction?: string; text: string; }
export interface DocumentationSymbol {
    name: string; kind: string; signature: string; scope: string[];
    declaration: DocumentationRange; selection: DocumentationRange;
    documentation: { text: string; range: DocumentationRange; tags: DocumentationTag[] };
    tags?: { name: string; arguments?: { name?: string; value?: string; kind?: string }[] }[];
}
export interface DocumentationIndex { version: 1; files: { path: string; symbols: DocumentationSymbol[] }[]; }
export interface DocumentationShape { name: string; parameters: string[]; typeParameters: string[]; returnType?: string; }
interface ProtocolPosition { line: number; character: number; }
interface ProtocolRange { start: ProtocolPosition; end: ProtocolPosition; }
interface DeclarationDocumentation {
    name: string; signature: string; kind?: string; range: ProtocolRange; selectionRange?: ProtocolRange;
    documentation?: { text: string; range?: ProtocolRange }; parameters?: string[]; typeParameters?: string[]; returnType?: string;
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Only web URLs are navigable; source text never gains command or local-file authority. */
export function safeDocumentationUrl(value: string): string | undefined {
    if (/[\u0000-\u0020\u007F]/.test(value)) { return undefined; }
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
    } catch { return undefined; }
}

export function renderDocumentationInline(text: string): string {
    const tokens = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<>]+)|\*\*([^*\n]+)\*\*/g;
    let html = '', previous = 0;
    for (const match of text.matchAll(tokens)) {
        html += escapeHtml(text.slice(previous, match.index));
        if (match[1] !== undefined) { html += `<code>${escapeHtml(match[1])}</code>`; }
        else if (match[2] !== undefined) {
            const href = safeDocumentationUrl(match[3]);
            html += href ? `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(match[2])}</a>` : `${escapeHtml(match[2])} (${escapeHtml(match[3])})`;
        } else if (match[4] !== undefined) {
            const suffix = /[.,;:!?]+$/.exec(match[4])?.[0] ?? '';
            const value = match[4].slice(0, match[4].length - suffix.length);
            const href = safeDocumentationUrl(value);
            html += href ? `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(value)}</a>${escapeHtml(suffix)}` : escapeHtml(match[4]);
        } else { html += `<strong>${escapeHtml(match[5])}</strong>`; }
        previous = (match.index ?? 0) + match[0].length;
    }
    return html + escapeHtml(text.slice(previous));
}

function renderProse(text: string): string {
    const sections: string[] = [];
    let paragraph: string[] = [], list: string[] = [], literal: string[] | undefined;
    const flush = (): void => {
        if (paragraph.length) { sections.push(`<p>${renderDocumentationInline(paragraph.join(' '))}</p>`); paragraph = []; }
        if (list.length) { sections.push(`<ul>${list.map(item => `<li>${renderDocumentationInline(item)}</li>`).join('')}</ul>`); list = []; }
    };
    for (const line of text.split(/\r\n|\n|\r/)) {
        if (/^\s*```/.test(line)) {
            if (literal) { sections.push(`<pre><code>${escapeHtml(literal.join('\n'))}</code></pre>`); literal = undefined; }
            else { flush(); literal = []; }
        } else if (literal) { literal.push(line); }
        else if (!line.trim()) { flush(); }
        else if (/^\s*[-*]\s+/.test(line)) {
            if (paragraph.length) { flush(); }
            list.push(line.replace(/^\s*[-*]\s+/, ''));
        } else { if (list.length) { flush(); } paragraph.push(line.trim()); }
    }
    flush();
    if (literal) { sections.push(`<pre><code>${escapeHtml(literal.join('\n'))}</code></pre>`); }
    return sections.join('\n');
}

export function renderDoxygen(text: string, symbols: ReadonlyMap<string, string> = new Map()): string {
    const lines = text.split(/\r\n|\n|\r/), output: string[] = [], parameters: string[] = [], typeParameters: string[] = [];
    let prose: string[] = [];
    const flush = (): void => { if (prose.length) { output.push(renderProse(prose.join('\n'))); prose = []; } };
    const command = /^\s*[@\\]([A-Za-z]+)(?:\[([^\]]*)\])?\s*(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) {
            flush(); const literal = [lines[i]];
            while (i + 1 < lines.length) { const next = lines[++i]; literal.push(next); if (/^\s*```/.test(next)) { break; } }
            output.push(renderProse(literal.join('\n'))); continue;
        }
        const match = command.exec(lines[i]);
        if (!match) { prose.push(lines[i]); continue; }
        flush();
        const [, name, direction, initial] = match;
        if (name === 'code' || name === 'verbatim') {
            const code: string[] = [];
            if (initial.trim() && !/^\{[^}]*\}$/.test(initial.trim())) { code.push(initial); }
            while (i + 1 < lines.length && !new RegExp(`^\\s*[@\\\\]end${name}\\b`).test(lines[i + 1])) { code.push(lines[++i]); }
            if (i + 1 < lines.length) { i++; }
            output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
        }
        const content = [initial];
        let fence = false;
        while (i + 1 < lines.length) {
            const next = lines[i + 1];
            if (!fence && command.test(next)) { break; }
            if (/^\s*```/.test(next)) { fence = !fence; }
            content.push(lines[++i]);
        }
        const body = content.join('\n').trim();
        if (name === 'param' || name === 'tparam') {
            const subject = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
            const row = `<tr><th><code>${escapeHtml(subject?.[1] ?? '')}</code>${direction ? `<small>${escapeHtml(direction)}</small>` : ''}</th><td>${renderProse(subject?.[2] ?? '')}</td></tr>`;
            (name === 'param' ? parameters : typeParameters).push(row);
        } else if (name === 'brief' || name === 'details') { output.push(`<div class="${name}">${renderProse(body)}</div>`); }
        else if (name === 'ref' || name === 'see' || name === 'sa') {
            const reference = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body), target = reference && symbols.get(reference[1]);
            output.push(`<section class="reference"><h4>See also</h4>${target ? `<a href="#${escapeHtml(target)}">${escapeHtml(reference![1])}</a>${renderProse(reference![2] ?? '')}` : renderProse(body)}</section>`);
        } else if (['return', 'returns', 'retval'].includes(name)) { output.push(`<section><h4>Returns${name === 'retval' ? ' a value' : ''}</h4>${renderProse(body)}</section>`); }
        else {
            const labels: Record<string, string> = { warning: 'Warning', note: 'Note', attention: 'Attention', deprecated: 'Deprecated', pre: 'Precondition', post: 'Postcondition', invariant: 'Invariant', since: 'Since', example: 'Example', author: 'Author', version: 'Version', todo: 'To do' };
            const role = ['warning', 'attention', 'deprecated'].includes(name) ? 'notice warning' : 'notice';
            output.push(`<section class="${role}"><h4>${escapeHtml(labels[name] ?? `@${name}`)}</h4>${renderProse(body)}</section>`);
        }
    }
    flush();
    if (typeParameters.length) { output.push(`<section><h4>Type parameters</h4><table>${typeParameters.join('')}</table></section>`); }
    if (parameters.length) { output.push(`<section><h4>Parameters</h4><table>${parameters.join('')}</table></section>`); }
    return output.join('\n');
}

export function parseDocumentationIndex(value: string): DocumentationIndex {
    const index: unknown = JSON.parse(value);
    if (!index || typeof index !== 'object' || (index as { version?: unknown }).version !== 1 || !Array.isArray((index as DocumentationIndex).files)) { throw new Error('The toolchain returned an unsupported documentation index.'); }
    for (const file of (index as DocumentationIndex).files) {
        if (typeof file.path !== 'string' || !Array.isArray(file.symbols)) { throw new Error('The toolchain returned an invalid documentation file.'); }
        for (const symbol of file.symbols) {
            if (typeof symbol.name !== 'string' || typeof symbol.signature !== 'string' || typeof symbol.kind !== 'string' || !Array.isArray(symbol.scope) || symbol.scope.some(part => typeof part !== 'string') || typeof symbol.documentation?.text !== 'string' || !symbol.declaration || !symbol.selection) { throw new Error('The toolchain returned an invalid documented declaration.'); }
        }
    }
    return index as DocumentationIndex;
}

export function renderDocumentationHtml(index: DocumentationIndex, title: string, nonce: string): string {
    const ids = new Map<string, string>(); let sequence = 0;
    for (const file of index.files) { for (const symbol of file.symbols) { const id = `symbol-${++sequence}`; ids.set([...symbol.scope, symbol.name].join('.'), id); if (!ids.has(symbol.name)) { ids.set(symbol.name, id); } } }
    sequence = 0;
    const nav: string[] = [], sections: string[] = [];
    for (const file of index.files) {
        const declarations: string[] = [];
        for (const symbol of file.symbols) {
            const id = `symbol-${++sequence}`, qualified = [...symbol.scope, symbol.name].join('.');
            nav.push(`<li><a href="#${id}">${escapeHtml(qualified)}</a></li>`);
            const tags = (symbol.tags ?? []).map(tag => `<code class="tag">#${escapeHtml(tag.name)}</code>`).join(' ');
            declarations.push(`<article id="${id}"><div class="kind">${escapeHtml(symbol.kind)} · line ${Number(symbol.selection.line) || 1}</div><h2>${escapeHtml(qualified)}</h2><pre class="signature"><code>${escapeHtml(symbol.signature)}</code></pre>${tags ? `<p>${tags}</p>` : ''}${renderDoxygen(symbol.documentation.text, ids)}</article>`);
        }
        sections.push(`<section class="file"><h2>${escapeHtml(path.basename(file.path))}</h2>${declarations.length ? declarations.join('\n') : '<p>No documented declarations. Use Generate or Update Documentation to add a <code>///</code> block.</p>'}</section>`);
    }
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'; img-src 'none'; base-uri 'none'; form-action 'none';"><title>${escapeHtml(title)}</title><style nonce="${escapeHtml(nonce)}">
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.65;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:1.5rem 2rem;max-width:1100px;margin:auto}a{color:var(--vscode-textLink-foreground)}a:focus{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}h1,h2,h3,h4{line-height:1.3}h4{margin:.8rem 0 .2rem}nav{border:1px solid var(--vscode-widget-border);padding:.7rem 1rem;border-radius:6px}nav ul{columns:2;list-style:none;padding:0}article{padding:1.5rem 0;border-bottom:1px solid var(--vscode-widget-border);scroll-margin-top:1rem}.kind,.intro,small{color:var(--vscode-descriptionForeground)}.signature,pre{padding:1rem;overflow:auto;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border);border-radius:5px}code{font-family:var(--vscode-editor-font-family);font-size:.95em}.tag{padding:.15rem .4rem;border:1px solid var(--vscode-widget-border);border-radius:4px}.brief{font-size:1.1em}.notice{border-left:3px solid var(--vscode-editorInfo-foreground);padding:.1rem 1rem;margin:1rem 0}.warning{border-color:var(--vscode-editorWarning-foreground)}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid var(--vscode-widget-border)}th{width:25%}small{display:block}td p{margin:0}@media(max-width:600px){body{padding:1rem}nav ul{columns:1}}
</style></head><body><h1>${escapeHtml(title)}</h1><p class="intro">Offline documentation from the active Neura compiler. Only declarations with attached <code>///</code> documentation are included.</p>${nav.length ? `<nav aria-label="Documented declarations"><h2>Declarations</h2><ul>${nav.join('')}</ul></nav>` : ''}${sections.join('\n')}</body></html>`;
}

function splitTopLevel(text: string): string[] {
    const result: string[] = []; let depth = 0, previous = 0;
    for (let i = 0; i < text.length; i++) {
        if ('<([{'.includes(text[i])) { depth++; }
        else if ('>)]}'.includes(text[i]) && depth > 0 && text[i - 1] !== '-') { depth--; }
        else if (text[i] === ',' && depth === 0) { result.push(text.slice(previous, i).trim()); previous = i + 1; }
    }
    result.push(text.slice(previous).trim()); return result.filter(Boolean);
}
function balancedPart(text: string, start: number, open: string, close: string): { text: string; end: number } | undefined {
    if (text[start] !== open) { return undefined; } let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open) { depth++; } else if (text[i] === close && text[i - 1] !== '-' && --depth === 0) { return { text: text.slice(start + 1, i), end: i + 1 }; }
    }
    return undefined;
}
/** Extract names from a compiler-rendered signature, never from unparsed source. */
export function documentationShape(name: string, signature: string): DocumentationShape {
    const shape: DocumentationShape = { name, parameters: [], typeParameters: [] };
    const kind = /\b(func|class|interface|enum)\b/.exec(signature); if (!kind) { return shape; }
    let cursor = (kind.index ?? 0) + kind[0].length;
    while (/\s/.test(signature[cursor] ?? '') && cursor < signature.length) { cursor++; }
    const generic = balancedPart(signature, cursor, '<', '>');
    if (generic) { shape.typeParameters = splitTopLevel(generic.text).map(part => /^([A-Za-z_][A-Za-z_0-9]*)/.exec(part)?.[1]).filter((value): value is string => !!value); cursor = generic.end; }
    while (/\s/.test(signature[cursor] ?? '') && cursor < signature.length) { cursor++; }
    if (kind[1] === 'func') {
        const parameters = balancedPart(signature, cursor, '(', ')');
        if (parameters) { shape.parameters = splitTopLevel(parameters.text).map(part => /^([A-Za-z_][A-Za-z_0-9]*)\s*:/.exec(part)?.[1]).filter((value): value is string => !!value); cursor = parameters.end; }
        const result = /^\s*->\s*([\s\S]+)$/.exec(signature.slice(cursor)); if (result) { shape.returnType = result[1].trim(); }
    }
    return shape;
}

export function mergeDocumentation(existing: string, shape: DocumentationShape): { text: string; stale: string[] } {
    const lines = existing ? existing.replace(/\r\n|\r/g, '\n').split('\n') : [`@brief ${shape.name.replace(/_/g, ' ')}.`];
    const params = new Set<string>(), types = new Set<string>(); let returns = false, fence = false, literalEnd = '';
    for (const line of lines) {
        if (literalEnd) { if (new RegExp(`^\\s*[@\\\\]${literalEnd}\\b`).test(line)) { literalEnd = ''; } continue; }
        if (/^\s*```/.test(line)) { fence = !fence; continue; } if (fence) { continue; }
        const literal = /^\s*[@\\](code|verbatim)\b/.exec(line); if (literal) { literalEnd = `end${literal[1]}`; continue; }
        const tag = /^\s*[@\\](param|tparam)(?:\[[^\]]*\])?\s+(\S+)/.exec(line);
        if (tag) { (tag[1] === 'param' ? params : types).add(tag[2]); }
        if (/^\s*[@\\](?:return|returns|retval)\b/.test(line)) { returns = true; }
    }
    while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
    for (const name of shape.typeParameters) { if (!types.has(name)) { lines.push(`@tparam ${name} Description of ${name}.`); } }
    for (const name of shape.parameters) { if (!params.has(name)) { lines.push(`@param ${name} Description of ${name}.`); } }
    if (shape.returnType && shape.returnType !== 'void' && !returns) { lines.push('@return Description of the result.'); }
    return { text: lines.join('\n'), stale: [...params].filter(name => !shape.parameters.includes(name)).concat([...types].filter(name => !shape.typeParameters.includes(name))) };
}

async function documentationIndex(document: vscode.TextDocument, runtime: Runtime, token?: vscode.CancellationToken): Promise<DocumentationIndex> {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before running Neura documentation tools.'); }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri); if (!folder) { throw new Error('Open the source in a workspace folder.'); }
    const executable = await runtime.getExecutable(folder); if (!executable) { throw new Error('Select a Neura toolchain first.'); }
    let temporary: string | undefined;
    try {
        let input = document.uri.fsPath;
        if (document.isDirty || document.isUntitled) { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neura-docs-')); input = path.join(temporary, path.basename(input) || 'untitled.nra'); await fs.writeFile(input, document.getText(), 'utf8'); }
        const roots = new Set(testSourceRoots(folder, document.uri.fsPath));
        if (temporary) roots.add(path.dirname(document.uri.fsPath));
        const args = ['docs', ...[...roots].flatMap(root => ['-I', root]), input];
        const result = await runProcess(executable, args, { cwd: folder.uri.fsPath, env: toolEnvironment(folder), token, timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024 });
        if (result.cancelled) { throw new vscode.CancellationError(); }
        if (result.code !== 0) { throw new Error(result.stderr || 'Documentation export failed.'); }
        const index = parseDocumentationIndex(result.stdout); if (temporary) { for (const file of index.files) { file.path = document.uri.fsPath; } } return index;
    } finally { if (temporary) { await fs.rm(temporary, { recursive: true, force: true }); } }
}

function protocolRange(range: ProtocolRange): vscode.Range { return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character); }
function bytePosition(document: vscode.TextDocument, offset: number): vscode.Position { return document.positionAt(Buffer.from(document.getText(), 'utf8').subarray(0, offset).toString('utf8').length); }

export function registerDocumentation(context: vscode.ExtensionContext, runtime: Runtime, output: vscode.OutputChannel): void {
    const report = (error: unknown): void => { if (error instanceof vscode.CancellationError) { return; } output.appendLine(`Documentation: ${String(error)}`); void vscode.window.showErrorMessage(`Neura documentation: ${error instanceof Error ? error.message : String(error)}`); };
    context.subscriptions.push(vscode.commands.registerCommand('neura.previewDocs', async (value?: vscode.Uri | string) => {
        try {
            const document = value ? await vscode.workspace.openTextDocument(typeof value === 'string' ? vscode.Uri.parse(value) : value) : vscode.window.activeTextEditor?.document;
            if (!document || document.languageId !== 'neura') { return; }
            const index = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generate Neura documentation', cancellable: true }, (_progress, token) => documentationIndex(document, runtime, token));
            const panel = vscode.window.createWebviewPanel('neura.documentation', `Documentation: ${path.basename(document.uri.fsPath)}`, vscode.ViewColumn.Beside, { enableScripts: false, enableCommandUris: false, localResourceRoots: [] });
            panel.webview.html = renderDocumentationHtml(index, path.basename(document.uri.fsPath), randomBytes(16).toString('hex'));
        } catch (error) { report(error); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('neura.generateDocumentation', async (value?: vscode.Uri | string, position?: ProtocolPosition) => {
        try {
            if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before querying the Neura compiler.'); }
            const editor = vscode.window.activeTextEditor;
            const document = value ? await vscode.workspace.openTextDocument(typeof value === 'string' ? vscode.Uri.parse(value) : value) : editor?.document;
            if (!document || document.languageId !== 'neura') { return; }
            const sourceVersion = document.version;
            const at = position ? new vscode.Position(position.line, position.character) : editor?.document === document ? editor.selection.active : new vscode.Position(0, 0);
            const folder = vscode.workspace.getWorkspaceFolder(document.uri), client = folder && runtime.language.client(folder);
            let info: DeclarationDocumentation | undefined;
            if (client) { try { info = await client.sendRequest<DeclarationDocumentation | undefined>('neura/declarationDocumentation', { textDocument: { uri: document.uri.toString() }, position: { line: at.line, character: at.character } }); } catch { /* Compatible older servers can still update indexed documented declarations below. */ } }
            if (document.version !== sourceVersion) { throw new Error('The source changed while documentation was generated. Try again.'); }
            if (!info) {
                const index = await documentationIndex(document, runtime);
                if (document.version !== sourceVersion) { throw new Error('The source changed while documentation was generated. Try again.'); }
                const candidates = index.files.flatMap(file => file.symbols).filter(symbol => { const start = bytePosition(document, symbol.documentation.range.offset).line; const end = bytePosition(document, symbol.declaration.offset + symbol.declaration.length).line; return start <= at.line && at.line <= end; });
                const symbol = candidates.sort((a, b) => a.declaration.length - b.declaration.length)[0];
                if (symbol) { const start = bytePosition(document, symbol.declaration.offset), end = bytePosition(document, symbol.declaration.offset + symbol.declaration.length); const docStart = bytePosition(document, symbol.documentation.range.offset), docEnd = bytePosition(document, symbol.documentation.range.offset + symbol.documentation.range.length); info = { name: symbol.name, signature: symbol.signature, range: { start, end }, documentation: { text: symbol.documentation.text, range: { start: docStart, end: docEnd } } }; }
            }
            if (!info) { throw new Error('Place the cursor in a declaration. Generating documentation for an undocumented declaration requires the Neura tooling language server.'); }
            const shape = documentationShape(info.name, info.signature);
            if (info.parameters) { shape.parameters = info.parameters; } if (info.typeParameters) { shape.typeParameters = info.typeParameters; } if (info.returnType) { shape.returnType = info.returnType; }
            const merged = mergeDocumentation(info.documentation?.text ?? '', shape), eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            let line = info.range.start.line;
            // Standalone tags remain attached to their declaration below the new /// block.
            while (line > 0 && /^\s*#/.test(document.lineAt(line - 1).text)) { line--; }
            let range = new vscode.Range(line, 0, line, 0);
            let indent = /^\s*/.exec(document.lineAt(line).text)?.[0] ?? '';
            if (info.documentation?.range) { const existing = protocolRange(info.documentation.range); range = new vscode.Range(existing.start.line, 0, existing.end.line, document.lineAt(existing.end.line).text.length); indent = /^\s*/.exec(document.lineAt(existing.start.line).text)?.[0] ?? indent; }
            const replacement = merged.text.split('\n').map(text => `${indent}///${text ? ` ${text}` : ''}`).join(eol) + (range.isEmpty ? eol : '');
            const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, range, replacement);
            if (sourceVersion !== document.version) { throw new Error('The source changed while documentation was generated. Try again.'); }
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('The documentation edit could not be applied.'); }
            if (merged.stale.length) { void vscode.window.showWarningMessage(`Documentation was updated. Review documentation for removed or renamed parameters: ${merged.stale.join(', ')}. Existing descriptions were preserved.`); }
        } catch (error) { report(error); }
    }));
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'neura', scheme: 'file' }, {
        provideCodeActions(document, range, actionContext) {
            if (!vscode.workspace.isTrusted || actionContext.triggerKind === vscode.CodeActionTriggerKind.Automatic) { return undefined; }
            const action = new vscode.CodeAction('Generate or update Neura documentation', vscode.CodeActionKind.RefactorRewrite);
            action.command = { command: 'neura.generateDocumentation', title: action.title, arguments: [document.uri, range.start] }; return [action];
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }));
}
