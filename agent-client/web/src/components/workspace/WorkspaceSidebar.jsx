import { memo, useEffect, useRef, useState } from 'react';
import { getPathBaseName, getWorkspaceTreeStats, isProjectEditablePath } from '../../domain/workspace.js';
import {
  ChevronDownIcon, ChevronRightIcon, CloseIcon, EditIcon, FileIcon, FolderIcon, PlusIcon, RefreshIcon,
} from '../common/icons.jsx';

/**
 * 项目文件树。视图已从"顶栏标签"改成"面板内切换"：
 * 打开文件由 ChatView 把整棵树 hidden 掉，展开状态、上传目标、滚动位置都保留。
 */
export function WorkspaceSidebar({
  tree, summary, loading, error, directory = '', activePath = '', revealPath = '',
  onDirectoryChange, onRefresh, onOpenFile, onUpload, onDelete, onCreate, onRename,
}) {
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);
  const [creating, setCreating] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const rootPath = summary?.projectPath || '';
  const workspaceDirectoryName = getPathBaseName(rootPath);
  const treeStats = getWorkspaceTreeStats(tree);
  const artifactCount = summary?.artifacts?.length || 0;
  const segments = String(directory || '').split('/').filter(Boolean);
  const uploadTargetLabel = directory || '项目根目录';

  const upload = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length) await onUpload(files);
  };

  const startCreating = (type) => {
    setCreating(type);
    setDraftName('');
  };

  const submitCreate = async (event) => {
    event?.preventDefault();
    const name = draftName.trim();
    if (!creating || !name) {
      setCreating(null);
      return;
    }
    const path = [directory, name].filter(Boolean).join('/');
    setCreating(null);
    setDraftName('');
    const node = await onCreate?.(path, creating);
    if (node?.type === 'file') onOpenFile?.(node.path);
  };

  const startRename = (node) => {
    setRenaming(node.path);
    setRenameDraft(node.name);
  };

  const submitRename = async (event, node) => {
    event?.preventDefault();
    const name = renameDraft.trim();
    setRenaming('');
    if (!name || name === node.name) return;
    const parent = node.path.split('/').slice(0, -1).join('/');
    await onRename?.(node.path, [parent, name].filter(Boolean).join('/'));
  };

  const cancelRename = () => setRenaming('');

  const confirmDelete = (node) => {
    if (window.confirm(`删除「${node.path}」？此操作不可撤销。`)) onDelete?.(node.path);
  };

  return (
    <aside className="workspace-sidebar" aria-label="Workspace">
      <div className="workspace-header">
        <div>
          <span className="workspace-kicker">PROJECT DIRECTORY</span>
          <h3>项目文件</h3>
          <p className="workspace-bound-directory" data-tooltip={rootPath}>{workspaceDirectoryName || '未选择项目'}</p>
        </div>
        <div className="workspace-header-actions">
          <button className="icon-button" type="button" data-tooltip="新建文件" aria-label="新建文件" onClick={() => startCreating('file')}><PlusIcon /></button>
          <button className="icon-button" type="button" data-tooltip="新建文件夹" aria-label="新建文件夹" onClick={() => startCreating('directory')}><FolderIcon /></button>
          <button className="icon-button" type="button" data-tooltip="刷新" aria-label="刷新" onClick={onRefresh}><RefreshIcon /></button>
        </div>
      </div>

      <div className="workspace-overview" aria-label="Workspace 概览">
        <div className="workspace-overview-primary">
          <span className="workspace-orbit" aria-hidden="true" />
          <div><strong>项目共享文件</strong><span>同项目的所有会话共用这个目录</span></div>
        </div>
        <div className="workspace-metrics">
          <span><b>{treeStats.files}</b><small>文件</small></span>
          <span><b>{artifactCount}</b><small>产物</small></span>
        </div>
      </div>

      <div className="workspace-actions">
        <button
          className="primary-button workspace-upload-primary"
          type="button"
          data-tooltip={`上传到 ${uploadTargetLabel}`}
          onClick={() => fileInputRef.current?.click()}
          disabled={!tree}
        >
          上传到当前目录
        </button>
        <button className="secondary-button" type="button" onClick={() => directoryInputRef.current?.click()} disabled={!tree}>
          上传文件夹
        </button>
        <div className="workspace-upload-target">
          <span>上传目标</span>
          <div className="workspace-breadcrumb">
            <button className={segments.length ? '' : 'is-current'} type="button" onClick={() => onDirectoryChange?.('')}>项目根目录</button>
            {segments.map((segment, index) => {
              const path = segments.slice(0, index + 1).join('/');
              return (
                <button
                  key={path}
                  className={index === segments.length - 1 ? 'is-current' : ''}
                  type="button"
                  data-tooltip={path}
                  onClick={() => onDirectoryChange?.(path)}
                >
                  / {segment}
                </button>
              );
            })}
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple onChange={upload} hidden />
        <input ref={directoryInputRef} type="file" multiple onChange={upload} hidden {...{ webkitdirectory: '' }} />
      </div>

      {error && <div className="workspace-status error" role="alert">{error}</div>}
      {loading && <div className="workspace-status">正在处理...</div>}

      <div className="workspace-tree">
        <div className="workspace-tree-heading">
          <span>文件结构</span>
          {tree && <b>{treeStats.directories} 个目录</b>}
        </div>
        {creating && (
          <form className="workspace-inline-form" onSubmit={submitCreate}>
            <input
              autoFocus
              className="workspace-inline-input"
              value={draftName}
              placeholder={creating === 'file' ? '新文件名，如 notes.md' : '新文件夹名'}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setCreating(null); }}
              onBlur={() => { if (!draftName.trim()) setCreating(null); }}
            />
            <span className="workspace-inline-hint">{directory || '项目根目录'}</span>
          </form>
        )}
        {tree ? (
          <WorkspaceTreeNode
            node={tree}
            depth={0}
            directory={directory}
            activePath={activePath}
            revealPath={revealPath}
            renaming={renaming}
            renameDraft={renameDraft}
            onRenameDraft={setRenameDraft}
            onRenameSubmit={submitRename}
            onCancelRename={cancelRename}
            onDirectoryChange={onDirectoryChange}
            onOpenFile={onOpenFile}
            onStartRename={startRename}
            onDelete={confirmDelete}
          />
        ) : (
          <div className="workspace-empty">暂无项目文件</div>
        )}
      </div>
    </aside>
  );
}

const WorkspaceTreeNode = memo(function WorkspaceTreeNode({
  node, depth, directory, activePath, revealPath, renaming, renameDraft,
  onRenameDraft, onRenameSubmit, onCancelRename, onDirectoryChange, onOpenFile, onStartRename, onDelete,
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const canDelete = isProjectEditablePath(node.path);
  const isDirectory = node.type === 'directory';
  const isUploadTarget = isDirectory && Boolean(node.path) && node.path === directory;
  const isActive = !isDirectory && node.path === activePath;

  // 从消息/工具结果打开文件时，把它的祖先目录展开，用户能在树里看到"在哪"。
  useEffect(() => {
    if (isDirectory && revealPath && node.path && revealPath.startsWith(`${node.path}/`)) setExpanded(true);
  }, [isDirectory, node.path, revealPath]);

  const open = () => {
    if (isDirectory) {
      setExpanded((value) => !value);
      // 点开目录 = 浏览到该目录：后续上传与新建都落在这里。
      if (node.path) onDirectoryChange?.(node.path);
    } else {
      onOpenFile(node.path);
    }
  };

  return (
    <div className="workspace-node">
      {renaming && renaming === node.path ? (
        <form className="workspace-inline-form" onSubmit={(event) => onRenameSubmit(event, node)}>
          <input
            autoFocus
            className="workspace-inline-input"
            value={renameDraft}
            onChange={(event) => onRenameDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') onCancelRename(); }}
          />
        </form>
      ) : (
        <div
          className={`workspace-node-row${isUploadTarget ? ' is-upload-target' : ''}${isActive ? ' is-active' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <button className="workspace-node-main" type="button" onClick={open} data-tooltip={node.path || node.name}>
            <span className="workspace-node-glyph">
              {isDirectory ? (expanded ? <ChevronDownIcon /> : <ChevronRightIcon />) : <FileIcon />}
            </span>
            <strong>{node.name}</strong>
          </button>
          {canDelete && (
            <span className="workspace-node-actions">
              <button className="workspace-node-action" type="button" data-tooltip="重命名" aria-label="重命名" onClick={() => onStartRename(node)}>
                <EditIcon />
              </button>
              <button className="workspace-node-action" type="button" data-tooltip="删除" aria-label="删除" onClick={() => onDelete(node)}>
                <CloseIcon />
              </button>
            </span>
          )}
        </div>
      )}
      {isDirectory && expanded && (node.children || []).map((child) => (
        <WorkspaceTreeNode
          key={child.path || child.name}
          node={child}
          depth={depth + 1}
          directory={directory}
          activePath={activePath}
          revealPath={revealPath}
          renaming={renaming}
          renameDraft={renameDraft}
          onRenameDraft={onRenameDraft}
          onRenameSubmit={onRenameSubmit}
          onCancelRename={onCancelRename}
          onDirectoryChange={onDirectoryChange}
          onOpenFile={onOpenFile}
          onStartRename={onStartRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
});
