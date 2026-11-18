import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, apiJson, uploadBinaryFile } from '../api.js';
import { shouldChunkUpload } from '../domain/upload.js';
import {
  attachUploadFile,
  cancelUpload,
  dismissUpload,
  enqueueUploads,
  getUploadSnapshot,
  onUploadEvent,
  pauseUpload,
  restoreUploads,
  resumeUpload,
  retryUpload,
  subscribeUploads,
} from '../upload_manager.js';
import {
  addOpenPath,
  applyConflict,
  applyDraft,
  applyRemote,
  applySave,
  autoSavePreferenceValue,
  activePathAfterClose,
  autoSaveTargets,
  createFileSession,
  parseAutoSavePreference,
  removeOpenPath,
  removeSession,
  renameSession,
  shouldAutoSave,
  upsertSession,
  AUTOSAVE_DELAY_MS,
} from '../domain/file_edit.js';
import {
  isProjectEditablePath,
  normalizeWorkspaceDirectory,
  projectUploadPath,
  rawWorkspaceFileUrl,
  resolveWorkspaceFileView,
  sameWorkspacePayload,
  toProjectRelativePath,
  workspaceReadMaxBytes,
} from '../domain/workspace.js';

const AUTO_SAVE_KEY = 'bioflow-workspace-autosave';

function readAutoSavePreference() {
  try {
    return parseAutoSavePreference(localStorage.getItem(AUTO_SAVE_KEY));
  } catch {
    return true;
  }
}

/**
 * 项目文件面板：文件属于**项目目录**（多个会话共享），
 * 因此端点按 projectKey 走，会话只用来带出该会话的产物索引。
 *
 * 每个打开的文件是一个标签、一份会话（内容 + 草稿 + 版本基线），
 * 因此可以同时开着多个文件互不干扰；切走再切回草稿与冲突状态都还在。
 */
export function useWorkspace({ projectKey, sessionId }) {
  const [payload, setPayload] = useState(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [sessions, setSessions] = useState(() => new Map());
  const [openPaths, setOpenPaths] = useState([]);
  const [activePath, setActivePath] = useState('');
  const [loadingPaths, setLoadingPaths] = useState(() => new Set());
  const [savingPaths, setSavingPaths] = useState(() => new Set());
  const [fileError, setFileError] = useState('');
  const [autoSave, setAutoSaveState] = useState(readAutoSavePreference);
  // 上传落点：文件树里当前浏览到的目录，默认项目根目录。
  const [uploadDirectory, setUploadDirectory] = useState('');
  const uploadTasks = useSyncExternalStore(subscribeUploads, getUploadSnapshot);
  const uploads = useMemo(
    () => uploadTasks.filter((task) => task.projectKey === projectKey),
    [projectKey, uploadTasks],
  );
  const workspaceTimerRef = useRef(null);
  const workspaceRequestRef = useRef(0);
  const workspaceSnapshotRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const openPathsRef = useRef(openPaths);
  const activePathRef = useRef('');
  const savingRef = useRef(new Set());
  const projectPathRef = useRef('');
  sessionsRef.current = sessions;
  openPathsRef.current = openPaths;

  const filesUrl = useCallback((suffix = '', params = {}) => {
    const query = new URLSearchParams(params);
    if (sessionId) query.set('session', sessionId);
    const search = query.toString();
    return `/api/projects/${encodeURIComponent(projectKey)}/files${suffix}${search ? `?${search}` : ''}`;
  }, [projectKey, sessionId]);

  const fileUrl = useCallback((path) => {
    const params = new URLSearchParams({ path, maxBytes: String(workspaceReadMaxBytes(path)) });
    if (sessionId) params.set('session', sessionId);
    return `/api/projects/${encodeURIComponent(projectKey)}/files/file?${params.toString()}`;
  }, [projectKey, sessionId]);

  /** 二进制直出 URL：PDF / 图片交给浏览器自己渲染，下载走同一个端点的 download=1。 */
  const rawFileUrl = useCallback((path, options) => rawWorkspaceFileUrl(projectKey, path, options), [projectKey]);

  const applyWorkspacePayload = useCallback((data) => {
    if (!data?.tree) return;
    const nextPayload = { summary: data.summary, tree: data.tree };
    workspaceSnapshotRef.current = nextPayload;
    setPayload(nextPayload);
  }, []);

  /** 读一个文件并包成会话；`canEdit` 由 resolveWorkspaceFileView 统一判定。 */
  const readSession = useCallback(async (path) => {
    const data = await apiJson(fileUrl(path));
    const remote = data.file;
    const view = resolveWorkspaceFileView(remote);
    return { session: createFileSession({ ...remote, canEdit: view.canEdit }), remote, view };
  }, [fileUrl]);

  const markLoading = useCallback((path, loading) => {
    setLoadingPaths((current) => {
      const next = new Set(current);
      if (loading) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const refreshWorkspace = useCallback(async ({ debounce = false, showLoading = false } = {}) => {
    if (debounce) {
      clearTimeout(workspaceTimerRef.current);
      workspaceTimerRef.current = setTimeout(() => {
        refreshWorkspace({ showLoading }).catch(console.error);
      }, 300);
      return;
    }
    if (!projectKey) {
      setPayload(null);
      workspaceSnapshotRef.current = null;
      return;
    }
    const requestId = ++workspaceRequestRef.current;
    if (showLoading) setWorkspaceLoading(true);
    try {
      const data = await apiJson(filesUrl());
      if (requestId !== workspaceRequestRef.current) return;
      const changed = !sameWorkspacePayload(workspaceSnapshotRef.current, data);
      if (changed) {
        workspaceSnapshotRef.current = data;
        setPayload(data);
      }
      setWorkspaceError('');
      // 磁盘上的文件可能被 Agent 改过：当前标签若是干净的就跟上磁盘，脏的留着等冲突处理。
      const currentPath = activePathRef.current;
      const current = currentPath ? sessionsRef.current.get(currentPath) : null;
      if (current && !current.dirty && !savingRef.current.has(currentPath)) {
        try {
          const { remote, view } = await readSession(currentPath);
          setSessions((map) => {
            const session = map.get(currentPath);
            if (!session) return map;
            return upsertSession(map, { ...applyRemote(session, remote), canEdit: view.canEdit });
          });
        } catch {
          // 文件可能刚被删除；保留标签，等用户操作时再给出明确错误。
        }
      }
    } catch (error) {
      if (requestId === workspaceRequestRef.current) {
        setWorkspaceError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === workspaceRequestRef.current && showLoading) setWorkspaceLoading(false);
    }
  }, [filesUrl, projectKey, readSession]);

  /** 打开文件：已打开就切过去，否则读进来追加一个标签。返回最终的项目相对路径。 */
  const openFile = useCallback(async (rawPath) => {
    // 工具结果里常见的是项目内的绝对路径；文件 API 只认项目相对路径。
    const path = toProjectRelativePath(rawPath, projectPathRef.current);
    if (!projectKey || !path) return '';
    if (sessionsRef.current.has(path)) {
      setActivePath(path);
      return path;
    }
    markLoading(path, true);
    setFileError('');
    try {
      const { session } = await readSession(path);
      setSessions((map) => upsertSession(map, session));
      setOpenPaths((paths) => addOpenPath(paths, path));
      setActivePath(path);
      return path;
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
      return '';
    } finally {
      markLoading(path, false);
    }
  }, [markLoading, projectKey, readSession]);

  /** 切到某个已打开的标签；干净的文件顺便从磁盘刷一次（懒刷新，避免给每个标签都发请求）。 */
  const activateFile = useCallback((path) => {
    setActivePath(path);
    const session = sessionsRef.current.get(path);
    if (!session || session.dirty || savingRef.current.has(path)) return;
    readSession(path).then(({ remote, view }) => {
      setSessions((map) => {
        const current = map.get(path);
        if (!current) return map;
        return upsertSession(map, { ...applyRemote(current, remote), canEdit: view.canEdit });
      });
    }).catch(() => {
      // 读不到就保持现状；真正操作时再报错。
    });
  }, [readSession]);

  /** 关掉一个或多个标签，返回关完之后应该激活的路径（空串=回到「项目文件」）。 */
  const closeFiles = useCallback((paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return activePathRef.current;
    const nextSessions = list.reduce((map, path) => removeSession(map, path), sessionsRef.current);
    const nextPaths = list.reduce((paths_, path) => removeOpenPath(paths_, path), openPathsRef.current);
    const nextActive = list.includes(activePathRef.current)
      ? activePathAfterClose(openPathsRef.current, list)
      : activePathRef.current;
    setSessions(nextSessions);
    setOpenPaths(nextPaths);
    setActivePath(nextActive);
    setFileError('');
    return nextActive;
  }, []);

  const closeFile = useCallback((path) => closeFiles([path]), [closeFiles]);

  const updateDraft = useCallback((path, content) => {
    setSessions((map) => {
      const session = map.get(path);
      if (!session) return map;
      return upsertSession(map, applyDraft(session, content));
    });
  }, []);

  const saveFile = useCallback(async ({ path = activePathRef.current, force = false } = {}) => {
    const current = sessionsRef.current.get(path);
    if (!projectKey || !current?.canEdit || savingRef.current.has(path)) return;
    savingRef.current.add(path);
    setSavingPaths((set) => new Set(set).add(path));
    setFileError('');
    try {
      const baseVersion = force ? (current.conflict?.version ?? null) : current.version;
      // tree=0：保存只需要文件自己的新版本号，整棵树交给后台轮询去刷新。
      const data = await apiJson(filesUrl('/file', { tree: 0 }), {
        method: 'PUT',
        body: JSON.stringify({ path: current.path, content: current.content, baseVersion }),
      });
      setSessions((map) => {
        const session = map.get(path);
        if (!session) return map;
        return upsertSession(map, applySave(session, data.file));
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSessions((map) => {
          const session = map.get(path);
          if (!session) return map;
          return upsertSession(map, applyConflict(session, {
            version: error.payload?.version ?? null,
            size: error.payload?.size ?? 0,
            mtimeMs: error.payload?.mtimeMs ?? 0,
          }));
        });
      } else {
        setFileError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      savingRef.current.delete(path);
      setSavingPaths((set) => {
        const next = new Set(set);
        next.delete(path);
        return next;
      });
    }
  }, [applyWorkspacePayload, filesUrl, projectKey]);

  /** 放弃本地改动、取磁盘版本：冲突横条的「重新加载」，也用于文件被外部删除后重开。 */
  const reloadFile = useCallback(async (path = activePathRef.current) => {
    if (!projectKey || !path) return;
    setFileError('');
    try {
      const { session } = await readSession(path);
      setSessions((map) => upsertSession(map, session));
    } catch (error) {
      // 磁盘上已经没有了：关掉这个标签并给出提示，而不是留着一个不存在的文件。
      closeFile(path);
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }, [closeFile, projectKey, readSession]);

  const saveFileRef = useRef(saveFile);
  saveFileRef.current = saveFile;

  // 自动保存：任何一份会话变脏都重新计时，停笔 AUTOSAVE_DELAY_MS 后把所有该存的存掉。
  const autoSaveQueue = useMemo(
    () => autoSaveTargets(sessions, { autoSave, savingPaths }),
    [autoSave, savingPaths, sessions],
  );
  useEffect(() => {
    if (!autoSaveQueue.length) return undefined;
    const paths = autoSaveQueue.map((session) => session.path);
    const timer = setTimeout(() => {
      for (const path of paths) {
        const session = sessionsRef.current.get(path);
        if (shouldAutoSave(session, { autoSave: true, saving: savingRef.current.has(path) })) {
          saveFileRef.current({ path }).catch(console.error);
        }
      }
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoSaveQueue]);

  const setAutoSave = useCallback((enabled) => {
    const next = Boolean(enabled);
    setAutoSaveState(next);
    try {
      localStorage.setItem(AUTO_SAVE_KEY, autoSavePreferenceValue(next));
    } catch {
      // 忽略持久化失败
    }
  }, []);

  const uploadWorkspaceFile = useCallback(async (files) => {
    if (!projectKey) return;
    const selectedFiles = Array.isArray(files) ? files : [files].filter(Boolean);
    if (!selectedFiles.length) return;
    // 大文件走分块管理器（可续传、有进度）；小文件保持原来的单请求直传。
    const chunked = selectedFiles.filter((item) => shouldChunkUpload(item.size));
    const direct = selectedFiles.filter((item) => !shouldChunkUpload(item.size));
    if (chunked.length) {
      enqueueUploads(chunked, { projectKey, directory: uploadDirectory, sessionId });
    }
    if (!direct.length) return;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    try {
      for (const item of direct) {
        // 上传落在文件树里当前浏览的目录；没有浏览上下文时就是项目根目录。
        const latest = await uploadBinaryFile(filesUrl('/upload'), item, {
          fileName: item.name,
          path: projectUploadPath(item, uploadDirectory),
        });
        applyWorkspacePayload(latest);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkspaceError(`上传失败：${message}`);
    } finally {
      setWorkspaceLoading(false);
    }
  }, [applyWorkspacePayload, filesUrl, projectKey, sessionId, uploadDirectory]);

  const deleteWorkspaceItem = useCallback(async (rawPath) => {
    const path = normalizeWorkspaceDirectory(rawPath);
    if (!projectKey || !isProjectEditablePath(path)) return;
    try {
      const data = await apiJson(filesUrl('/item'), {
        method: 'DELETE',
        body: JSON.stringify({ path }),
      });
      applyWorkspacePayload(data);
      // 删掉的文件（或目录下所有文件）连同标签一起收掉。
      const affected = openPathsRef.current.filter((openPath) => openPath === path || openPath.startsWith(`${path}/`));
      if (affected.length) closeFiles(affected);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }, [applyWorkspacePayload, closeFiles, filesUrl, projectKey]);

  const createWorkspaceItem = useCallback(async (rawPath, type = 'file') => {
    const path = normalizeWorkspaceDirectory(rawPath);
    if (!projectKey || !path || !isProjectEditablePath(path)) return null;
    try {
      const data = await apiJson(filesUrl('/item'), {
        method: 'POST',
        body: JSON.stringify({ path, type }),
      });
      applyWorkspacePayload(data);
      return data.node;
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [applyWorkspacePayload, filesUrl, projectKey]);

  const moveWorkspaceItem = useCallback(async (rawFrom, rawTo) => {
    const from = normalizeWorkspaceDirectory(rawFrom);
    const to = normalizeWorkspaceDirectory(rawTo);
    if (!projectKey || !from || !to || !isProjectEditablePath(from) || !isProjectEditablePath(to)) return null;
    try {
      const data = await apiJson(filesUrl('/move'), {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      });
      applyWorkspacePayload(data);
      // 重命名/移动：把会话与标签原地搬到新路径，草稿和版本基线都跟着走。
      const affected = openPathsRef.current.filter((path) => path === from || path.startsWith(`${from}/`));
      if (affected.length) {
        const remap = (path) => `${to}${path.slice(from.length)}`;
        const moved = new Map(affected.map((path) => [path, remap(path)]));
        setSessions((map) => {
          let next = map;
          for (const [path, nextPath] of moved) next = renameSession(next, path, nextPath);
          return next;
        });
        setOpenPaths((paths) => paths.map((path) => moved.get(path) || path));
        setActivePath((current) => moved.get(current) || current);
      }
      return data.node;
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [applyWorkspacePayload, filesUrl, projectKey]);

  // 换项目时回到根目录、关掉上一个项目的所有标签，避免把文件上传进或显示成上一个项目的内容。
  useEffect(() => {
    setUploadDirectory('');
    setSessions(new Map());
    setOpenPaths([]);
    setActivePath('');
    setFileError('');
  }, [projectKey]);

  const changeUploadDirectory = useCallback((value) => {
    setUploadDirectory(normalizeWorkspaceDirectory(value));
  }, []);

  // 刷新后接回未完成的分块任务（File 对象已丢，需要用户重选同一文件）。
  useEffect(() => {
    restoreUploads();
  }, []);

  // 分块上传完成时刷新文件树；任务可能在切到别的项目后才完成，因此按 projectKey 过滤。
  useEffect(() => onUploadEvent((event) => {
    if (event?.type === 'completed' && event.projectKey === projectKey) applyWorkspacePayload(event.payload);
  }), [applyWorkspacePayload, projectKey]);

  // 正在上传时离开页面要提示：刷新会丢掉 File 引用，只能重新选择文件续传。
  useEffect(() => {
    const active = uploadTasks.some((task) => ['preparing', 'queued', 'uploading', 'completing'].includes(task.status));
    if (!active) return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploadTasks]);

  useEffect(() => () => clearTimeout(workspaceTimerRef.current), []);

  activePathRef.current = activePath;
  projectPathRef.current = payload?.summary?.projectPath || '';

  return {
    tree: payload?.tree || null,
    summary: payload?.summary || null,
    workspaceLoading,
    workspaceError,
    sessions,
    openPaths,
    activePath,
    loadingPaths,
    fileError,
    savingPaths,
    autoSave,
    uploadDirectory,
    setUploadDirectory: changeUploadDirectory,
    refreshWorkspace,
    openFile,
    activateFile,
    rawFileUrl,
    closeFile,
    closeFiles,
    updateDraft,
    saveFile,
    reloadFile,
    setAutoSave,
    createWorkspaceItem,
    moveWorkspaceItem,
    deleteWorkspaceItem,
    uploadWorkspaceFile,
    uploads,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    retryUpload,
    dismissUpload,
    attachUploadFile,
  };
}
