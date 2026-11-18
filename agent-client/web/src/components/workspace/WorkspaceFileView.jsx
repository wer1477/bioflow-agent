import { memo, useEffect, useMemo, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';
import { getWorkspaceTextPreview } from '../../domain/workspace.js';
import { describeFileStatus } from '../../domain/file_edit.js';
import { getWorkspaceFileExtension } from '../../workspace_preview.js';
import { CopyIcon, DownloadIcon, EditIcon } from '../common/icons.jsx';
import { CodeEditor } from './CodeEditor.jsx';
import { WorkspacePreview } from './WorkspacePreviews.jsx';

const READ_ONLY_TEXT = {
  runtime: '运行时的内部目录，只读。',
  binary: '二进制文件，不能在这里编辑。',
  truncated: '文件较大，只加载了开头一段，当前为只读预览。',
};

const KIND_LABEL = { text: '文本', code: '代码' };

/** PDF 内嵌阅读器：按页宽缩放、隐藏侧栏，在窄栏里也能读到正文。 */
const PDF_FRAME_SUFFIX = '#view=FitH&toolbar=0&navpanes=0';

/**
 * 单个文件的预览/编辑面板，对应 dock 里的一个文件标签。
 * 默认进预览态；只有显式点「编辑」才进入编辑，避免"只想看一眼却掉进编辑器"。
 *
 * 图片与 PDF 走 `rawUrl`（`/files/raw`）：浏览器原生阅读器自带缩放/翻页，
 * 也不用把整份文件 base64 塞进 JSON。
 */
export const WorkspaceFileView = memo(function WorkspaceFileView({
  file, view, loading, error, saving, autoSave, byteSizeLabel, rawUrl = '', downloadUrl = '',
  onChange, onSave, onReload, onOverwrite, onToggleAutoSave,
}) {
  const [mode, setMode] = useState('preview');
  const [wrapText, setWrapText] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const path = file?.path || '';

  // 换文件回到预览态：预览是默认视图，编辑必须是有意的动作。
  useEffect(() => {
    setMode('preview');
    setWrapText(false);
    setActualSize(false);
  }, [path]);

  const status = describeFileStatus(file, { saving });
  const preview = useMemo(
    () => (view && !view.isImage && !view.isPdf && view.viewKind !== 'blocked'
      ? getWorkspaceTextPreview(file, view.viewKind)
      : null),
    [file, view],
  );

  const copyFileContent = async () => {
    if (!file?.content || !navigator.clipboard?.writeText) return;
    const ok = await copyToClipboard(file.content);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!file) return null;
  const editing = mode === 'edit' && view?.canEdit;
  const supportsWrap = Boolean(preview) && ['text', 'code', 'json', 'table'].includes(view?.viewKind);
  // 图片与 PDF 的正文就是远端那一份，本地 content 只有开头几 KB，别再拿 truncate 提示吓人。
  const remoteRendered = Boolean(view?.isImage || view?.isPdf);

  return (
    <section className="workspace-file-view" aria-label="文件预览与编辑">
      <div className="workspace-file-header">
        <div className="workspace-file-identity">
          <strong data-tooltip={path}>{path.split('/').pop() || path}</strong>
          <span className="workspace-file-path" data-tooltip={path}>{path}</span>
        </div>
        {/* 下载放在文件头而不是工具栏：工具栏在 440px 下已经挤成两排了。 */}
        {downloadUrl && (
          <a
            className="workspace-file-download"
            href={downloadUrl}
            download={path.split('/').pop()}
            aria-label="下载这个文件"
            data-tooltip="下载这个文件"
          >
            <DownloadIcon />
          </a>
        )}
      </div>

      <div className="workspace-file-toolbar">
        <div className="workspace-file-meta">
          <span className="workspace-file-kind">{getWorkspaceFileExtension(path)}</span>
          {view?.canEdit && <span className={`workspace-file-status is-${status.tone}`}>{status.label}</span>}
          {!view?.canEdit && <span className="workspace-file-status is-readonly">只读</span>}
        </div>
        <div className="workspace-file-toolbar-actions">
          {/* 编辑态也保留：CodeEditor 本来就吃 wrap，藏起来只会让人以为预览里的换行丢了。 */}
          {supportsWrap && (
            <button
              className={`workspace-preview-control${wrapText ? ' active' : ''}`}
              type="button"
              aria-pressed={wrapText}
              onClick={() => setWrapText((value) => !value)}
            >
              换行
            </button>
          )}
          {view?.isImage && (
            <button
              className={`workspace-preview-control${actualSize ? ' active' : ''}`}
              type="button"
              aria-pressed={actualSize}
              data-tooltip={actualSize ? '缩回适应宽度' : '按原始尺寸查看'}
              onClick={() => setActualSize((value) => !value)}
            >
              1:1
            </button>
          )}
          <button className="workspace-preview-control" type="button" onClick={copyFileContent}>
            <CopyIcon />{copied ? '已复制' : '复制'}
          </button>
          {view?.canEdit && (
            <button
              className={`workspace-preview-control${editing ? ' active' : ''}`}
              type="button"
              onClick={() => setMode(editing ? 'preview' : 'edit')}
            >
              <EditIcon />{editing ? '预览' : '编辑'}
            </button>
          )}
          {view?.canEdit && (
            <label className="workspace-autosave" data-tooltip="停笔后自动保存">
              <input type="checkbox" checked={autoSave} onChange={(event) => onToggleAutoSave(event.target.checked)} />
              <span>自动保存</span>
            </label>
          )}
          {view?.canEdit && (
            <button
              className="primary-button workspace-save-button"
              type="button"
              disabled={!file.dirty || saving}
              onClick={onSave}
            >
              保存
            </button>
          )}
        </div>
      </div>

      {error && <div className="workspace-status error" role="alert">{error}</div>}

      {file.conflict && (
        <div className="workspace-conflict" role="alert">
          <div>
            <strong>磁盘上的文件已被其他写入者更新</strong>
            <span>直接保存会覆盖对方刚写的内容。选一个：</span>
          </div>
          <div className="workspace-conflict-actions">
            <button type="button" className="workspace-preview-control" onClick={onReload}>重新加载（放弃我的修改）</button>
            <button type="button" className="workspace-preview-control is-danger" onClick={onOverwrite}>仍然覆盖</button>
          </div>
        </div>
      )}

      {view?.truncated && !remoteRendered && (
        <div className="workspace-preview-note is-banner">{READ_ONLY_TEXT.truncated}</div>
      )}
      {!view?.truncated && view?.readOnlyReason === 'runtime' && (
        <div className="workspace-preview-note is-banner">{READ_ONLY_TEXT.runtime}</div>
      )}

      <div className="workspace-file-body">
        {loading && <div className="workspace-status">正在读取文件…</div>}
        {!loading && view?.viewKind === 'blocked' && (
          <div className="workspace-binary-preview">
            <strong>无法预览这个文件</strong>
            <span>{view.mimeType} · {byteSizeLabel}</span>
            <span>文件超过预览上限或不是可渲染的格式，可以下载后用本地应用打开。</span>
          </div>
        )}
        {!loading && view?.isImage && rawUrl && (
          <img
            className={`workspace-preview-image${view.isSvg ? ' svg' : ''}${actualSize ? ' is-actual' : ''}`}
            alt={path}
            src={rawUrl}
          />
        )}
        {!loading && view?.isPdf && rawUrl && (
          <iframe className="workspace-preview-frame" title={path} src={`${rawUrl}${PDF_FRAME_SUFFIX}`} />
        )}
        {!loading && editing && (
          <CodeEditor
            value={file.content}
            language={view.language}
            wrap={wrapText}
            onChange={onChange}
            onSave={onSave}
            ariaLabel={path}
          />
        )}
        {!loading && !editing && preview && <WorkspacePreview view={view} preview={preview} wrapText={wrapText} />}
      </div>

      <div className="workspace-file-footer">
        {preview?.totalLines > 0 && (
          <span>{view?.truncated ? '≥' : ''}{preview.totalLines.toLocaleString()} 行</span>
        )}
        <span>{byteSizeLabel}</span>
        <span>{KIND_LABEL[view?.viewKind] || view?.viewKind}</span>
      </div>
    </section>
  );
});
