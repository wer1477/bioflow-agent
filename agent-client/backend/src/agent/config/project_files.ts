import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceArtifact } from './workspace_artifact_store.js';

/**
 * File operations rooted at a *project directory*.
 *
 * The project directory is the agent's working root and belongs to the user:
 * the backend only reads and writes inside it, never creates preset layouts,
 * and never stores engine state here (that lives in the session store).
 */
export interface ProjectTreeNode {
  name: string;
  path: string;
  absolutePath?: string;
  type: 'file' | 'directory';
  size: number;
  updatedAt: string;
  children?: ProjectTreeNode[];
}

/**
 * Read-only view of the project a session works in. Building it must never
 * touch the filesystem beyond reading the artifact index.
 */
export interface ProjectWorkspaceSummary {
  projectPath: string;
  artifacts: WorkspaceArtifact[];
}

export interface ProjectFileContent {
  path: string;
  absolutePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
  mimeType: string;
  /** Byte size on disk, independent of whether `content` was truncated. */
  size: number;
  mtimeMs: number;
  /** Optimistic-locking baseline for writes: `size:mtimeMs`. */
  version: string;
  /** True when `content` is not the whole file (over `maxBytes`). */
  truncated: boolean;
  binary: boolean;
}

export interface ProjectFileInfo {
  path: string;
  absolutePath: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  version: string;
}

/** Read cap applied by the UI; the agent-facing readers stay unlimited by default. */
export interface ReadProjectFileOptions {
  /** 0 or undefined reads the whole file. */
  maxBytes?: number;
}

/** Write options; `baseVersion` turns the write into a compare-and-set. */
export interface WriteProjectFileOptions {
  /**
   * Version the caller last read. A mismatch (including a file that appeared or
   * disappeared since) throws `ProjectFileConflictError` instead of overwriting.
   * `null` means "the caller believes the file does not exist yet".
   */
  baseVersion?: string | null;
}

/** Raised when a write loses the optimistic-lock race against another writer. */
export class ProjectFileConflictError extends Error {
  readonly currentVersion: string | null;

  constructor(currentVersion: string | null) {
    super('Project file changed on disk.');
    this.name = 'ProjectFileConflictError';
    this.currentVersion = currentVersion;
  }
}

/** Version token for an existing file; cheap (stat only) and monotonic enough for a UI lock. */
export function projectFileVersion(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

function currentFileVersion(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return projectFileVersion(fs.statSync(filePath));
}

function assertBaseVersion(filePath: string, baseVersion: string | null): void {
  const current = currentFileVersion(filePath);
  if (current !== baseVersion) throw new ProjectFileConflictError(current);
}

/** First `maxBytes` of a text file, cut back to the last complete line. */
function readTextPrefix(filePath: string, maxBytes: number): string {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    return lastBreak > 0 ? text.slice(0, lastBreak + 1) : text;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Hidden entries are engine-internal (e.g. `.bioflow`) and stay out of the tree. */
const HIDDEN_ENTRY_PREFIX = '.';

export function isInsideProject(projectPath: string, candidate: string): boolean {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/**
 * Resolves a project-relative path and refuses anything that escapes the
 * project root (traversal, absolute paths outside, symlinked escapes).
 */
export function resolveProjectPath(projectPath: string, relativePath: string, allowMissing = false): string {
  const root = path.resolve(projectPath);
  const rawPath = String(relativePath || '').trim();
  if (!rawPath || rawPath.includes('\0')) throw new Error('A project file path is required.');
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, normalized));
  if (!isInsideProject(root, resolved)) throw new Error('Project file path escapes the project directory.');
  if (!allowMissing && !fs.existsSync(resolved)) throw new Error('Project file not found.');
  return resolved;
}

export function projectRelativePath(projectPath: string, filePath: string): string {
  return path.relative(path.resolve(projectPath), filePath).replace(/\\/g, '/');
}

export function projectAbsolutePath(projectPath: string, relativePath: string): string {
  return path.resolve(resolveProjectPath(projectPath, relativePath, true));
}

export function getProjectTree(projectPath: string, relativePath = ''): ProjectTreeNode {
  const root = path.resolve(projectPath);
  const itemPath = String(relativePath || '').trim() ? resolveProjectPath(root, relativePath) : root;
  return buildProjectTree(root, itemPath);
}

export function readProjectFile(
  projectPath: string,
  relativePath: string,
  options: ReadProjectFileOptions = {},
): ProjectFileContent {
  const filePath = resolveProjectPath(projectPath, relativePath);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error('Project path is a directory.');
  const mimeType = guessProjectMimeType(filePath);
  const isText = isProjectTextFile(filePath, mimeType);
  const maxBytes = Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : 0;
  const truncated = maxBytes > 0 && stat.size > maxBytes;
  const readWholeFile = !truncated;
  let content = '';
  if (isText) {
    content = truncated ? readTextPrefix(filePath, maxBytes) : fs.readFileSync(filePath, 'utf8');
  } else if (readWholeFile) {
    content = fs.readFileSync(filePath).toString('base64');
  }
  return {
    path: projectRelativePath(projectPath, filePath),
    absolutePath: path.resolve(filePath),
    content,
    encoding: isText ? 'utf8' : 'base64',
    mimeType,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    version: projectFileVersion(stat),
    truncated,
    binary: !isText,
  };
}

export function getProjectFileInfo(projectPath: string, relativePath: string): ProjectFileInfo {
  const filePath = resolveProjectPath(projectPath, relativePath);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error('Project path is a directory.');
  return {
    path: projectRelativePath(projectPath, filePath),
    absolutePath: path.resolve(filePath),
    mimeType: guessProjectMimeType(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    version: projectFileVersion(stat),
  };
}

export function writeProjectFile(
  projectPath: string,
  relativePath: string,
  content: string,
  options: WriteProjectFileOptions = {},
): ProjectFileInfo {
  const filePath = resolveProjectPath(projectPath, relativePath, true);
  if (options.baseVersion !== undefined) assertBaseVersion(filePath, options.baseVersion);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return getProjectFileInfo(projectPath, projectRelativePath(projectPath, filePath));
}

export function writeProjectFileBuffer(projectPath: string, relativePath: string, content: Buffer): ProjectFileInfo {
  const filePath = resolveProjectPath(projectPath, relativePath, true);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return getProjectFileInfo(projectPath, projectRelativePath(projectPath, filePath));
}

export function createProjectItem(projectPath: string, relativePath: string, type: 'file' | 'directory'): ProjectTreeNode {
  const itemPath = resolveProjectPath(projectPath, relativePath, true);
  if (fs.existsSync(itemPath)) throw new Error('Project item already exists.');
  if (type === 'directory') {
    fs.mkdirSync(itemPath, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(itemPath), { recursive: true });
    fs.writeFileSync(itemPath, '', 'utf8');
  }
  return buildProjectTree(path.resolve(projectPath), itemPath);
}

export function deleteProjectItem(projectPath: string, relativePath: string): void {
  const root = path.resolve(projectPath);
  const itemPath = resolveProjectPath(root, relativePath);
  if (path.resolve(itemPath) === root) throw new Error('Cannot delete the project root.');
  fs.rmSync(itemPath, { recursive: true, force: true });
}

export function moveProjectItem(projectPath: string, fromRelativePath: string, toRelativePath: string): ProjectTreeNode {
  const root = path.resolve(projectPath);
  const fromPath = resolveProjectPath(root, fromRelativePath);
  const toPath = resolveProjectPath(root, toRelativePath, true);
  if (fs.existsSync(toPath)) throw new Error('Project target already exists.');
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.renameSync(fromPath, toPath);
  return buildProjectTree(root, toPath);
}

/** Recursive directory listing for one project; the root node itself is the project. */
function buildProjectTree(root: string, itemPath: string): ProjectTreeNode {
  const stat = fs.statSync(itemPath);
  const relativePath = projectRelativePath(root, itemPath);
  const node: ProjectTreeNode = {
    name: relativePath ? path.basename(itemPath) : path.basename(root),
    path: relativePath,
    absolutePath: path.resolve(itemPath),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
  if (stat.isDirectory()) {
    node.children = fs.readdirSync(itemPath)
      .filter((name) => !name.startsWith(HIDDEN_ENTRY_PREFIX))
      .map((name) => buildProjectTree(root, path.join(itemPath, name)))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }
  return node;
}

export function guessProjectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.tsv') return 'text/tab-separated-values';
  if ([
    '.txt',
    '.log',
    '.js',
    '.mjs',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.r',
    '.go',
    '.java',
    '.lua',
    '.sql',
    '.sh',
    '.ps1',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.xml',
    '.css',
    '.jsonl',
    '.ndjson',
    '.ipynb',
    '.fa',
    '.fna',
    '.faa',
    '.ffn',
    '.fasta',
    '.fastq',
    '.fq',
    '.bed',
    '.gff',
    '.gff3',
    '.gtf',
    '.vcf',
    '.sam',
    '.pdb',
    '.cif',
    '.nwk',
    '.treefile',
    '.nex',
    '.phy',
    '.mtx',
  ].includes(ext)) return 'text/plain';
  if (['.html', '.htm'].includes(ext)) return 'text/html';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.ico') return 'image/x-icon';
  if (['.tif', '.tiff'].includes(ext)) return 'image/tiff';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

export function isProjectTextFile(filePath: string, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (['application/json', 'application/xml'].includes(mimeType)) return true;
  return /\.(md|txt|json|csv|tsv|log|js|mjs|ts|tsx|jsx|py|sh|ps1|yaml|yml|toml|xml|html|css|fa|fasta|fastq|fq|bed|gff|gtf|vcf|sam|pdb|cif)$/i.test(filePath);
}

export function inferProjectArtifactType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'report';
  if (['.csv', '.tsv', '.json'].includes(ext)) return 'data';
  if (ext === '.pdf') return 'document';
  return 'file';
}
