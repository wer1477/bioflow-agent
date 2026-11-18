import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../api.js';
import { ChatView } from '../components/chat/ChatView.jsx';
import { ToastViewport } from '../components/common/ToastViewport.jsx';
import { Sidebar } from '../components/layout/Sidebar.jsx';
import { SettingsView } from '../components/settings/SettingsView.jsx';
import { GeneralSettingsView } from '../components/settings/GeneralSettingsView.jsx';
import { findProject, groupSessionsByProject, sessionsForProject } from '../domain/project_tree.js';
import { shouldReloadSettledConversation } from '../domain/activity_view.js';
import { buildModelCatalog } from '../domain/model_selection.js';
import { useToast } from '../hooks/useToast.js';
import { applyTheme, parsePreference, prefersDark, readPreference, rememberPreference, resolveTheme, watchSystemTheme } from './theme.js';
import { parseCollapseTiming, readCollapseTiming, rememberCollapseTiming } from './chat_preferences.js';
import { buildHash, navigate, useRoute } from './router.js';
import { useActiveConversation } from '../hooks/useActiveConversation.js';
import { useConversationStats } from '../hooks/useConversationStats.js';
import { useConversation } from '../hooks/useConversation.js';
import { useConversationActions } from '../hooks/useConversationActions.js';
import { useConversationActivity } from '../hooks/useConversationActivity.js';
import { useProjects } from '../hooks/useProjects.js';
import { useRun } from '../hooks/useRun.js';
import { useSettings } from '../hooks/useSettings.js';
import { useUserLlm } from '../hooks/useUserLlm.js';
import { useSubagents } from '../hooks/useSubagents.js';
import { findSubagentRow } from '../domain/subagent_view.js';
import { useWorkspace } from '../hooks/useWorkspace.js';

export function App({ account }) {
  const route = useRoute();
  const [settingsTab, setSettingsTab] = useState('agent');
  // 当前会话所属的团队（角色名册、模式、活跃角色、交接卡）。每个会话都是一个团队根。
  const [team, setTeam] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 主题偏好是「用户选了什么」，生效主题是它的派生值：system 时看系统深浅色。
  const [themePreference, setThemePreference] = useState(readPreference);
  // 对话里整轮过程的收起时机，同样是浏览器级偏好，选中即时生效。
  const [collapseTiming, setCollapseTiming] = useState(readCollapseTiming);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const theme = resolveTheme(themePreference, systemDark);
  const { toasts, toast, removeToast } = useToast();

  const projectKey = route.name === 'project' || route.name === 'session' ? route.projectKey : '';
  const routeSessionId = route.name === 'session' ? route.sessionId : '';

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 只在偏好是 system 时才让系统变更影响生效主题；显式选了 light/dark 的用户不被覆盖。
  useEffect(() => watchSystemTheme(setSystemDark), []);

  // `#/settings` 是旧入口：补成规范 URL，replace 不产生额外历史。
  useEffect(() => {
    if (route.name === 'settings' && !route.section) {
      window.location.replace(buildHash({ name: 'settings', section: 'agent' }));
    }
  }, [route]);

  const settings = useSettings();
  const userLlm = useUserLlm(account);
  // 输入框模型选择器的可选项：管理员/开发实例用全局 provider 列表，受限用户用
  // `/api/me/llm` 的「系统预置 + 自己的 provider」——与设置页完全同源，不新增权限面。
  const modelCatalog = useMemo(
    () => buildModelCatalog({ settings: settings.settings, userLlm: userLlm.data }),
    [settings.settings, userLlm.data],
  );
  const projects = useProjects();
  const active = useActiveConversation();
  // 侧栏要展示所有项目的会话树，因此拉全量会话，分组在前端完成。
  const conversation = useConversation('');
  const currentProject = findProject(projects.projects, projectKey);
  const sessionsByProject = useMemo(() => {
    const pathToKey = new Map(projects.projects.map((project) => [project.path, project.key]));
    return groupSessionsByProject(conversation.conversations, pathToKey);
  }, [conversation.conversations, projects.projects]);
  const currentSessions = sessionsForProject(sessionsByProject, projectKey);
  const stats = useConversationStats({
    currentConversationId: active.currentConversation?.id,
    selectedAgentId: settings.selectedAgentId,
  });
  const workspace = useWorkspace({
    projectKey,
    sessionId: active.currentConversation?.id || routeSessionId,
  });

  // 跨 hook 环：startRun 依赖 selectConversation，selectConversation 依赖 run/workspace 的 reset。
  // 用 ref 延迟绑定让 startRun 始终拿到最新的 selectConversation，同时保持 startRun 稳定。
  const selectConversationRef = useRef(null);
  const stableSelect = useCallback((id) => selectConversationRef.current?.(id), []);

  // 运行圈/完成点的后端来源：角色会话和委派子 Agent 的 run 不由当前页面发起，
  // 只看本地 run 状态会漏掉"别的会话正在跑"这件事。也要在 useRun 之前拿到，
  // 因为"这个会话是不是被占住"决定了提交是发出去还是排队。
  const activity = useConversationActivity({ currentConversationId: active.currentConversation?.id || '' });

  // auto 下本轮由哪个角色回答由服务端决定，流里先来 `route_decision`（派发时还有
  // `role_switch`）。把它写进本地团队视图，输入框左侧的模型标签才会跟着角色走——
  // 否则它会一直停在上一个接手角色的模型上。
  const handleTeamRoute = useCallback((roleId) => {
    if (!roleId) return;
    setTeam((current) => (current && current.activeRoleId !== roleId ? { ...current, activeRoleId: roleId } : current));
  }, []);

  const run = useRun({
    currentConversationId: active.currentConversation?.id,
    projectKey,
    selectedAgentId: settings.selectedAgent?.id,
    teamMode: Boolean(team) && !active.currentConversation?.roleId && !active.currentConversation?.parentConversationId,
    externalRunningIds: activity.runningIds,
    selectConversation: stableSelect,
    loadConversations: conversation.loadConversations,
    refreshStats: stats.refreshStats,
    refreshWorkspace: workspace.refreshWorkspace,
    selectedConversationIdRef: active.selectedConversationIdRef,
    messageListShouldStickRef: active.messageListShouldStickRef,
    setCurrentConversation: active.setCurrentConversation,
    setMessages: active.setMessages,
    onTeamRoute: handleTeamRoute,
  });

  // 完成点 = 本页刚跑完的 + 后端判定为未读的（别的视图/角色会话跑完的那部分）。
  const completedConversationIds = useMemo(
    () => new Set([...run.completedConversationIds, ...activity.completedIds]),
    [run.completedConversationIds, activity.completedIds],
  );

  // 当前视图已经加载到的完成序号（见下方活动快照 effect）。
  const settledSeqRef = useRef(new Map());
  const activityConversationsRef = useRef({});
  activityConversationsRef.current = activity.conversations;

  const selectConversation = useCallback(async (id) => {
    active.selectedConversationIdRef.current = id;
    run.removeCompleted(id);
    activity.markSeen(id);
    const data = await apiJson(`/api/conversations/${encodeURIComponent(id)}`);
    active.messageListShouldStickRef.current = true;
    // 父会话摘要随子会话一起回来，标题左侧的面包屑因此不需要第二次请求。
    active.setCurrentConversation({ ...data.conversation, parent: data.parent || null });
    const isTeamRoot = !data.conversation.roleId && !data.conversation.parentConversationId;
    const teamInfo = await apiJson(`/api/conversations/${encodeURIComponent(id)}/team`).catch(() => null);
    setTeam(teamInfo);
    // 团队根显示合并时间线：根会话自己的历史 + 每个角色会话的消息，按时间排序。
    const rows = isTeamRoot && teamInfo
      ? (await apiJson(`/api/conversations/${encodeURIComponent(id)}/team/messages`).catch(() => null))?.messages
      : null;
    active.setMessages(rows || data.messages || []);
    // 这次加载已经把该会话当前的完成序号带了进来：之后快照序号再前进才需要重拉。
    settledSeqRef.current.set(id, Number(activityConversationsRef.current[id]?.seq) || 0);
    run.resetForConversationSwitch();
  }, [
    active.messageListShouldStickRef,
    active.selectedConversationIdRef,
    active.setCurrentConversation,
    active.setMessages,
    activity.markSeen,
    run.removeCompleted,
    run.resetForConversationSwitch,
  ]);
  selectConversationRef.current = selectConversation;

  // 切角色 = 进入该角色自己的会话：右侧 subagent 面板随之变成该角色委派的子 agent。
  // 服务端在选择角色时会按需创建会话，所以这里拿到的 sessionId 一定可用。
  const handleTeamSelectRole = useCallback(async (roleId) => {
    const rootId = team?.rootId;
    if (!rootId) return;
    const next = await apiJson(`/api/conversations/${encodeURIComponent(rootId)}/team`, {
      method: 'PUT',
      body: JSON.stringify({ mode: 'manual', activeRoleId: roleId }),
    }).catch((err) => { toast.error(err instanceof Error ? err.message : '切换角色失败'); return null; });
    if (!next) return;
    setTeam(next);
    const sessionId = (next.roles || []).find((role) => role.id === roleId)?.sessionId;
    if (sessionId && sessionId !== active.currentConversation?.id) {
      if (projectKey) navigate({ name: 'session', projectKey, sessionId });
      await selectConversation(sessionId).catch(console.error);
    }
  }, [active.currentConversation?.id, projectKey, selectConversation, team?.rootId, toast]);

  // auto = 回到团队会话（合并时间线）。
  const handleTeamSelectAuto = useCallback(async () => {
    const rootId = team?.rootId;
    if (!rootId) return;
    const next = await apiJson(`/api/conversations/${encodeURIComponent(rootId)}/team`, {
      method: 'PUT',
      body: JSON.stringify({ mode: 'auto' }),
    }).catch((err) => { toast.error(err instanceof Error ? err.message : '切换回自动失败'); return null; });
    if (!next) return;
    setTeam(next);
    if (active.currentConversation?.id !== rootId) {
      if (projectKey) navigate({ name: 'session', projectKey, sessionId: rootId });
      await selectConversation(rootId).catch(console.error);
    }
  }, [active.currentConversation?.id, projectKey, selectConversation, team?.rootId, toast]);

  // 输入框里的模型选择只写「本会话 × 本角色」：请求打到当前会话（服务端从根会话/角色
  // 会话自己推断目标角色），成功后用回传的团队视图整体刷新，选择器不自己维护状态。
  const handleModelSelect = useCallback(async (selection) => {
    const conversationId = active.currentConversation?.id;
    if (!conversationId) return false;
    try {
      const next = await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/llm-override`, {
        method: 'PUT',
        body: JSON.stringify(selection),
      });
      if (next?.team) setTeam(next.team);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换模型失败');
      throw err;
    }
  }, [active.currentConversation?.id, toast]);

  const handleModelClear = useCallback(async () => {
    const conversationId = active.currentConversation?.id;
    if (!conversationId) return false;
    try {
      const next = await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/llm-override`, { method: 'DELETE' });
      if (next?.team) setTeam(next.team);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复角色默认模型失败');
      throw err;
    }
  }, [active.currentConversation?.id, toast]);

  // 子 Agent 入口：当前会话自己的委派清单（标题右侧），
  // 加上父会话的清单（只在看子会话时用，用来显示它自己的状态）。
  const subagents = useSubagents(active.currentConversation?.id || '', { parentRunning: run.running });
  const parentSubagents = useSubagents(active.currentConversation?.parentConversationId || '');
  const selfSubagent = active.currentConversation?.parentConversationId
    ? findSubagentRow(parentSubagents.rows, active.currentConversation.id)
    : null;

  // 子会话不在任何列表里，只能从父会话的入口或面包屑跳过去；两者都在同一个项目目录下。
  const handleOpenConversation = useCallback((id) => {
    if (!id) return;
    if (projectKey) navigate({ name: 'session', projectKey, sessionId: id });
    selectConversation(id).catch(console.error);
  }, [projectKey, selectConversation]);

  const conversationActions = useConversationActions({
    conversation,
    active,
    run,
    workspace,
    selectConversation,
    projectKey,
  });

  useEffect(() => {
    settings.loadSettings().catch(console.error);
  }, [settings.loadSettings]);

  useEffect(() => {
    conversation.loadConversations().catch(console.error);
  }, [conversation.loadConversations]);

  // URL 是选中会话的真相源：刷新/深链接都能直接落到某个会话。
  useEffect(() => {
    if (!routeSessionId || !projectKey) return;
    if (active.currentConversation?.id === routeSessionId) return;
    selectConversation(routeSessionId).catch(console.error);
  }, [routeSessionId, projectKey, active.currentConversation?.id, selectConversation]);

  // 点项目名只给到 `#/projects/<key>`：有会话就直接打开最近一个（与 dsh 一致），
  // 没有会话则停在项目空态，由用户点“开启第一个会话”。
  useEffect(() => {
    if (route.name !== 'project' || !projectKey) return;
    const first = currentSessions[0];
    if (!first) return;
    navigate({ name: 'session', projectKey, sessionId: first.id });
  }, [route.name, projectKey, currentSessions]);

  // 回到项目列表（浏览器后退 / 初次进入）时不要再显示上一个会话的聊天。
  useEffect(() => {
    if (route.name !== 'projects' && route.name !== 'root') return;
    active.setCurrentConversation(null);
    active.setMessages([]);
  }, [route.name, active.setCurrentConversation, active.setMessages]);

  // 正在看着的会话不该给自己出完成点：每次活动快照更新都把它记为已看过。
  useEffect(() => {
    const id = active.currentConversation?.id;
    if (id) activity.markSeen(id);
  }, [active.currentConversation?.id, activity.markSeen, activity.generatedAt]);

  // 角色会话可能在团队运行里完成，那一刻只有活动快照知道结果；
  // 序号变化说明当前会话刚结束一轮，重新拉一次落盘消息，别让视图停在半截。
  useEffect(() => {
    const id = active.currentConversation?.id;
    const entry = id ? activity.conversations[id] : null;
    if (!id || !entry) return;
    const previous = settledSeqRef.current.get(id);
    // 运行中也要记一笔：只记「已结束」的序号，会让「看着它跑 → 它结束」的第一次结束
    // 被当成「打开会话时就已经结束」，那次重拉正好被跳过。
    settledSeqRef.current.set(id, entry.seq);
    if (!shouldReloadSettledConversation(previous, entry)) return;
    Promise.resolve(selectConversationRef.current?.(id)).catch(console.error);
  }, [activity.conversations, active.currentConversation?.id]);

  useEffect(() => {
    stats.refreshStats({ debounce: true });
  }, [stats.refreshStats, active.messages.length, run.liveEvents.length]);

  useEffect(() => {
    if (!projectKey) return undefined;
    workspace.refreshWorkspace().catch(console.error);
    const timer = setInterval(() => {
      workspace.refreshWorkspace().catch(console.error);
    }, run.running ? 1200 : 3000);
    return () => clearInterval(timer);
  }, [projectKey, run.running, workspace.refreshWorkspace]);

  useEffect(() => {
    if (active.messageListRef.current && active.messageListShouldStickRef.current) {
      active.messageListRef.current.scrollTop = active.messageListRef.current.scrollHeight;
    }
  }, [active.messageListShouldStickRef, active.messageListRef, active.messages, run.liveEvents]);

  const handleSidebarToggle = useCallback(() => {
    setSidebarCollapsed((value) => !value);
  }, []);

  const handleOpenSettings = useCallback((section) => {
    navigate({ name: 'settings', section: section === 'general' ? 'general' : 'agent' });
  }, []);

  // 选择偏好：记住它，并让生效主题立即跟上（system 时取当前系统深浅色）。
  const handleThemePreferenceChange = useCallback((next) => {
    rememberPreference(next);
    setThemePreference(parsePreference(next));
  }, []);

  const handleCollapseTimingChange = useCallback((next) => {
    rememberCollapseTiming(next);
    setCollapseTiming(parseCollapseTiming(next));
  }, []);

  const handleRenameConversation = useCallback((id, title) => {
    conversationActions.updateConversationDetails(id, { title });
  }, [conversationActions.updateConversationDetails]);

  const handleToggleConversationPin = useCallback((id, pinned) => {
    conversationActions.updateConversationDetails(id, { pinned });
  }, [conversationActions.updateConversationDetails]);

  const handleSelectProject = useCallback((key) => {
    navigate({ name: 'project', projectKey: key });
  }, []);

  const handleNewSession = useCallback(async (key) => {
    const created = await conversationActions.createConversation(key);
    if (created) await conversation.loadConversations();
  }, [conversationActions.createConversation, conversation.loadConversations]);

  const handleSelectSession = useCallback((key, id) => {
    navigate({ name: 'session', projectKey: key, sessionId: id });
    selectConversation(id).catch(console.error);
  }, [selectConversation]);

  const handleSubmitMessage = useCallback((message) => {
    run.startRun(message, settings.selectedAgent?.id);
  }, [run.startRun, settings.selectedAgent?.id]);

  const handleQueueMessage = useCallback((message) => {
    const conversationId = active.currentConversation?.id;
    if (!conversationId) return;
    run.enqueueMessage({ conversationId, message, agentId: settings.selectedAgent?.id });
  }, [active.currentConversation?.id, run.enqueueMessage, settings.selectedAgent?.id]);

  const sidebar = (
    <Sidebar
      collapsed={sidebarCollapsed}
      onToggle={handleSidebarToggle}
      projects={projects.projects}
      sessionsByProject={sessionsByProject}
      orphans={projects.orphans}
      trashItems={projects.trashItems}
      loading={projects.loading}
      currentProjectKey={projectKey}
      currentConversationId={active.currentConversation?.id}
      query={conversation.conversationQuery}
      onQueryChange={conversation.setConversationQuery}
      runningConversationIds={run.runningConversationIds}
      completedConversationIds={completedConversationIds}
      onSelectProject={handleSelectProject}
      onCreateProject={projects.createProject}
      onRenameProject={projects.renameProject}
      onDeleteProject={projects.deleteProject}
      onNewSession={handleNewSession}
      onSelectSession={handleSelectSession}
      onRenameSession={handleRenameConversation}
      onToggleSessionPin={handleToggleConversationPin}
      onDeleteSession={conversationActions.deleteConversationById}
      onAssignOrphan={projects.assignOrphan}
      onRestoreTrash={projects.restoreTrash}
      onLoadTrash={projects.loadTrash}
      settingsSection={route.name === 'settings' ? (route.section || 'agent') : null}
      onOpenSettings={handleOpenSettings}
      account={account}
    />
  );

  let mainPanel;
  if (route.name === 'settings' && route.section === 'general') {
    mainPanel = (
      <GeneralSettingsView
        preference={themePreference}
        onPreferenceChange={handleThemePreferenceChange}
        collapseTiming={collapseTiming}
        onCollapseTimingChange={handleCollapseTimingChange}
        account={account}
      />
    );
  } else if (route.name === 'settings') {
    mainPanel = (
      <SettingsView
        tab={settingsTab}
        onTabChange={setSettingsTab}
        settings={settings.settings}
        selectedAgentId={settings.selectedAgentId}
        onSelectedAgentChange={settings.setSelectedAgentId}
        onReload={settings.reloadSettings}
        applySettingsResponse={settings.applySettingsResponse}
        toast={toast}
        account={account}
        userLlm={userLlm}
      />
    );
  } else if (active.currentConversation) {
    mainPanel = (
      <ChatView
        conversation={active.currentConversation}
        messages={active.messages}
        liveEvents={run.liveEvents}
        running={run.running}
        runStartedAt={run.runStartedAt}
        runStatus={run.runStatus}
        foldTiming={collapseTiming}
        busy={run.busy}
        queuedMessages={run.queuedMessages.filter((item) => item.conversationId === active.currentConversation?.id)}
        conversationStats={stats.stats}
        subagents={subagents}
        selfSubagent={selfSubagent}
        team={team}
        viewRoleId={active.currentConversation?.roleId || null}
        teamActivity={activity.conversations}
        unreadRoleSessionIds={completedConversationIds}
        onTeamSelectRole={handleTeamSelectRole}
        onTeamSelectAuto={handleTeamSelectAuto}
        modelCatalog={modelCatalog}
        onModelSelect={handleModelSelect}
        onModelClear={handleModelClear}
        workspace={workspace}
        messageListRef={active.messageListRef}
        onMessageListScroll={active.handleMessageListScroll}
        onSubmit={handleSubmitMessage}
        onStop={run.stopCurrentRun}
        onSecurityApproval={run.respondSecurityApproval}
        onQueue={handleQueueMessage}
        onOpenConversation={handleOpenConversation}
      />
    );
  } else if (projectKey) {
    mainPanel = (
      <div className="welcome-panel">
        <h2>{currentProject?.title || projectKey}</h2>
        <p className="welcome-path">{currentProject?.path || ''}</p>
        <p>这个项目还没有会话。每个会话都以项目目录作为 agent 的工作目录，同项目的会话共享同一批文件。</p>
        <button className="primary-button" type="button" onClick={() => handleNewSession(projectKey)}>开启第一个会话</button>
      </div>
    );
  } else {
    mainPanel = (
      <div className="welcome-panel">
        <h2>Bioflow Agent</h2>
        <p>左侧是项目树：<strong>一个项目 = workspace 下的一个目录</strong>，每个项目可以开多个会话，会话的 agent 工作目录就是项目目录。</p>
        {projects.projects.length === 0
          ? <p className="welcome-hint">还没有项目，点左上角「新建项目」创建一个空目录。</p>
          : <p className="welcome-hint">从左侧选择一个项目，或新建一个。</p>}
      </div>
    );
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}`}>
      {sidebar}
      <main className="main-panel">{mainPanel}</main>
      <ToastViewport toasts={toasts} onClose={removeToast} />
    </div>
  );
}
