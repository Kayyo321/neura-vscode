# Contributing

Run `npm ci`, `npm run compile`, `npm test`, and `npm run package`. Run actual-host integration tests for activation or VS Code API changes. Keep compiler semantics upstream; do not implement a competing type system in TypeScript or regular expressions.

Use an isolated branch. Preserve unrelated work. Add behavior-level tests for protocol, runtime, or editing changes; do not add tests that merely repeat implementation strings. Keep capabilities, manifest contributions, documentation, and fallback behavior consistent.

Release candidates are GitHub prereleases. The VSIX does not require a Marketplace token to build. Marketplace/Open VSX publication is a separate explicitly configured workflow. Never overwrite tags, publish a stable release, merge a branch, or change someone else's work as part of a candidate release.
