import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { findSessionProjectKey, listRecords } from './conversation_file_store.js';
import { artifactsFilePath } from './session_paths.js';

export interface StoredArtifact { id: string; conversationId: string; scope: string; planId: string | null; executionId: string | null; type: string; title: string; path: string; mimeType: string; summary: string; tags: string[]; status: string; createdByAgentId: string | null; metadata: Record<string, unknown>; createdAt: string; updatedAt: string; }

export interface WorkspaceArtifact extends StoredArtifact {
  scope: 'planning' | 'execution' | 'shared';
}

/**
 * Artifacts are session bookkeeping: `artifacts.json` lives in the session's
 * own state directory (`WORKSPACE_ROOT/.sessions/<projectKey>/<sessionId>/`),
 * never inside the project directory.
 */
function file(conversationId: string): string | null {
  const projectKeyValue = findSessionProjectKey(conversationId);
  return projectKeyValue ? artifactsFilePath(projectKeyValue, conversationId) : null;
}
export function listArtifacts(conversationId: string): StoredArtifact[] { const target = file(conversationId); if (!target) return []; try { const value = JSON.parse(fs.readFileSync(target, 'utf8')) as { artifacts?: StoredArtifact[] }; return Array.isArray(value.artifacts) ? value.artifacts : []; } catch { return []; } }
export function getArtifact(conversationId: string, id: string): StoredArtifact | undefined { return listArtifacts(conversationId).find((item) => item.id === id); }
export function saveArtifact(item: StoredArtifact): StoredArtifact { const artifacts = listArtifacts(item.conversationId); const index = artifacts.findIndex((entry) => entry.id === item.id); if (index >= 0) artifacts[index] = item; else artifacts.push(item); save(item.conversationId, artifacts); return item; }
export function findArtifact(conversationId: string, relativePath: string): StoredArtifact | undefined { return listArtifacts(conversationId).find((item) => item.path === relativePath); }
export function deleteArtifactsAt(conversationId: string, relativePath: string): void { save(conversationId, listArtifacts(conversationId).filter((item) => item.path !== relativePath && !item.path.startsWith(`${relativePath}/`))); }
export function moveArtifactsAt(conversationId: string, from: string, to: string): void { save(conversationId, listArtifacts(conversationId).map((item) => item.path === from || item.path.startsWith(`${from}/`) ? { ...item, path: `${to}${item.path.slice(from.length)}`, title: path.basename(`${to}${item.path.slice(from.length)}`), updatedAt: new Date().toISOString() } : item)); }
function save(conversationId: string, artifacts: StoredArtifact[]): void {
  const target = file(conversationId);
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, artifacts }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
}

export function createWorkspaceArtifact(data: Omit<WorkspaceArtifact, 'id' | 'createdAt' | 'updatedAt'>): WorkspaceArtifact {
  const now = new Date().toISOString();
  return saveArtifact({ id: uuidv4(), ...data, createdAt: now, updatedAt: now } as StoredArtifact) as WorkspaceArtifact;
}

export function getConversationArtifacts(conversationId: string): WorkspaceArtifact[] {
  return listArtifacts(conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) as WorkspaceArtifact[];
}

/** Looks up one artifact across every project key of the session store. */
export function getWorkspaceArtifact(id: string): WorkspaceArtifact | undefined {
  for (const record of listRecords()) {
    const artifact = getArtifact(record.conversation.id, id);
    if (artifact) return artifact as WorkspaceArtifact;
  }
  return undefined;
}
