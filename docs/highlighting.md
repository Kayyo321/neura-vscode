# Highlighting

Neura contributes standard semantic token roles and the custom types `neuraGetter`, `neuraSetter`, `neuraAccessorRead`, `neuraAccessorWrite`, `neuraStorage`, `neuraModule`, `neuraConstructor`, and `neuraDestructor`. Custom types inherit standard method, property, or namespace roles for compatibility with other themes.

Modifiers include declaration/definition, readonly, static, deprecated, abstract, documentation, defaultLibrary, exported, override, captured, deferred, reference, scopeBound, transferable, and synchronized. Balanced themes group related meanings into comfortable color families; Vivid distinguishes more roles.

The parser decides contextual words. `last`, `scope`, `spawn`, `select`, `get`, `set`, and `value` are ordinary identifiers outside their grammatical roles. Semantic resolution distinguishes backing storage from accessor calls and generic parameters from concrete types.

Neura 0.3.0 reserves only `not` and `typeof`. The TextMate grammar colors the other new words only in their forms, and leaves them ordinary names elsewhere, as the parser does:

| Form | Scopes |
| --- | --- |
| `defer call;`, `using (name = value) { }`, `yield value;`, `return value unless guard;` | `keyword.control.defer`, `keyword.control.using`, `keyword.control.yield`, `keyword.control.conditional.unless` |
| `iterator(...) -> T { }`, `record (...)`, `new with(source) { }` | `storage.type.iterator`, `storage.type.record`, `keyword.other.with` |
| `match.is (value) { }`, `derive json.Codec<T> { field T.name: "..."; }` | `keyword.control`, `keyword.other.derive`, `keyword.other.derive.mapping` |
| `let.extension`, `let.extensions`, `let.override`, `\| get.virtual:`, `\| get.override:`, `\| get;`, `=> set;` | `storage.modifier`, `storage.modifier.accessor`, `keyword.other.constructor-shorthand` |
| `nameof(x)`, `typeof(x)`, `not`, `any` | `keyword.operator.expression.nameof`, `keyword.operator.expression.typeof`, `keyword.operator.word`, `support.type.primitive` |
| `?.`, `??`, postfix `?`, `!==`, `..=` | `punctuation.accessor.optional`, `keyword.operator.coalescing`, `keyword.operator.propagation`, `keyword.operator.identity`, `keyword.operator.range` |
| `'A'`, `'\n'`, `"\u{1F600}"`, `$"{name}: {count:>4}"` | `constant.character`, `constant.character.escape`, `string.interpolated` with `meta.interpolation` holes and `constant.other.format-specification` |
| `#[Final, Since("0.3.0")]` | `meta.annotation.group`, `entity.name.tag` |
| `html(...) { <li>{name}</li> }`, `css { .card { ... } }` | `meta.embedded.block.html` and `meta.embedded.block.css`, with Neura holes and `@if`/`@for` blocks as `meta.interpolation` and `keyword.control.template` |

The bodies of `html` and `css` forms are mapped to the HTML and CSS languages, so comment toggling and Emmet follow the language under the cursor.

Customize a category without replacing the whole theme:

```json
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "typeParameter:neura": "#C3AEFF",
      "neuraGetter:neura": "#91D5CB",
      "neuraSetter:neura": "#EDBB83"
    }
  }
}
```

These example colors target dark backgrounds. Check contrast when using a light theme. Diagnostics always have messages, codes, and visual markers in addition to color. The optional Neura artifact icon theme does not replace your existing icons automatically.
