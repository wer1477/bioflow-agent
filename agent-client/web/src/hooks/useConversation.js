import { useCallback, useMemo, useState } from 'react';
import { apiJson } from '../api.js';

export function useConversation(projectKey = '') {
  const [conversations, setConversations] = useState([]);
  const [conversationQuery, setConversationQuery] = useState('');

  const loadConversations = useCallback(async () => {
    const query = projectKey ? `?project=${encodeURIComponent(projectKey)}` : '';
    const data = await apiJson(`/api/conversations${query}`);
    setConversations(data.conversations || []);
    return data.conversations || [];
  }, [projectKey]);

  const filteredConversations = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase();
    return conversations.filter((item) => !query || item.title.toLowerCase().includes(query));
  }, [conversationQuery, conversations]);

  return {
    conversations,
    setConversations,
    conversationQuery,
    setConversationQuery,
    loadConversations,
    filteredConversations,
  };
}
