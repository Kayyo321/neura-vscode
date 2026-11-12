const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: [path.join(__dirname, '../src/documentation.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] }).outputFiles[0].text;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? {} : require(id), compiled, compiled.exports);
const docs = compiled.exports;
const span = { line: 3, column: 1, offset: 18, length: 60 };
function index(text = '@brief A safe declaration.\n@param value The input.\n@return A result.') {
  return { version: 1, files: [{ path: '/source/example.nra', symbols: [{ name: 'identity', kind: 'function', signature: 'identity = func<T>(value: T) -> T', scope: ['Example'], declaration: span, selection: span, documentation: { text, range: span, tags: [] }, tags: [{ name: 'NoDiscard', arguments: [] }] }] }] };
}
test('documentation links permit web links without command or file authority', () => {
  assert.equal(docs.safeDocumentationUrl('https://example.com/docs?q=a&x=b'), 'https://example.com/docs?q=a&x=b');
  assert.equal(docs.safeDocumentationUrl('http://localhost/docs'), 'http://localhost/docs');
  for (const url of ['command:workbench.action.openSettings', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'vscode://extension/command', 'data:text/html,hi', 'https://name:password@example.com', 'https://exa\nmple.com', '//example.com', 'docs/Types.md']) assert.equal(docs.safeDocumentationUrl(url), undefined, url);
});
test('inline renderer escapes raw HTML and unsafe link labels/targets', () => {
  const html = docs.renderDocumentationInline('<img src=x onerror=alert(1)> [<b>click</b>](command:evil) `a < b` **safe** https://example.com/docs.');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;b&gt;click&lt;/b&gt; (command:evil)'));
  assert.ok(html.includes('<code>a &lt; b</code>'));
  assert.ok(html.includes('<strong>safe</strong>'));
  assert.ok(html.includes('href="https://example.com/docs"'));
  assert.ok(!html.includes('href="command:'));
  assert.ok(!html.includes('<img'));
});
test('Doxygen parameters, type parameters, returns, notices and references render as structured content', () => {
  const html = docs.renderDoxygen('@brief Computes a value.\n@tparam T Value type.\n@param[in,out] value Mutable input.\n  Continues here.\n@return The value.\n@warning Validate the value.\n@see Other More information.\n@vendorCustom Keep this text.', new Map([['Other', 'symbol-2']]));
  for (const text of ['Parameters', 'Type parameters', 'Returns', 'Warning', 'vendorCustom', 'Continues here.', 'in,out']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('href="#symbol-2"'));
});
test('code fences and Doxygen code blocks never interpret commands or HTML', () => {
  for (const source of ['```neura\n@param fake <script>alert(1)</script>\n```', '@code{.nra}\n@param fake <script>alert(1)</script>\n@endcode', '\\verbatim\n@param fake <script>alert(1)</script>\n\\endverbatim']) {
    const html = docs.renderDoxygen(source);
    assert.ok(html.includes('@param fake'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<h4>Parameters</h4>'));
    assert.ok(html.includes('<pre><code>'));
  }
});
test('the complete preview has a restrictive CSP, semantic navigation, and escaped metadata', () => {
  const data = index('@brief <script>evil()</script>\n@param value Input.');
  data.files[0].symbols[0].name = '<img src=x>';
  const html = docs.renderDocumentationHtml(data, '<title>unsafe</title>', '1234567890abcdef');
  for (const directive of ["default-src 'none'", "script-src 'none'", "img-src 'none'", "base-uri 'none'", "form-action 'none'", "style-src 'nonce-1234567890abcdef'"]) assert.ok(html.includes(directive), directive);
  assert.ok(html.includes('aria-label="Documented declarations"'));
  assert.ok(html.includes('&lt;title&gt;unsafe&lt;/title&gt;'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('command:'));
});
test('empty documentation explains the compiler index rather than inventing symbols', () => {
  const html = docs.renderDocumentationHtml({ version: 1, files: [{ path: 'empty.nra', symbols: [] }] }, 'Empty', '1234567890abcdef');
  assert.ok(html.includes('No documented declarations'));
  assert.ok(html.includes('Only declarations with attached'));
});
test('documentation schema validation rejects unsupported versions and malformed records', () => {
  assert.deepEqual(docs.parseDocumentationIndex(JSON.stringify(index())), index());
  for (const data of [{ version: 2, files: [] }, { version: 1, files: [{}] }, { version: 1, files: [{ path: 'x', symbols: [{ name: 'x' }] }] }, null]) assert.throws(() => docs.parseDocumentationIndex(JSON.stringify(data)));
});
test('signature names come from compiler signatures, including nested generics and function types', () => {
  const shape = docs.documentationShape('map', 'map = func<T: [Comparable<T>, Iterable<int>], U>(values: Box<T>[], transform: func(T) -> U, options: [int, string]) -> Box<U>');
  assert.deepEqual(shape.typeParameters, ['T', 'U']);
  assert.deepEqual(shape.parameters, ['values', 'transform', 'options']);
  assert.equal(shape.returnType, 'Box<U>');
  assert.deepEqual(docs.documentationShape('Box', 'Box = class<T>'), { name: 'Box', parameters: [], typeParameters: ['T'] });
  assert.equal(docs.documentationShape('main', 'main = func(args: string[]) -> void').returnType, 'void');
});
test('generation preserves prose, descriptions, directions, unknown tags and stale names', () => {
  const source = 'User-authored summary.\n\\param[in] value Keep my description.\n@param removed Keep this until reviewed.\n@vendorCustom Preserve this.';
  const merged = docs.mergeDocumentation(source, { name: 'identity', parameters: ['value', 'other'], typeParameters: ['T'], returnType: 'T' });
  for (const value of ['User-authored summary.', '\\param[in] value Keep my description.', '@vendorCustom Preserve this.', '@param other', '@tparam T', '@return']) assert.ok(merged.text.includes(value), value);
  assert.equal((merged.text.match(/(?:@|\\)param(?:\[in\])? value/g) || []).length, 1);
  assert.deepEqual(merged.stale, ['removed']);
  assert.ok(!docs.mergeDocumentation('', { name: 'perform_action', parameters: [], typeParameters: [], returnType: 'void' }).text.includes('@return'));
});

test('documentation updates do not interpret parameter examples inside literal blocks', () => {
  for (const existing of ['@brief Example.\n```neura\n@param fake Example-only parameter.\n```', '@brief Example.\n@code\n@param fake Example-only parameter.\n@endcode', '@brief Example.\n\\verbatim\n@param fake Example-only parameter.\n\\endverbatim']) {
    const merged = docs.mergeDocumentation(existing, { name: 'identity', parameters: ['value'], typeParameters: [], returnType: 'void' });
    assert.deepEqual(merged.stale, []);
    assert.ok(merged.text.includes('@param value Description of value.'));
    assert.ok(merged.text.includes('@param fake Example-only parameter.'));
  }
});
