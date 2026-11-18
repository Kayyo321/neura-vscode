import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { configuration, configuredTargets, resolvePath, ResolvedTarget } from './configuration';
import { findProjects, ProjectTargetReference } from './projectTasks';
import { projectTemplates, validProjectName } from './manifest';

class ProjectItem extends vscode.TreeItem {
    projectTarget?: ProjectTargetReference;
    constructor(label: string, public readonly children: ProjectItem[] = []) {
        super(label, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    }
}

export class Projects implements vscode.TreeDataProvider<ProjectItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<ProjectItem | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly registration: vscode.Disposable;
    constructor() { this.registration = vscode.window.registerTreeDataProvider('neura.projects', this); }
    refresh(): void { this.changed.fire(undefined); }
    dispose(): void { this.registration.dispose(); this.changed.dispose(); }
    getTreeItem(item: ProjectItem): vscode.TreeItem { return item; }
    async getChildren(item?: ProjectItem): Promise<ProjectItem[]> {
        if (item) { return item.children; }
        const manifests = vscode.workspace.isTrusted ? await findProjects() : [];
        const sdkProjects = manifests.map(({ folder, manifest, project }) => {
            const targets = project.targets.map(target => {
                const entry = new ProjectItem(target.name); entry.description = target.kind || 'target';
                entry.iconPath = new vscode.ThemeIcon(target.kind === 'web' ? 'globe' : target.kind === 'server' ? 'server' : target.kind === 'desktop' ? 'window' : 'symbol-event');
                entry.contextValue = target.kind === 'web' ? 'neuraProjectTarget' : 'neuraProjectTargetPackageable';
                entry.projectTarget = { folder, manifest, target };
                entry.tooltip = `${target.name} (${target.kind}${target.package ? `, package ${target.package}` : ''}) in ${vscode.workspace.asRelativePath(manifest)}`;
                return entry;
            });
            const node = new ProjectItem(project.name ?? path.basename(path.dirname(manifest)), targets);
            node.description = vscode.workspace.asRelativePath(manifest); node.iconPath = new vscode.ThemeIcon('package');
            node.resourceUri = vscode.Uri.file(manifest);
            node.command = { command: 'vscode.open', title: 'Open Manifest', arguments: [node.resourceUri] };
            node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded; return node;
        });
        return [...sdkProjects, ...(vscode.workspace.workspaceFolders ?? []).map(folder => {
            const roots = configuration(folder).get<string[]>('sourceRoots', ['.']).map(root => {
                const uri = vscode.Uri.file(resolvePath(root, folder));
                const entry = new ProjectItem(root); entry.resourceUri = uri; entry.iconPath = new vscode.ThemeIcon('folder');
                entry.command = { command: 'revealInExplorer', title: 'Reveal Source Root', arguments: [uri] }; return entry;
            });
            let targets: ProjectItem[];
            try { targets = configuredTargets(folder).map(target => targetItem(target)); }
            catch (error) { targets = [new ProjectItem(String(error))]; }
            const project = new ProjectItem(folder.name, [new ProjectItem('Source Roots', roots), new ProjectItem('Targets', targets)]);
            project.iconPath = new vscode.ThemeIcon('project'); project.contextValue = 'neuraProject'; return project;
        })];
    }
}

function targetItem(target: ResolvedTarget): ProjectItem {
    const sources = target.inputs.map(input => {
        const item = new ProjectItem(path.relative(target.folder.uri.fsPath, input)); item.resourceUri = vscode.Uri.file(input);
        item.command = { command: 'vscode.open', title: 'Open Source', arguments: [item.resourceUri] }; return item;
    });
    const artifact = new ProjectItem(path.relative(target.folder.uri.fsPath, target.output)); artifact.resourceUri = vscode.Uri.file(target.output);
    artifact.iconPath = new vscode.ThemeIcon('package');
    artifact.command = { command: 'revealInExplorer', title: 'Reveal Artifact', arguments: [artifact.resourceUri] };
    const item = new ProjectItem(target.name, [...sources, artifact]);
    item.description = target.kind; item.iconPath = new vscode.ThemeIcon(target.kind === 'library' ? 'library' : 'play');
    item.contextValue = 'neuraTarget'; return item;
}

const application = `let console = import:Std.Io.Console;
let program = import:Std.Program;

/// The application entry point.
let App = module:program.Entry (
    export let.override main = func(args: string[]) -> program.ExitCode {
        console.print_line("Hello, Neura!");
        return program.ExitCode.Ok;
    };
);
`;

const library = `/// Small reusable arithmetic helpers.
let Arithmetic = module (
    /// Add two integers.
    /// @param left The first value.
    /// @param right The second value.
    /// @return The sum.
    export let add = func(left: int32, right: int32) -> int32 {
        return left + right;
    };
);
`;

const tests = `let test = import:Std.Test;

let ExampleTests = module (
    export let test_addition = func() -> void {
        test.assert_equal_int32(2, 1 + 1);
    };
);
`;

/** Runs `neura new <directory> --template <id> [--name <name>]` and reports whether it succeeded. */
export type NewProjectTool = (directory: string, template: string, name: string | undefined) => Promise<{ code: number; message: string }>;

export async function createProject(newProject?: NewProjectTool): Promise<void> {
    if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('Trust this workspace before creating a Neura project.'); return; }
    const sdkTemplates = newProject ? projectTemplates.map(template => ({ label: template.label, detail: `${template.detail} (neura new --template ${template.id})`,
        templateId: `sdk:${template.id}` })) : [];
    const template = await vscode.window.showQuickPick([
        ...(sdkTemplates.length ? [{ label: 'neura.toml projects', kind: vscode.QuickPickItemKind.Separator, templateId: '' }] : []),
        ...sdkTemplates,
        ...(sdkTemplates.length ? [{ label: 'Single-file programs', kind: vscode.QuickPickItemKind.Separator, templateId: '' }] : []),
        { label: 'Console application', templateId: 'application' },
        { label: 'Library', templateId: 'library' },
        { label: 'Test suite', templateId: 'tests' },
        { label: 'Application with a reusable module', templateId: 'multi' },
    ], { title: 'New Neura Project' });
    if (!template || !template.templateId) { return; }
    if (template.templateId.startsWith('sdk:') && newProject) {
        const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'Choose the parent directory for the new project' });
        if (!parents?.[0]) { return; }
        const name = await vscode.window.showInputBox({ title: 'Project name', value: 'hello-neura',
            prompt: 'The directory and the project name: lowercase letters, digits and hyphens.',
            validateInput: value => validProjectName(value) ? undefined : 'Use lowercase letters, digits and hyphens.' });
        if (!name) { return; }
        const directory = path.join(parents[0].fsPath, name);
        const result = await newProject(directory, template.templateId.slice(4), name);
        if (result.code !== 0) { void vscode.window.showErrorMessage(`neura new: ${result.message.trim() || `exit status ${result.code}`}`); return; }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), { forceNewWindow: true });
        return;
    }
    const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: 'Choose the parent directory for the new project' });
    if (!parents?.[0]) { return; }
    const name = await vscode.window.showInputBox({ title: 'Project directory name', value: 'hello-neura',
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..' ? undefined : 'Use letters, digits, periods, hyphens, or underscores.' });
    if (!name) { return; }
    const directory = path.join(parents[0].fsPath, name);
    try { await fs.mkdir(directory); }
    catch (error) { void vscode.window.showErrorMessage(`Cannot create project directory: ${String(error)}`); return; }
    const sourceFile = template.templateId === 'library' ? 'src/arithmetic.nra' : template.templateId === 'tests' ? 'tests/example-tests.nra' : 'src/main.nra';
    const source = template.templateId === 'library' ? library : template.templateId === 'tests' ? tests : application;
    const files: Record<string, string> = {
        [sourceFile]: source,
        '.gitignore': '.neura-vscode/\n',
        '.vscode/settings.json': JSON.stringify({ 'neura.sourceRoots': ['src'], 'neura.testing.include': ['**/tests/**/*.nra'],
            'neura.targets': template.templateId === 'tests' ? [] : [{ name, kind: template.templateId === 'library' ? 'library' : 'application', inputs: [sourceFile] }] }, null, 4) + '\n',
        'README.md': `# ${name}\n\nOpen this folder in VS Code with the Neura extension. Use the Neura walkthrough to install the toolchain, then build, run, or test.\n`,
    };
    if (template.templateId !== 'tests') { files['tests/example-tests.nra'] = tests; }
    if (template.templateId === 'multi') {
        files['src/arithmetic.nra'] = library;
        files[sourceFile] = application.replace('let program =', 'let arithmetic = import:Arithmetic;\nlet program =')
            .replace('console.print_line("Hello, Neura!");', 'console.println("2 + 3 = {}", arithmetic.add(2, 3));');
    }
    try {
        for (const [filename, contents] of Object.entries(files)) {
            const destination = path.join(directory, filename); await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, contents, { flag: 'wx' });
        }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), { forceNewWindow: true });
    } catch (error) { void vscode.window.showErrorMessage(`Project creation stopped: ${String(error)}. Existing files were not overwritten.`); }
}
