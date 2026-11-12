import * as vscode from 'vscode';

interface Token { text: string; start: number; end: number; }
interface Frame { open: Token; header: Token[]; declaration: boolean; }

// This is a delimiter-aware typing aid, not a parser: ambiguous expressions and
// type positions deliberately receive no edit. The compiler owns their meaning.
function tokens(source: string): Token[] {
    const result: Token[] = [];
    const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]?|[^"\\])*(?:"|$)|[A-Za-z_][A-Za-z_0-9]*|=>|[^\s]/g;
    for (const match of source.matchAll(pattern)) {
        if (match[0].startsWith('//') || match[0].startsWith('/*')) continue;
        result.push({ text: match[0], start: match.index!, end: match.index! + match[0].length });
    }
    return result;
}

function declarationBody(header: Token[], delimiter: string): boolean {
    let start = header.length - 1;
    while (start >= 0 && !['let', 'const', 'last'].includes(header[start].text)) start--;
    if (start < 0) return false;
    let index = start + 1;
    if (header[index]?.text === '.') index += 2; // let.override and similar declarations
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(header[index++]?.text ?? '') || header[index++]?.text !== '=') return false;
    const kind = header[index++]?.text;
    if (delimiter === '(') return ['class', 'interface', 'module', 'enum', 'singleton', 'monitor'].includes(kind ?? '') &&
        !header.slice(index).some(token => ['=', '=>', '(', ')', '{', '}'].includes(token.text));
    return delimiter === '{' && kind === 'func' && !header.slice(index).some(token => ['=>', '{', '}'].includes(token.text));
}

/** Offsets immediately after newly typed declaration closers that need a ';'. */
export function declarationSemicolons(source: string, changedStart: number, changedEnd: number): number[] {
    const all = tokens(source), stack: Frame[] = [];
    let current: Token[] = [];
    const result: number[] = [];
    for (let index = 0; index < all.length; index++) {
        const token = all[index];
        if (['(', '[', '{'].includes(token.text)) {
            stack.push({ open: token, header: current, declaration: declarationBody(current, token.text) });
            current = [];
        } else if ([')', ']', '}'].includes(token.text)) {
            const frame = stack.pop();
            if (!frame || '([{'.indexOf(frame.open.text) !== ')]}'.indexOf(token.text)) return [];
            current = frame.header;
            current.push(frame.open, token);
            const changed = (token.start >= changedStart && token.end <= changedEnd) ||
                (frame.open.start >= changedStart && frame.open.end <= changedEnd &&
                    !source.slice(frame.open.end, token.start).trim());
            const next = all[index + 1];
            // Existing terminators and expression continuations always win.
            const continuation = next && (next.text === ';' || next.text === 'or' || next.text === 'callback' || next.text === '=' ||
                next.text === '.' || next.text === '(' || next.text === '[' || next.text === ',' || next.text === '?');
            if (changed && frame.declaration && !continuation) result.push(token.end);
        } else if (token.text === ';') current = [];
        else current.push(token);
    }
    return result;
}

export function registerEditing(context: vscode.ExtensionContext): void {
    const pending = new Set<string>();
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        const editor = vscode.window.activeTextEditor;
        if (document.languageId !== 'neura' || !editor || editor.document !== document || event.reason !== undefined ||
            pending.has(document.uri.toString()) || event.contentChanges.length !== 1 ||
            !vscode.workspace.getConfiguration('neura', document.uri).get<boolean>('editing.autoSemicolon', true)) return;
        const change = event.contentChanges[0];
        // Restrict edits to delimiter-sized changes. Larger pasted declarations
        // and refactorings are left intact; undo/redo must remain exact.
        if (change.rangeLength !== 0 || !['(', '{', '()', '{}', ')', '}'].includes(change.text)) return;
        const offsets = declarationSemicolons(document.getText(), change.rangeOffset, change.rangeOffset + change.text.length);
        if (!offsets.length) return;
        const key = document.uri.toString(), version = document.version;
        pending.add(key);
        void Promise.resolve().then(async () => {
            if (document.version !== version || editor.document !== document) return;
            await editor.edit(builder => {
                for (const offset of offsets) builder.insert(document.positionAt(offset), ';');
            }, { undoStopBefore: false, undoStopAfter: false });
        }).catch(() => undefined).finally(() => pending.delete(key));
    }));
}
