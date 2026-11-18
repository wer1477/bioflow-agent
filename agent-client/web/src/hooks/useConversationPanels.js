import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../api.js';
import { EMPTY_PANELS } from '../domain/panels.js';

/**
 * Read and mutate the durable conversation panels.
 *
 * The server owns the fold, so this hook never reconstructs state from history: it seeds
 * from `GET /panels` and then lets live events replace whole values as they stream. The
 * refetch after a run ends is the reconciliation point — one request decides the final
 * state instead of the client guessing which of its own events won.
 */
export function useConversationPanels(conversationId, { running = false } = {}) {
  const [panels, setPanels] = useState(EMPTY_PANELS);
  const requestRef = useRef(0);
  const runningRef = useRef(running);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setPanels(EMPTY_PANELS);
      return;
    }
    const request = requestRef.current + 1;
    requestRef.current = request;
    try {
      const data = await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/panels`);
      if (request !== requestRef.current) return;
      setPanels({
        asOfSequence: Number.isFinite(data?.asOfSequence) ? data.asOfSequence : -1,
        goal: data?.goal || null,
        todos: data?.todos || null,
      });
    } catch {
      // Panel state is advisory: a failed read must not take the conversation view down.
      // The next run boundary retries, and in the meantime live events still update the dock.
    }
  }, [conversationId]);

  useEffect(() => {
    setPanels(EMPTY_PANELS);
    refresh();
  }, [conversationId, refresh]);

  // A run just ended: ask the owner of the log what the final state is.
  useEffect(() => {
    const wasRunning = runningRef.current;
    runningRef.current = running;
    if (wasRunning && !running) refresh();
  }, [running, refresh]);

  /** Apply one Web-originated goal mutation and adopt the returned document. */
  const mutateGoal = useCallback(async (action, payload = {}) => {
    if (!conversationId) throw new Error('没有可用的会话');
    const data = await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/goal`, {
      method: 'POST',
      body: JSON.stringify({ action, ...payload }),
    });
    setPanels((current) => ({ ...current, goal: data?.goal || null }));
    return data?.goal || null;
  }, [conversationId]);

  return { panels, refresh, mutateGoal };
}
