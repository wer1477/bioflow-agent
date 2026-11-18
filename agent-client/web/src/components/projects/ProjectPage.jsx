import { ChatView } from '../chat/ChatView.jsx';
import { Sidebar } from '../layout/Sidebar.jsx';

/**
 * 单个项目的聊天界面：左侧是该项目的会话列表，右侧是 ChatView。
 * 项目未解析出来（被移除/地址过期）时仍渲染聊天壳，由 ChatView 给出
 * “先创建或选择一个项目”的空状态并禁用输入。
 */
export function ProjectPage({
  projectTitle,
  sessions,
  query,
  onQueryChange,
  currentSessionId,
  runningConversationIds,
  completedConversationIds,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onToggleSessionPin,
  onDeleteSession,
  onBackToProjects,
  onSettings,
  theme,
  onToggleTheme,
  collapsed,
  onToggleSidebar,
  conversation,
  messages,
  liveEvents,
  running,
  queuedMessages,
  conversationStats,
  projectSelected,
  onBrowseProjects,
  workspace,
  messageListRef,
  onMessageListScroll,
  onSubmit,
  onStop,
  onSecurityApproval,
  onQueue,
}) {
  return (
    <>
      <Sidebar
        collapsed={collapsed}
        projectTitle={projectTitle}
        onBackToProjects={onBackToProjects}
        conversations={sessions}
        currentConversationId={currentSessionId}
        query={query}
        onQueryChange={onQueryChange}
        onToggle={onToggleSidebar}
        onNewConversation={onNewSession}
        onRenameConversation={onRenameSession}
        onToggleConversationPin={onToggleSessionPin}
        onDeleteConversation={onDeleteSession}
        runningConversationIds={runningConversationIds}
        completedConversationIds={completedConversationIds}
        onSelectConversation={onSelectSession}
        onSettings={onSettings}
        settingsActive={false}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
      <main className="main-panel">
        <ChatView
          conversation={conversation}
          messages={messages}
          liveEvents={liveEvents}
          running={running}
          queuedMessages={queuedMessages}
          conversationStats={conversationStats}
          workspace={workspace}
          projectSelected={projectSelected}
          messageListRef={messageListRef}
          onMessageListScroll={onMessageListScroll}
          onSubmit={onSubmit}
          onStop={onStop}
          onSecurityApproval={onSecurityApproval}
          onQueue={onQueue}
          onBrowseProjects={onBrowseProjects}
        />
      </main>
    </>
  );
}
