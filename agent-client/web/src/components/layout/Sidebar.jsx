import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { formatDate } from '../../format.js';
import {
  canDeleteProject,
  DEFAULT_VISIBLE_PROJECTS,
  DEFAULT_VISIBLE_SESSIONS,
  isExpandedKey,
  matchProjects,
  orphanSubtitle,
  projectSubtitle,
  sessionsForProject,
  sortProjects,
  toggleExpandedKey,
  visibleProjects,
  visibleSessions,
} from '../../domain/project_tree.js';
import {
  ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, EditIcon, MoreHorizontalIcon,
  PinIcon, PlusIcon, ProjectIcon, SearchIcon, TrashIcon,
} from '../common/icons.jsx';
import { AccountMenu } from './AccountMenu.jsx';

/**
 * 左侧栏 = 项目树（参考 dsh 的布局）：
 * 项目是可展开的顶层节点，会话嵌在项目下面；新建项目、重命名、移除都在这里完成。
 */
export const Sidebar = memo(function Sidebar({
  collapsed,
  onToggle,
  projects,
  sessionsByProject,
  orphans,
  trashItems,
  loading,
  currentProjectKey,
  currentConversationId,
  query,
  onQueryChange,
  runningConversationIds,
  completedConversationIds,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onToggleSessionPin,
  onDeleteSession,
  onAssignOrphan,
  onRestoreTrash,
  onLoadTrash,
  settingsSection,
  onOpenSettings,
  account,
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [expandedSessionKeys, setExpandedSessionKeys] = useState(() => new Set());
  const [projectMenuKey, setProjectMenuKey] = useState('');
  const [renamingProjectKey, setRenamingProjectKey] = useState('');
  const [projectRenameValue, setProjectRenameValue] = useState('');
  const [sessionMenuKey, setSessionMenuKey] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState('');
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [orphansOpen, setOrphansOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [allProjectsOpen, setAllProjectsOpen] = useState(false);
  const [revealProjectKey, setRevealProjectKey] = useState('');
  const treeRef = useRef(null);

  // 当前项目始终展开
  useEffect(() => {
    if (!currentProjectKey) return;
    setExpandedKeys((keys) => (keys.has(currentProjectKey) ? keys : new Set(keys).add(currentProjectKey)));
  }, [currentProjectKey]);

  const needle = query.trim();
  const { projects: shownProjects, sessionsByProject: shownSessions } = useMemo(
    () => matchProjects(sortProjects(projects), sessionsByProject, needle),
    [needle, projects, sessionsByProject],
  );

  // 项目几百个时默认只列最近的一小段；当前项目和运行中的项目始终保留，搜索或点
  // “显示全部项目”时看全量。
  const { visible: projectRows, hidden: hiddenProjects } = useMemo(
    () => visibleProjects(shownProjects, {
      currentKey: currentProjectKey,
      expanded: allProjectsOpen || Boolean(needle),
      limit: DEFAULT_VISIBLE_PROJECTS,
    }),
    [allProjectsOpen, currentProjectKey, needle, shownProjects],
  );

  // 新建的项目可能落在收起段里：列表展开后把它滚进视野，再清掉待滚动标记。
  useEffect(() => {
    if (!revealProjectKey) return;
    const node = Array.from(treeRef.current?.querySelectorAll('[data-project-key]') || [])
      .find((element) => element.dataset.projectKey === revealProjectKey);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    setRevealProjectKey('');
  }, [revealProjectKey, projectRows]);

  const closeMenus = () => {
    setProjectMenuKey('');
    setRenamingProjectKey('');
    setSessionMenuKey('');
    setRenamingSessionId('');
  };

  const run = async (action) => {
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const submitNewProject = async (event) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    await run(async () => {
      const project = await onCreateProject(name);
      setNewProjectName('');
      setCreating(false);
      if (project?.key) {
        setAllProjectsOpen(true);
        setRevealProjectKey(project.key);
      }
    });
  };

  const submitProjectRename = async (event, project) => {
    event.preventDefault();
    const title = projectRenameValue.trim();
    if (!title || title === project.title) {
      closeMenus();
      return;
    }
    await run(async () => {
      await onRenameProject(project.key, title);
      closeMenus();
    });
  };

  const submitSessionRename = async (event, projectKey, session) => {
    event.preventDefault();
    const title = sessionRenameValue.trim();
    if (!title) return;
    await run(async () => {
      await onRenameSession(session.id, title);
      closeMenus();
    });
  };

  return (
    <aside id="sidebar" className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-lockup">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M5 18c4-9 10-12 21-13-1 11-5 18-14 21" />
              <path d="M9 22c4-5 8-8 14-12M13 18l1 5M18 14l4 1" />
            </svg>
            <h1>Bioflow</h1>
          </div>
          <div className="brand-actions">
            <button className="sidebar-top-icon sidebar-search-toggle" type="button" data-tooltip="搜索项目或会话" aria-label="搜索项目或会话" aria-pressed={searchOpen} onClick={() => setSearchOpen((value) => !value)}>
              <SearchIcon />
            </button>
            <button id="sidebarToggleBtn" className="sidebar-top-icon" type="button" data-tooltip={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={onToggle}>
              {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </button>
          </div>
        </div>
        {searchOpen && (
          <div className="sidebar-toolbar">
            <input autoFocus type="search" placeholder="搜索项目或会话" aria-label="搜索项目或会话" value={query} onChange={(event) => onQueryChange(event.target.value)} />
          </div>
        )}
        {creating ? (
          <form className="project-create-form" onSubmit={submitNewProject}>
            <input
              autoFocus
              aria-label="新项目名称"
              placeholder="新项目名称"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
            />
            <div className="project-create-actions">
              <button className="secondary-button" type="button" onClick={() => { setCreating(false); setNewProjectName(''); }}>取消</button>
              <button className="primary-button" type="submit" disabled={!newProjectName.trim()}>创建</button>
            </div>
          </form>
        ) : (
          <button className="new-project-button" type="button" onClick={() => { setCreating(true); setNotice(''); }}>
            <span aria-hidden="true">+</span>
            新建项目
          </button>
        )}
        {notice && <div className="sidebar-notice" role="alert">{notice}</div>}
      </div>

      <nav className="project-tree" ref={treeRef} aria-label="项目与会话">
        {loading && !shownProjects.length && <p className="sidebar-empty">正在加载…</p>}
        {!loading && !shownProjects.length && (
          <p className="sidebar-empty">{needle ? '没有匹配的项目或会话' : '还没有项目。点上方“新建项目”创建一个空目录。'}</p>
        )}

        {/* 项目一多，默认只列最近一段；这行常驻在列表顶部，随时可以展开/收起。 */}
        {(hiddenProjects > 0 || (allProjectsOpen && !needle && shownProjects.length > DEFAULT_VISIBLE_PROJECTS)) && (
          <button className="project-list-toggle" type="button" onClick={() => setAllProjectsOpen((open) => !open)}>
            {hiddenProjects > 0 ? `共 ${shownProjects.length} 个项目 · 显示全部` : '收起项目列表'}
          </button>
        )}

        {projectRows.map((project) => {
          const expanded = isExpandedKey(expandedKeys, project.key) || Boolean(needle);
          const allSessions = sessionsForProject(shownSessions, project.key);
          const sessions = needle ? allSessions : sessionsForProject(sessionsByProject, project.key);
          const { visible, hidden } = visibleSessions(sessions, {
            expanded: isExpandedKey(expandedSessionKeys, project.key),
            limit: DEFAULT_VISIBLE_SESSIONS,
            runningIds: runningConversationIds,
          });
          const menuOpen = projectMenuKey === project.key;
          const active = project.key === currentProjectKey;
          const running = Number(project.runningCount || 0) > 0;
          return (
            <div className={`project-node${active ? ' active' : ''}`} key={project.key} data-project-key={project.key}>
              {renamingProjectKey === project.key ? (
                <form className="project-rename-form" onSubmit={(event) => submitProjectRename(event, project)}>
                  <input autoFocus aria-label="新的项目名称" value={projectRenameValue} onChange={(event) => setProjectRenameValue(event.target.value)} />
                  <div className="project-create-actions">
                    <button className="secondary-button" type="button" onClick={closeMenus}>取消</button>
                    <button className="primary-button" type="submit">保存</button>
                  </div>
                </form>
              ) : (
                <div className={`project-row${menuOpen ? ' menu-open' : ''}`}>
                  <button
                    className="project-toggle"
                    type="button"
                    aria-label={expanded ? `收起项目 ${project.title}` : `展开项目 ${project.title}`}
                    aria-expanded={expanded}
                    onClick={() => setExpandedKeys((keys) => toggleExpandedKey(keys, project.key))}
                  >
                    {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  </button>
                  <button className="project-open" type="button" onClick={() => onSelectProject(project.key)} data-tooltip={project.path}>
                    <ProjectIcon />
                    <strong>{project.title}</strong>
                    <span className={running ? 'project-meta is-running' : 'project-meta'}>{projectSubtitle(project)}</span>
                  </button>
                  <button
                    className="project-menu-trigger"
                    type="button"
                    aria-label={`项目操作：${project.title}`}
                    aria-expanded={menuOpen}
                    onClick={() => { if (menuOpen) closeMenus(); else { closeMenus(); setProjectMenuKey(project.key); } }}
                  >
                    <MoreHorizontalIcon />
                  </button>
                  {menuOpen && (
                    <div className="project-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setRenamingProjectKey(project.key); setProjectRenameValue(project.title); }}><EditIcon /><span>重命名</span></button>
                      <button type="button" role="menuitem" onClick={() => { closeMenus(); onNewSession(project.key); }}><PlusIcon /><span>新建会话</span></button>
                      <button
                        className="danger"
                        type="button"
                        role="menuitem"
                        disabled={!canDeleteProject(project)}
                        data-tooltip={canDeleteProject(project) ? '' : '项目里有正在运行的会话'}
                        onClick={() => {
                          if (!window.confirm(`移除项目“${project.title}”？目录会移入 workspace/.trash，不会被删除，会话转为未分组。`)) return;
                          closeMenus();
                          run(() => onDeleteProject(project.key));
                        }}
                      >
                        <TrashIcon /><span>移除项目</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {expanded && (
                <div className="session-list">
                  {visible.map((session) => {
                    const compound = `${project.key}:${session.id}`;
                    const sessionMenuOpen = sessionMenuKey === compound;
                    const renaming = renamingSessionId === session.id;
                    return (
                      <div key={session.id} className={`conversation-row${session.id === currentConversationId ? ' active' : ''}${sessionMenuOpen ? ' menu-open' : ''}`}>
                        <button className="conversation-item" type="button" onClick={() => onSelectSession(project.key, session.id)}>
                          <strong>{session.title}</strong>
                          <span>{formatDate(session.updatedAt)}</span>
                        </button>
                        {runningConversationIds.has(session.id) ? (
                          <span className="conversation-activity is-running" title="Agent 正在运行" aria-label="Agent 正在运行" />
                        ) : completedConversationIds.has(session.id) ? (
                          <span className="conversation-activity has-completed" title="任务已完成" aria-label="任务已完成" />
                        ) : session.pinned && <span className="conversation-pinned" title="已置顶" aria-label="已置顶"><PinIcon /></span>}
                        <button
                          className="conversation-menu-trigger"
                          type="button"
                          title="会话操作"
                          aria-label={`操作会话：${session.title}`}
                          aria-expanded={sessionMenuOpen}
                          onClick={() => { if (sessionMenuOpen) closeMenus(); else { closeMenus(); setSessionMenuKey(compound); } }}
                        >
                          <MoreHorizontalIcon />
                        </button>
                        {sessionMenuOpen && (
                          <div className="conversation-menu" role="menu">
                            {renaming ? (
                              <form className="conversation-rename-form" onSubmit={(event) => submitSessionRename(event, project.key, session)}>
                                <input autoFocus aria-label="新的会话名称" value={sessionRenameValue} onChange={(event) => setSessionRenameValue(event.target.value)} />
                                <div>
                                  <button className="secondary-button" type="button" onClick={closeMenus}>取消</button>
                                  <button className="primary-button" type="submit">保存</button>
                                </div>
                              </form>
                            ) : (
                              <>
                                <button type="button" role="menuitem" onClick={() => { setRenamingSessionId(session.id); setSessionRenameValue(session.title); }}><EditIcon /><span>重命名</span></button>
                                <button type="button" role="menuitem" onClick={async () => { await onToggleSessionPin(session.id, !session.pinned); closeMenus(); }}><PinIcon /><span>{session.pinned ? '取消置顶' : '置顶'}</span></button>
                                <button className="danger" type="button" role="menuitem" onClick={async () => { await onDeleteSession(session.id); closeMenus(); }}><TrashIcon /><span>删除</span></button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {hidden > 0 && (
                    <button className="show-more-sessions" type="button" onClick={() => setExpandedSessionKeys((keys) => new Set(keys).add(project.key))}>
                      显示更多（还有 {hidden} 个）
                    </button>
                  )}
                  <button className="new-session-row" type="button" onClick={() => onNewSession(project.key)}>
                    <PlusIcon /> 新会话
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {orphans.length > 0 && (
          <div className="sidebar-section">
            <button className="sidebar-section-toggle" type="button" aria-expanded={orphansOpen} onClick={() => setOrphansOpen((value) => !value)}>
              {orphansOpen ? <ChevronDownIcon /> : <ChevronRightIcon />} 未分组会话 ({orphans.length})
            </button>
            {orphansOpen && (
              <ul className="orphan-list">
                {orphans.map((orphan) => (
                  <li key={orphan.id}>
                    <div>
                      <strong>{orphan.title}</strong>
                      <span data-tooltip={orphan.projectPath || ''}>{orphanSubtitle(orphan)}</span>
                    </div>
                    <select
                      aria-label={`把会话 ${orphan.title} 指派到项目`}
                      defaultValue=""
                      disabled={!projects.length}
                      onChange={(event) => {
                        const key = event.target.value;
                        event.target.value = '';
                        if (key) run(() => onAssignOrphan(orphan.id, key));
                      }}
                    >
                      <option value="">指派到…</option>
                      {sortProjects(projects).map((project) => <option key={project.key} value={project.key}>{project.title}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="sidebar-section">
          <button
            className="sidebar-section-toggle"
            type="button"
            aria-expanded={trashOpen}
            onClick={() => { const next = !trashOpen; setTrashOpen(next); if (next) run(onLoadTrash); }}
          >
            {trashOpen ? <ChevronDownIcon /> : <ChevronRightIcon />} 回收站 ({trashItems.length})
          </button>
          {trashOpen && (
            trashItems.length ? (
              <ul className="trash-list">
                {trashItems.map((item) => (
                  <li key={item.name}>
                    <span data-tooltip={item.path}>{item.name}</span>
                    <button className="secondary-button" type="button" onClick={() => run(() => onRestoreTrash(item.name))}>恢复</button>
                  </li>
                ))}
              </ul>
            ) : <p className="sidebar-empty">回收站为空。</p>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <AccountMenu settingsSection={settingsSection} onOpenSettings={onOpenSettings} account={account} />
      </div>
    </aside>
  );
});
