import fs from 'node:fs';
import path from 'node:path';
import { currentWorkspaceRoot, projectsIndexFile } from '../../paths.js';
import { projectKey } from './project_key.js';

/**
 * `WORKSPACE_ROOT/.projects.json` is a *rebuildable cache*, never the source of
 * truth: the source of truth is the filesystem (project directories) plus each
 * session record's `projectPath`. Losing this file only loses the ability to
 * follow a rename (dev+ino matching), never data.
 */
export interface ProjectRecord {
  key: string;
  path: string;
  title: string;
  dev: number;
  ino: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDirectory {
  name: string;
  path: string;
  dev: number;
  ino: number;
}

export interface ProjectRename {
  fromKey: string;
  toKey: string;
  fromPath: string;
  toPath: string;
}

export interface ReconcileResult {
  projects: ProjectRecord[];
  renames: ProjectRename[];
}

interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectRecord>;
}

const REGISTRY_VERSION = 1;

function emptyRegistry(): RegistryFile {
  return { version: REGISTRY_VERSION, projects: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tolerant read: a missing, unreadable or unknown-version file means "no cache". */
export function readRegistry(): RegistryFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(projectsIndexFile(), 'utf8'));
    if (!isObject(parsed) || parsed.version !== REGISTRY_VERSION || !isObject(parsed.projects)) return emptyRegistry();
    const projects: Record<string, ProjectRecord> = {};
    for (const [key, value] of Object.entries(parsed.projects)) {
      const record = parseProjectRecord(key, value);
      if (record) projects[key] = record;
    }
    return { version: REGISTRY_VERSION, projects };
  } catch {
    return emptyRegistry();
  }
}

function parseProjectRecord(key: string, value: unknown): ProjectRecord | null {
  if (!isObject(value)) return null;
  if (typeof value.path !== 'string' || typeof value.title !== 'string') return null;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
  const dev = Number(value.dev);
  const ino = Number(value.ino);
  return {
    key,
    path: value.path,
    title: value.title,
    dev: Number.isFinite(dev) ? dev : -1,
    ino: Number.isFinite(ino) ? ino : -1,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Atomic replace, mirroring `workspace_artifact_store.save()`. */
export function writeRegistry(projects: ProjectRecord[]): void {
  const payload: RegistryFile = {
    version: REGISTRY_VERSION,
    projects: Object.fromEntries(projects.map((project) => [project.key, project])),
  };
  fs.mkdirSync(path.dirname(projectsIndexFile()), { recursive: true });
  const temp = `${projectsIndexFile()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, projectsIndexFile());
}

/**
 * Project directories are exactly the non-hidden, non-symlink first-level
 * directories of the workspace root. Hidden entries (`.sessions`, `.trash`,
 * `.runtime`, `.projects.json`) are internal state and never projects.
 */
export function scanProjectDirectories(): ProjectDirectory[] {
  if (!fs.existsSync(currentWorkspaceRoot())) return [];
  const directories: ProjectDirectory[] = [];
  for (const entry of fs.readdirSync(currentWorkspaceRoot(), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    try {
      const realPath = fs.realpathSync(path.join(currentWorkspaceRoot(), entry.name));
      const stat = fs.statSync(realPath);
      if (!stat.isDirectory()) continue;
      directories.push({ name: entry.name, path: realPath, dev: stat.dev, ino: stat.ino });
    } catch {
      // A directory that disappeared or cannot be resolved is simply not a project.
    }
  }
  return directories.sort((a, b) => a.name.localeCompare(b.name));
}

export function findProjectByKey(key: string): ProjectRecord | undefined {
  return readRegistry().projects[key];
}

/**
 * Merges the filesystem scan with the cache:
 *  - a directory whose path is already known keeps its identity;
 *  - a directory whose `dev+ino` matches a vanished path is treated as a rename
 *    (the caller migrates the session store and rewrites `projectPath`);
 *  - anything else is a new project.
 */
export function reconcileProjects(now = new Date().toISOString()): ReconcileResult {
  const previous = readRegistry().projects;
  const byPath = new Map(Object.values(previous).map((project) => [project.path, project]));
  const byIdentity = new Map(Object.values(previous).map((project) => [`${project.dev}:${project.ino}`, project]));
  const claimed = new Set<string>();
  const projects: ProjectRecord[] = [];
  const renames: ProjectRename[] = [];

  for (const directory of scanProjectDirectories()) {
    const known = byPath.get(directory.path);
    if (known) {
      claimed.add(known.key);
      projects.push({ ...known, title: directory.name, dev: directory.dev, ino: directory.ino });
      continue;
    }
    const renamed = byIdentity.get(`${directory.dev}:${directory.ino}`);
    if (renamed && !claimed.has(renamed.key) && renamed.path !== directory.path) {
      claimed.add(renamed.key);
      const toKey = projectKey(directory.name);
      renames.push({ fromKey: renamed.key, toKey, fromPath: renamed.path, toPath: directory.path });
      projects.push({
        key: toKey,
        path: directory.path,
        title: directory.name,
        dev: directory.dev,
        ino: directory.ino,
        createdAt: renamed.createdAt,
        updatedAt: now,
      });
      continue;
    }
    projects.push({
      key: projectKey(directory.name),
      path: directory.path,
      title: directory.name,
      dev: directory.dev,
      ino: directory.ino,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (registryChanged(previous, projects)) writeRegistry(projects);
  return { projects, renames };
}

function registryChanged(previous: Record<string, ProjectRecord>, next: ProjectRecord[]): boolean {
  if (Object.keys(previous).length !== next.length) return true;
  for (const project of next) {
    const before = previous[project.key];
    if (!before) return true;
    if (before.path !== project.path || before.dev !== project.dev || before.ino !== project.ino) return true;
  }
  return false;
}

/** Registers a freshly created or renamed project without a full reconcile. */
export function upsertProject(record: ProjectRecord): void {
  const registry = readRegistry();
  registry.projects[record.key] = record;
  writeRegistry(Object.values(registry.projects));
}

/** Drops a project from the cache (used when it is moved to the trash). */
export function removeProject(key: string): void {
  const registry = readRegistry();
  if (!registry.projects[key]) return;
  delete registry.projects[key];
  writeRegistry(Object.values(registry.projects));
}
