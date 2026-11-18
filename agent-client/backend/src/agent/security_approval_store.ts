import { randomUUID } from 'node:crypto';
import type { CommandRisk, SecurityMode } from './security_policy.js';

export type SecurityApprovalDecision = 'approve' | 'deny';

export interface PendingSecurityApproval {
  id: string;
  runId: string | null;
  conversationId: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  mode: SecurityMode;
  risk: CommandRisk;
  reason: string;
  createdAt: string;
}

interface PendingEntry extends PendingSecurityApproval {
  resolve: (decision: SecurityApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

class SecurityApprovalStore {
  private readonly pending = new Map<string, PendingEntry>();

  create(input: Omit<PendingSecurityApproval, 'id' | 'createdAt'>, signal?: AbortSignal): { request: PendingSecurityApproval; wait: Promise<SecurityApprovalDecision> } {
    const request: PendingSecurityApproval = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    let resolveDecision!: (decision: SecurityApprovalDecision) => void;
    let rejectDecision!: (error: Error) => void;
    const wait = new Promise<SecurityApprovalDecision>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    const settle = (callback: () => void) => {
      const entry = this.pending.get(request.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(request.id);
      callback();
    };
    const timer = setTimeout(() => settle(() => rejectDecision(new Error('Security approval timed out.'))), APPROVAL_TIMEOUT_MS);
    this.pending.set(request.id, { ...request, resolve: resolveDecision, reject: rejectDecision, timer });
    signal?.addEventListener('abort', () => settle(() => rejectDecision(new Error('Security approval was cancelled.'))), { once: true });
    return { request, wait };
  }

  respond(conversationId: string, runId: string, approvalId: string, decision: SecurityApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.conversationId !== conversationId || entry.runId !== runId) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve(decision);
    return true;
  }
}

export const securityApprovalStore = new SecurityApprovalStore();
