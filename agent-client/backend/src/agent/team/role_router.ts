import { getTeamConfig, TEAM_ROLE_IDS, type AgentRole } from '../config/agent_config_store.js';
import { isBiodDisabledByEnv, loadBiodConfig } from '../biod/config.js';
import type { TeamMode } from './team_service.js';

/**
 * Turns a user message into "which role answers this".
 *
 * v1 ships `always-pi`: every turn goes to the lead. The interface exists now so the other
 * engines can slot in without touching the route or the team session model — `biod` gets a
 * `role_select` decision point later, `rules+llm` is the offline fallback until it does.
 */

export type RoleRouteSource = 'default' | 'rule' | 'llm' | 'biod' | 'fallback' | 'manual';

export interface RoleRouteDecision {
  roleId: AgentRole;
  /** 0..1. `always-pi` reports 1 because it is not guessing. */
  confidence: number;
  source: RoleRouteSource;
  reason: string;
  at: string;
}

export interface RoleRouteInput {
  conversationId: string;
  message: string;
  mode: TeamMode;
  /** Role the team is currently on; what a sticky router would keep. */
  activeRoleId: AgentRole;
  /** Set when the user picked a role explicitly. */
  requestedRoleId?: AgentRole;
}

export interface RoleRouter {
  decide(input: RoleRouteInput): Promise<RoleRouteDecision> | RoleRouteDecision;
}

function now(): string {
  return new Date().toISOString();
}

export const alwaysPiRouter: RoleRouter = {
  decide(input) {
    const team = getTeamConfig();
    if (input.requestedRoleId) {
      return {
        roleId: input.requestedRoleId,
        confidence: 1,
        source: 'manual',
        reason: '用户指定了角色',
        at: now(),
      };
    }
    if (input.mode === 'manual') {
      return {
        roleId: input.activeRoleId,
        confidence: 1,
        source: 'manual',
        reason: '手动模式下沿用当前角色',
        at: now(),
      };
    }
    if (team.router.engine === 'always-pi') {
      return {
        roleId: team.leadRoleId,
        confidence: 1,
        source: 'default',
        reason: '路由引擎为 always-pi',
        at: now(),
      };
    }
    // A configured engine that is not implemented yet must not swallow the turn.
    return {
      roleId: team.router.fallbackRoleId || team.leadRoleId,
      confidence: 0,
      source: 'fallback',
      reason: `路由引擎 ${team.router.engine} 尚未接入，回落到 ${team.router.fallbackRoleId}`,
      at: now(),
    };
  },
};

/**
 * Ask the multitask sidecar which role should answer. Any failure (disabled,
 * unreachable, slow, unknown role, bad confidence) is a normal fallback to the
 * configured fallback role — the user's message is never lost.
 */
async function biodRoleDecision(message: string): Promise<{ roleId: AgentRole; confidence: number } | null> {
  const config = loadBiodConfig();
  if (!config.enabled || isBiodDisabledByEnv() || config.decisionPoints.role_select.mode === 'off') return null;
  const baseUrl = String(config.service.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const timeoutMs = Math.min(1_500, config.service.requestTimeoutMs || 1_500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('role route timeout')), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/decide/role_select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ state: message }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    const role = String(payload.role ?? '');
    if (!(TEAM_ROLE_IDS as readonly string[]).includes(role)) return null;
    const confidence = Number(payload.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return { roleId: role as AgentRole, confidence };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const biodRouter: RoleRouter = {
  async decide(input) {
    const team = getTeamConfig();
    const fallback = (): RoleRouteDecision => ({
      roleId: team.router.fallbackRoleId || team.leadRoleId,
      confidence: 0,
      source: 'fallback',
      reason: 'biod 路由不可用，回落到兜底角色',
      at: now(),
    });
    if (input.requestedRoleId) {
      return { roleId: input.requestedRoleId, confidence: 1, source: 'manual', reason: '用户指定了角色', at: now() };
    }
    if (input.mode === 'manual') {
      return { roleId: input.activeRoleId, confidence: 1, source: 'manual', reason: '手动模式下沿用当前角色', at: now() };
    }
    const decision = await biodRoleDecision(input.message);
    if (!decision) return fallback();
    const tau = loadBiodConfig().decisionPoints.role_select.tau;
    if (decision.confidence < tau) {
      return {
        roleId: team.router.fallbackRoleId || team.leadRoleId,
        confidence: decision.confidence,
        source: 'biod',
        reason: `biod 置信度 ${decision.confidence.toFixed(2)} < ${tau}，交给兜底角色`,
        at: now(),
      };
    }
    return { roleId: decision.roleId, confidence: decision.confidence, source: 'biod', reason: 'biod role_select', at: now() };
  },
};

let activeRouter: RoleRouter = alwaysPiRouter;

export function getRoleRouter(): RoleRouter {
  return activeRouter;
}

/** Test seam: pass `null` to restore the shipped router. */
export function setRoleRouterForTests(router: RoleRouter | null): void {
  activeRouter = router || alwaysPiRouter;
}

/**
 * Decide, never throw.
 *
 * A router that fails must not lose the user's message, so any error becomes a low-confidence
 * fallback to the configured fallback role.
 */
export async function decideRole(input: RoleRouteInput): Promise<RoleRouteDecision> {
  const team = getTeamConfig();
  const router = activeRouter !== alwaysPiRouter
    ? activeRouter
    : (team.router.engine === 'biod' ? biodRouter : activeRouter);
  try {
    return await router.decide(input);
  } catch (err) {
    const team = getTeamConfig();
    return {
      roleId: team.router.fallbackRoleId || team.leadRoleId,
      confidence: 0,
      source: 'fallback',
      reason: `路由失败：${err instanceof Error ? err.message : String(err)}`,
      at: now(),
    };
  }
}
