# Get started with Neura 0.3.0 in VS Code

Use **Neura for VS Code 0.3.0** with the **Neura 0.3.0 SDK**. The extension delegates hover, completion, diagnostics, formatting, tests and debugging to the toolchain you select, so install both.

## 1. Install the extension

1. Install [Visual Studio Code](https://code.visualstudio.com/) 1.100 or newer.
2. Install the extension: from the Marketplace or Open VSX when it is published there, or download **`neura-vscode-0.3.0.vsix`** from the [extension's releases](https://github.com/Kayyo321/neura-vscode/releases) and choose **Extensions → … → Install from VSIX…**. From a terminal: `code --install-extension neura-vscode-0.3.0.vsix`.
3. Run **Neura: Get Started** from the Command Palette.

On **Windows**, install WSL 2 with a distribution such as Ubuntu 24.04 and Microsoft's **WSL** extension, then run **Neura: Reopen in WSL** and install the extension there. Neura runs inside WSL; there is no native Windows toolchain. For SSH or a container, install the extension and the SDK on that host.

## 2. Install the Neura SDK

Run **Neura: Install Toolchain** and leave the version empty for the latest release, or enter `0.3.0`. It runs the official installer in a visible terminal and installs under your home directory without `sudo`. The equivalent command, on Linux, macOS, or inside WSL:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/Kayyo321/neura/releases/latest/download/install.sh | sh
```

The installer installs **Neura-sdk**, which is what the editor needs. Neura 0.3.0 also ships **Neura-runtime**, which only runs images. If the status bar shows **Neura 0.3.0 (no SDK)**, the selected installation is runtime-only: run `neura update --components sdk` (or reinstall with the command above) and then **Neura: Refresh Toolchain**.

The extension finds `neura` on `PATH`, in `~/.local/bin`, and in the install root (`~/.local/share/neura/current/bin`). It keeps the installed link rather than the generation it points at, so `neura update` moves the editor to the new generation at the next toolchain refresh. **Neura: Select Toolchain** picks another executable, such as a build tree's `bin/neura`.

Check the host in its own terminal:

```sh
neura --version            # neura 0.3.0 (...)
neura doctor
neura capabilities --json  # features lsp, debugger, formatter, tests ... true
```

Supported hosts are Linux x86-64 and arm64 with glibc 2.39 or newer, macOS 15 or newer on Apple silicon and Intel, and Windows 10 and 11 through WSL 2.

## 3. Create a project

**Neura: Create Project** offers the SDK's templates, which run `neura new <directory> --template <name>`:

- **Full-stack application** (`fullstack`): a web page, a server and a desktop shell over shared contracts.
- **Web application** (`web`), **Server application** (`server`) and **Desktop application** (`desktop`).

It also keeps the single-file starters (console application, library, test suite), configured with `neura.targets` in `.vscode/settings.json`.

A project is a `neura.toml` with packages and targets, and a `neura.lock` that the SDK writes. The **Projects and Targets** view lists every `neura.toml` in the workspace with its targets. Each target has inline actions:

| Action | Command | Runs |
| --- | --- | --- |
| Build | **Neura: Build Project Target** | `neura build --project <manifest> --target <name>` into `dist/<name>` |
| Develop | **Neura: Develop Project Target (neura dev)** | `neura dev`: builds into `dist/dev/<name>`, serves a web target on `127.0.0.1:4310` or runs a server or desktop target, and rebuilds on change. Stop it with the terminal's trash icon or Ctrl+C. |
| Package | **Neura: Package Project Target** | `neura package` for a server or desktop target; a desktop target asks for `tar.gz`, `deb` or `zip`. |
| Update lock | **Neura: Build Project Target and Update neura.lock** | `neura build --update-lock` after you change a dependency or component pin. |

**Build** and **Run** above the editor act on the project too: on a source file inside a project, Build builds the target whose package holds the file and Run starts `neura dev` for it, unless a `neura.targets` entry lists the file.

The same actions are tasks of type `neura-project` (**Terminal → Run Task**), so a `tasks.json` can name them:

```json
{
  "version": "2.0.0",
  "tasks": [
    { "type": "neura-project", "action": "build", "target": "web", "label": "Build web" },
    { "type": "neura-project", "action": "dev", "target": "server", "project": "apps/stock/neura.toml", "port": 0 }
  ]
}
```

Project diagnostics appear in **Problems**. With the [Even Better TOML](https://marketplace.visualstudio.com/items?itemName=tamasfe.even-better-toml) extension, `neura.toml` is validated and completed from the extension's schema: unknown keys, a capability a target kind cannot have, and malformed names and versions are marked as you type.

The language server checks a file in a project with the workspace folder as its import root. It does not yet apply a project's package boundaries: an import across packages that the `depends` lists forbid (`E1030`) is reported by `neura check` and `neura build --target`, not while you type.

## 4. Write Neura 0.3.0

Highlighting covers the 0.3.0 language: grouped and defaulted parameters, named arguments, `=> set` constructors, records and `new with(...)` copies, interface properties, `get.virtual`/`get.override` accessors and `let.override`, static requirements, `derive json.Codec<...>`, `let.extension`/`let.extensions`, `match.is`, `any`, `?.`, `??`, postfix `?`, `!==`, `..=`, string chains, `defer`, `using`, generators with `yield`, `return ... unless`, `nameof`, `typeof`, `not`, character literals, interpolated strings `$"{value:>4}"`, tag groups `#[Final, Since("0.3.0")]`, class hooks, `static scope`, and `html`/`css` forms with HTML and CSS inside. Snippets start with `nra-` (for example `nra-record`, `nra-iterator`, `nra-match-is`, `nra-html`).

Hover, completion, signature help, rename and formatting come from the SDK's language server: completion offers argument labels, a record's fields inside `new with(source) { }`, and members after `?.`; hover shows defaults, records and generator types.

## 5. Run, test and debug

Use **Run**, **Build** and **Debug** above the editor for single-file programs and `neura.targets`. The Testing view discovers exported `test_` functions. Set a breakpoint and start **Neura: Debug**: `neura debug --stdio` runs unoptimized NVM code, stops at breakpoints, steps, and shows locals, including the state of a suspended generator by its source names. Source locations have block granularity, so a breakpoint on a line that spans several blocks (an interpolated string, for example) can stop more than once.

## Troubleshooting

- **No language features:** the status bar names the toolchain. Run **Neura: Check Toolchain Health**, and look at **Neura: Show Output** for the language-server log.
- **`E1022 neura.lock is missing`:** run **Build Project Target and Update neura.lock** once, then commit `neura.lock`.
- **`neura dev` port busy:** set `"port": 0` in the task to let the system choose one.
