import { useCallback } from 'react';
import { apiJson } from '../api.js';
import { navigate } from '../app/router.js';

export function useConversationActions({ conversation, active, run, workspace, selectConversation, projectKey = '' }) {
  const { conversations, loadConversations } = conversation;
  const { currentConversation, setCurrentConversation, setMessages } = active;
  const { removeCompleted } = run;
  const { closeFile } = workspace;

  // 侧栏可以给任意项目开新会话，所以目标项目由调用方指定（缺省=当前项目）。
  const createConversation = useCallback(async (targetProjectKey = projectKey) => {
    if (!targetProjectKey) return null;
    const data = await apiJson('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'New conversation', project: targetProjectKey }),
    });
    await loadConversations();
    await selectConversation(data.conversation.id);
    navigate({ name: 'session', projectKey: targetProjectKey, sessionId: data.conversation.id });
    return data.conversation;
  }, [loadConversations, projectKey, selectConversation]);

  const updateConversationDetails = useCallback(async (id, patch) => {
    const data = await apiJson(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (currentConversation?.id === id) setCurrentConversation(data.conversation);
    await loadConversations();
    return data.conversation;
  }, [currentConversation?.id, loadConversations, setCurrentConversation]);

  const deleteConversationById = useCallback(async (id) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!window.confirm(`删除“${conversation?.title || '此会话'}”？其消息记录会被移除（项目目录里的文件不受影响）。`)) return;
    await apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    removeCompleted(id);
    await loadConversations();
    if (currentConversation?.id !== id) return;
    // 删掉的是当前会话：回到项目页，由路由决定下一个落点，而不是自动挑一条会话。
    setCurrentConversation(null);
    setMessages([]);
    closeFile();
    if (projectKey) navigate({ name: 'project', projectKey });
  }, [conversations, currentConversation?.id, loadConversations, projectKey, removeCompleted, closeFile, setCurrentConversation, setMessages]);

  return { createConversation, updateConversationDetails, deleteConversationById };
}
