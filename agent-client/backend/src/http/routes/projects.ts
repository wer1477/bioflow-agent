import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  assignOrphan,
  createProject,
  findProject,
  listProjects,
  listTrash,
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectValidationError,
  renameProject,
  restoreTrash,
  trashProject,
} from '../../agent/config/project_service.js';
import { getConversationArtifacts } from '../../agent/config/workspace_artifact_store.js';
import {
  cancelUpload,
  completeUpload,
  getUpload,
  initUpload,
  listUploads,
  UPLOAD_CHUNK_BYTES,
  UploadError,
  writeUploadChunk,
} from '../../services/upload_service.js';
import {
  createProjectItem,
  deleteProjectItem,
  getProjectFileInfo,
  getProjectTree,
  guessProjectMimeType,
  moveProjectItem,
  ProjectFileConflictError,
  readProjectFile,
  resolveProjectPath,
  writeProjectFile,
  writeProjectFileBuffer,
} from '../../agent/config/project_files.js';

const router = express.Router();

/** Engine-internal state stays readable to the agent but not editable in the UI. */
const UI_READ_ONLY_PREFIXES = ['.bioflow/'];

/**
 * Read caps for the file viewer. Text stays small so editing never round-trips a
 * huge buffer; binary is bigger because images/PDF are shown whole or not at all.
 */
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const DEFAULT_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;

function parseMaxBytes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TRANSFER_MAX_BYTES;
  return Math.min(MAX_TRANSFER_BYTES, Math.floor(parsed));
}

function normalizeRelativePath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function assertUiWritable(relativePath: string): string {
  if (!relativePath) throw new Error('A project file path is required.');
  if (UI_READ_ONLY_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
    throw new Error('This path is managed by the runtime and cannot be edited from the UI.');
  }
  if (relativePath.split('/').includes('..')) throw new Error('Project file path escapes the project directory.');
  return relativePath;
}

function decodeUploadHeader(req: express.Request, name: string): string {
  const raw = String(req.headers[name] || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getProjectOr404(key: string, res: express.Response) {
  const project = findProject(key);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project;
}

function workspacePayload(projectPath: string, sessionId: string | null, relativePath = ''): Record<string, unknown> {
  return {
    summary: {
      projectPath,
      sessionId,
      artifacts: sessionId ? getConversationArtifacts(sessionId) : [],
    },
    tree: getProjectTree(projectPath, relativePath),
  };
}

/** Fresh version metadata for the 409 body, so the client can reload or overwrite. */
function currentFileVersionPayload(projectPath: string, relativePath: string): Record<string, unknown> {
  if (!relativePath) return { version: null, size: null, mtimeMs: null };
  try {
    const info = getProjectFileInfo(projectPath, relativePath);
    return { version: info.version, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    // Deleted under the writer: no version, the client must re-open.
    return { version: null, size: null, mtimeMs: null };
  }
}

/**
 * `inline` lets the browser render the file in place (PDF/img). Downloads name
 * the file after the basename, RFC 5987-encoded so non-ASCII names survive;
 * `encodeURIComponent` leaves `'()*`, which are not attr-chars, so escape them.
 */
function contentDispositionHeader(absolutePath: string, download: boolean): string {
  if (!download) return 'inline';
  const encoded = encodeURIComponent(path.basename(absolutePath))
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function handleProjectError(error: unknown, res: express.Response): void {
  if (error instanceof ProjectNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof ProjectValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof ProjectConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

function handleUploadError(error: unknown, res: express.Response): void {
  if (error instanceof UploadError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  handleProjectError(error, res);
}

router.get('/', (_req, res) => {
  res.json(listProjects());
});

router.post('/', (req, res) => {
  try {
    res.status(201).json({ project: createProject(req.body?.name) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.get('/trash', (_req, res) => {
  res.json({ items: listTrash() });
});

router.post('/trash/:name/restore', (req, res) => {
  try {
    res.json({ project: restoreTrash(req.params.name) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.post('/orphans/:sessionId/assign', (req, res) => {
  try {
    res.json({ conversation: assignOrphan(req.params.sessionId, String(req.body?.project || '').trim()) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.patch('/:key', (req, res) => {
  try {
    res.json({ project: renameProject(req.params.key, req.body?.title) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.delete('/:key', (req, res) => {
  try {
    res.json({ trashed: trashProject(req.params.key) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.get('/:key/files', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const sessionId = String(req.query.session || '').trim() || null;
    res.json(workspacePayload(project.path, sessionId, normalizeRelativePath(req.query.path)));
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.get('/:key/files/file', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    res.json({
      file: readProjectFile(project.path, normalizeRelativePath(req.query.path), {
        maxBytes: parseMaxBytes(req.query.maxBytes),
      }),
    });
  } catch (error) {
    handleProjectError(error, res);
  }
});

/**
 * Raw bytes for the viewer. The JSON file endpoint hands back base64, which a
 * browser cannot render inline; streaming from a URL lets PDFs and large images
 * load directly and makes `Range` work (PDF page seeking, image progress).
 */
router.get('/:key/files/raw', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const absolutePath = resolveProjectPath(project.path, normalizeRelativePath(req.query.path));
    if (fs.statSync(absolutePath).isDirectory()) throw new Error('Project path is a directory.');
    res.sendFile(absolutePath, {
      // Path safety is already settled by resolveProjectPath, and readProjectFile
      // serves dotfiles such as `.bioflow/` too; send()'s default `ignore` would 404 them.
      dotfiles: 'allow',
      // Pin the type to the project-file helper instead of letting send() re-guess it.
      headers: {
        'Content-Type': guessProjectMimeType(absolutePath),
        'Content-Disposition': contentDispositionHeader(absolutePath, String(req.query.download ?? '') === '1'),
      },
    });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.put('/:key/files/file', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  let relativePath = '';
  try {
    relativePath = assertUiWritable(normalizeRelativePath(req.body?.path));
    const hasBaseVersion = Object.prototype.hasOwnProperty.call(req.body || {}, 'baseVersion');
    const baseVersion = hasBaseVersion
      ? (req.body?.baseVersion === null ? null : String(req.body?.baseVersion))
      : undefined;
    const file = writeProjectFile(project.path, relativePath, String(req.body?.content ?? ''), { baseVersion });
    // 保存的响应默认带回整棵树（其它调用方依赖它）；编辑器自动保存会传 tree=0，
    // 否则每次停笔都要序列化并传回整个项目树，大项目下一次保存要 1-2 秒。
    const includeTree = String(req.query.tree ?? '') !== '0';
    res.json(includeTree
      ? { file, ...workspacePayload(project.path, String(req.query.session || '').trim() || null) }
      : { file });
  } catch (error) {
    if (error instanceof ProjectFileConflictError) {
      res.status(409).json({
        error: '文件已被其他写入者修改。',
        code: 'FILE_VERSION_CONFLICT',
        ...currentFileVersionPayload(project.path, relativePath),
      });
      return;
    }
    handleProjectError(error, res);
  }
});

router.post('/:key/files/upload', express.raw({ type: 'application/octet-stream', limit: '256mb' }), (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const isBinaryUpload = Buffer.isBuffer(req.body);
    const fileName = normalizeRelativePath(isBinaryUpload ? decodeUploadHeader(req, 'x-workspace-file-name') : req.body?.fileName).split('/').filter(Boolean).pop();
    if (!fileName) throw new Error('fileName is required.');
    const targetInput = isBinaryUpload ? decodeUploadHeader(req, 'x-workspace-path') : req.body?.path;
    // Uploads land in the directory the file browser is showing; the project root by default.
    const relativePath = assertUiWritable(normalizeRelativePath(targetInput) || fileName);
    const content = isBinaryUpload ? req.body : Buffer.from(String(req.body?.content ?? ''), req.body?.encoding === 'base64' ? 'base64' : 'utf8');
    const file = writeProjectFileBuffer(project.path, relativePath, content);
    res.status(201).json({ file, ...workspacePayload(project.path, String(req.query.session || '').trim() || null) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.post('/:key/uploads', async (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const upload = await initUpload({
      projectKey: project.key,
      targetPath: assertUiWritable(normalizeRelativePath(req.body?.path)),
      size: req.body?.size,
    });
    res.status(201).json({ upload });
  } catch (error) {
    handleUploadError(error, res);
  }
});

router.get('/:key/uploads', async (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    res.json({ uploads: await listUploads(project.key) });
  } catch (error) {
    handleUploadError(error, res);
  }
});

router.get('/:key/uploads/:uploadId', async (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    res.json({ upload: await getUpload(project.key, req.params.uploadId) });
  } catch (error) {
    handleUploadError(error, res);
  }
});

// One chunk per request keeps memory bounded by the chunk size instead of the
// file size. The parser limit is deliberately a little above the chunk size so
// the service can report a precise CHUNK_SIZE_MISMATCH instead of a bare 413.
router.put(
  '/:key/uploads/:uploadId/chunks/:index',
  express.raw({ type: 'application/octet-stream', limit: UPLOAD_CHUNK_BYTES + 1024 * 1024 }),
  async (req, res) => {
    const project = getProjectOr404(req.params.key, res);
    if (!project) return;
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new UploadError(400, 'INVALID_CHUNK_BODY', 'Chunk body must be application/octet-stream.');
      }
      const chunk = await writeUploadChunk(project.key, req.params.uploadId, Number(req.params.index), req.body);
      res.json({ chunk });
    } catch (error) {
      handleUploadError(error, res);
    }
  },
);

router.post('/:key/uploads/:uploadId/complete', async (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const { file } = await completeUpload(project.key, req.params.uploadId, project.path);
    res.status(201).json({ file, ...workspacePayload(project.path, String(req.query.session || '').trim() || null) });
  } catch (error) {
    handleUploadError(error, res);
  }
});

router.delete('/:key/uploads/:uploadId', async (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    await cancelUpload(project.key, req.params.uploadId);
    res.status(204).end();
  } catch (error) {
    handleUploadError(error, res);
  }
});

router.delete('/:key/files/item', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    deleteProjectItem(project.path, assertUiWritable(normalizeRelativePath(req.body?.path)));
    res.json(workspacePayload(project.path, String(req.query.session || '').trim() || null));
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.post('/:key/files/item', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const relativePath = assertUiWritable(normalizeRelativePath(req.body?.path));
    const type = req.body?.type === 'directory' ? 'directory' : 'file';
    res.status(201).json({ node: createProjectItem(project.path, relativePath, type), ...workspacePayload(project.path, String(req.query.session || '').trim() || null) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

router.post('/:key/files/move', (req, res) => {
  const project = getProjectOr404(req.params.key, res);
  if (!project) return;
  try {
    const from = assertUiWritable(normalizeRelativePath(req.body?.from));
    const to = assertUiWritable(normalizeRelativePath(req.body?.to));
    res.json({ node: moveProjectItem(project.path, from, to), ...workspacePayload(project.path, String(req.query.session || '').trim() || null) });
  } catch (error) {
    handleProjectError(error, res);
  }
});

export default router;
