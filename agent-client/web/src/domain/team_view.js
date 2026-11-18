/**
 * View model for the team switcher and role attribution.
 *
 * Everything here is pure so `node --test` can cover it: the Web has no DOM test harness, and
 * the role grid / badge / divider logic is exactly the part worth pinning down.
 */

/** Display order of the five roles; mirrors `TEAM_ROLE_IDS` on the backend. */
export const TEAM_ROLE_ORDER = ['pi', 'searcher', 'researcher', 'writer', 'reviewer'];

/** The popover is a 2×3 grid: `auto|pi`, `searcher|researcher`, `writer|reviewer`. */
export const TEAM_GRID_ROWS = [
  ['auto', 'pi'],
  ['searcher', 'researcher'],
  ['writer', 'reviewer'],
];

export function roleById(team, roleId) {
  return (team?.roles || []).find((role) => role.id === roleId) || null;
}

export function roleLabel(team, roleId) {
  if (!roleId) return team?.leadRoleId ? roleLabel(team, team.leadRoleId) : 'PI';
  return roleById(team, roleId)?.label || roleId;
}

/**
 * What the composer/header should say the team is currently doing.
 *
 * `viewRoleId` is the role whose session is open. When it is set, the label describes where
 * the user is rather than where routing would send the next auto turn.
 */
export function teamStatusLabel(team, viewRoleId = null) {
  if (!team) return '团队';
  if (viewRoleId) return `${roleLabel(team, viewRoleId)} · 会话`;
  const active = roleLabel(team, team.activeRoleId);
  if (team.mode === 'manual') return `${active} · 手动`;
  const route = team.lastRoute;
  // A manual pick is not a routing decision: once the team is back on auto it must not keep
  // advertising the role the user happened to open a session of.
  if (!route || route.source === 'manual') return `${roleLabel(team, team.leadRoleId)} · 自动`;
  return `${roleLabel(team, route.roleId)} · 自动`;
}

/**
 * Cells of the switcher grid, in render order. `auto` is a mode, not a role, so it carries
 * no role metadata.
 *
 * `teamActivity` is the server's activity map (`conversationId -> { running, runningRoles }`).
 * A role cell is busy when its own session is running or when something below it is: a role
 * whose delegated subagent is still working is busy too, which is what `running` on the
 * ancestor entry means. `auto` deliberately carries no ring — it is a mode, and the role
 * that is actually working already shows one.
 *
 * `unreadRoleSessionIds` holds the role sessions with a completion the user has not looked
 * at yet. Only the role that finished last across the whole team gets the dot, so the grid
 * answers "which role just finished" instead of slowly filling up with one dot per turn.
 */
export function teamGridCells(team, viewRoleId = null, teamActivity = {}, unreadRoleSessionIds = null) {
  const newestSessionId = newestRoleCompletion(team, teamActivity);
  return TEAM_GRID_ROWS.map((row) => row.map((id) => {
    if (id === 'auto') {
      return {
        id,
        kind: 'mode',
        label: 'auto',
        active: !viewRoleId && team?.mode !== 'manual',
        hint: viewRoleId ? '回到团队会话' : '由团队决定谁接手',
      };
    }
    const role = roleById(team, id);
    const active = viewRoleId ? viewRoleId === id : (team?.mode === 'manual' && team?.activeRoleId === id);
    const sessionId = role?.sessionId || '';
    const entry = sessionId ? teamActivity?.[sessionId] : null;
    return {
      id,
      kind: 'role',
      label: role?.label || id,
      name: role?.name || '',
      description: role?.orchestratorDescription || role?.description || '',
      active,
      hasSession: Boolean(sessionId),
      running: Boolean(entry?.running),
      // 只有"最近一次结束且还没打开过"的角色打点。若按"每个未读都打点"，历史轮次会
      // 积一堆点，打开一个还会把更旧的点顶上来；按"全团队最新"就不会。
      finished: Boolean(
        sessionId
        && !entry?.running
        && sessionId === newestSessionId
        && unreadRoleSessionIds?.has?.(sessionId),
      ),
    };
  }));
}

/**
 * Badge text for one merged-timeline message.
 *
 * Root-level messages (`roleId: null`) predate the team and are attributed to the lead; an
 * assistant message with no role is the lead's too, because a role session always tags its
 * own messages.
 */
export function messageRoleLabel(team, message, viewRoleId = null) {
  if (!message) return '';
  if (message.role === 'user') return '';
  if (message.roleId) return roleLabel(team, message.roleId);
  // Inside a role session the messages predate the `roleId` tag; they are that role's.
  if (viewRoleId) return roleLabel(team, viewRoleId);
  return roleLabel(team, team?.leadRoleId);
}

/**
 * Which messages start a new role's turn.
 *
 * Returns a parallel array of booleans: `true` where the role changed from the previous
 * assistant message, i.e. where the timeline should draw "X 接手".
 */
export function roleDividers(team, messages) {
  const rows = messages || [];
  let previous = null;
  return rows.map((message) => {
    if (message.role === 'user') return false;
    const roleId = message.roleId || team?.leadRoleId || null;
    const changed = Boolean(roleId) && roleId !== previous;
    previous = roleId;
    return changed;
  });
}

/** Compact line for a live `role_switch` event; `null` when it is not a switch. */
export function roleSwitchLabel(team, event) {
  if (!event || event.type !== 'role_switch') return null;
  const to = roleLabel(team, event.toRoleId);
  const reason = String(event.reason || '').trim();
  return reason ? `${to} 接手 · ${reason}` : `${to} 接手`;
}

/** The role a live event stream currently belongs to, for the streaming bubble's badge. */
export function liveRoleLabel(team, events) {
  for (let index = (events || []).length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.roleId) return roleLabel(team, event.roleId);
    if (event?.type === 'route_decision' && event.roleId) return roleLabel(team, event.roleId);
  }
  return team?.roles?.length ? roleLabel(team, team.activeRoleId) : '';
}

/**
 * Role session whose run finished last, across the whole team, or null.
 *
 * Deliberately independent of the read markers: if this were "newest unread", opening the
 * dotted role would promote an older unread turn into the dot instead of clearing it.
 */
function newestRoleCompletion(team, teamActivity) {
  let newestId = null;
  let newestSeq = 0;
  for (const role of team?.roles || []) {
    const sessionId = role?.sessionId;
    if (!sessionId) continue;
    const seq = Number(teamActivity?.[sessionId]?.seq) || 0;
    if (seq > newestSeq) {
      newestSeq = seq;
      newestId = sessionId;
    }
  }
  return newestId;
}
