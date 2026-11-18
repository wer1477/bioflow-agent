import fs from 'node:fs';
import path from 'node:path';
import { currentWorkspaceRoot, sessionsRoot, trashRoot } from '../../paths.js';
import { listRecords, moveSessionToProject } from './conversation_file_store.js';
import { projectKey, validateProjectName } from './project_key.js';
import { reconcileProjects, removeProject, upsertProject, type ProjectRecord, type ProjectRename } from './project_registry.js';
import { isPathSegment } from './path_segments.js';
import { getConversation } from './conversation_service.js';
import type { Conversation } from './conversation_types.js';
import type { AgentRunStatus } from './run_store.js';

const ACTIVE_RUN_STATUSES: AgentRunStatus[] = ['queued', 'building_context', 'model_turn', 'tool_execution', 'waiting_user_input', 'compacting'];

export interface ProjectSummary {
  key: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  runningCount: number;
  lastActivityAt: string | null;
}

export interface OrphanSessionSummary {
  id: string;
  title: string;
  projectPath: string | null;
  updatedAt: string;
}

export interface TrashEntry {
  name: string;
  path: string;
  deletedAt: string;
}

export interface ProjectList {
  projects: ProjectSummary[];
  orphans: OrphanSessionSummary[];
}

/**
 * Lists projects by reconciling the filesystem with the cache, then joining the
 * session store. Membership is recomputed on every call: sessions are never
 * "attached" once and forgotten, so a directory the user renames or deletes
 * outside the UI cannot silently strand them.
 */
export function listProjects(): ProjectList {
  const { projects: records, renames } = reconcileProjects();
  for (const rename of renames) applyRename(rename);

  const byPath = new Map(records.map((record) => [record.path, record]));
  const summaries = new Map<string, ProjectSummary>();
  for (const record of records) {
    summaries.set(record.path, {
      key: record.key,
      title: record.title,
      path: record.path,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sessionCount: 0,
      runningCount: 0,
      lastActivityAt: null,
    });
  }

  const orphans: OrphanSessionSummary[] = [];
  for (const record of listRecords()) {
    const conversation = record.conversation;
    // Delegated children belong to their parent conversation, so they neither count
    // towards a project's sessions nor appear as a session the user could adopt.
    if (conversation.parentConversationId) continue;
    const summary = conversation.projectPath ? summaries.get(conversation.projectPath) : undefined;
    if (!summary) {
      orphans.push({
        id: conversation.id,
        title: conversation.title,
        projectPath: conversation.projectPath,
        updatedAt: conversation.updatedAt,
      });
      continue;
    }
    summary.sessionCount += 1;
    if (record.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) summary.runningCount += 1;
    if (!summary.lastActivityAt || conversation.updatedAt > summary.lastActivityAt) summary.lastActivityAt = conversation.updatedAt;
  }

  return { projects: [...summaries.values()].sort((a, b) => a.title.localeCompare(b.title)), orphans: orphans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

export function findProject(key: string): ProjectRecord | undefined {
  const { projects } = reconcileProjects();
  return projects.find((project) => project.key === key);
}

export function requireProject(key: string): ProjectRecord {
  const project = findProject(key);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

export class ProjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Project "${key}" was not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConflictError';
  }
}

/** Invalid input (400), as opposed to a state conflict (409). */
export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

/** Creates an *empty* project directory. No preset layout is ever written. */
export function createProject(name: unknown): ProjectSummary {
  const validation = validateProjectName(name);
  if (!validation.ok) throw new ProjectValidationError(validation.reason);
  const target = path.join(currentWorkspaceRoot(), validation.value);
  if (fs.existsSync(target)) throw new ProjectConflictError(`A directory named "${validation.value}" already exists.`);
  fs.mkdirSync(target, { recursive: true });
  const stat = fs.statSync(target);
  const now = new Date().toISOString();
  const record: ProjectRecord = {
    key: projectKey(validation.value),
    path: fs.realpathSync(target),
    title: validation.value,
    dev: stat.dev,
    ino: stat.ino,
    createdAt: now,
    updatedAt: now,
  };
  upsertProject(record);
  return toSummary(record);
}

/** Renaming a project renames its directory and follows its sessions. */
export function renameProject(key: string, title: unknown): ProjectSummary {
  const project = requireProject(key);
  const validation = validateProjectName(title);
  if (!validation.ok) throw new ProjectValidationError(validation.reason);
  if (validation.value === project.title) return toSummary(project);
  const target = path.join(currentWorkspaceRoot(), validation.value);
  if (fs.existsSync(target)) throw new ProjectConflictError(`A directory named "${validation.value}" already exists.`);

  fs.renameSync(project.path, target);
  const stat = fs.statSync(target);
  const realPath = fs.realpathSync(target);
  const updated: ProjectRecord = { ...project, key: projectKey(validation.value), path: realPath, title: validation.value, dev: stat.dev, ino: stat.ino, updatedAt: new Date().toISOString() };
  for (const sessionId of sessionIdsUnderKey(project.key)) {
    try {
      moveSessionToProject(sessionId, realPath);
    } catch (error) {
      console.warn(`Unable to follow session ${sessionId} across the project rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  removeProject(project.key);
  upsertProject(updated);
  return toSummary(updated);
}

/** Moves the project directory to `.trash`; data is never destroyed. */
export function trashProject(key: string): { name: string; path: string } {
  const project = requireProject(key);
  const running = listRecords().filter((record) => record.conversation.projectPath === project.path && record.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)));
  if (running.length) throw new ProjectConflictError('Stop the running sessions of this project before removing it.');

  fs.mkdirSync(trashRoot(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  let target = path.join(trashRoot(), `${project.title}-${stamp}`);
  for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(trashRoot(), `${project.title}-${stamp}-${suffix}`);
  fs.renameSync(project.path, target);
  removeProject(key);
  return { name: path.basename(target), path: target };
}

export function listTrash(): TrashEntry[] {
  if (!fs.existsSync(trashRoot())) return [];
  return fs.readdirSync(trashRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const entryPath = path.join(trashRoot(), entry.name);
      return { name: entry.name, path: entryPath, deletedAt: fs.statSync(entryPath).mtime.toISOString() };
    })
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function restoreTrash(name: string): ProjectSummary {
  const safeName = path.basename(String(name || '').trim());
  const source = path.join(trashRoot(), safeName);
  if (!safeName || !source.startsWith(trashRoot()) || !fs.existsSync(source)) throw new ProjectNotFoundError(safeName);

  // `<dir>-<yyyyMMdd-HHmmss>` is the trash naming convention; strip the stamp.
  const baseName = safeName.replace(/-\d{8}-\d{6}(-\d+)?$/, '') || safeName;
  let targetName = baseName;
  let target = path.join(currentWorkspaceRoot(), targetName);
  if (fs.existsSync(target)) {
    targetName = `${baseName}-restored`;
    target = path.join(currentWorkspaceRoot(), targetName);
  }
  for (let suffix = 2; fs.existsSync(target); suffix += 1) {
    targetName = `${baseName}-restored-${suffix}`;
    target = path.join(currentWorkspaceRoot(), targetName);
  }
  fs.renameSync(source, target);
  const stat = fs.statSync(target);
  const now = new Date().toISOString();
  const record: ProjectRecord = { key: projectKey(targetName), path: fs.realpathSync(target), title: targetName, dev: stat.dev, ino: stat.ino, createdAt: now, updatedAt: now };
  upsertProject(record);
  return toSummary(record);
}

/** Re-assigns an orphaned session (its project directory is gone) to a project. */
export function assignOrphan(sessionId: string, key: string): Conversation {
  const project = requireProject(key);
  const conversation = getConversation(sessionId);
  if (!conversation) throw new ProjectNotFoundError(sessionId);
  moveSessionToProject(sessionId, project.path);
  const updated = getConversation(sessionId);
  if (!updated) throw new ProjectNotFoundError(sessionId);
  return updated;
}

function toSummary(record: ProjectRecord): ProjectSummary {
  const sessions = listRecords().filter((item) => item.conversation.projectPath === record.path && !item.conversation.parentConversationId);
  const runningCount = sessions.filter((item) => item.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))).length;
  const lastActivityAt = sessions.reduce<string | null>((latest, item) => (!latest || item.conversation.updatedAt > latest ? item.conversation.updatedAt : latest), null);
  return {
    key: record.key,
    title: record.title,
    path: record.path,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sessionCount: sessions.length,
    runningCount,
    lastActivityAt,
  };
}

function applyRename(rename: ProjectRename): void {
  for (const sessionId of sessionIdsUnderKey(rename.fromKey)) {
    try {
      moveSessionToProject(sessionId, rename.toPath);
    } catch (error) {
      console.warn(`Unable to follow session ${sessionId} across a project rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sessionIdsUnderKey(key: string): string[] {
  const directory = path.join(sessionsRoot(), key);
  if (!isPathSegment(key) || !fs.existsSync(directory)) return [];
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isPathSegment(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
