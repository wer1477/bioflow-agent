import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../api.js';
import { splitProjectsAndOrphans } from '../domain/project_tree.js';

/** 项目列表 / 回收站 / 未分组会话的统一入口。 */
export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [trashItems, setTrashItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson('/api/projects');
      const { projects: rows, orphans: orphanRows } = splitProjectsAndOrphans(data);
      setProjects(rows);
      setOrphans(orphanRows);
      setError('');
      return rows;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      const data = await apiJson('/api/projects/trash');
      setTrashItems(data.items || []);
      return data.items || [];
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  const createProject = useCallback(async (name) => {
    const data = await apiJson('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    await refresh();
    return data.project;
  }, [refresh]);

  const renameProject = useCallback(async (key, title) => {
    const data = await apiJson(`/api/projects/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    await refresh();
    return data.project;
  }, [refresh]);

  const deleteProject = useCallback(async (key) => {
    const data = await apiJson(`/api/projects/${encodeURIComponent(key)}`, { method: 'DELETE' });
    await Promise.all([refresh(), loadTrash()]);
    return data.trashed;
  }, [refresh, loadTrash]);

  const restoreTrash = useCallback(async (name) => {
    const data = await apiJson(`/api/projects/trash/${encodeURIComponent(name)}/restore`, { method: 'POST' });
    await Promise.all([refresh(), loadTrash()]);
    return data.project;
  }, [refresh, loadTrash]);

  const assignOrphan = useCallback(async (sessionId, projectKey) => {
    const data = await apiJson(`/api/projects/orphans/${encodeURIComponent(sessionId)}/assign`, {
      method: 'POST',
      body: JSON.stringify({ project: projectKey }),
    });
    await refresh();
    return data.conversation;
  }, [refresh]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return {
    projects,
    orphans,
    trashItems,
    loading,
    error,
    refresh,
    loadTrash,
    createProject,
    renameProject,
    deleteProject,
    restoreTrash,
    assignOrphan,
  };
}
