import { appendContextMessage } from '../config/context_message_store.js';

/**
 * Process-local bookkeeping for delegated child agents.
 *
 * Deliberately free of any Agent-runtime import: the module only owns the concurrency
 * gate, the cancel handles and the parent notice queue, so both the CoreTool executor
 * and the runtime loop can depend on it without an import cycle.
 *
 * The durable record of a child is its own conversation (`parentConversationId` on the
 * conversation). This module holds nothing that must survive a restart: an active child
 * whose process died is simply no longer running, and its conversation still tells the
 * story.
 */

export interface SubagentLimits {
  /** Delegation depth allowed from a user run (root depth 0). */
  maxDepth: number;
  /** Live child runs across the whole backend process. No queue: see `canStart`. */
  maxConcurrent: number;
  /** Default and maximum wall clock for one child run. */
  timeoutMs: number;
}

const DEFAULT_LIMITS: SubagentLimits = {
  maxDepth: 1,
  maxConcurrent: 2,
  timeoutMs: 15 * 60 * 1000,
};

const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Read the delegation limits from the environment.
 *
 * Invalid values fall back to the defaults instead of throwing: a typo in a deployment
 * variable must not take the whole agent runtime down.
 */
export function resolveSubagentLimits(env: NodeJS.ProcessEnv = process.env): SubagentLimits {
  return {
    maxDepth: boundedInteger(env.BIOFLOW_SUBAGENT_MAX_DEPTH, DEFAULT_LIMITS.maxDepth, 0, 8),
    maxConcurrent: boundedInteger(env.BIOFLOW_SUBAGENT_MAX_CONCURRENT, DEFAULT_LIMITS.maxConcurrent, 1, 16),
    timeoutMs: boundedInteger(env.BIOFLOW_SUBAGENT_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, 30_000, MAX_TIMEOUT_MS),
  };
}

export interface SubagentHandle {
  conversationId: string;
  parentConversationId: string;
  description: string;
  depth: number;
  startedAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set by the wall-clock timer so the runner can report a timeout, not a cancel. */
  timedOut: boolean;
  /** Removes the parent-signal listener once the child settles. */
  detachParentAbort: (() => void) | null;
}

class SubagentRuntime {
  private readonly active = new Map<string, SubagentHandle>();
  private readonly parentRuns = new Set<string>();
  private readonly pendingNotices = new Map<string, string[]>();

  activeCount(): number {
    return this.active.size;
  }

  /**
   * Admission for one more child. Deliberately a refusal, never a queue: a parent that
   * blocks waiting for a slot it may itself be holding deadlocks its own subtree
   * (the same reason the DSH seam rejects at capacity instead of queuing).
   */
  canStart(limits: Pick<SubagentLimits, 'maxConcurrent'>): boolean {
    return this.active.size < limits.maxConcurrent;
  }

  track(handle: SubagentHandle): void {
    this.active.set(handle.conversationId, handle);
  }

  get(conversationId: string): SubagentHandle | undefined {
    return this.active.get(conversationId);
  }

  listForParent(parentConversationId: string): SubagentHandle[] {
    return [...this.active.values()].filter((handle) => handle.parentConversationId === parentConversationId);
  }

  /** Remove a finished child and release its timer; the notice is published by the caller. */
  release(conversationId: string): SubagentHandle | undefined {
    const handle = this.active.get(conversationId);
    if (!handle) return undefined;
    if (handle.timer) clearTimeout(handle.timer);
    handle.detachParentAbort?.();
    this.active.delete(conversationId);
    return handle;
  }

  /** Abort one live child; idempotent, and a no-op for a child that already settled. */
  cancel(conversationId: string): boolean {
    const handle = this.active.get(conversationId);
    if (!handle) return false;
    handle.controller.abort(new Error('Subagent cancellation was requested.'));
    return true;
  }

  /** Mark one parent run as live so notices can be injected at its next model step. */
  registerParentRun(conversationId: string): void {
    this.parentRuns.add(conversationId);
    // Anything still queued belongs to a previous run; its text is already durable in
    // the context transcript, so replaying it here would duplicate it in this run.
    this.pendingNotices.delete(conversationId);
  }

  unregisterParentRun(conversationId: string): void {
    this.parentRuns.delete(conversationId);
    this.pendingNotices.delete(conversationId);
  }

  isParentRunActive(conversationId: string): boolean {
    return this.parentRuns.has(conversationId);
  }

  /**
   * Durable completion notice.
   *
   * It is always appended to the parent's model transcript: a finished child must never
   * be forgotten just because the parent run happened to be idle. When the parent run is
   * live it is queued as well, so the model sees it before the next model request of the
   * same run instead of waiting for the next user turn.
   *
   * Return `queued: false` tells the caller the notice will be picked up by the next run's
   * history assembly rather than injected now.
   */
  publishNotice(parentConversationId: string, text: string): { queued: boolean } {
    appendContextMessage(parentConversationId, { role: 'user', content: text, runId: null });
    if (!this.parentRuns.has(parentConversationId)) return { queued: false };
    const queue = this.pendingNotices.get(parentConversationId);
    if (queue) queue.push(text);
    else this.pendingNotices.set(parentConversationId, [text]);
    return { queued: true };
  }

  /** Take every notice waiting for an active parent run, oldest first. */
  drainNotices(conversationId: string): string[] {
    const queue = this.pendingNotices.get(conversationId);
    if (!queue?.length) return [];
    this.pendingNotices.delete(conversationId);
    return queue;
  }

  resetForTests(): void {
    for (const handle of this.active.values()) {
      if (handle.timer) clearTimeout(handle.timer);
      handle.detachParentAbort?.();
    }
    this.active.clear();
    this.parentRuns.clear();
    this.pendingNotices.clear();
  }
}

export const subagentRuntime = new SubagentRuntime();
