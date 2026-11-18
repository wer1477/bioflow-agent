import { useCallback, useRef, useState } from 'react';
import { isNearBottom } from '../domain/message_scroll.js';

export function useActiveConversation() {
  const [currentConversation, setCurrentConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const selectedConversationIdRef = useRef('');
  const messageListRef = useRef(null);
  const messageListShouldStickRef = useRef(true);

  const handleMessageListScroll = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    messageListShouldStickRef.current = isNearBottom(element);
  }, []);

  return {
    currentConversation,
    setCurrentConversation,
    messages,
    setMessages,
    selectedConversationIdRef,
    messageListRef,
    messageListShouldStickRef,
    handleMessageListScroll,
  };
}
