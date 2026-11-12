const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
const root = path.resolve(__dirname, '..');
const grammars = new Map([
  ['source.neura', 'neura'], ['source.neurair', 'neurair'], ['source.nvra', 'nvra'],
]);
let registry;
before(async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: x => new oniguruma.OnigScanner(x), createOnigString: x => new oniguruma.OnigString(x) }),
    loadGrammar: async scope => {
      if (!grammars.has(scope)) return null;
      const file = path.join(root, 'syntaxes', grammars.get(scope) + '.tmLanguage.json');
      return textmate.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
    },
  });
});
async function tokenize(source, scope = 'source.neura') {
  const grammar = await registry.loadGrammar(scope);
  let state = textmate.INITIAL;
  return source.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, state); state = result.ruleStack;
    return result.tokens.map(t => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
}
const hasScope = (tokens, text, scope) => tokens.some(t => t.text === text && t.scopes.some(s => s.startsWith(scope)));
test('all Neura grammars load and tokenize real listings', async () => {
  assert.ok((await tokenize('let Main = module (\n);'))[0].length);
  assert.ok((await tokenize('%3 function identity at "source.nra":1:1', 'source.neurair'))[0].length);
  assert.ok((await tokenize('nvr 1.0 profile 1\nfunction 0 parameters 1 result 2 frame [ 1 3 ]', 'source.nvra'))[0].length);
});
test('contextual words stay ordinary names outside language forms', async () => {
  for (const word of ['last', 'scope', 'spawn', 'select', 'get', 'set', 'value']) {
    const [tokens] = await tokenize(`let ${word} = 1;`);
    assert.ok(hasScope(tokens, word, 'variable.other.readwrite.declaration.neura'), `${word} must be a binding`);
    assert.ok(!tokens.some(t => t.text === word && t.scopes.some(s => s.startsWith('keyword.'))), `${word} was reserved globally`);
  }
  const tokens = (await tokenize('last result = spawn compute();\nscope (group) {\nselect {\n  | get: balance;\n  | set: balance = value;\n}')).flat();
  assert.ok(hasScope(tokens, 'last', 'storage.type.binding.neura'));
  assert.ok(hasScope(tokens, 'spawn', 'keyword.control.spawn.neura'));
  assert.ok(hasScope(tokens, 'scope', 'keyword.control.scope.neura'));
  assert.ok(hasScope(tokens, 'select', 'keyword.control.select.neura'));
  assert.ok(hasScope(tokens, 'get', 'entity.name.function.accessor.neura'));
  assert.ok(hasScope(tokens, 'set', 'entity.name.function.accessor.neura'));
  assert.ok(hasScope(tokens, 'value', 'variable.other.readwrite.neura'));
});
test('generics, parameters, accessors, tags and Doxygen have distinct roles', async () => {
  const lines = await tokenize('/// @param[in] value A `value` to return.\n#NoDiscard\nlet identity = func<T>(value: T) -> T {\n    return value;\n};\nlet box: Box<int> = new;');
  assert.ok(hasScope(lines[0], '@param', 'storage.type.documentation.command.neura'));
  assert.ok(hasScope(lines[0], '[in]', 'storage.modifier.documentation.direction.neura'));
  assert.ok(hasScope(lines[0], 'value', 'variable.parameter.documentation.neura'));
  assert.ok(hasScope(lines[1], 'NoDiscard', 'entity.name.tag.neura'));
  assert.ok(hasScope(lines[2], 'identity', 'entity.name.function.neura'));
  assert.ok(hasScope(lines[2], 'T', 'entity.name.type.parameter.neura'));
  assert.ok(hasScope(lines[2], 'value', 'variable.parameter.neura'));
  assert.ok(hasScope(lines[5], 'Box', 'entity.name.type.neura'));
  assert.ok(hasScope(lines[5], 'int', 'support.type.primitive.neura'));
});
test('strings follow Neura escapes without invented interpolation or character literals', async () => {
  const [tokens] = await tokenize(String.raw`let message = "a\n\t\"\\ {value} \q";`);
  for (const escape of [String.raw`\n`, String.raw`\t`, String.raw`\"`, String.raw`\\`]) {
    assert.ok(hasScope(tokens, escape, 'constant.character.escape.neura'), escape);
  }
  assert.ok(hasScope(tokens, String.raw`\q`, 'invalid.illegal.escape.neura'));
  assert.ok(tokens.filter(t => t.text.includes('{value}')).every(t => t.scopes.includes('string.quoted.double.neura')));
  assert.ok(!(await tokenize("'x'"))[0].some(t => t.scopes.some(s => s.startsWith('string.'))));
  assert.ok(!(await tokenize('/* ordinary slash/star tokens */'))[0].some(t => t.scopes.some(s => s.startsWith('comment.'))));
});
test('numeric syntax is decimal and exponential, with unsupported suffixes identified', async () => {
  const [tokens] = await tokenize('let values = [42, 1.5, 2e-4, 10u8, 0xff];');
  assert.ok(hasScope(tokens, '42', 'constant.numeric.integer.decimal.neura'));
  assert.ok(hasScope(tokens, '1.5', 'constant.numeric.float.neura'));
  assert.ok(hasScope(tokens, '2e-4', 'constant.numeric.float.neura'));
  assert.ok(hasScope(tokens, '10u8', 'invalid.illegal.numeric.neura'));
  assert.ok(hasScope(tokens, '0xff', 'invalid.illegal.numeric.neura'));
});
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return channels.reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) { const vals = [luminance(a), luminance(b)].sort((a, b) => a - b); return (vals[1] + .05) / (vals[0] + .05); }
test('all four themes meet source-text contrast and map the complete semantic taxonomy', () => {
  for (const file of ['neura-dark.json', 'neura-light.json', 'neura-dark-vivid.json', 'neura-light-vivid.json']) {
    const theme = JSON.parse(fs.readFileSync(path.join(root, 'themes', file), 'utf8'));
    assert.equal(theme.semanticHighlighting, true);
    const bg = theme.colors['editor.background'];
    for (const [type, style] of Object.entries(theme.semanticTokenColors)) {
      const color = typeof style === 'string' ? style : style.foreground;
      if (color) assert.ok(contrast(color, bg) >= 4.5, `${file}: ${type} (${color}) has insufficient contrast`);
    }
    for (const rule of theme.tokenColors) assert.ok(contrast(rule.settings.foreground, bg) >= 4.5, `${file}: ${rule.name}`);
    for (const type of ['namespace', 'class', 'interface', 'enum', 'typeParameter', 'parameter', 'property', 'enumMember', 'function', 'method', 'neuraGetter', 'neuraSetter', 'neuraAccessorRead', 'neuraAccessorWrite', 'neuraStorage', 'neuraModule', 'neuraConstructor', 'neuraDestructor']) assert.ok(theme.semanticTokenColors[type], `${file}: missing ${type}`);
  }
});
test('language configuration and snippets use the actual comment/test/entry conventions', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8'));
  assert.deepEqual(config.comments, { lineComment: '//' });
  const snippets = JSON.parse(fs.readFileSync(path.join(root, 'snippets/neura.code-snippets'), 'utf8'));
  assert.ok(snippets['Application entry'].body.join('\n').includes('module:program.Entry'));
  assert.ok(snippets['Test function'].body.join('\n').includes('export let test_'));
  assert.ok(snippets['For each'].body[0].startsWith('for (let '));
  assert.ok(Object.values(snippets).every(s => !s.body.join('\n').includes('#Test')));
  assert.ok(Object.keys(snippets).length >= 30);
});
test('gallery tokenizes without grammar stalls across its full text', async () => {
  const text = fs.readFileSync(path.join(root, 'examples/token-gallery.nra'), 'utf8');
  const lines = await tokenize(text);
  assert.equal(lines.length, text.split('\n').length);
  assert.ok(lines.flat().some(t => t.scopes.includes('entity.name.function.accessor.neura')));
});
