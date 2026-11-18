import { useRef, useState } from 'react';
import { formatUploadEta, formatUploadSpeed } from '../../domain/upload.js';
import { formatWorkspaceByteSize } from '../../domain/workspace.js';
import { CloseIcon, PauseIcon, PlayIcon, UploadIcon } from '../common/icons.jsx';

const ACTIVE_STATUSES = new Set(['preparing', 'queued', 'uploading', 'completing']);
const PAUSABLE_STATUSES = new Set(['preparing', 'queued', 'uploading']);
const CANCELLABLE_STATUSES = new Set(['preparing', 'queued', 'uploading', 'paused', 'needs-file']);

function statusLabel(task) {
  switch (task.status) {
    case 'preparing':
      return '准备中…';
    case 'queued':
      return '排队中';
    case 'uploading':
      return `${formatUploadSpeed(task.speed)} · 剩余 ${formatUploadEta(task.etaSeconds)}`;
    case 'completing':
      return '正在合并文件…';
    case 'paused':
      return '已暂停';
    case 'needs-file':
      return '刷新后需要重新选择同一个文件';
    case 'failed':
      return task.error || '上传失败';
    case 'completed':
      return '已完成';
    default:
      return '';
  }
}

/**
 * 大文件上传任务面板：放在右侧 dock 底部，切换文件标签时也不消失。
 * 这里只渲染管理器快照，所有副作用都在 upload_manager 里。
 */
export function UploadDock({ tasks, onPause, onResume, onCancel, onRetry, onDismiss, onAttach }) {
  const inputRef = useRef(null);
  const [pickingId, setPickingId] = useState('');
  const [attachError, setAttachError] = useState('');

  if (!tasks?.length) return null;

  const pick = (task) => {
    setPickingId(task.id);
    setAttachError('');
    const input = inputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const attach = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const id = pickingId;
    setPickingId('');
    if (!file || !id || !onAttach) return;
    const result = await onAttach(id, file);
    if (result && !result.ok) setAttachError(result.error || '重新选择文件失败');
  };

  return (
    <section className="upload-dock" aria-label="上传任务">
      <div className="upload-dock-header">
        <span className="upload-dock-title"><UploadIcon /> 上传任务</span>
        <small>{tasks.length}</small>
      </div>
      <input ref={inputRef} type="file" hidden onChange={attach} />
      {attachError && <div className="upload-dock-error" role="alert">{attachError}</div>}
      <ul className="upload-task-list">
        {tasks.map((task) => (
          <li key={task.id} className={`upload-task is-${task.status}`}>
            <div className="upload-task-head">
              <strong data-tooltip={task.path || task.name}>{task.name}</strong>
              <small>{formatWorkspaceByteSize(task.size)}</small>
            </div>
            <div
              className="upload-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={task.percent}
              aria-label={`${task.name} 上传进度`}
            >
              <span style={{ width: `${task.percent}%` }} />
            </div>
            <div className="upload-task-meta">
              <span className={`upload-task-status is-${task.status}`}>{statusLabel(task)}</span>
              <span>
                {formatWorkspaceByteSize(task.receivedBytes)} / {formatWorkspaceByteSize(task.size)} · {task.percent}%
              </span>
            </div>
            <div className="upload-task-actions">
              {PAUSABLE_STATUSES.has(task.status) && (
                <button className="upload-action" type="button" data-tooltip="暂停" aria-label="暂停" onClick={() => onPause?.(task.id)}>
                  <PauseIcon />
                </button>
              )}
              {task.status === 'paused' && (
                <button className="upload-action" type="button" data-tooltip="继续" aria-label="继续" onClick={() => onResume?.(task.id)}>
                  <PlayIcon />
                </button>
              )}
              {task.status === 'needs-file' && (
                <button className="upload-action upload-action-text" type="button" onClick={() => pick(task)}>
                  重新选择文件
                </button>
              )}
              {task.status === 'failed' && (
                <button className="upload-action upload-action-text" type="button" onClick={() => onRetry?.(task.id)}>
                  重试
                </button>
              )}
              {CANCELLABLE_STATUSES.has(task.status) && (
                <button className="upload-action" type="button" data-tooltip="取消上传" aria-label="取消上传" onClick={() => onCancel?.(task.id)}>
                  <CloseIcon />
                </button>
              )}
              {!ACTIVE_STATUSES.has(task.status) && !CANCELLABLE_STATUSES.has(task.status) && (
                <button className="upload-action" type="button" data-tooltip="关闭" aria-label="关闭" onClick={() => onDismiss?.(task.id)}>
                  <CloseIcon />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
