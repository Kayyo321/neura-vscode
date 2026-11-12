# Changelog

## 0.1.1 research candidate (RC2)

- Companion Neura 0.2.1-rc.2 fixes documentation hover rendering, invalid outline symbols, incomplete-buffer formatting, and completion for declaration modifiers, eligible overrides, promoted exports, and standard-library imports.
- Add automatic declaration semicolons while typing named bodies, preserving inline class annotations and statement blocks. Disable with `neura.editing.autoSemicolon`.
- Stop Test Explorer from scanning tool worktrees and build outputs; honor editor exclusions, configured import roots, and configuration/trust refreshes.
- Resolve tasks.json build/run/check/test/clean actions correctly, report compiler diagnostics in Problems, and rebuild before Run.
- Apply the configured tool environment consistently to language services, tests, debugger and inspection tools; cancel descendant processes reliably on timeout.
- Install as extension version 0.1.1 so RC1 installations can upgrade normally. See [the RC2 walkthrough](docs/TRY-RC2.md).

## 0.1.0 research candidate

- Initial Neura development environment with toolchain onboarding, projects, build/run, compiler language services, Test Explorer, NVM debugging, documentation, and artifact workflows.
- Four accessible pink/blue themes, source/IR/assembly grammars, 37 snippets, semantic-token customization, and optional artifact icons.
- Companion Neura 0.2.1-rc.1 tooling protocols; existing compilers retain reduced, explicit support.
