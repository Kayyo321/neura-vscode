import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toolEnvironment } from './configuration';
import { parseManifest, projectActions, projectArguments, ProjectAction, ProjectManifest, ProjectTarget } from './manifest';

/** A project manifest (neura.toml) in a workspace folder, with the targets it declares. */
export interface ProjectFile { folder: vscode.WorkspaceFolder; manifest: string; project: ProjectManifest; }
export interface ProjectTargetReference { folder: vscode.WorkspaceFolder; manifest: string; target: ProjectTarget; }

interface ProjectTaskDefinition extends vscode.TaskDefinition {
    type: 'neura-project'; action: ProjectAction; target: string; project?: string;
    port?: number; format?: string; updateLock?: boolean;
}

const EXCLUDED = '{**/node_modules/**,**/dist/**,**/.git/**,**/build/**,**/.neura-vscode/**}';

export async function findProjects(folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []): Promise<ProjectFile[]> {
    const found: ProjectFile[] = [];
    for (const folder of folders) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/neura.toml'), EXCLUDED, 50);
        for (const file of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
            try { found.push({ folder, manifest: file.fsPath, project: parseManifest(await fs.readFile(file.fsPath, 'utf8')) }); }
            catch { /* An unreadable manifest is reported by the SDK when it is built. */ }
        }
    }
    return found;
}

export function projectTask(executable: string, folder: vscode.WorkspaceFolder, definition: ProjectTaskDefinition, manifest: string): vscode.Task {
    const args = projectArguments(definition.action, manifest, definition.target,
        { port: definition.port, format: definition.format, updateLock: definition.updateLock });
    const label = `${definition.action === 'dev' ? 'Develop' : definition.action === 'package' ? 'Package' : 'Build'} ${definition.target}`;
    // A process execution keeps a live terminal: `neura dev` stops at the end of its input.
    const task = new vscode.Task(definition, folder, label, 'Neura project', new vscode.ProcessExecution(executable, args,
        { cwd: folder.uri.fsPath, env: { NEURA_NO_UPDATE_CHECK: '1', ...toolEnvironment(folder) } }),
    ['$neura-project', '$neura-project-detail']);
    if (definition.action === 'build') { task.group = vscode.TaskGroup.Build; }
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true,
        focus: definition.action === 'dev' };
    return task;
}

function manifestFor(folder: vscode.WorkspaceFolder, project: string | undefined): string {
    return path.resolve(folder.uri.fsPath, project || 'neura.toml');
}

export class ProjectTaskProvider implements vscode.TaskProvider {
    constructor(private readonly getExecutable: (folder: vscode.WorkspaceFolder) => Promise<string | undefined>) { }
    async provideTasks(): Promise<vscode.Task[]> {
        const tasks: vscode.Task[] = [];
        for (const { folder, manifest, project } of await findProjects()) {
            const executable = await this.getExecutable(folder); if (!executable) { continue; }
            const relative = path.relative(folder.uri.fsPath, manifest).split(path.sep).join('/');
            for (const target of project.targets) {
                for (const action of projectActions(target)) {
                    tasks.push(projectTask(executable, folder, { type: 'neura-project', action, target: target.name,
                        ...(relative === 'neura.toml' ? {} : { project: relative }) }, manifest));
                }
            }
        }
        return tasks;
    }
    async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
        if (!task.scope || typeof task.scope !== 'object') { return undefined; }
        const definition = task.definition as ProjectTaskDefinition;
        if (!['build', 'dev', 'package'].includes(definition.action) || typeof definition.target !== 'string') {
            throw new Error(`Unsupported Neura project task: ${JSON.stringify(definition)}`);
        }
        const executable = await this.getExecutable(task.scope); if (!executable) { return undefined; }
        return projectTask(executable, task.scope, definition, manifestFor(task.scope, definition.project));
    }
}

/** Pick a project target for an action, from an explicit tree item, the active file's project, or a list. */
export async function pickProjectTarget(action: ProjectAction, argument?: unknown): Promise<ProjectTargetReference | undefined> {
    const given = argument as { projectTarget?: ProjectTargetReference } | undefined;
    if (given?.projectTarget) { return given.projectTarget; }
    const projects = await findProjects();
    const choices = projects.flatMap(({ folder, manifest, project }) => project.targets
        .filter(target => projectActions(target).includes(action))
        .map(target => ({ label: target.name, description: target.kind,
            detail: `${project.name ?? path.basename(path.dirname(manifest))} · ${vscode.workspace.asRelativePath(manifest)}`,
            value: { folder, manifest, target } })));
    if (!choices.length) {
        void vscode.window.showInformationMessage(action === 'package'
            ? 'No server or desktop target was found in a neura.toml of this workspace.'
            : 'No neura.toml project was found in this workspace. Use Neura: Create Project to make one.');
        return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const near = active ? choices.filter(choice => active.startsWith(path.dirname(choice.value.manifest) + path.sep)) : [];
    const pool = near.length ? near : choices;
    if (pool.length === 1) { return pool[0]!.value; }
    return (await vscode.window.showQuickPick(pool, { title: `Neura: ${action} a project target` }))?.value;
}

export async function runProjectAction(executable: string, action: ProjectAction, reference: ProjectTargetReference, updateLock = false): Promise<void> {
    const relative = path.relative(reference.folder.uri.fsPath, reference.manifest).split(path.sep).join('/');
    let format: string | undefined;
    if (action === 'package' && reference.target.kind === 'desktop') {
        const picked = await vscode.window.showQuickPick([
            { label: 'Manifest formats', description: 'packaging.formats', value: undefined },
            { label: 'tar.gz', value: 'tar.gz' }, { label: 'deb', value: 'deb' }, { label: 'zip', value: 'zip' },
        ], { title: `Package ${reference.target.name}` });
        if (!picked) { return; }
        format = picked.value;
    }
    const definition: ProjectTaskDefinition = { type: 'neura-project', action, target: reference.target.name,
        ...(relative === 'neura.toml' ? {} : { project: relative }), ...(format ? { format } : {}),
        ...(updateLock ? { updateLock } : {}) };
    await vscode.tasks.executeTask(projectTask(executable, reference.folder, definition, reference.manifest));
}
