# Highlighting

Neura contributes standard semantic token roles and the custom types `neuraGetter`, `neuraSetter`, `neuraAccessorRead`, `neuraAccessorWrite`, `neuraStorage`, `neuraModule`, `neuraConstructor`, and `neuraDestructor`. Custom types inherit standard method, property, or namespace roles for compatibility with other themes.

Modifiers include declaration/definition, readonly, static, deprecated, abstract, documentation, defaultLibrary, exported, override, captured, deferred, reference, scopeBound, transferable, and synchronized. Balanced themes group related meanings into comfortable color families; Vivid distinguishes more roles.

The parser decides contextual words. `last`, `scope`, `spawn`, `select`, `get`, `set`, and `value` are ordinary identifiers outside their grammatical roles. Semantic resolution distinguishes backing storage from accessor calls and generic parameters from concrete types.

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
