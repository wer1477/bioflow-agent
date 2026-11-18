/**
 * Process-wide gate that keeps **one live run per conversation**.
 *
 * The transcript is append-only, and a recorder allocates its sequence from the log tail
 * exactly once, at construction. Two recorders on the same conversation therefore hand out
 * the same numbers, which the reader treats as corruption — and because a writer never
 * renumbers, that damage is permanent. The team runtime made this reachable: a dispatch
 * batch runs several messages at once, and two of them can target one role session.
 *
 * Every run path funnels through `AgentService.runCompletion`, so the queue lives there.
 * It is FIFO rather than a rejection: a lead that queued two tasks for one role expects
 * both to run, in order, not one of them to fail.
 *
 * The HTTP layer keeps its own `activeConversationControllers` for a different job —
 * answering 409 to a second *request* and propagating aborts. That map is a reservation,
 * not a mutex, and it never covered runs started directly (a delegated child).
 */

class RunRegistry {
  /** Tail of each conversation's queue; the value resolves when its holder releases. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Conversations whose run is executing right now. */
  private readonly holders = new Map<string, number>();
  /** Callers queued for a conversation, counted so `isActive` sees them too. */
  private readonly waiting = new Map<string, number>();

  /**
   * Wait for this conversation's turn and return the release function.
   *
   * Awaiting is deliberate: the caller has already decided the work must happen. A
   * caller that cannot wait (an HTTP request with a client-side queue of its own) is
   * rejected earlier, by the request-level controllers in the route.
   */
  async acquire(conversationId: string): Promise<() => void> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    this.increment(this.waiting, conversationId);
    // Chain behind the previous turn. A failed run must not poison its followers, so
    // the previous promise is awaited through a catch that swallows its rejection.
    this.tails.set(conversationId, previous.catch(() => undefined).then(() => turn));
    await previous.catch(() => undefined);
    this.decrement(this.waiting, conversationId);
    this.increment(this.holders, conversationId);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrement(this.holders, conversationId);
      releaseTurn();
      if (!this.holders.has(conversationId) && !this.waiting.has(conversationId)) {
        this.tails.delete(conversationId);
      }
    };
  }

  /** True while a run holds this conversation or is queued for it. */
  isActive(conversationId: string): boolean {
    return (this.holders.get(conversationId) ?? 0) > 0
      || (this.waiting.get(conversationId) ?? 0) > 0;
  }

  anyActive(conversationIds: readonly string[]): boolean {
    return conversationIds.some((conversationId) => this.isActive(conversationId));
  }

  /** Test seam: forget every queued and running conversation. */
  resetForTests(): void {
    this.tails.clear();
    this.holders.clear();
    this.waiting.clear();
  }

  private increment(counter: Map<string, number>, key: string): void {
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }

  private decrement(counter: Map<string, number>, key: string): void {
    const next = (counter.get(key) ?? 1) - 1;
    if (next > 0) counter.set(key, next);
    else counter.delete(key);
  }
}

export const runRegistry = new RunRegistry();
