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
  for (const word of ['last', 'scope', 'spawn', 'select', 'get', 'set', 'value', 'defer', 'using', 'yield', 'iterator', 'record',
    'derive', 'field', 'variant', 'unless', 'with', 'nameof', 'extension', 'extensions', 'virtual', 'html', 'css', 'from']) {
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
test('strings and character literals follow the 0.3.0 escapes; plain strings do not interpolate', async () => {
  const [tokens] = await tokenize(String.raw`let message = "a\n\t\"\\ \0\r\' \x41 \u{1F600} {value} \q";`);
  for (const escape of [String.raw`\n`, String.raw`\t`, String.raw`\"`, String.raw`\\`, String.raw`\0`, String.raw`\r`, String.raw`\'`, String.raw`\x41`, String.raw`\u{1F600}`]) {
    assert.ok(hasScope(tokens, escape, 'constant.character.escape.neura'), escape);
  }
  assert.ok(hasScope(tokens, String.raw`\q`, 'invalid.illegal.escape.neura'));
  assert.ok(tokens.filter(t => t.text.includes('{value}')).every(t => t.scopes.includes('string.quoted.double.neura')));
  assert.ok(!tokens.some(t => t.scopes.some(s => s.startsWith('meta.interpolation'))), 'a plain string has no holes');
  const [chars] = await tokenize(String.raw`let c = ['A', '\n', '\'', '\xFF', '\u{E9}'];`);
  assert.ok(hasScope(chars, 'A', 'constant.character.neura'));
  for (const escape of [String.raw`\n`, String.raw`\'`, String.raw`\xFF`, String.raw`\u{E9}`]) assert.ok(hasScope(chars, escape, 'constant.character.escape.neura'), escape);
  assert.ok(!chars.some(t => t.scopes.some(s => s.startsWith('string.'))), 'character literals are not strings');
  assert.ok(!(await tokenize("let s = 'too long';"))[0].some(t => t.scopes.some(s => s.startsWith('constant.character.neura'))), 'only one-byte character literals');
  assert.ok(!(await tokenize('/* ordinary slash/star tokens */'))[0].some(t => t.scopes.some(s => s.startsWith('comment.'))));
  const lines = await tokenize('let s = "never closed\nlet next = 1;');
  assert.ok(hasScope(lines[1], 'next', 'variable.other.readwrite.declaration.neura'), 'an unterminated string ends at its line');
});
test('interpolated strings scope holes, specifications, nested holes and doubled braces', async () => {
  const [tokens] = await tokenize('let text = $"{name}: {count:>4} items, {{braces}}, {value:>{width}} {(ok ? 1 : 2)}";');
  assert.ok(hasScope(tokens, '$', 'string.interpolated.neura'));
  assert.ok(tokens.some(t => t.text === 'name' && t.scopes.includes('meta.interpolation.neura') && t.scopes.includes('variable.other.readwrite.neura')));
  assert.ok(hasScope(tokens, '>4', 'constant.other.format-specification.neura'));
  assert.ok(hasScope(tokens, '{{', 'constant.character.escape.brace.neura'));
  assert.ok(hasScope(tokens, '}}', 'constant.character.escape.brace.neura'));
  assert.ok(tokens.some(t => t.text === 'width' && t.scopes.filter(s => s === 'meta.interpolation.neura').length === 2), 'nested width hole');
  assert.ok(hasScope(tokens, '?', 'keyword.operator.conditional.neura'), 'a parenthesized conditional stays an expression');
  assert.ok(hasScope(tokens, ';', 'punctuation.terminator.statement.neura'), 'the literal closes before the terminator');
  const lines = await tokenize('let open = $"{name\nlet next = 1;');
  assert.ok(hasScope(lines[1], 'next', 'variable.other.readwrite.declaration.neura'), 'an unclosed hole ends with its line');
});
test('numeric syntax is decimal and exponential, with unsupported suffixes identified', async () => {
  const [tokens] = await tokenize('let values = [42, 1.5, 2e-4, 10u8, 0xff];');
  assert.ok(hasScope(tokens, '42', 'constant.numeric.integer.decimal.neura'));
  assert.ok(hasScope(tokens, '1.5', 'constant.numeric.float.neura'));
  assert.ok(hasScope(tokens, '2e-4', 'constant.numeric.float.neura'));
  assert.ok(hasScope(tokens, '10u8', 'invalid.illegal.numeric.neura'));
  assert.ok(hasScope(tokens, '0xff', 'invalid.illegal.numeric.neura'));
});
const all = lines => lines.flat();
test('NeuraIR 1.11-1.15 and NVR 1.8-1.9 listings scope their new operations', async () => {
  const [ir] = await tokenize('      any_pack : any at "a.nra":1:1 cleanup pending yield concat_text hook_read conformance_call type_of', 'source.neurair');
  for (const op of ['any_pack', 'cleanup', 'pending', 'yield', 'concat_text', 'hook_read', 'conformance_call', 'type_of']) assert.ok(hasScope(ir, op, 'keyword.control.neurair'), op);
  assert.ok(hasScope(ir, 'any', 'support.type.primitive.neurair'));
  const [asm] = await tokenize('hook-enter read-tag concat-text text-from-utf8 write-component constant 42 type 0 bytes 6f74686572 ; "other"', 'source.nvra');
  for (const op of ['hook-enter', 'read-tag', 'concat-text', 'text-from-utf8', 'write-component']) assert.ok(hasScope(asm, op, 'entity.name.function.nvra'), op);
  assert.ok(hasScope(asm, '6f74686572', 'constant.numeric.hex.nvra'));
});
test('0.3.0 reserved words not and typeof are operators; nameof is an operator only when called', async () => {
  const [tokens] = await tokenize('if (not ready && shape is not Circle) { let n = nameof(Shape.area); let t = typeof(value); }');
  assert.equal(tokens.filter(t => t.text === 'not' && t.scopes.includes('keyword.operator.word.neura')).length, 2);
  assert.ok(hasScope(tokens, 'typeof', 'keyword.operator.expression.typeof.neura'));
  assert.ok(hasScope(tokens, 'nameof', 'keyword.operator.expression.nameof.neura'));
  assert.ok(!hasScope((await tokenize('let x = nameof;'))[0], 'nameof', 'keyword.'));
});
test('grouped, defaulted, variadic, tagged and untyped lambda parameters; => set constructors', async () => {
  const [grouped] = await tokenize('let f = func(x, y: float64, label: string = "a, b", #Unused items: ...string) -> void {};');
  for (const name of ['x', 'y', 'label', 'items']) assert.ok(hasScope(grouped, name, 'variable.parameter.neura'), name);
  assert.ok(hasScope(grouped, 'float64', 'support.type.primitive.neura'));
  assert.ok(hasScope(grouped, '=', 'keyword.operator.assignment.default.neura'));
  assert.ok(hasScope(grouped, '"', 'string.quoted.double.neura'), 'a default is an expression');
  assert.ok(hasScope(grouped, '...', 'keyword.operator.variadic.neura'));
  assert.ok(hasScope(grouped, 'Unused', 'entity.name.tag.neura'));
  const [generic] = await tokenize('let map = func<T, U>(values: Map<T, U>, transform: func(T) -> U) -> U {};');
  assert.ok(hasScope(generic, 'values', 'variable.parameter.neura'));
  assert.ok(hasScope(generic, 'transform', 'variable.parameter.neura'));
  assert.ok(!generic.some(t => ['T', 'U'].includes(t.text) && t.scopes.includes('variable.parameter.neura')), 'types inside parameter types stay types');
  const [lambda] = await tokenize('let add: func(int, int) -> int = func(a, b) => a + b;');
  assert.ok(hasScope(lambda, 'a', 'variable.parameter.neura'));
  assert.ok(!lambda.some(t => t.text === 'int' && t.scopes.includes('variable.parameter.neura')), 'a function type is not a parameter list');
  const [shorthand] = await tokenize('export let init = func(x, y: int) => set;');
  assert.ok(hasScope(shorthand, 'set', 'keyword.other.constructor-shorthand.neura'));
  assert.ok(hasScope(shorthand, 'x', 'variable.parameter.neura'));
});
test('named arguments and field labels are labels, not conditional operators', async () => {
  const [call] = await tokenize('schedule("backup", urgent: true, retries: 3);');
  assert.ok(hasScope(call, 'urgent', 'variable.parameter.label.neura'));
  assert.ok(hasScope(call, 'retries', 'variable.parameter.label.neura'));
  assert.ok(!call.some(t => t.scopes.includes('keyword.operator.conditional.neura')));
  const [generic] = await tokenize('let x = make<int>(count: 3);');
  assert.ok(hasScope(generic, 'count', 'variable.parameter.label.neura'), 'a generic call is not a parameter list');
  assert.ok(!generic.some(t => t.scopes.includes('meta.function.parameters.neura')));
  const [copy] = await tokenize('let m = new with(user) { name: "Grace", id: 3 };');
  assert.ok(hasScope(copy, 'name', 'variable.parameter.label.neura'));
  assert.ok(hasScope(copy, 'id', 'variable.parameter.label.neura'));
  const [ternary] = await tokenize('let c = f(ok ? a : b);');
  assert.ok(hasScope(ternary, ':', 'keyword.operator.conditional.neura'));
  const [arm] = await tokenize('let n = match.is (value) { text: string => 0, _ => 1 };');
  assert.ok(!hasScope(arm, 'text', 'variable.parameter.label.neura'), 'a match.is binding is not a label');
});
test('records, copies, properties, virtual accessors, let.override and static requirements', async () => {
  const lines = await tokenize([
    'let User = record (id: int64, name: string);',
    'let copy = new with(user) { name: "Grace" };',
    'let Named = interface (',
    '    let name: string;',
    '        | get;',
    '        | set;',
    '    static let zero = func() -> T;',
    ');',
    'let Shape = class (',
    '    export let label: string = "";',
    '        | get.virtual: label;',
    '    export let.override label: string;',
    '        | get.override: "circle of " + label;',
    ');',
  ].join('\n'));
  assert.ok(hasScope(lines[0], 'User', 'entity.name.type.class.neura'));
  assert.ok(hasScope(lines[0], 'record', 'storage.type.record.neura'));
  assert.ok(hasScope(lines[0], 'id', 'variable.parameter.neura'));
  assert.ok(hasScope(lines[1], 'with', 'keyword.other.with.neura'));
  assert.ok(hasScope(lines[4], 'get', 'entity.name.function.accessor.neura'));
  assert.ok(hasScope(lines[5], 'set', 'entity.name.function.accessor.neura'));
  assert.ok(hasScope(lines[6], 'static', 'storage.modifier.neura'));
  assert.ok(hasScope(lines[6], 'zero', 'entity.name.function.neura'));
  assert.ok(hasScope(lines[10], 'virtual', 'storage.modifier.accessor.neura'));
  assert.ok(hasScope(lines[11], '.override', 'storage.modifier.neura'));
  assert.ok(hasScope(lines[11], 'label', 'variable.other.readwrite.declaration.neura'));
  assert.ok(hasScope(lines[12], 'override', 'storage.modifier.accessor.neura'));
});
test('derive, extension sets, hooks and static scope', async () => {
  const lines = await tokenize([
    'let UserJson = derive json.Codec<User> {',
    '    field User.name: "display_name";',
    '    variant Mode.Slow: "slow";',
    '};',
    'let.extensions text = import:Std.Text;',
    'export let.extension shout = func(text: string, marks: int = 1) -> string => text;',
    'let Session = class (',
    '    | get: instance;',
    ');',
    'static scope {',
    '}',
  ].join('\n'));
  assert.ok(hasScope(lines[0], 'UserJson', 'entity.name.namespace.neura'));
  assert.ok(hasScope(lines[0], 'derive', 'keyword.other.derive.neura'));
  assert.ok(hasScope(lines[0], 'User', 'entity.name.type.argument.neura'));
  assert.ok(hasScope(lines[1], 'field', 'keyword.other.derive.mapping.neura'));
  assert.ok(hasScope(lines[2], 'variant', 'keyword.other.derive.mapping.neura'));
  assert.ok(hasScope(lines[4], '.extensions', 'storage.modifier.neura'));
  assert.ok(hasScope(lines[4], 'text', 'entity.name.namespace.alias.neura'));
  assert.ok(hasScope(lines[5], '.extension', 'storage.modifier.neura'));
  assert.ok(hasScope(lines[5], 'shout', 'entity.name.function.neura'));
  assert.ok(hasScope(lines[7], 'get', 'entity.name.function.accessor.neura'));
  assert.ok(hasScope(lines[7], 'instance', 'variable.language.neura'));
  assert.ok(hasScope(lines[9], 'static', 'storage.modifier.neura'));
  assert.ok(hasScope(lines[9], 'scope', 'keyword.control.scope.neura'));
});
test('match.is, any, optional access, coalescing, propagation, !== and ranges', async () => {
  const [tokens] = await tokenize('let r = match.is (value) { name: string if name != "" => a?.b ?? c?.m(x), nil => f()?, _ => 0 } !== nil;');
  assert.ok(tokens.some(t => t.text === 'is' && t.scopes.includes('keyword.control.neura')), 'match.is');
  assert.ok(hasScope(tokens, '?.', 'punctuation.accessor.optional.neura'));
  assert.ok(hasScope(tokens, 'b', 'variable.other.property.neura'));
  assert.ok(hasScope(tokens, 'm', 'entity.name.function.member.neura'));
  assert.ok(hasScope(tokens, '??', 'keyword.operator.coalescing.neura'));
  assert.ok(hasScope(tokens, '?', 'keyword.operator.propagation.neura'));
  assert.ok(hasScope(tokens, '!==', 'keyword.operator.identity.neura'));
  assert.ok(hasScope((await tokenize('let held: any = 3;'))[0], 'any', 'support.type.primitive.neura'));
  const [ternary] = await tokenize('let t = ok ? 1 : 2;');
  assert.ok(hasScope(ternary, '?', 'keyword.operator.conditional.neura'));
  const [range] = await tokenize('for (let i in 0 ..= count : 2) { line ..= "x" .. name; }');
  assert.equal(range.filter(t => t.text === '..=' && t.scopes.includes('keyword.operator.range.neura')).length, 2);
  assert.ok(hasScope(range, '..', 'keyword.operator.range.neura'));
});
test('defer, using, generators, yield and return unless', async () => {
  const lines = await tokenize([
    'let squares = iterator(count: int32) -> int32 {',
    '    defer audit.end_section("import");',
    '    using (source = files.open(path)?) {',
    '        yield count * count;',
    '    }',
    '    return new iterator() -> int { yield 1; };',
    '    return value unless guard;',
    '};',
  ].join('\n'));
  assert.ok(hasScope(lines[0], 'squares', 'entity.name.function.neura'));
  assert.ok(hasScope(lines[0], 'iterator', 'storage.type.iterator.neura'));
  assert.ok(hasScope(lines[0], 'count', 'variable.parameter.neura'));
  assert.ok(hasScope(lines[1], 'defer', 'keyword.control.defer.neura'));
  assert.ok(hasScope(lines[2], 'using', 'keyword.control.using.neura'));
  assert.ok(hasScope(lines[3], 'yield', 'keyword.control.yield.neura'));
  assert.ok(hasScope(lines[5], 'iterator', 'storage.type.iterator.neura'));
  assert.ok(hasScope(lines[6], 'unless', 'keyword.control.conditional.unless.neura'));
  const [call] = await tokenize('let x = defer(1) + using(2) + yield(3);');
  assert.ok(!call.some(t => t.scopes.some(s => /keyword\.control\.(?:defer|using|yield)/.test(s))), 'calls of functions named like the contextual words');
});
test('tag groups stay on one line with their arguments', async () => {
  const lines = await tokenize('#[Inline(always: true), Since("0.2.0")]\nlet f = func() {};');
  assert.ok(hasScope(lines[0], 'Inline', 'entity.name.tag.neura'));
  assert.ok(hasScope(lines[0], 'Since', 'entity.name.tag.neura'));
  assert.ok(hasScope(lines[0], 'always', 'variable.parameter.label.neura'));
  assert.ok(hasScope(lines[0], 'true', 'constant.language.boolean.neura'));
  assert.ok(hasScope(lines[0], ']', 'punctuation.section.annotation.end.neura'));
  assert.ok(hasScope(lines[1], 'f', 'entity.name.function.neura'));
});
test('html forms embed HTML with Neura holes and control blocks; css forms embed CSS', async () => {
  const lines = await tokenize([
    'let part_row = html(name: string, count: int32) {',
    '    <li class="part" title=\'it}s\'>',
    "        <span>Don't {name} &amp; it</span>",
    '        <!-- a } comment -->',
    '        @if (count < 5) {',
    '            <strong>Low</strong>',
    '        } @else {',
    '            <button on:click={restock}>Restock</button>',
    '        }',
    '    </li>',
    '};',
    'const PartStyles = css {',
    '    .part-list { color: var(--warning, #a40); background: url(a.png); }',
    '    /* it\'s } */',
    '};',
    'let Local = css.module from "./parts.module.css";',
    'let row = html(name: string) from "./part-row.html";',
    'let after = 1;',
  ].join('\n'));
  assert.ok(hasScope(lines[0], 'part_row', 'entity.name.function.neura'));
  assert.ok(hasScope(lines[0], 'html', 'storage.type.html.neura'));
  assert.ok(hasScope(lines[0], 'name', 'variable.parameter.neura'));
  assert.ok(hasScope(lines[1], 'li', 'entity.name.tag.html'));
  assert.ok(hasScope(lines[1], 'class', 'entity.other.attribute-name.html'));
  assert.ok(hasScope(lines[1], 'it}s', 'string.quoted.single.html'), 'a brace in a quoted attribute does not close the form');
  assert.ok(lines[2].some(t => t.text.startsWith("Don't") && t.scopes.includes('meta.embedded.block.html') && !t.scopes.some(s => s.startsWith('string'))), 'an apostrophe in text opens nothing');
  assert.ok(lines[2].some(t => t.text === 'name' && t.scopes.includes('meta.interpolation.neura')));
  assert.ok(hasScope(lines[2], '&amp;', 'constant.character.entity.html'));
  assert.ok(hasScope(lines[3], ' a } comment ', 'comment.block.html'));
  assert.ok(hasScope(lines[4], 'if', 'keyword.control.template.neura'));
  assert.ok(hasScope(lines[4], 'count', 'variable.other.readwrite.neura'));
  assert.ok(hasScope(lines[6], 'else', 'keyword.control.template.neura'));
  assert.ok(hasScope(lines[7], 'on', 'keyword.other.directive.neura'));
  assert.ok(lines[7].some(t => t.text === 'restock' && t.scopes.includes('meta.interpolation.neura')));
  assert.ok(hasScope(lines[10], '}', 'punctuation.section.embedded.end.neura'));
  assert.ok(hasScope(lines[11], 'css', 'storage.type.css.neura'));
  assert.ok(hasScope(lines[12], '.part-list', 'entity.other.attribute-name.class.css'));
  assert.ok(hasScope(lines[12], 'color', 'support.type.property-name.css'));
  assert.ok(hasScope(lines[12], '#a40', 'constant.other.color.rgb-value.hex.css'));
  assert.ok(hasScope(lines[12], 'a.png', 'variable.parameter.url.css'));
  assert.ok(lines[12].every(t => t.scopes.includes('meta.embedded.block.css')));
  assert.ok(hasScope(lines[13], " it's } ", 'comment.block.css'));
  assert.ok(hasScope(lines[14], '}', 'punctuation.section.embedded.end.neura'));
  assert.ok(hasScope(lines[15], 'module', 'storage.modifier.css.neura'));
  assert.ok(hasScope(lines[15], 'from', 'keyword.other.from.neura'));
  assert.ok(hasScope(lines[16], 'from', 'keyword.other.from.neura'));
  assert.ok(hasScope(lines[17], 'after', 'variable.other.readwrite.declaration.neura'), 'forms close and later code is ordinary Neura');
  assert.ok(!all(lines).some(t => t.scopes.some(s => s.startsWith('invalid.'))));
});
test('html and css stay ordinary names outside their forms', async () => {
  const [tokens] = await tokenize('let page = render.html(view); let css = sheet.css; let x = html;');
  assert.ok(!tokens.some(t => t.scopes.some(s => s.startsWith('meta.embedded'))));
  assert.ok(!hasScope(tokens, 'html', 'storage.type.html.neura'));
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
