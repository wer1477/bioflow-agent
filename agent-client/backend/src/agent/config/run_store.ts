import { v4 as uuidv4 } from 'uuid';
import { readRecord, updateRecord } from './conversation_file_store.js';

export type AgentRunStatus = 'queued' | 'building_context' | 'model_turn' | 'tool_execution' | 'waiting_user_input' | 'compacting' | 'completed' | 'failed' | 'cancelled';
export type AgentRunStopReason = 'final_answer' | 'max_tokens' | 'budget_exceeded' | 'unfinished_tasks' | 'tool_error' | 'permission_denied' | 'user_input_required' | 'cancelled' | 'connection_error';
export interface AgentRun { id: string; conversationId: string; assistantMessageId: string | null; agentId: string | null; parentRunId: string | null; parentStepId: string | null; status: AgentRunStatus; stopReason: AgentRunStopReason | null; error: string; plan: unknown; loadedTools: string[]; loadedSkills: string[]; summary: string; metadata: Record<string, unknown>; startedAt: string; completedAt: string | null; updatedAt: string; }
export interface AgentRunStep { id: string; runId: string; stepIndex: number; turnIndex: number | null; planStepIndex: number | null; parentStepId: string | null; kind: string; status: string; title: string; payload: unknown; resultPreview: string; startedAt: string; completedAt: string | null; }

export function createAgentRun(data: { conversationId: string; assistantMessageId?: string | null; agentId?: string | null; parentRunId?: string | null; parentStepId?: string | null; status?: AgentRunStatus; metadata?: Record<string, unknown>; }): AgentRun {
  const now = new Date().toISOString();
  const run: AgentRun = { id: uuidv4(), conversationId: data.conversationId, assistantMessageId: data.assistantMessageId || null, agentId: data.agentId || null, parentRunId: data.parentRunId || null, parentStepId: data.parentStepId || null, status: data.status || 'building_context', stopReason: null, error: '', plan: {}, loadedTools: [], loadedSkills: [], summary: '', metadata: data.metadata || {}, startedAt: now, completedAt: null, updatedAt: now };
  const result = updateRecord(data.conversationId, (record) => { record.runs.push(run); return run; }, () => ({ type: 'patch', collections: { runs: { upserts: [run], deletes: [] } } }));
  if (!result) throw new Error('Conversation not found.');
  return result;
}

export function updateAgentRun(conversationId: string, runId: string, data: Partial<Pick<AgentRun, 'status' | 'stopReason' | 'error' | 'plan' | 'loadedTools' | 'loadedSkills' | 'summary' | 'metadata' | 'completedAt'>>): AgentRun | undefined {
  return updateRecord(conversationId, (record) => {
    const index = record.runs.findIndex((run) => run.id === runId);
    if (index < 0) return undefined;
    const run = { ...record.runs[index], ...data, updatedAt: new Date().toISOString() };
    record.runs[index] = run;
    return run;
  }, (record) => {
    const run = record.runs.find((item) => item.id === runId);
    return { type: 'patch', collections: run ? { runs: { upserts: [run], deletes: [] } } : {} };
  });
}

export function createAgentRunStep(data: { conversationId: string; runId: string; turnIndex?: number | null; planStepIndex?: number | null; parentStepId?: string | null; kind: string; status?: string; title: string; payload?: unknown; resultPreview?: string; }): AgentRunStep {
  const record = readRecord(data.conversationId);
  if (!record || !record.runs.some((run) => run.id === data.runId)) throw new Error('Agent run not found.');
  const now = new Date().toISOString();
  const step: AgentRunStep = { id: uuidv4(), runId: data.runId, stepIndex: record.runSteps.filter((item) => item.runId === data.runId).length + 1, turnIndex: data.turnIndex ?? null, planStepIndex: data.planStepIndex ?? null, parentStepId: data.parentStepId || null, kind: data.kind, status: data.status || 'completed', title: data.title, payload: data.payload || {}, resultPreview: data.resultPreview || '', startedAt: now, completedAt: null };
  return updateRecord(data.conversationId, (next) => { next.runSteps.push(step); return step; }, () => ({ type: 'patch', collections: { runSteps: { upserts: [step], deletes: [] } } }))!;
}

export function updateAgentRunStep(conversationId: string, stepId: string, data: Partial<Pick<AgentRunStep, 'status' | 'title' | 'resultPreview'>> & { payload?: unknown; turnIndex?: number | null; planStepIndex?: number | null; parentStepId?: string | null; completedAt?: string | null; }): AgentRunStep | undefined {
  return updateRecord(conversationId, (record) => {
    const index = record.runSteps.findIndex((step) => step.id === stepId);
    if (index < 0) return undefined;
    const step = { ...record.runSteps[index], ...data };
    record.runSteps[index] = step;
    return step;
  }, (record) => {
    const step = record.runSteps.find((item) => item.id === stepId);
    return { type: 'patch', collections: step ? { runSteps: { upserts: [step], deletes: [] } } : {} };
  });
}

export function getAgentRun(conversationId: string, runId: string): AgentRun | undefined {
  return readRecord(conversationId)?.runs.find((run) => run.id === runId);
}

export function getConversationRuns(conversationId: string): AgentRun[] { return (readRecord(conversationId)?.runs || []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
export function getAgentRunSteps(conversationId: string, runId: string): AgentRunStep[] { return (readRecord(conversationId)?.runSteps || []).filter((step) => step.runId === runId).slice().sort((a, b) => a.stepIndex - b.stepIndex); }
