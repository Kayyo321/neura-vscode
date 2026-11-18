# Changelog

## 0.3.0

The extension's version now follows the Neura language release it is built for. This release works with the **Neura 0.3.0 SDK**; see [Get started](docs/GETTING-STARTED.md).

- **Language:** the grammar covers Neura 0.3.0: grouped, defaulted, variadic and untyped lambda parameters and `=> set` constructors; records, `new with(...)` copies, interface properties, `get.virtual`/`get.override` accessors and `let.override`; static requirements and `derive json.Codec<...>` with `field`/`variant` mappings; `let.extension` and `let.extensions`; `match.is`, `any`, `?.`, `??`, postfix `?`, `!==`, `..=` and string chains; `defer`, `using`, generators and `yield`, `return ... unless`; `nameof`, `typeof` and `not`; character literals and the shared escapes; interpolated strings with holes, format specifications and nested width holes; `#[...]` tag groups; class hooks and `static scope`; and `html`/`css` forms, whose bodies are embedded HTML and CSS with Neura holes and `@if`/`@for` blocks. New words stay ordinary names outside their forms, as in the parser. The NeuraIR and NVR assembly grammars know the NeuraIR 1.11–1.15 and NVR 1.8–1.9 operations.
- **Projects:** the Projects view lists every `neura.toml` with its targets. Build (`neura build --project --target`), Develop (`neura dev`), Package (`neura package`) and Update Lock run as `neura-project` tasks with problem matchers for project diagnostics; Build and Run on a project's source file act on the target that owns it. **Create Project** offers the SDK's `fullstack`, `web`, `server` and `desktop` templates through `neura new`. Package builds the bundle first. Debug on a project source file adds the project directory as a source root. A `neura.toml` JSON schema derived from the SDK's manifest reader is contributed for Even Better TOML.
- **Toolchain:** discovery finds 0.3 installations through `~/.local/share/neura/current/bin` and keeps the installed link, so an update does not pin the editor to a generation that may be removed. A runtime-only installation is reported as missing the SDK, with the command that adds it.
- **Snippets:** 21 more, for records, copies, constructor shorthand, defaults, generators, counted ranges, `match.is`, `defer`, `using`, interpolated strings, extensions, properties, static requirements, JSON codecs, startup blocks, tag groups, and `html` and `css` forms.
- **Verification:** grammar tests for every new construct, `npm run smoke:grammar` over a tree of `.nra` files, and integration tests against the 0.3.0 SDK: semantic-token legend agreement, the 0.3.0 forms in the language server, a project build through its task, and a debug session to a breakpoint.

## 0.1.1 research candidate (RC2)

- Companion Neura 0.2.1-rc.2 fixes documentation hover rendering, invalid outline symbols, incomplete-buffer formatting, and completion for declaration modifiers, eligible overrides, promoted exports, and standard-library imports.
- Add automatic declaration semicolons while typing named bodies, preserving inline class annotations and statement blocks. Disable with `neura.editing.autoSemicolon`.
- Stop Test Explorer from scanning tool worktrees and build outputs; honor editor exclusions, configured import roots, and configuration/trust refreshes.
- Resolve tasks.json build/run/check/test/clean actions correctly, report compiler diagnostics in Problems, and rebuild before Run.
- Apply the configured tool environment consistently to language services, tests, debugger and inspection tools; cancel descendant processes reliably on timeout.
- Install as extension version 0.1.1 so RC1 installations can upgrade normally.

## 0.1.0 research candidate

- Initial Neura development environment with toolchain onboarding, projects, build/run, compiler language services, Test Explorer, NVM debugging, documentation, and artifact workflows.
- Four accessible pink/blue themes, source/IR/assembly grammars, 37 snippets, semantic-token customization, and optional artifact icons.
- Companion Neura 0.2.1-rc.1 tooling protocols; existing compilers retain reduced, explicit support.
