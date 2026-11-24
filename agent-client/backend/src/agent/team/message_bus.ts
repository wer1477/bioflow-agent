import { listArtifacts } from '../config/workspace_artifact_store.js';
import type { TeamMessage } from './message.js';
import { enqueueTeamDelivery, listRoleSessions, readTeamState, updateTeamDeliveries, type PendingTeamDelivery } from './team_service.js';

export const enqueueTeamMessage = enqueueTeamDelivery;

export function peekTeamMessages(rootId: string): TeamMessage[] {
  return readTeamState(rootId).pendingDeliveries.filter((item) => item.state === 'queued')
    .map((item) => item.message);
}

/** Claim pending messages while the root is locked by the team stream. */
export function drainTeamMessages(rootId: string): TeamMessage[] {
  const state = readTeamState(rootId);
  const pending = new Map(state.pendingDeliveries.map((item) => [item.message.id, item.state]));
  const claimed: TeamMessage[] = [];
  let latest: Map<string, string> | undefined;
  const latestVersions = () => {
    if (!latest) {
      latest = new Map();
      for (const role of listRoleSessions(rootId)) {
        for (const artifact of listArtifacts(role.id)) {
          const current = latest.get(artifact.path);
          if (!current || artifact.updatedAt > current) latest.set(artifact.path, artifact.updatedAt);
        }
      }
    }
    return latest;
  };

  updateTeamDeliveries(rootId, (items) => {
    let changed = false;
    const entries = items.map((item): PendingTeamDelivery => {
      if (item.state !== 'queued' && item.state !== 'blocked') return item;
      const dependencies = item.message.dependsOn || [];
      for (const id of dependencies) {
        const result = state.handoffOutcomes[id];
        let reason;
        if (result && !result.passed) reason = `上游任务 ${id} 执行失败。`;
        if (pending.get(id) === 'interrupted') reason = `上游任务 ${id} 执行中断。`;
        if (pending.get(id) === 'blocked') reason = `上游任务 ${id} 尚未解除阻塞。`;
        if (result?.versions.some((ref) => latestVersions().get(ref.path) !== ref.version)) {
          reason = `上游任务 ${id} 引用的产物版本已失效。`;
        }
        if (reason) {
          if (item.state === 'blocked' && item.reason === reason) return item;
          changed = true;
          return { ...item, state: 'blocked', reason };
        }
      }
      if (dependencies.some((id) => !Object.hasOwn(state.handoffOutcomes, id))) return item;
      claimed.push(item.message);
      changed = true;
      return { message: item.message, state: 'claimed' };
    });
    return changed ? entries : items;
  });
  return claimed;
}

/** Work that had begun is visible as interrupted. A later turn can resume work that had not begun. */
export function recoverTeamMessages(rootId: string): void {
  updateTeamDeliveries(rootId, (items) => {
    if (!items.some((item) => item.state === 'claimed' || item.state === 'running')) return items;
    return items.map((item) => {
      if (item.state === 'claimed') return { ...item, state: 'queued' };
      if (item.state === 'running') return { ...item, state: 'interrupted' };
      return item;
    });
  });
}

export function startTeamMessage(rootId: string, id: string): void {
  updateTeamDeliveries(rootId, (items) => items.map((item) =>
    item.message.id === id && item.state === 'claimed' ? { ...item, state: 'running' } : item));
}

export function finishTeamMessage(rootId: string, id: string): void {
  updateTeamDeliveries(rootId, (items) => items.filter((item) => item.message.id !== id));
}
