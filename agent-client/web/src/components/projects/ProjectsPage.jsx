import { useCallback, useMemo, useState } from 'react';
import { navigate } from '../../app/router.js';
import {
  canDeleteProject,
  groupConversationsByProject,
  isExpandedKey,
  orphanSubtitle,
  projectSubtitle,
  searchProjects,
  sortProjects,
  toggleExpandedKey,
} from '../../domain/project_tree.js';

/** 项目列表页：创建、重命名、移除（进回收站）、跨项目搜索、未分组会话指派、回收站恢复。 */
export function ProjectsPage({ projects, conversations, orphans, trashItems, loading, error, onCreate, onRename, onDelete, onRestore, onLoadTrash, onAssignOrphan }) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [renamingKey, setRenamingKey] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());

  const run = useCallback(async (action) => {
    setBusy(true);
    setNotice('');
    try {
      await action();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const submitCreate = useCallback(async (event) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await run(async () => {
      const project = await onCreate(name);
      setNewName('');
      if (project) navigate({ name: 'project', projectKey: project.key });
    });
  }, [newName, onCreate, run]);

  const submitRename = useCallback(async (event, project) => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!title || title === project.title) {
      setRenamingKey('');
      return;
    }
    await run(async () => {
      const renamed = await onRename(project.key, title);
      setRenamingKey('');
      if (renamed) navigate({ name: 'project', projectKey: renamed.key });
    });
  }, [onRename, renameValue, run]);

  const confirmDelete = useCallback((project) => {
    if (!window.confirm(`移除项目“${project.title}”？目录会移入 workspace/.trash，不会被删除，会话转为未分组。`)) return;
    run(() => onDelete(project.key));
  }, [onDelete, run]);

  const toggleSection = useCallback((key) => {
    setExpanded((keys) => toggleExpandedKey(keys, key));
  }, []);

  const toggleTrash = useCallback(async () => {
    const willOpen = !isExpandedKey(expanded, 'trash');
    setExpanded((keys) => toggleExpandedKey(keys, 'trash'));
    if (willOpen) await onLoadTrash();
  }, [expanded, onLoadTrash]);

  const ordered = useMemo(() => sortProjects(projects), [projects]);
  const matches = useMemo(
    () => searchProjects(ordered, groupConversationsByProject(conversations, ordered), query),
    [ordered, conversations, query],
  );
  const searching = Boolean(query.trim());
  const trashOpen = isExpandedKey(expanded, 'trash');
  const orphansOpen = isExpandedKey(expanded, 'orphans');

  return (
    <main className="main-panel projects-panel">
      <header className="projects-header">
        <div>
          <h2>项目</h2>
          <p className="projects-hint">workspace 下的一级目录就是项目；每个项目可以开多个会话，会话的 agent 工作目录就是项目目录。</p>
        </div>
        <div className="projects-header-actions">
          <input
            type="search"
            className="projects-search"
            value={query}
            placeholder="搜索项目或会话"
            aria-label="搜索项目或会话"
            onChange={(event) => setQuery(event.target.value)}
          />
          <form className="projects-create" onSubmit={submitCreate}>
            <input
              type="text"
              value={newName}
              placeholder="新项目名称"
              aria-label="新项目名称"
              onChange={(event) => setNewName(event.target.value)}
            />
            <button className="primary-button" type="submit" disabled={busy || !newName.trim()}>新建项目</button>
          </form>
        </div>
      </header>

      {(notice || error) && <div className="projects-status error" role="alert">{notice || error}</div>}
      {loading && <div className="projects-status">正在加载…</div>}

      {searching ? (
        <section className="projects-section">
          <h3>搜索结果 {matches.length ? `(${matches.length})` : ''}</h3>
          {matches.length === 0 ? <p className="projects-hint">没有匹配的项目或会话。</p> : (
            <ul className="project-search-results">
              {matches.map(({ project, sessions }) => (
                <li key={project.key}>
                  <button className="project-open" type="button" onClick={() => navigate({ name: 'project', projectKey: project.key })}>
                    <strong>{project.title}</strong>
                    <span>{projectSubtitle(project)}</span>
                  </button>
                  {sessions.length > 0 && (
                    <ul className="project-search-sessions">
                      {sessions.map((session) => (
                        <li key={session.id}>
                          <button
                            type="button"
                            title={session.title}
                            onClick={() => navigate({ name: 'session', projectKey: project.key, sessionId: session.id })}
                          >
                            {session.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : ordered.length === 0 && !loading ? (
        <div className="projects-empty">
          <strong>还没有项目</strong>
          <span>在上方输入名称创建一个空目录，然后在里面开始第一个会话。</span>
        </div>
      ) : (
        <ul className="project-list">
          {ordered.map((project) => (
            <li key={project.key} className={`project-row${project.runningCount ? ' is-running' : ''}`}>
              {renamingKey === project.key ? (
                <form className="project-rename-form" onSubmit={(event) => submitRename(event, project)}>
                  <input autoFocus aria-label="新的项目名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                  <div>
                    <button className="secondary-button" type="button" onClick={() => setRenamingKey('')}>取消</button>
                    <button className="primary-button" type="submit">保存</button>
                  </div>
                </form>
              ) : (
                <>
                  <button className="project-open" type="button" onClick={() => navigate({ name: 'project', projectKey: project.key })}>
                    <strong>{project.title}</strong>
                    <span>{projectSubtitle(project)}</span>
                  </button>
                  <div className="project-row-actions">
                    <button className="secondary-button" type="button" onClick={() => { setRenamingKey(project.key); setRenameValue(project.title); }}>重命名</button>
                    <button
                      className="secondary-button danger"
                      type="button"
                      title={canDeleteProject(project) ? '移入回收站' : '项目里有正在运行的会话，先停止再移除'}
                      disabled={busy || !canDeleteProject(project)}
                      onClick={() => confirmDelete(project)}
                    >
                      移除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="projects-section">
        <button className="projects-section-toggle" type="button" onClick={toggleTrash} aria-expanded={trashOpen}>
          {trashOpen ? '▾' : '▸'} 回收站 {trashItems.length ? `(${trashItems.length})` : ''}
        </button>
        {trashOpen && (
          trashItems.length ? (
            <ul className="trash-list">
              {trashItems.map((item) => (
                <li key={item.name}>
                  <span title={item.path}>{item.name}</span>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => run(() => onRestore(item.name))}>恢复</button>
                </li>
              ))}
            </ul>
          ) : <p className="projects-hint">回收站为空。移除的项目会先进入这里。</p>
        )}
      </section>

      <section className="projects-section">
        <button className="projects-section-toggle" type="button" onClick={() => toggleSection('orphans')} aria-expanded={orphansOpen}>
          {orphansOpen ? '▾' : '▸'} 未分组会话 {orphans.length ? `(${orphans.length})` : ''}
        </button>
        {orphansOpen && (
          orphans.length ? (
            <ul className="orphan-list">
              {orphans.map((orphan) => (
                <li key={orphan.id}>
                  <div>
                    <strong>{orphan.title}</strong>
                    <span title={orphan.projectPath || ''}>{orphanSubtitle(orphan)}</span>
                  </div>
                  <select
                    aria-label={`把会话 ${orphan.title} 指派到项目`}
                    defaultValue=""
                    disabled={busy || !ordered.length}
                    onChange={(event) => {
                      const key = event.target.value;
                      event.target.value = '';
                      if (key) run(() => onAssignOrphan(orphan.id, key));
                    }}
                  >
                    <option value="">指派到…</option>
                    {ordered.map((project) => <option key={project.key} value={project.key}>{project.title}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          ) : <p className="projects-hint">没有未分组的会话。</p>
        )}
      </section>
    </main>
  );
}
