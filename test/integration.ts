import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('Kayyo321.neura-vscode'); assert.ok(extension); await extension.activate();
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of ['neura.run', 'neura.build', 'neura.debug', 'neura.refreshTests', 'neura.inspectArtifact', 'neura.install', 'neura.explainDiagnostic']) assert.ok(commands.has(command), command);
  const source = await vscode.workspace.openTextDocument({ language: 'neura', content: 'let identity = func(value: int32) -> int32 { return value; };\n' });
  assert.equal(source.languageId, 'neura');
  const config = vscode.workspace.getConfiguration('neura'); assert.equal(config.get('testing.watch'), false);
  await vscode.window.showTextDocument(source);
  const themes = extension.packageJSON.contributes.themes; assert.equal(themes.length, 4);
  if (process.env.NEURA_TEST_EXECUTABLE) {
    const executable = process.env.NEURA_TEST_EXECUTABLE;
    await config.update('toolchain.path', executable, vscode.ConfigurationTarget.Global);
    const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
    const directory = await fs.mkdtemp(path.join(workspace.uri.fsPath, 'neura-host-test-'));
    const file = vscode.Uri.file(path.join(directory, 'editor.nra'));
    await fs.writeFile(file.fsPath, 'let Identity=module (\n    export let answer = func(value: int32) -> int32 {\n        return value;\n    };\n);\n');
    try {
      const doc = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('neura.restartLanguageServer');
      let symbols: vscode.DocumentSymbol[] = [];
      for (let attempt = 0; attempt < 120; attempt++) {
        symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', file) ?? [];
        if (symbols.some(symbol => symbol.name === 'Identity')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(symbols.some(symbol => symbol.name === 'Identity'), 'real language-server symbols');
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', file, new vscode.Position(2, 16));
      assert.ok(hover?.length, 'real compiler hover');
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', file, { tabSize: 4, insertSpaces: true });
      assert.ok(Array.isArray(edits), 'real formatter request');
      await vscode.commands.executeCommand('neura.refreshTests');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  console.log('Neura Extension Development Host integration passed.');
}
