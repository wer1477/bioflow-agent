import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../api.js';
import { acknowledgeSeen, pruneSeen, unseenCompletions } from '../domain/activity_view.js';

/** 与委派面板同样的节奏：轮询成本低，晚两秒感知到活动就够了。 */
const POLL_INTERVAL_MS = 2000;
const STORAGE_KEY = 'bioflow.activity.seen';

/** `{ epoch, seen: { conversationId: seq } }`；读不出来就当作没看过任何完成。 */
function readSeen() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed && typeof parsed === 'object' && parsed.seen && typeof parsed.seen === 'object') {
      return { epoch: String(parsed.epoch || ''), seen: parsed.seen };
    }
  } catch {
    // 隐私模式下 localStorage 不可用：退化为只在本次页面内记住，刷新后会重新出点。
  }
  return { epoch: '', seen: {} };
}

function writeSeen(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 写不进去只影响刷新后的未读标记，不影响本次会话。
  }
}

const EMPTY_SNAPSHOT = { epoch: '', generatedAt: '', conversations: {} };

/**
 * 后端进程内的运行活动：谁在跑、什么时候结束的。
 *
 * 侧栏的运行圈不能只看本标签页：角色在自己的会话里回答、子 Agent 在父 run 结束后继续
 * 跑，这些都不由当前页面发起的流来驱动。所以活动状态从 `GET /api/conversations/activity`
 * 轮询，和本地 run 状态取并集使用；完成点则用后端给的单调序号配合本地"已看过"标记，
 * 避免比较两个机器的挂钟。
 */
export function useConversationActivity({ currentConversationId = '' } = {}) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [seen, setSeen] = useState(readSeen);
  const requestRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const seenRef = useRef(seen);
  seenRef.current = seen;

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const data = await apiJson('/api/conversations/activity');
      // 更早的响应不能覆盖更新的快照（切换/网络抖动时可能乱序）。
      if (requestId !== requestRef.current) return null;
      const conversations = data?.conversations && typeof data.conversations === 'object' ? data.conversations : {};
      setSnapshot({ epoch: String(data?.epoch || ''), generatedAt: String(data?.generatedAt || ''), conversations });
      return conversations;
    } catch {
      // 后端不可达时保留上一次快照：指示器短暂失真比弹错误更不打扰。
      return null;
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const runningIds = useMemo(() => new Set(
    Object.entries(snapshot.conversations)
      .filter(([, entry]) => Boolean(entry?.running))
      .map(([conversationId]) => conversationId),
  ), [snapshot.conversations]);

  const completedIds = useMemo(
    () => unseenCompletions(snapshot.conversations, seen, currentConversationId),
    [snapshot.conversations, seen, currentConversationId],
  );

  /** 用户正看着/刚打开这个会话：把它当前的完成序号记为已看过。 */
  const markSeen = useCallback((conversationId) => {
    const entry = snapshotRef.current.conversations?.[conversationId];
    const next = acknowledgeSeen(seenRef.current, {
      epoch: snapshotRef.current.epoch,
      conversationId,
      seq: Number(entry?.seq) || 0,
    });
    if (next === seenRef.current) return;
    // 只留下本快照里还有活动的会话 + 刚看过的这个，避免标记无限堆积。
    const stored = pruneSeen(next, new Set([...Object.keys(snapshotRef.current.conversations || {}), conversationId]));
    seenRef.current = stored;
    setSeen(stored);
    writeSeen(stored);
  }, []);

  return {
    conversations: snapshot.conversations,
    epoch: snapshot.epoch,
    generatedAt: snapshot.generatedAt,
    runningIds,
    completedIds,
    markSeen,
    refresh: load,
  };
}
