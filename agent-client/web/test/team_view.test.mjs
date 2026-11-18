import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEAM_GRID_ROWS,
  liveRoleLabel,
  messageRoleLabel,
  roleDividers,
  roleLabel,
  roleSwitchLabel,
  teamGridCells,
  teamStatusLabel,
} from '../src/domain/team_view.js';

const TEAM = {
  rootId: 'root',
  leadRoleId: 'pi',
  mode: 'auto',
  activeRoleId: 'pi',
  lastRoute: { roleId: 'searcher', confidence: 1, source: 'default', reason: 'always-pi' },
  cards: [],
  roles: [
    { id: 'pi', label: 'PI', name: 'PI', sessionId: 's-pi', messageCount: 2 },
    { id: 'searcher', label: 'Searcher', name: '文献与假设专家', sessionId: 's-searcher', messageCount: 1 },
    { id: 'researcher', label: 'Researcher', name: '研究执行专家', sessionId: null, messageCount: 0 },
    { id: 'writer', label: 'Writer', name: '论文写作专家', sessionId: null, messageCount: 0 },
    { id: 'reviewer', label: 'Reviewer', name: '审查专家', sessionId: null, messageCount: 0 },
  ],
};

test('the switcher is a 2x3 grid with auto in the mode slot', () => {
  assert.deepEqual(TEAM_GRID_ROWS, [
    ['auto', 'pi'],
    ['searcher', 'researcher'],
    ['writer', 'reviewer'],
  ]);
  const cells = teamGridCells(TEAM);
  assert.equal(cells.length, 3);
  assert.equal(cells[0][0].kind, 'mode');
  assert.equal(cells[0][0].active, true, 'auto is active while the team is not manual');
  assert.equal(cells[0][1].label, 'PI');
  assert.equal(cells[1][0].label, 'Searcher');
  assert.equal(cells[1][0].hasSession, true);
  assert.equal(cells[1][1].hasSession, false, 'a role with no session says so');
});

test('a running role shows its own ring, and auto never takes one', () => {
  const teamActivity = {
    root: { running: true, runningRoles: ['reviewer'], seq: 3 },
    's-searcher': { running: true, selfRunning: true, runningRoles: ['searcher'] },
    's-pi': { running: false, seq: 1 },
  };
  const cells = teamGridCells(TEAM, null, teamActivity).flat();
  assert.equal(cells.find((cell) => cell.id === 'searcher').running, true);
  assert.equal(cells.find((cell) => cell.id === 'pi').running, false, 'an idle role is not marked');
  assert.equal(cells.find((cell) => cell.id === 'writer').running, false, 'a role without a session cannot be running');
  assert.equal(cells.find((cell) => cell.id === 'auto').running, undefined, 'auto is a mode, not a running role');
});

test('the role that finished most recently gets the completion dot', () => {
  const teamActivity = { 's-pi': { seq: 5 }, 's-searcher': { seq: 2 } };
  const cells = teamGridCells(TEAM, null, teamActivity, new Set(['s-pi', 's-searcher'])).flat();
  assert.equal(cells.find((cell) => cell.id === 'pi').finished, true);
  assert.equal(cells.find((cell) => cell.id === 'searcher').finished, false, 'an older completion does not dot');
  assert.equal(cells.find((cell) => cell.id === 'auto').finished, undefined, 'auto has no conversation to be unread');
});

test('opening the dotted role does not promote an older unread turn', () => {
  // PI finished last but has been opened; the older unread Searcher turn must stay quiet.
  const teamActivity = { 's-pi': { seq: 5 }, 's-searcher': { seq: 2 } };
  const cells = teamGridCells(TEAM, null, teamActivity, new Set(['s-searcher'])).flat();
  assert.equal(cells.find((cell) => cell.id === 'pi').finished, false);
  assert.equal(cells.find((cell) => cell.id === 'searcher').finished, false);
});

test('a role with nothing unread is not dotted', () => {
  const cells = teamGridCells(TEAM, null, { 's-searcher': { seq: 2 } }, new Set()).flat();
  assert.equal(cells.find((cell) => cell.id === 'searcher').finished, false);
});

test('a running role never shows the completion dot at the same time', () => {
  const teamActivity = { 's-searcher': { running: true, runningRoles: ['searcher'], seq: 3 } };
  const cells = teamGridCells(TEAM, null, teamActivity, new Set(['s-searcher'])).flat();
  const searcher = cells.find((cell) => cell.id === 'searcher');
  assert.equal(searcher.running, true);
  assert.equal(searcher.finished, false);
});

test('a role whose delegated child still runs is busy too', () => {
  // The server folds activity up to ancestors, so the role session entry is already true.
  const teamActivity = { 's-pi': { running: true, selfRunning: false, runningRoles: ['pi'] } };
  const cells = teamGridCells(TEAM, null, teamActivity).flat();
  assert.equal(cells.find((cell) => cell.id === 'pi').running, true);
});

test('a manual pick highlights exactly one role cell', () => {
  const manual = { ...TEAM, mode: 'manual', activeRoleId: 'writer' };
  const cells = teamGridCells(manual).flat();
  assert.equal(cells.find((cell) => cell.id === 'auto').active, false);
  assert.deepEqual(cells.filter((cell) => cell.active).map((cell) => cell.id), ['writer']);
});

test('the trigger label explains who is answering and why', () => {
  assert.equal(teamStatusLabel(TEAM), 'Searcher · 自动');
  assert.equal(teamStatusLabel({ ...TEAM, mode: 'manual', activeRoleId: 'writer' }), 'Writer · 手动');
  assert.equal(teamStatusLabel({ ...TEAM, lastRoute: null }), 'PI · 自动');
  assert.equal(
    teamStatusLabel({ ...TEAM, activeRoleId: 'writer', lastRoute: { roleId: 'writer', confidence: 1, source: 'manual' } }),
    'PI · 自动',
    'a manual pick is not advertised once the team is back on auto',
  );
  assert.equal(teamStatusLabel(null), '团队');
});

test('messages carry the role that produced them, and user turns carry none', () => {
  assert.equal(messageRoleLabel(TEAM, { role: 'assistant', roleId: 'searcher' }), 'Searcher');
  assert.equal(messageRoleLabel(TEAM, { role: 'assistant', roleId: 'writer' }), 'Writer');
  assert.equal(messageRoleLabel(TEAM, { role: 'user', roleId: 'searcher' }), '');
  assert.equal(messageRoleLabel(TEAM, { role: 'assistant', roleId: null }), 'PI', 'a legacy root message is the lead');
  assert.equal(roleLabel(TEAM, 'nobody'), 'nobody');
});

test('the divider marks where the answering role changes', () => {
  const messages = [
    { role: 'user' },
    { role: 'assistant', roleId: 'pi' },
    { role: 'assistant', roleId: 'pi' },
    { role: 'user' },
    { role: 'assistant', roleId: 'searcher' },
  ];
  assert.deepEqual(roleDividers(TEAM, messages), [false, true, false, false, true]);
});

test('opening a role session marks that role, not the routing target', () => {
  const cells = teamGridCells(TEAM, 'searcher').flat();
  assert.equal(cells.find((cell) => cell.id === 'auto').active, false, 'auto is left while a role session is open');
  assert.deepEqual(cells.filter((cell) => cell.active).map((cell) => cell.id), ['searcher']);
  assert.equal(teamStatusLabel(TEAM, 'searcher'), 'Searcher · 会话');
  assert.equal(messageRoleLabel(TEAM, { role: 'assistant', roleId: null }, 'writer'), 'Writer');
});

test('role switch events and live attribution', () => {
  assert.equal(roleSwitchLabel(TEAM, { type: 'role_switch', toRoleId: 'writer', reason: 'PI 派发任务' }), 'Writer 接手 · PI 派发任务');
  assert.equal(roleSwitchLabel(TEAM, { type: 'content' }), null);
  assert.equal(liveRoleLabel(TEAM, [{ type: 'content', roleId: 'searcher' }, { type: 'content', roleId: 'writer' }]), 'Writer');
  assert.equal(liveRoleLabel(TEAM, []), 'PI', 'with no events yet the badge shows the active role');
});
