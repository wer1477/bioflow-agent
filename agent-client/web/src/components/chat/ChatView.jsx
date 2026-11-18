import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildTraceItems, findRunId, hasVisibleLiveContent } from '../../domain/trace.js';
import { resolvePendingTurn } from '../../domain/pending_turn.js';
import { isNearBottom } from '../../domain/message_scroll.js';
import { traceExpansionId } from '../../domain/tool_expansion.js';
import { latestCompletedIndex as findLatestCompletedIndex, DEFAULT_COLLAPSE_TIMING } from '../../domain/turn_process.js';
import { formatDate } from '../../format.js';
import {
  buildWorkspacePathIndex, fileDisplayName, formatWorkspaceByteSize,
  resolveWorkspaceFileView, toProjectRelativePath,
} from '../../domain/workspace.js';
import { fileTabId, tabFilePath } from '../../domain/right_dock.js';
import { useRightDock } from '../../hooks/useRightDock.js';
import { useToolExpansion } from '../../hooks/useToolExpansion.js';
import { useTurnProcess } from '../../hooks/useTurnProcess.js';
import { RightDock } from '../workspace/RightDock.jsx';
import { UploadDock } from '../workspace/UploadDock.jsx';
import { WorkspaceFileView } from '../workspace/WorkspaceFileView.jsx';
import { WorkspaceSidebar } from '../workspace/WorkspaceSidebar.jsx';
import { ComposerActions } from './Composer.jsx';
import { ComposerStats } from './ComposerStats.jsx';
import { FlowMessage } from './FlowMessage.jsx';
import { PendingTurnRow } from './PendingTurnRow.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { SubagentBar } from './SubagentBar.jsx';
import { TeamSwitcher } from './TeamSwitcher.jsx';
import { liveRoleLabel, messageRoleLabel, roleDividers } from '../../domain/team_view.js';
import { roleLlm, targetRoleId } from '../../domain/model_selection.js';
import { ChevronLeftIcon } from '../common/icons.jsx';
import { subagentStatusMeta } from '../../domain/subagent_view.js';
import { TodoDock } from './TodoDock.jsx';
import { GoalDock } from './GoalDock.jsx';
import { applyPanelEvents } from '../../domain/panels.js';
import { useConversationPanels } from '../../hooks/useConversationPanels.js';

export function ChatView({
  conversation,
  messages,
  liveEvents,
  running,
  // 本轮第一次进入 active 的时刻（useRun 维护）：等待行的 elapsed 从它起算。
  runStartedAt = 0,
  // 本页 run state 的最新状态：切走再切回、直播事件被清空后，等待行仍能说明卡在哪一步。
  runStatus = '',
  // 整轮过程的收起时机（'nextInput' | 'completion'），见 app/chat_preferences.js。
  foldTiming = DEFAULT_COLLAPSE_TIMING,
  // 会话被占用（本页在跑，或角色会话正被团队/别的视图跑）：提交变成排队。
  busy = false,
  queuedMessages,
  conversationStats,
  subagents = { rows: [], total: 0, running: 0 },
  selfSubagent = null,
  team = null,
  viewRoleId = null,
  // 后端活动快照里的会话状态：切换器用它标出正在运行的角色。
  teamActivity = {},
  // 有未读完成的角色会话：切换器给它们打完成点。
  unreadRoleSessionIds = null,
  onTeamSelectRole,
  onTeamSelectAuto,
  // 输入框左侧的模型选择器：目录来自设置页的同一份 provider/model 列表，
  // 当前生效值由团队端点解析好（本会话该角色的 provider/model/强度）。
  modelCatalog = null,
  onModelSelect,
  onModelClear,
  workspace,
  projectSelected = true,
  messageListRef,
  onMessageListScroll,
  onSubmit,
  onStop,
  onSecurityApproval,
  onQueue,
  onOpenConversation,
  onBrowseProjects,
}) {
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef(null);
  // 委派子会话是只读记录：只能看，不能继续发指令，也不提供 goal 写入。
  // 角色会话也是子会话，但它是一个可对话的工作会话，因此按 roleId 区分。
  const subagentView = Boolean(conversation?.parentConversationId) && !conversation?.roleId;

  // 草稿每次变化后重新量一次高度：发送/排队走的是 setDraft('')，程序化改值
  // 不会触发 input 事件，只靠 onInput 的话内联高度会停在最后一次撑开的值上，
  // 空输入框就再也回不来。useLayoutEffect 在绘制前量，用户输入时看不到跳动。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const handleDragOver = (event) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) workspace.uploadWorkspaceFile(files);
  };

  const submit = (event) => {
    event.preventDefault();
    if (!projectSelected) return;
    const message = draft.trim();
    // 会话忙：有内容就排队（等这一轮结束自动发送），空提交只在本页真的在跑时才是"终止"。
    if (busy) {
      if (message) {
        onQueue(message);
        setDraft('');
      } else if (running) {
        onStop();
      }
      return;
    }
    if (!message) return;
    setDraft('');
    onSubmit(message);
  };
  // 排队提示：忙但不在本页跑时说明消息会等；已经有排队消息时给出条数。
  const queueHint = queuedMessages.length
    ? `已排队 ${queuedMessages.length} 条，当前回答结束后自动发送`
    : busy && !running
      ? '当前会话正在回答，这条消息会排队，结束后自动发送'
      : '';
  // 合并时间线里每条消息属于哪个角色，以及角色切换处要画的分隔线。
  // 角色会话里只有一个人说话，不需要分隔线；团队会话才有角色切换。
  const roleDividerFlags = useMemo(() => (viewRoleId ? messages.map(() => false) : roleDividers(team, messages)), [team, messages, viewRoleId]);
  const messageTraceRows = useMemo(() => messages.map((message, index) => ({
    message,
    index,
    roleLabel: messageRoleLabel(team, message, viewRoleId),
    showRoleDivider: roleDividerFlags[index] || false,
    traceItems: message.role === 'assistant'
      ? buildTraceItems(
        message.toolCalls?.run?.events || [],
        message.toolCalls?.run?.plan,
        `message-${message.id || index}`,
        message.toolCalls?.run?.runId || '',
      )
      : [],
  })), [messages, roleDividerFlags, team, viewRoleId]);
  // 运行中的消息还没有持久 runId，从 live 事件流里取（run_status 是运行时最先发出的事件）。
  const liveRunId = useMemo(() => findRunId(liveEvents), [liveEvents]);
  const liveTraceItems = useMemo(() => buildTraceItems(liveEvents, null, 'live', liveRunId), [liveEvents, liveRunId]);
  // 等待态：本轮在跑、但直播流还没有任何一条可见行时（后端装配上下文、等模型首字），
  // 在消息列表下方补一条「已收到、正在准备」的反馈。可见性判据与渲染层同源
  // （trace.hasVisibleLiveContent），占位行和第一条过程行不会同时出现或同时缺席。
  const liveHasContent = useMemo(() => hasVisibleLiveContent(liveEvents), [liveEvents]);
  const teamMode = Boolean(team) && !conversation?.roleId && !conversation?.parentConversationId;
  const pendingTurn = useMemo(
    () => resolvePendingTurn({ running, events: liveEvents, visible: liveHasContent, teamMode, status: runStatus }),
    [running, liveEvents, liveHasContent, teamMode, runStatus],
  );
  // Durable panels come from the server's fold of the transcript; live events only
  // overlay the same whole values while a run streams. The old dock scanned rebuilt run
  // events instead, which is why it disappeared after a reload cleared the live stream —
  // and why it could disagree with the log when history was paged or rebuilt.
  const { panels: storedPanels, mutateGoal } = useConversationPanels(conversation?.id, { running });
  const panels = useMemo(() => applyPanelEvents(storedPanels, liveEvents), [storedPanels, liveEvents]);
  const { expandedIds: expandedToolIds, toggle: toggleToolExpansion } = useToolExpansion(conversation?.id || '');
  const { overrides: processOverrides, setOpen: setProcessOpen } = useTurnProcess(conversation?.id || '');
  // 「最新一轮」= 会话的最后一条消息恰好还是一个刚完成的回答；用户一发出下一条消息
  // （哪怕只是本地的乐观行）这个身份就让出去了。已经排队的消息同样算作"已发出"。
  const latestCompletedIndex = useMemo(
    () => findLatestCompletedIndex(messages, { pendingInput: queuedMessages.length > 0 }),
    [messages, queuedMessages.length],
  );
  const pendingAnchorRef = useRef(null);
  const pendingProcessAnchorRef = useRef(null);

  const toggleTool = useCallback((item, element) => {
    pendingAnchorRef.current = {
      element,
      top: element ? element.getBoundingClientRect().top : 0,
      stick: isNearBottom(messageListRef.current),
    };
    toggleToolExpansion(traceExpansionId(item));
  }, [messageListRef, toggleToolExpansion]);

  // 展开体改变行高，而消息列表的自动滚底只跟随 messages / liveEvents（见 App.jsx），
  // 不会为展开做补偿：这里显式把视口放回点击前的位置——原本贴底就继续贴底，
  // 否则让被点击的那一行停在原处（不依赖浏览器默认的 scroll anchoring）。
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    pendingAnchorRef.current = null;
    const list = messageListRef.current;
    if (!list) return;
    if (pending.stick) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    if (!pending.element) return;
    const delta = pending.element.getBoundingClientRect().top - pending.top;
    if (delta) list.scrollTop += delta;
  }, [expandedToolIds, messageListRef]);

  /**
   * 点击收起/展开一轮过程：把锚点按点击前的位置钉回去。
   *
   * 与工具行的展开补偿是同一条路径，只是锚点由调用方按方向挑：收起时锚答案块
   * （折叠发生在它上方，用户的注意力也在答案上），展开时锚折叠行本身（让过程
   * 从行下方长出来，而不是把答案顶在原地、过程长到视口外）。
   *
   * 自动折起（下一条消息到来）不做补偿：那时消息列表的贴底逻辑已经接管，
   * 硬补偿反而会和它抢滚动位置。
   */
  const toggleTurnProcess = useCallback((messageId, nextOpen, element) => {
    pendingProcessAnchorRef.current = {
      element,
      top: element ? element.getBoundingClientRect().top : 0,
      // 只有收起才跟随贴底：展开是为了读过程，贴底会把刚开始展开的过程留在视口外。
      stick: !nextOpen && isNearBottom(messageListRef.current),
    };
    setProcessOpen(messageId, nextOpen);
  }, [messageListRef, setProcessOpen]);

  useLayoutEffect(() => {
    const pending = pendingProcessAnchorRef.current;
    if (!pending) return;
    pendingProcessAnchorRef.current = null;
    const list = messageListRef.current;
    if (!list) return;
    if (pending.stick) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    if (!pending.element) return;
    const delta = pending.element.getBoundingClientRect().top - pending.top;
    if (delta) list.scrollTop += delta;
  }, [processOverrides, messageListRef]);

  const submitPlanningResponse = useCallback((message) => {
    if (busy) onQueue(message);
    else onSubmit(message);
  }, [busy, onQueue, onSubmit]);
  const dock = useRightDock({ openPaths: workspace.openPaths });
  // 标签栏：第一个永远是「项目文件」（不可关闭），之后每个打开的文件一个标签。
  const dockTabs = useMemo(() => [
    { id: 'files', label: '项目文件' },
    ...workspace.openPaths.map((path) => ({
      id: fileTabId(path),
      label: fileDisplayName(path),
      title: path,
      dirty: Boolean(workspace.sessions.get(path)?.dirty),
      closable: true,
    })),
  ], [workspace.openPaths, workspace.sessions]);
  const activeFilePath = tabFilePath(dock.tab);
  const activeFile = activeFilePath ? workspace.sessions.get(activeFilePath) || null : null;
  const activeFileView = useMemo(() => resolveWorkspaceFileView(activeFile), [activeFile]);

  /** 打开文件并切到它的标签；工具卡与消息里的路径点击都走这里。 */
  const openWorkspacePath = useCallback(async (path) => {
    const opened = await workspace.openFile(path);
    if (opened) dock.setTab(fileTabId(opened));
  }, [dock.setTab, workspace.openFile]);

  const changeDockTab = useCallback((id) => {
    dock.setTab(id);
    const path = tabFilePath(id);
    if (path) workspace.activateFile(path);
  }, [dock.setTab, workspace.activateFile]);

  /** 关闭文件标签：自动保存开着就直接落盘，否则脏草稿要先确认。 */
  const closeDockTab = useCallback((id) => {
    const path = tabFilePath(id);
    if (!path) return;
    const session = workspace.sessions.get(path);
    if (session?.dirty) {
      if (workspace.autoSave && session.canEdit && !session.conflict) {
        workspace.saveFile({ path }).catch(console.error);
      } else if (!window.confirm(`「${fileDisplayName(path)}」还有未保存的修改，确定关闭？`)) {
        return;
      }
    }
    const next = workspace.closeFile(path);
    dock.setTab(next ? fileTabId(next) : 'files');
  }, [dock.setTab, workspace.autoSave, workspace.closeFile, workspace.saveFile, workspace.sessions]);
  const refreshWorkspace = useCallback(() => {
    workspace.refreshWorkspace({ showLoading: true }).catch(console.error);
  }, [workspace.refreshWorkspace]);
  // 消息里提到的路径只有真的存在于当前项目文件树里才变成链接。
  // 索引用 ref：每 1-3 秒一次的工作区刷新不该把所有消息的 markdown 重排一遍；
  // 只在"索引从空变成有"时抬一次版本号，让已经渲染过的消息补上链接。
  const workspacePathsRef = useRef(new Set());
  const [pathIndexVersion, setPathIndexVersion] = useState(0);
  const projectPath = workspace.summary?.projectPath || '';
  useEffect(() => {
    const next = buildWorkspacePathIndex(workspace.tree);
    const wasEmpty = workspacePathsRef.current.size === 0;
    workspacePathsRef.current = next;
    if (wasEmpty && next.size > 0) setPathIndexVersion((value) => value + 1);
  }, [workspace.tree]);
  const resolveOpenablePath = useCallback((text) => {
    const relative = toProjectRelativePath(text, projectPath);
    return relative && workspacePathsRef.current.has(relative) ? relative : null;
    // pathIndexVersion 只用于在索引首次就绪时换掉这个回调的引用。
  }, [pathIndexVersion, projectPath]);

  // 选择器替「这个 composer 由谁回答」选模型：角色会话是它自己的角色，团队根是最近
  // 接手的角色。服务端已经把该角色的 provider/model/强度解析好放进团队视图，这里只
  // 负责取出那一行，不重算优先级。
  const modelRoleId = targetRoleId(team, conversation);
  const modelRole = (team?.roles || []).find((role) => role.id === modelRoleId) || null;
  const modelLlm = roleLlm(team, modelRoleId);
  const modelControl = !subagentView && modelLlm ? (
    <ModelPicker
      llm={modelLlm}
      catalog={modelCatalog}
      roleLabel={modelRole?.label || ''}
      disabled={!projectSelected}
      onSelect={onModelSelect}
      onClear={onModelClear}
    />
  ) : null;

  return (
    <section className="view active chat-view">
      <header className="main-header">
        {conversation?.parentConversationId && conversation.parent && (
          <button
            type="button"
            className="chat-header-parent"
            data-tooltip="返回父会话"
            onClick={() => onOpenConversation(conversation.parent.id)}
          >
            <ChevronLeftIcon />
            <span>{conversation.parent.title || '父会话'}</span>
          </button>
        )}
        <h2
          className="chat-header-title"
          data-tooltip={conversation ? `更新于 ${formatDate(conversation.updatedAt)}` : ''}
        >
          {conversation?.title || '选择或新建会话'}
        </h2>
        {conversation && !subagentView && (
          <TeamSwitcher
            team={team}
            viewRoleId={viewRoleId}
            teamActivity={teamActivity}
            unreadRoleSessionIds={unreadRoleSessionIds}
            // 运行中也要能切换：本轮继续由当前角色答完，下一轮才按新选择路由。
            onSelectRole={onTeamSelectRole}
            onSelectAuto={onTeamSelectAuto}
          />
        )}
        <SubagentBar
          rows={subagents.rows}
          total={subagents.total}
          running={subagents.running}
          onOpen={onOpenConversation}
        />
        <span className="chat-header-meta">
          {conversation
            ? subagentView
              ? `子 Agent 会话 · ${selfSubagent ? `${subagentStatusMeta(selfSubagent.status).label} · ` : ''}${messages.length} 条消息`
              : `${messages.length} 条消息`
            : '历史会话存储在本地数据库'}
        </span>
      </header>
      <div className="chat-workspace-layout" ref={dock.layoutRef}>
        <div className="chat-conversation-panel">
          <section ref={messageListRef} className="messages" aria-live="polite" onScroll={onMessageListScroll}>
            {!projectSelected ? (
              <div className="chat-empty-state">
                <strong>先创建或选择一个项目</strong>
                <p>会话必须属于一个项目：项目目录就是 Agent 的工作目录，一个项目可以开多个会话。</p>
                <button className="primary-button" type="button" onClick={onBrowseProjects}>去项目列表</button>
              </div>
            ) : messageTraceRows.length === 0 && liveEvents.length === 0 ? (
              <div className="chat-empty-state">
                <strong>{conversation ? '开始新的任务' : '这个项目还没有会话'}</strong>
                <p>{conversation ? '直接输入任务或问题即可继续这个会话。' : '直接输入任务或问题，Agent 会在项目目录里开始第一个会话。'}</p>
              </div>
            ) : null}
            {projectSelected && messageTraceRows.map(({ message, index, traceItems, roleLabel, showRoleDivider }) => (
              <FlowMessage
                key={`${message.id || index}-${message.role}`}
                message={message}
                roleLabel={roleLabel}
                showRoleDivider={showRoleDivider}
                traceItems={traceItems}
                expandedToolIds={expandedToolIds}
                onToggleTool={toggleTool}
                onPlanningResponse={submitPlanningResponse}
                onSecurityApproval={onSecurityApproval}
                onOpenFile={openWorkspacePath}
                resolveOpenablePath={resolveOpenablePath}
                foldTiming={foldTiming}
                isLatestCompleted={index === latestCompletedIndex}
                processOpenOverride={processOverrides.get(message.id)}
                onToggleProcess={toggleTurnProcess}
              />
            ))}
            {projectSelected && liveEvents.length > 0 && (
              <FlowMessage
                message={{ role: 'assistant', content: '', toolCalls: { run: { events: liveEvents } } }}
                roleLabel={liveRoleLabel(team, liveEvents)}
                traceItems={liveTraceItems}
                traceNamespace="live"
                traceRunId={liveRunId}
                expandedToolIds={expandedToolIds}
                onToggleTool={toggleTool}
                onPlanningResponse={submitPlanningResponse}
                onSecurityApproval={onSecurityApproval}
                onOpenFile={openWorkspacePath}
                resolveOpenablePath={resolveOpenablePath}
                // 运行中的轮次永远展开：没有完成态就没有可折叠的过程。
                foldTiming={foldTiming}
                isLatestCompleted={false}
                onToggleProcess={toggleTurnProcess}
              />
            )}
            {projectSelected && pendingTurn && (
              <PendingTurnRow
                phase={pendingTurn.phase}
                label={pendingTurn.label}
                startedAt={runStartedAt}
              />
            )}
          </section>
          {panels.todos && panels.todos.length > 0 && <TodoDock todos={panels.todos} />}
          {/* 目标是顶层 Agent 的能力：委派子会话里没有可写入口，就不渲染 goal dock。 */}
          {!subagentView && <GoalDock goal={panels.goal} running={running} onMutate={mutateGoal} />}
          {subagentView ? (
            <div className="composer composer-readonly">
              <div className="composer-readonly-body">
                <strong>这是一个子 Agent 会话，只读</strong>
                <p>它由父会话委派、结束后把结论写回父会话，不在这里接收新指令。</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => conversation?.parent && onOpenConversation(conversation.parent.id)}
              >
                返回父会话
              </button>
            </div>
          ) : (
            <>
              {/* 提示放在 composer 外面：composer 是两行 grid，多一个子元素会打乱它的行模板。 */}
              {queueHint && projectSelected && (
                <p className="composer-queue-hint" role="status">{queueHint}</p>
              )}
              <form className={`composer${running ? ' running' : ''}${dragging ? ' is-dragging' : ''}${projectSelected ? '' : ' is-disabled'}`} onSubmit={submit} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                {dragging && projectSelected && <div className="composer-drop-overlay">释放以上传文件到项目目录</div>}
                <textarea
                  rows="2"
                  ref={textareaRef}
                  aria-label="输入任务或问题"
                  placeholder={projectSelected ? '输入任务或问题，或上传文件开始分析…' : '先创建或选择一个项目'}
                  value={draft}
                  disabled={!projectSelected}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <ComposerActions
                  onUpload={workspace.uploadWorkspaceFile}
                  canUpload={projectSelected}
                  disabled={!projectSelected}
                  running={running}
                  queuedCount={queuedMessages.length}
                  modelControl={modelControl}
                />
              </form>
            </>
          )}
          <ComposerStats stats={conversationStats} />
        </div>
        <RightDock
          tab={dock.tab}
          onTabChange={changeDockTab}
          onCloseTab={closeDockTab}
          tabs={dockTabs}
          collapsed={dock.collapsed}
          canExpand={dock.canExpand}
          onToggleCollapsed={dock.toggleCollapsed}
          maximized={dock.maximized}
          onToggleMaximized={dock.toggleMaximized}
          width={dock.width}
          onResizeStart={dock.beginResize}
        >
          {/* 树与文件视图常驻挂载，只切换可见性：树的展开状态、编辑器草稿与
              滚动位置都不该因为"切回目录"而丢失。 */}
          {/* 树与文件视图在同一个面板里按槽位切换，因此面板本身不再按标签隐藏。 */}
          <div className="right-dock-panel">
            <div className="workspace-panel-stack">
              <div className="workspace-panel-slot" hidden={Boolean(activeFilePath)}>
                <WorkspaceSidebar
                  tree={workspace.tree}
                  summary={workspace.summary}
                  loading={workspace.workspaceLoading}
                  error={workspace.workspaceError || workspace.fileError}
                  directory={workspace.uploadDirectory}
                  activePath={workspace.activePath}
                  revealPath={workspace.activePath}
                  onDirectoryChange={workspace.setUploadDirectory}
                  onRefresh={refreshWorkspace}
                  onOpenFile={openWorkspacePath}
                  onUpload={workspace.uploadWorkspaceFile}
                  onDelete={workspace.deleteWorkspaceItem}
                  onCreate={workspace.createWorkspaceItem}
                  onRename={workspace.moveWorkspaceItem}
                />
              </div>
              <div className="workspace-panel-slot" hidden={!activeFilePath}>
                {activeFile && (
                  <WorkspaceFileView
                    file={activeFile}
                    view={activeFileView}
                    loading={workspace.loadingPaths.has(activeFilePath)}
                    error={workspace.fileError}
                    saving={workspace.savingPaths.has(activeFilePath)}
                    autoSave={workspace.autoSave}
                    byteSizeLabel={formatWorkspaceByteSize(activeFile.size || 0)}
                    rawUrl={workspace.rawFileUrl(activeFilePath)}
                    downloadUrl={workspace.rawFileUrl(activeFilePath, { download: true })}
                    onChange={(content) => workspace.updateDraft(activeFilePath, content)}
                    onSave={() => workspace.saveFile({ path: activeFilePath }).catch(console.error)}
                    onReload={() => workspace.reloadFile(activeFilePath).catch(console.error)}
                    onOverwrite={() => workspace.saveFile({ path: activeFilePath, force: true }).catch(console.error)}
                    onToggleAutoSave={workspace.setAutoSave}
                  />
                )}
              </div>
            </div>
          </div>
          <UploadDock
            tasks={workspace.uploads}
            onPause={workspace.pauseUpload}
            onResume={workspace.resumeUpload}
            onCancel={workspace.cancelUpload}
            onRetry={workspace.retryUpload}
            onDismiss={workspace.dismissUpload}
            onAttach={workspace.attachUploadFile}
          />
        </RightDock>
      </div>
    </section>
  );
}
