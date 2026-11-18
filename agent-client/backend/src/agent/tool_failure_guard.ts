export const REPEATED_TOOL_FAILURE_WARNING = 3;
export const TOOL_FAILURE_LIMIT = 10;

export class RepeatedToolFailureError extends Error {
  constructor(
    readonly toolName: string,
    readonly failureCount: number,
  ) {
    super(`Tool ${toolName} failed ${failureCount} consecutive times; stopping run.`);
    this.name = 'RepeatedToolFailureError';
  }
}

/** Tracks failures per tool for one agent run. A successful call resets that tool's count. */
export class ToolFailureTracker {
  private readonly failureCounts = new Map<string, number>();

  record(toolName: string, result: string): { failed: boolean; failureCount: number; shouldWarn: boolean; shouldAbort: boolean } {
    if (!isFailedToolResult(result)) {
      this.failureCounts.delete(toolName);
      return { failed: false, failureCount: 0, shouldWarn: false, shouldAbort: false };
    }

    const failureCount = (this.failureCounts.get(toolName) || 0) + 1;
    this.failureCounts.set(toolName, failureCount);
    return {
      failed: true,
      failureCount,
      shouldWarn: failureCount === REPEATED_TOOL_FAILURE_WARNING,
      shouldAbort: failureCount >= TOOL_FAILURE_LIMIT,
    };
  }
}

export function isFailedToolResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      return value.ok === false || value.isError === true || typeof value.error === 'string';
    }
  } catch {
    // MCP tool errors are commonly returned as plain text rather than JSON.
  }
  return /^error\s*:/i.test(result.trim());
}
