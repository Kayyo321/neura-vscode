const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = require('./load.cjs');
const original = Module._load;
Module._load = function(request, ...args) { return request === 'vscode' ? {} : original.call(this, request, ...args); };
const { declarationSemicolons } = load('src/editing.ts');
Module._load = original;

function marked(source) {
  const start = source.indexOf('|');
  source = source.replace('|', '');
  return { source, result: declarationSemicolons(source, start, start + 2) };
}

test('typing named declaration bodies completes their terminator', () => {
  for (const kind of ['class', 'interface', 'module', 'enum', 'singleton', 'monitor']) {
    for (const source of [`let Name = ${kind} |()`, `let Outer = module (\n export let Name = ${kind} |()\n);`]) {
      const actual = marked(source);
      assert.deepEqual(actual.result, [actual.source.indexOf('()', source.indexOf('|')) + 2], source);
    }
  }
  const source = 'export let render = func(value: int) -> string {}';
  assert.deepEqual(declarationSemicolons(source, source.indexOf('{}'), source.length), [source.length]);
});

test('typing aids leave anonymous class types and ordinary expressions alone', () => {
  for (const source of [
    'let value: class |() = new;', 'let value: class |()',
    'let construct = new class |()', 'let invoke = func|()', 'call|()',
    'if (ready) |{}', 'let f = func() => match(value) |{}',
    '/// let Name = class |()', 'let text = "let Name = class |()";',
    '/* let Name = class |() */', 'let value = old == class |()',
  ]) assert.deepEqual(marked(source).result, [], source);
  assert.deepEqual(marked('let text = "let Name = class |()' + String.fromCharCode(92)).result, [], 'unterminated strings ending in a backslash remain string content');
});

test('typing aids preserve existing terminators and expression continuations', () => {
  for (const source of [
    'let Name = class |();', 'let Name = class |() = new;',
    'let Name = class |().member', 'let f = func() |{} or func() {};',
    'let f = func() |{} callback("notify", 1);',
  ]) assert.deepEqual(marked(source).result, [], source);
});

test('closing multiline declarations is recognized without touching inner parentheses', () => {
  const source = 'let C = class (\n export let f = func(value: int) {};\n)';
  assert.deepEqual(declarationSemicolons(source, source.length - 1, source.length), [source.length]);
  const nested = 'let E = enum (Value(int))';
  assert.deepEqual(declarationSemicolons(nested, nested.indexOf('(int)'), nested.length - 1), []);
});
