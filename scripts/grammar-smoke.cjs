#!/usr/bin/env node
// Tokenize every .nra file under the given directories with the Neura grammar and report
// lines where tokenization is left in a bogus state:
//   - a top-level declaration line (column 0: let, const, last, export, #) that starts inside an open rule;
//   - a line that starts inside a string or comment opened on an earlier line;
//   - an open rule (unbalanced begin/end) at the end of the file;
//   - an invalid.illegal scope.
// Usage: node scripts/grammar-smoke.cjs [--quiet] <directory>...
const fs = require('node:fs');
const path = require('node:path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'build', 'node_modules', 'dist', 'out', '.neura-vscode']);

function* sources(directory) {
  if (fs.statSync(directory).isFile()) { yield directory; return; }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (entry.isFile() && entry.name.endsWith('.nra')) yield file;
  }
}

async function loadGrammar() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: x => new oniguruma.OnigScanner(x), createOnigString: x => new oniguruma.OnigString(x) }),
    loadGrammar: async scope => {
      if (scope !== 'source.neura') return null;
      const file = path.join(root, 'syntaxes', 'neura.tmLanguage.json');
      return textmate.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
    },
  });
  return registry.loadGrammar('source.neura');
}

function check(grammar, text) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  let state = textmate.INITIAL;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const depth = state === textmate.INITIAL ? 1 : state.depth;
    if (depth > 1 && /^(?:let|const|last|export)\b|^#/.test(line)) {
      problems.push({ line: index + 1, kind: 'declaration-inside-rule', detail: `rule depth ${depth}` });
    }
    const result = grammar.tokenizeLine(line, state, 1000);
    if (result.stoppedEarly) problems.push({ line: index + 1, kind: 'stopped-early', detail: 'tokenization timed out' });
    const first = result.tokens[0];
    const opensLiteral = /^\s*(?:\/\/|\$?")/.test(line);
    if (index > 0 && first && line.trim() && !opensLiteral) {
      const leaked = first.scopes.find(scope => /^(?:string\.|comment\.)/.test(scope) && !/^(?:comment\.block\.(?:html|css|neura)|string\.quoted\.(?:double|single)\.html)/.test(scope));
      if (leaked) problems.push({ line: index + 1, kind: 'leaked-literal', detail: leaked });
    }
    for (const token of result.tokens) {
      const bad = token.scopes.find(scope => scope.startsWith('invalid.illegal'));
      if (bad) problems.push({ line: index + 1, kind: 'invalid', detail: `${bad}: ${JSON.stringify(line.slice(token.startIndex, token.endIndex))}` });
    }
    state = result.ruleStack;
  }
  const depth = state === textmate.INITIAL ? 1 : state.depth;
  if (depth > 1) problems.push({ line: lines.length, kind: 'open-at-eof', detail: `rule depth ${depth}` });
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const directories = args.filter(arg => arg !== '--quiet');
  if (!directories.length) { console.error('usage: grammar-smoke.cjs [--quiet] <directory>...'); process.exit(2); }
  const grammar = await loadGrammar();
  let files = 0, lines = 0;
  const byKind = new Map();
  const flagged = [];
  for (const directory of directories) {
    for (const file of sources(path.resolve(directory))) {
      const text = fs.readFileSync(file, 'utf8');
      files++; lines += text.split('\n').length;
      const problems = check(grammar, text);
      if (!problems.length) continue;
      flagged.push(file);
      for (const problem of problems) {
        byKind.set(problem.kind, (byKind.get(problem.kind) ?? 0) + 1);
        if (!quiet) console.log(`${file}:${problem.line}: ${problem.kind}: ${problem.detail}`);
      }
    }
  }
  console.log(`grammar smoke: ${files} files, ${lines} lines, ${flagged.length} files flagged` +
    (byKind.size ? ` (${[...byKind].map(([kind, count]) => `${kind} ${count}`).join(', ')})` : ''));
  if (process.env.SMOKE_FLAGGED) fs.writeFileSync(process.env.SMOKE_FLAGGED, flagged.join('\n') + '\n');
  process.exitCode = flagged.length ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 2; });
