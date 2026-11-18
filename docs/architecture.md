# Architecture

The TypeScript extension runs in the workspace extension host. Compiler, language server, debugger, tests, and terminals run on that same host. Remote WSL, containers, and SSH therefore use their own executable and paths.

The compiler owns language semantics. TextMate handles immediate lexical coloring; a per-folder LSP session adds compiler AST/IR symbols, unsaved overlays, partial syntax recovery, navigation, semantic tokens, diagnostics, and versioned editor edits. Documentation JSON remains a documentation index, not an incomplete replacement for the symbol database.

A conservative delimiter-aware typing aid adds `;` to named declaration bodies. It leaves anonymous class type positions and statement blocks intact; `neura.editing.autoSemicolon` disables it. The compiler still decides whether a declaration is valid.

The native Task API owns interactive build/run terminals. Test Explorer honors configured editor/search exclusions and skips generated directories and nested worktrees. It shares configured source roots, matching target roots, and tool environment between discovery, Run, and Debug. A lexical candidate filter avoids compiling support files merely because a comment mentions `test_`; the compiler determines test eligibility. Test Explorer consumes versioned discovery and NDJSON events; captured program output is framed and attributed. The DAP adapter drives actual NVM steps and typed snapshots. Webviews are bounded, escaped, and protected by CSP; source text cannot gain command authority.

Neura 0.3.0 projects (`neura.toml`) are read only to list targets; the SDK's `neura build --project <manifest> --target`, `neura dev` and `neura package` do the work as `neura-project` tasks in a live terminal (`neura dev` stops at the end of its input), with absolute manifest paths so that problem matchers can resolve every location. `neura new` creates projects. A JSON schema derived from the SDK's manifest reader is contributed for Even Better TOML.

Toolchain discovery looks on `PATH`, in `~/.local/bin`, and in the 0.3 install root's `current/bin`, and keeps the installed link instead of resolving it to a generation, which a later update may remove. A 0.3 runtime-only installation reports the language server, formatter, debugger and tests as unavailable; the extension names the missing SDK instead of treating it as an older release.

Toolchain capabilities are discovered explicitly. Missing features degrade to useful existing CLI behavior. No normal edit-loop operation downloads tools. Workspace-controlled processes and settings require trust. Process capture is bounded; cancellation cleans up child groups. Diagnostic export omits workspace paths, source contents, and environment values.

The extension is bundled with esbuild. `dist/extension.js` and static grammar/theme assets comprise the VSIX; source, tests, dependencies, and development caches are excluded.
