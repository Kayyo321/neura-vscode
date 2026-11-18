# Neura for Visual Studio Code

The Neura development environment: install the toolchain, write and navigate `.nra` programs, build and run applications, execute individual tests, and debug the Neura Virtual Machine.

Version 0.3.0 of the extension works with the **Neura 0.3.0 SDK**: its language, its language server and debugger, and its `neura.toml` projects. Follow [Get started with Neura 0.3.0](docs/GETTING-STARTED.md) to install both and try them.

## Install

Install the extension, or its VSIX from this repository's releases with **Extensions → Install from VSIX**. Open the Neura walkthrough with **Neura: Get Started**.

Choose **Neura: Install Toolchain** or **Neura: Select Toolchain**. Installation uses the official installer in a visible terminal and requires an explicit action. The extension never changes your theme or downloads a compiler merely because a source file opens.

The language services, testing, and debugger come from the **Neura-sdk** product. A **Neura-runtime** installation, which only runs images, is reported in the status bar as having no SDK, with the command that adds it. Older toolchains retain syntax, themes, build/run, and saved-file diagnostics. The extension checks actual capabilities instead of assuming that a version number implies a feature.

Supported workspace hosts are Linux x86-64/arm64 with glibc 2.39 or newer, macOS 15 or newer on Intel/Apple silicon, and Windows through Remote WSL2 with a compatible Linux distribution. SSH and containers run tools on the remote host. Native Windows execution is not supported.

## Daily development

- **Run, Build, Debug:** editor buttons, Explorer actions, entry-point CodeLens, standard VS Code tasks, and integrated terminals. Running builds first and stops on compilation failure.
- **Language intelligence:** compiler-backed diagnostics, suggestions, hover, completion, signature help, semantic highlighting, symbols, definitions, references, rename, call/type hierarchy, and configurable hints.
- **Refactoring:** compiler-validated transformations where their preconditions hold. Unsafe transformations are omitted rather than offered as text substitutions.
- **Formatting:** comment-preserving, idempotent formatting through the same `neura fmt` implementation as the CLI. Format-on-save follows VS Code settings.
- **Testing:** native Test Explorer, exact selected tests, cancellation, failure links, schedule exploration, virtual time, and saved-schedule reproduction. Tests follow Neura's exported `test_` function convention, not a reserved `#Test` tag.
- **Debugging:** NVM source launch and selected tests, breakpoints, stepping, frames, typed values, object/collection inspection, tasks, traps, conditions, logpoints, and read-only watches. **Neura: Send Program Input** and **Close Program Input** handle interactive input.
- **Documentation:** `///` continuation, Doxygen-aware highlighting, safe offline previews, parameter/return documentation generation and updates, and Doxygen export.
- **Inspection:** typed IR, optimized/unoptimized comparisons, disassembly, decompilation, execution profiles, record/replay, and task traces.

Syntax and themes remain usable without Neura installed. Execution and workspace-controlled tooling require Workspace Trust.

## Projects and targets

Neura 0.3.0 projects are described by `neura.toml` and locked by `neura.lock`. **Neura: Create Project** runs `neura new` with the SDK's `fullstack`, `web`, `server` and `desktop` templates. The **Projects and Targets** view lists each manifest's targets with **Build** (`neura build --project <manifest> --target <name>`), **Develop** (`neura dev`) and, for server and desktop targets, **Package** (`neura package`) actions; they are also `neura-project` tasks for `tasks.json`. Diagnostics from project builds appear in Problems. A `neura.toml` schema is contributed to Even Better TOML. See [Get started](docs/GETTING-STARTED.md#3-create-a-project).

For single-file programs, **Create Project** also offers a console, library, test, or multi-module starter, and editor targets are configured in `.vscode/settings.json`:

```json
{
  "neura.sourceRoots": ["src"],
  "neura.targets": [
    {
      "name": "application",
      "kind": "application",
      "inputs": ["src/main.nra"],
      "args": ["an argument with spaces"],
      "cwd": "."
    }
  ],
  "neura.testing.include": ["tests/**/*.nra"]
}
```

Targets support source roots, outputs, working directory, environment, and structured compiler/runtime arguments. Application builds produce `.nvr`; library builds produce binary `.nir`. Inspect binary artifacts using Neura commands rather than a text editor. Native executable targets are offered on supported Linux x86-64 toolchains.

Build-on-save, restart-on-change, test watch, schedule exploration, and virtual time are opt-in. Ordinary Run always rebuilds; **Run Existing Artifact** is explicit.

## Color and accessibility

Choose **Neura Dark**, **Neura Light**, or their **Vivid** variants. Pink/blue accents follow the Neura website with brighter source colors for comfortable contrast. Themes distinguish generics, parameters, mutable/assign-once bindings, classes/interfaces/enums, tags, constructors/destructors, storage, accessors, and documentation. Every semantic category is customizable and falls back to standard VS Code token types.

The grammar covers the Neura 0.3.0 language, including records, generators, `match.is`, optional access, interpolated strings, tag groups, and `html`/`css` forms with embedded HTML and CSS. See [the semantic token gallery](examples/token-gallery.nra) and [highlighting guide](docs/highlighting.md). Normal source-text colors are tested for 4.5:1 contrast. Existing themes and fonts remain selected unless you change them.

## Tooling commands and limitations

The toolchain exposes `lsp --stdio`, `debug --stdio`, `fmt`, `capabilities --json`, structured test discovery/reporting, and read-only image inspection. Protocols have versioned contracts and do not mix program output with messages.

Source debugging uses unoptimized CPU execution with JIT disabled. Source locations inherit NVM block granularity; watches cannot execute functions or getters. Native/optimized attach and reverse debugging are not supported. Coverage, where available, reports actual mapped-block line execution and does not claim branch coverage.

See [architecture](docs/architecture.md), [testing](docs/testing.md), and [contributing](CONTRIBUTING.md).

## Build from source

```sh
npm ci
npm run compile
npm test
npm run package
```

Press F5 to start an Extension Development Host. `npm run test:integration` runs an actual VS Code host; Linux CI uses Xvfb. Set `NEURA_TEST_EXECUTABLE` to a Neura 0.3.0 SDK's `neura` when running real-toolchain editor checks. `npm run smoke:grammar -- <directory>...` tokenizes every `.nra` file under the given directories and reports grammar states that leak past a line or a declaration.

Licensed under Apache-2.0, matching Neura.
