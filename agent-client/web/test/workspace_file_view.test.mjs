import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINARY_PREVIEW_MAX_BYTES,
  METADATA_PREVIEW_MAX_BYTES,
  buildWorkspacePathIndex,
  rawWorkspaceFileUrl,
  TEXT_PREVIEW_MAX_BYTES,
  formatWorkspaceByteSize,
  resolveWorkspaceFileView,
  toProjectRelativePath,
  workspaceReadMaxBytes,
} from '../src/domain/workspace.js';

function file(overrides = {}) {
  return {
    path: 'runs/report.md',
    content: '# title',
    encoding: 'utf8',
    mimeType: '',
    size: 7,
    version: '7:100',
    truncated: false,
    binary: false,
    ...overrides,
  };
}

test('a text file resolves to its preview kind and stays editable', () => {
  const view = resolveWorkspaceFileView(file({ path: 'notes.md', mimeType: 'text/markdown' }));
  assert.equal(view.viewKind, 'markdown');
  assert.equal(view.kind, 'markdown');
  assert.equal(view.canEdit, true);
  assert.equal(view.readOnlyReason, '');
  assert.equal(view.byteSize, 7);
});

test('code files carry a highlight language', () => {
  const view = resolveWorkspaceFileView(file({ path: 'bin/pipeline.py', mimeType: 'text/plain' }));
  assert.equal(view.kind, 'code');
  assert.equal(view.language, 'python');
});

test('images render from a data URL and never enter the editor', () => {
  const view = resolveWorkspaceFileView(file({ path: 'plots/pca.png', content: 'AAAA', encoding: 'base64', mimeType: 'image/png', binary: true }));
  assert.equal(view.isImage, true);
  assert.equal(view.viewKind, 'image');
  assert.equal(view.canEdit, false);
  assert.equal(view.readOnlyReason, 'binary');
  assert.match(view.dataUrl, /^data:image\/png;base64,AAAA$/);
});

test('PDFs keep their own view kind', () => {
  const view = resolveWorkspaceFileView(file({ path: 'paper.pdf', content: 'AAAA', encoding: 'base64', mimeType: 'application/pdf', binary: true }));
  assert.equal(view.isPdf, true);
  assert.equal(view.viewKind, 'pdf');
});

test('a truncated text file is read-only with a reason', () => {
  const view = resolveWorkspaceFileView(file({ path: 'big.tsv', truncated: true, size: 40 * 1024 * 1024 }));
  assert.equal(view.canEdit, false);
  assert.equal(view.readOnlyReason, 'truncated');
});

test('runtime-internal paths stay read-only even when they are text', () => {
  const view = resolveWorkspaceFileView(file({ path: '.bioflow/session.json', mimeType: 'application/json' }));
  assert.equal(view.canEdit, false);
  assert.equal(view.readOnlyReason, 'runtime');
});

test('an unrecognised binary falls back to a hex view', () => {
  const view = resolveWorkspaceFileView(file({ path: 'sample.bam', content: 'AAEC', encoding: 'base64', mimeType: 'application/octet-stream', binary: true }));
  assert.equal(view.viewKind, 'hex');
  assert.equal(view.canEdit, false);
});

test('a binary past the read cap offers no content at all', () => {
  const view = resolveWorkspaceFileView(file({ path: 'huge.bam', content: '', encoding: 'base64', binary: true, truncated: true, mimeType: 'application/octet-stream' }));
  assert.equal(view.viewKind, 'blocked');
  assert.equal(view.readOnlyReason, 'binary');
});

test('read budgets：图片/PDF 只读元信息（正文走 /files/raw），文本要能就地编辑', () => {
  assert.equal(workspaceReadMaxBytes('plots/pca.png'), METADATA_PREVIEW_MAX_BYTES);
  assert.equal(workspaceReadMaxBytes('paper.PDF'), METADATA_PREVIEW_MAX_BYTES);
  assert.equal(workspaceReadMaxBytes('runs/report.md'), TEXT_PREVIEW_MAX_BYTES);
  assert.ok(METADATA_PREVIEW_MAX_BYTES < TEXT_PREVIEW_MAX_BYTES);
  // 二进制截断上限仍然存在：hex 兜底与"无法预览"判定要用它。
  assert.ok(BINARY_PREVIEW_MAX_BYTES > TEXT_PREVIEW_MAX_BYTES);
});

test('/files/raw 的 URL 带路径编码与下载开关', () => {
  assert.equal(
    rawWorkspaceFileUrl('proj 1', 'reports/报告.pdf'),
    `/api/projects/proj%201/files/raw?path=${encodeURIComponent('reports/报告.pdf')}`,
  );
  assert.equal(
    rawWorkspaceFileUrl('proj', 'a.pdf', { download: true }),
    `/api/projects/proj/files/raw?path=a.pdf&download=1`,
  );
  // 没有项目 key 时给空串：调用方据此不渲染 iframe/img，而不是请求 /api/projects//files/raw。
  assert.equal(rawWorkspaceFileUrl('', 'a.pdf'), '');
});

test('byte size formatting accepts numbers from the server and legacy strings', () => {
  assert.equal(formatWorkspaceByteSize(512), '512 B');
  assert.equal(formatWorkspaceByteSize(2048), '2.0 KB');
  assert.equal(formatWorkspaceByteSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatWorkspaceByteSize('ab'), '2 B');
});

test('absolute paths from tool results are folded back into project-relative ones', () => {
  const root = '/path/to/bioflow-dev/agent-client/workspace/321';
  assert.equal(toProjectRelativePath(`${root}/TASK.md`, root), 'TASK.md');
  assert.equal(toProjectRelativePath(`${root}/runs/data/a.tsv`, root), 'runs/data/a.tsv');
  assert.equal(toProjectRelativePath('runs/data/a.tsv', root), 'runs/data/a.tsv');
  assert.equal(toProjectRelativePath('/etc/passwd', root), 'etc/passwd');
  assert.equal(toProjectRelativePath('/TASK.md'), 'TASK.md');
  assert.equal(toProjectRelativePath('', root), '');
});

test('the path index only contains files, keyed by project-relative path', () => {
  const index = buildWorkspacePathIndex({
    name: '321',
    path: '',
    type: 'directory',
    children: [
      {
        name: 'data',
        path: 'data',
        type: 'directory',
        children: [
          { name: 'genomic.gff', path: 'data/genomic.gff', type: 'file' },
          { name: 'refseq', path: 'data/refseq', type: 'directory', children: [{ name: 'a.fna', path: 'data/refseq/a.fna', type: 'file' }] },
        ],
      },
      { name: 'TASK.md', path: 'TASK.md', type: 'file' },
    ],
  });

  assert.equal(index.has('TASK.md'), true);
  assert.equal(index.has('data/genomic.gff'), true);
  assert.equal(index.has('data/refseq/a.fna'), true);
  assert.equal(index.has('data'), false, '目录本身不是可打开的文件');
  assert.equal(index.has('list/ko'), false);
  assert.equal(buildWorkspacePathIndex(null).size, 0);
});
