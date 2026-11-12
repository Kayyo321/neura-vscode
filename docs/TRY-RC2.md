# Install and try RC2

Use **Neura VS Code 0.1.1-rc.2** with **Neura 0.2.1-rc.2**. The extension's installed version is `0.1.1`; its GitHub release is marked as a prerelease.

RC2 repairs the RC1 outline and formatting errors, renders Doxygen prose in hovers, and adds completion for `let.` modifiers, eligible inherited overrides, standard-library import paths, and promoted exports. Automatic declaration semicolons are enabled by default; `neura.editing.autoSemicolon` turns them off. An inline type such as `let value: class (...) = new;` keeps its closing parenthesis without an inserted semicolon.

Install both updates: the extension delegates hover, completion, symbols, and formatting to the selected compiler. Installing only this VSIX while keeping rc.1 leaves those server bugs in place.

## 1. Install the extension

1. Install [Visual Studio Code](https://code.visualstudio.com/) 1.100 or newer.
2. Open the [extension's RC2 release](https://github.com/Kayyo321/neura-vscode/releases/tag/v0.1.1-rc.2) and download **`neura-vscode-0.1.1.vsix`** from **Assets**.
3. In VS Code, open **Extensions**, select the **…** menu, choose **Install from VSIX…**, and select that file. Reload if prompted.
4. Open the Command Palette with **Ctrl+Shift+P** on Linux/Windows or **Cmd+Shift+P** on macOS. Run **Neura: Get Started**.

You can also install the downloaded file from a terminal:

```sh
code --install-extension neura-vscode-0.1.1.vsix
```

On **Windows**, install WSL2 with a compatible distribution such as **Ubuntu 24.04**, install Microsoft's **WSL** VS Code extension, then run **Neura: Reopen in WSL**. Install the Neura VSIX in that WSL window; use **Install in WSL** if VS Code offers it. The compiler runs inside WSL, not in Windows PowerShell. For SSH or a development container, install the extension and compiler on that workspace host.

## 2. Install the compiler candidate

Run **Neura: Install Toolchain**. When asked for a version, enter:

```text
0.2.1-rc.2
```

Leaving the field empty selects the latest **stable** release, which may not include these editor services. The installer runs in a visible terminal and installs under your home directory without `sudo`.

The equivalent terminal command on Linux, macOS, or inside WSL is:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/Kayyo321/neura/releases/download/v0.2.1-rc.2/install.sh \
  | sh -s -- --version 0.2.1-rc.2
```

Follow the installer's `PATH` instructions if needed, then open a new terminal. Run **Neura: Refresh Toolchain**, or **Neura: Select Toolchain** and select the installed executable, normally `~/.local/bin/neura`.

Check the result in the same host's terminal:

```sh
neura --version
neura doctor
neura capabilities --json
```

The version should be `0.2.1-rc.2`. The capability response should advertise language-server, debugger, formatter, test-discovery/reporting, coverage, and image-inspection support. **Neura: Check Toolchain Health** runs the doctor check in VS Code. Optional C-import dependencies can produce warnings without preventing the examples below from working.

Prebuilt compiler archives support Linux x86-64/arm64 with **glibc 2.39+** and macOS Intel/Apple silicon with **macOS 15+**. Windows uses the compatible Linux archive inside WSL2. There is no native Windows executable. The installer selects the archive for the host automatically; the [compiler RC2 assets](https://github.com/Kayyo321/neura/releases/tag/v0.2.1-rc.2) also provide manual downloads and checksums.

### Updates that include prereleases

Once you have a compiler that supports `--nightly`:

```sh
neura update --check --nightly
neura update --nightly
```

The first command only checks; exit status **4** means an update is available. The second installs the newest eligible release, including published prereleases such as RCs. Ordinary `neura update` continues to use stable releases. `--nightly` opts into prerelease selection; it does not build an untagged branch.

An older installed compiler may reject the new flag. Use the pinned RC2 installer above for that first upgrade. Updates manage installations made by Neura's installer; a source build or package-managed installation must use its own installation method. The extension's existing **Check for Updates** and **Update Toolchain** commands use the default stable channel; use the integrated terminal for `--nightly`.

## 3. Create a playground

Run **Neura: Create Project**, choose **Console application**, choose a parent folder, and name it `hello-neura`. The extension opens the new folder and creates:

```text
src/main.nra
tests/example-tests.nra
.vscode/settings.json
```

Trust this folder when VS Code asks, since you created it and will execute its code. Restricted Mode still provides syntax colors and themes; compiler processes and execution require trust.

Open `src/main.nra`. Click **Run** above `main`, or the editor's play button. You should see **Hello, Neura!** in the integrated terminal. Click **Build** to produce `.neura-vscode/hello-neura.nvr`. The Neura Activity Bar icon shows **Projects and Targets** and **Artifacts**.

To make navigation and debugging more interesting, replace `src/main.nra` with:

```neura
let console = import:Std.Io.Console;
let program = import:Std.Program;

/// @brief Double an integer.
/// @param value The input value.
/// @return Twice the input.
let double = func(value: int) -> int {
    return value * 2;
};

let App = module:program.Entry (
    export let.override main = func(args: string[]) -> program.ExitCode {
        let answer = double(21);
        console.println("Answer: {}", answer);
        return program.ExitCode.Ok;
    };
);
```

Run it again. The expected output is **Answer: 42**.

## 4. Try editing and documentation

| Feature | Try it | Expected result |
| --- | --- | --- |
| Completion | Type `console.` or invoke **Trigger Suggest** in the function body. | Compiler-backed members and signatures. |
| Hover and signature help | Hover `double`; type a call to it and invoke **Trigger Parameter Hints**. | Types, Doxygen text, and the active parameter. |
| Definition and references | Use **Go to Definition** on the call to `double`, then **Find All References** on its declaration. | Navigation between the declaration and call. |
| Rename | Use **Rename Symbol** on `double` and enter `twice`. | Validated edits update its references. Undo to keep the rest of this guide unchanged. |
| Symbols and hierarchy | Open **Go to Symbol in Editor…**, **Show Call Hierarchy**, or **Show Type Hierarchy** on a suitable symbol. | Source symbols, callers/callees, or class/interface relationships. |
| Live diagnostics | Change `double(21)` to `double("oops")` without saving. | An error appears in the editor and Problems view. Undo the error. |
| Error explanations | Open the diagnostic's available quick fixes, or run **Neura: Explain Diagnostic** and enter its displayed code. | An explanation of that compiler diagnostic. |
| Formatting | Change indentation, then run **Format Document** and choose Neura if asked. | Token-preserving layout; comments remain attached. |
| Documentation | Put the cursor on `double` and run **Neura: Generate or Update Documentation**, then **Neura: Preview Documentation**. | Parameter/return documentation and an offline preview. |
| Doxygen export | Run **Neura: Export Doxygen Declarations**. | Generated declarations open in a new view. |
| Snippets | Type `nra-func`, `nra-class`, or `nra-module` in a suitable location and choose the Neura snippet. | Editable snippet placeholders. Undo the insertion afterward. |

Use **Refactor…** or **Quick Fix…** on a valid selection to explore expression extraction, single-use literal inlining, getter/setter generation, constructors, missing interface members, missing enum-match arms, and import organization. Available actions depend on the selected code and compiler validation; every action is not available at every cursor position. For example, select `value * 2` in `double` and look for extraction actions.

Settings such as `neura.inlayHints.types`, `parameterNames`, `accessors`, and `captures` control the compiler's hints. For format-on-save, add `"editor.formatOnSave": true` to your workspace settings and select Neura as the formatter for `.nra` files.

## 5. Try the colors

Run **Preferences: Color Theme** and select **Neura Dark**, **Neura Light**, or either **Vivid** variant. Run **Preferences: File Icon Theme** and select **Neura Artifacts** if desired.

Open the [semantic color gallery](../examples/token-gallery.nra) to see generics, interfaces, enums, constructors, getters, setters, backing storage, accessor reads/writes, references, tags, and Doxygen roles in context. For a runnable version in the playground, replace `src/main.nra` with that file's contents, then Run. Keep its source in the configured target so the language server and build examine the same program.

Use **Developer: Inspect Editor Tokens and Scopes** to inspect a particular token. Semantic colors require the candidate language server; TextMate syntax colors also work without a compiler. See [highlighting customization](highlighting.md) for per-category color rules. The extension does not change your selected theme automatically.

## 6. Run, fail, debug, and cover tests

1. Open the **Testing** view and run **Neura: Refresh Tests**. Expand the workspace, `tests/example-tests.nra`, and `ExampleTests`.
2. Click Run beside **test_addition**. Exactly that selected test runs and should pass.
3. Change its assertion from `test.assert_equal_int32(2, 1 + 1)` to `test.assert_equal_int32(3, 1 + 1)`. Run again and inspect the failure output and source link. Restore `2` and rerun.
4. Right-click the test and choose **Debug Test**. Set a breakpoint on the assertion to inspect the test's execution.
5. Choose the **Coverage (mapped source lines)** test profile using VS Code's test coverage actions. Inspect file totals and the coverage overlay. These are actual mapped-block line hits, not branch-coverage measurements.
6. Enable `"neura.testing.watch": true`, run the test, then change and save that test file. Affected previously run tests rerun. Turn watch off when finished.

Discovery uses exported, non-generic, zero-argument `void` functions named `test_…`, as in the generated file. The default include patterns look for test filenames and `tests` folders. **Neura: Run File Tests** runs the active test file.

For concurrency tests, set `neura.testing.schedules` above `1` and choose a `neura.testing.scheduleSeed`. `neura.testing.virtualTime` enables a separate virtual clock for each test. After a failure with a saved schedule, **Neura: Reproduce Failing Schedule** selects and reruns it. A simple arithmetic test may have no interesting schedule to reproduce. Use the Testing view's Stop control to cancel a run.

## 7. Debug an application

Return to the small `double` example from step 3 and save it. Click the gutter beside `console.println`, then run **Neura: Debug** or the editor's debug button. The default launch stops on entry; Continue to your breakpoint.

- Expand **Variables** and inspect `answer` and the arguments.
- To enter `double`, restart the session with a breakpoint on `let answer = double(21);`, Continue to it, then Step Into. Use Step Over to execute a statement and Step Out to return.
- Add `answer` to **Watch** once it is initialized. Watch expressions are read-only; they cannot call functions or getters.
- Right-click a breakpoint to try a condition such as `answer == 42`, a hit count, or a log message.
- Inspect **Call Stack** and available task/frame data. A deliberate failing test is also a useful way to inspect a trap.
- For a program that reads input, use **Neura: Send Program Input** and **Neura: Close Program Input**.

For a saved launch configuration, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "neura",
      "request": "launch",
      "name": "Debug Neura",
      "program": "${workspaceFolder}/src/main.nra",
      "cwd": "${workspaceFolder}",
      "sourceRoots": ["${workspaceFolder}/src"],
      "stopOnEntry": true,
      "args": []
    }
  ]
}
```

RC2 source debugging uses unoptimized CPU execution with JIT disabled. Source stops inherit NVM mapping granularity, and frame metadata does not promise exact lexical lifetimes. Native/optimized attach and reverse debugging are not available. If you edit source during a session, restart to debug the new version; the debugger protects against showing stale source as current.

## 8. Explore artifacts, circuits, and execution

Keep the application target selected with **Neura: Select Target**. These execution tools build that target first.

| Command | What to inspect |
| --- | --- |
| **Neura: Show Typed IR** | Compiler IR in a generated, highlighted document. |
| **Neura: Compare Optimized IR** | Side-by-side unoptimized and optimized IR. |
| **Neura: Inspect Artifact** | Select the built `.nvr` for disassembly; a library `.nir` opens as IR. |
| **Neura: Decompile Image** | Recovered structure from the selected `.nvr`. |
| **Neura: Explore Circuit** | Build/select an `.nvr`, choose graphs, inspect neuron/wire data, and follow available source links. |
| **Neura: Profile Execution** | Runtime statistics and per-function cost in a terminal. |
| **Neura: Show Execution Cost** | A profile view with function costs and available source navigation. |
| **Neura: Record Execution** | Save a host-interaction trace, normally `execution.trace`. |
| **Neura: Replay Execution** | Select that trace and rerun the same program with recorded host responses. Keep the source and runtime options consistent. |
| **Neura: Record Task Trace** | Save scheduler events, normally `tasks.jsonl`. |
| **Neura: Open Task Timeline** | Open that scheduler JSONL, inspect task lifetimes, and filter by task/event. |
| **Neura: Show Tag Catalogue** | Compiler-supported tags and descriptions. |

For a useful task timeline, use the color gallery, which spawns a task, or one of Neura's concurrency examples. A record/replay `.trace` and a scheduler `.jsonl` are different formats; choose the matching viewer. Execution cost is the runner's measured function/step data, not a CPU sampling profiler.

The **Artifacts** view finds `.nvr` and `.nir` files in the workspace. Binary `.nir` is a compiled library format; the readable IR views use `.ir`.

## 9. Configure targets and automation

The generated `.vscode/settings.json` already has an application target. Use **Neura: Select Target** to switch when you add more. Targets support `kind` (`application`, `library`, `native`), `inputs`, `sourceRoots`, `output`, `cwd`, `args`, `env`, `buildArgs`, and `runArgs`; see the [README example](../README.md#projects-and-targets). Native executable targets require a supported Linux x86-64 toolchain.

Try **Neura: Clean Build Artifacts**, **Neura: Rebuild**, **Neura: Check Source**, and **Tasks: Run Task** for standard task integration. **Neura: Run Existing Artifact** explicitly runs an existing build. Ordinary **Run** builds first.

Opt in to `neura.build.onSave` or `neura.run.restartOnChange` if wanted. Restart-on-change restarts an already running selected target. Keep these disabled while initially learning the debugger. For multiple projects, add folders with **File: Add Folder to Workspace…**; each folder has its own targets and toolchain settings.

## If a feature is missing

1. Check that you installed the VSIX on the same workspace host as the compiler, trusted the folder, and opened a saved `.nra` file inside that folder.
2. Run **Neura: Select Toolchain**, **Neura: Refresh Toolchain**, and **Neura: Check Toolchain Health**. Confirm the candidate version and capabilities in the terminal.
3. Run **Neura: Restart Language Server**, then **Neura: Show Output**. Look for the language-server ready message or the reason startup was skipped.
4. Run **Neura: Refresh Tests** if test discovery is stale. Check `neura.testing.include` and the exported `test_` convention.
5. For a report, run **Neura: Export Diagnostic Report** and include the relevant Neura output/error in a [GitHub issue](https://github.com/Kayyo321/neura-vscode/issues). **Neura: Copy Source Fingerprint** can identify a source revision without copying the source itself.

Older toolchains keep syntax, themes, build/run, and saved-file diagnostics, but do not supply the candidate's complete language services, test protocol, or debugger.
