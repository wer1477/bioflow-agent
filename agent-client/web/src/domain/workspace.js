// Workspace 纯函数：文件树统计、路径处理、预览准备、MIME 推断。
// 无 React 依赖，保持纯函数可单测。

import {
  formatJsonPreview,
  getWorkspaceFileLanguage,
  getWorkspacePreviewKind,
  isImageExtension,
  parseBedPreview,
  parseDelimitedPreview,
  parseFastaPreview,
  parseFastqPreview,
  parseGffPreview,
  parseHexPreview,
  parseNotebookPreview,
  parseSamPreview,
  parseVcfPreview,
  prepareTextPreview,
} from '../workspace_preview.js';

/** 预览读取上限：文本要能编辑所以压得小；二进制要么整份渲染，要么只给元信息。 */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const BINARY_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 只需要元信息就能渲染的路径：图片与 PDF 由 `/files/raw` 直接喂给浏览器
 * （原生 PDF 阅读器、`<img>`），再在 JSON 里塞一份 base64 纯属浪费带宽。
 */
export const METADATA_PREVIEW_MAX_BYTES = 4 * 1024;

export function getWorkspaceTreeStats(node) {
  if (!node) return { files: 0, directories: 0 };
  const children = node.children || [];
  return children.reduce((stats, child) => {
    const childStats = getWorkspaceTreeStats(child);
    return {
      files: stats.files + childStats.files + (child.type === 'file' ? 1 : 0),
      directories: stats.directories + childStats.directories + (child.type === 'directory' ? 1 : 0),
    };
  }, { files: 0, directories: node.type === 'directory' ? 1 : 0 });
}

export function getPathBaseName(value) {
  const parts = String(value || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function getWorkspaceTextPreview(file, kind) {
  const content = file.content || '';
  if (kind === 'vcf') {
    const preview = parseVcfPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'table') {
    const delimiter = /\.(tsv|tab)$/i.test(file.path || '') ? '\t' : ',';
    const preview = parseDelimitedPreview(content, delimiter);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'json') {
    const json = formatJsonPreview(content);
    return { kind, ...json, ...prepareTextPreview(json.formatted) };
  }
  if (kind === 'gff') {
    const preview = parseGffPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'bed') {
    const preview = parseBedPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'sam') {
    const preview = parseSamPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'fasta') {
    const preview = parseFastaPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'fastq') {
    const preview = parseFastqPreview(content);
    return { kind, ...preview, totalLines: prepareTextPreview(content).totalLines };
  }
  if (kind === 'notebook') {
    const preview = parseNotebookPreview(content);
    return { kind, ...preview, ...prepareTextPreview(preview.valid ? '' : content) };
  }
  if (kind === 'hex') {
    return { kind, ...parseHexPreview(content) };
  }
  return { kind, ...prepareTextPreview(content) };
}

/**
 * 单个文件的可视化结论：用哪种视图看、能不能编辑、为什么只读。
 * 组件只消费这一个函数，避免"预览分支被编辑分支遮蔽"再次发生。
 */
export function resolveWorkspaceFileView(file) {
  if (!file) return null;
  const path = file.path || '';
  const kind = getWorkspacePreviewKind(path);
  const mimeType = getWorkspaceFileMimeType(file);
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const binary = Boolean(file.binary) || file.encoding === 'base64';
  const truncated = Boolean(file.truncated);
  const writable = isProjectEditablePath(path);
  const canEdit = writable && !binary && !truncated && file.encoding === 'utf8';
  const dataUrl = getWorkspaceFileDataUrl(file, mimeType);
  const viewKind = isImage ? 'image' : isPdf ? 'pdf' : binary ? (dataUrl || file.content ? 'hex' : 'blocked') : kind;
  return {
    path,
    kind,
    viewKind,
    language: getWorkspaceFileLanguage(path),
    mimeType,
    dataUrl,
    isImage,
    isPdf,
    isSvg: mimeType === 'image/svg+xml',
    binary,
    truncated,
    canEdit,
    readOnlyReason: !writable ? 'runtime' : binary ? 'binary' : truncated ? 'truncated' : '',
    byteSize: Number(file.size) || 0,
  };
}

/** 文件树 → 项目相对路径集合：消息里提到的路径要先存在才允许点开。 */
export function buildWorkspacePathIndex(tree) {
  const paths = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'file' && node.path) paths.add(node.path);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return paths;
}

/**
 * 工具结果里的路径可能是项目根目录下的绝对路径，文件 API 只认项目相对路径。
 * 落在项目内的绝对路径剥掉前缀；其余保持原样（后端会明确报"找不到"）。
 */
export function toProjectRelativePath(path, projectPath = '') {
  const normalized = String(path || '').replace(/\\/g, '/').trim();
  const root = String(projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && (normalized === root || normalized.startsWith(`${root}/`))) {
    return normalized.slice(root.length).replace(/^\/+/, '');
  }
  return normalized.replace(/^\/+/, '');
}

/**
 * 打开文件前就要决定向后端要多少字节。
 * 图片和 PDF 现在从 `/files/raw` 直接渲染，只需要开头的元信息；
 * 文本要能就地编辑，所以要整段（有上限）。
 */
export function workspaceReadMaxBytes(path) {
  const lower = String(path || '').toLowerCase();
  const rendersFromUrl = isImageExtension(lower) || lower.endsWith('.pdf');
  return rendersFromUrl ? METADATA_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
}

/**
 * `/files/raw` 的 URL：浏览器直接渲染二进制内容（PDF、图片），`download` 版本用于下载。
 * 同源请求会带上鉴权 cookie，所以 `<iframe src>` / `<img src>` / `<a download>` 都能直接用。
 */
export function rawWorkspaceFileUrl(projectKey, path, { download = false } = {}) {
  if (!projectKey) return '';
  const params = new URLSearchParams({ path: String(path || '') });
  if (download) params.set('download', '1');
  return `/api/projects/${encodeURIComponent(projectKey)}/files/raw?${params.toString()}`;
}

/** 字节数格式化；传字符串时按 UTF-8 估算（旧调用方），传数字时直接用它。 */
export function formatWorkspaceByteSize(value) {
  const bytes = typeof value === 'number'
    ? value
    : new TextEncoder().encode(String(value || '')).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getWorkspaceFileMimeType(file) {
  if (file?.mimeType) return file.mimeType;
  const filePath = String(file?.path || '').toLowerCase();
  if (filePath.endsWith('.pdf')) return 'application/pdf';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.gif')) return 'image/gif';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.avif')) return 'image/avif';
  if (filePath.endsWith('.bmp')) return 'image/bmp';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  if (filePath.endsWith('.tif') || filePath.endsWith('.tiff')) return 'image/tiff';
  return 'application/octet-stream';
}

export function getWorkspaceFileDataUrl(file, mimeType = getWorkspaceFileMimeType(file)) {
  if (!file?.content) return '';
  if (file.encoding === 'base64' && (mimeType.startsWith('image/') || mimeType === 'application/pdf')) {
    return `data:${mimeType};base64,${file.content}`;
  }
  if (file.encoding === 'utf8' && mimeType === 'image/svg+xml') {
    return `data:${mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
  }
  return '';
}

// 项目目录整体可编辑，只有运行时的内部目录（.bioflow）保持只读。
export function isProjectEditablePath(path) {
  if (typeof path !== 'string' || !path.trim()) return false;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return false;
  return normalized !== '.bioflow' && !normalized.startsWith('.bioflow/');
}

/** 目录路径归一化：统一分隔符，去掉空段与 `.`/`..`，避免越出项目目录。 */
export function normalizeWorkspaceDirectory(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/**
 * 上传落点：当前浏览的目录（默认项目根目录）。
 * 项目目录由多个会话共享，没有会话私有的 `user/` 目录。
 */
export function projectUploadPath(file, baseDirectory = '') {
  const rawPath = String(file?.webkitRelativePath || file?.name || 'upload.bin');
  const safePath = rawPath
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizePathSegment)
    .filter(Boolean)
    .join('/');
  const prefix = normalizeWorkspaceDirectory(baseDirectory);
  return [prefix, safePath || 'upload.bin'].filter(Boolean).join('/');
}

function sanitizePathSegment(value) {
  const segment = String(value || '').trim();
  if (!segment || segment === '.' || segment === '..') return '';
  return segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
}

export function sameWorkspacePayload(left, right) {
  if (!left || !right) return left === right;
  return JSON.stringify(left.summary || null) === JSON.stringify(right.summary || null)
    && JSON.stringify(left.tree || null) === JSON.stringify(right.tree || null);
}

export function fileDisplayName(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}
