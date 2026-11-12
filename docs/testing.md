# Verification

`npm test` covers real TextMate/Oniguruma tokenization, semantic-color contrast, documentation rendering and URL safety, configuration, Unicode coordinate conversion, process arguments, cancellation/timeouts, and protocol framing.

`npm run test:integration` starts a real VS Code Extension Development Host and checks activation, registered workflows, language documents, and contributed settings. On headless Linux run it under `xvfb-run -a`. CI runs on Linux, macOS, and Windows; actual Windows execution uses WSL, not a native Neura binary.

The companion Neura repository contains real LSP, DAP, formatter, test reporter, and coverage integration tests. Run them against a newly built compiler, not mocks. Existing language, compiler, VM, deterministic execution, and documentation suites must continue to pass.

Before publishing, create and install the VSIX, build and run Hello World, run exactly one discovered test, reproduce a saved schedule, and verify a breakpoint with locals. macOS arm64/Intel and WSL release qualification must be recorded separately from the Linux development run.

## Testing semantics

Test discovery is semantic and never initializes modules or links/runs native code. Eligible exported, non-generic, zero-argument `void` functions have `test_` names inside eligible modules of explicitly selected files. Imported files do not become test inputs implicitly. Each selected test gets fresh state.

The elapsed-time setting bounds extension-managed runs, including blocked real I/O. Neura's step limit bounds computation; it cannot replace an elapsed-time limit. Virtual time removes real timer waits but does not virtualize network peers.
