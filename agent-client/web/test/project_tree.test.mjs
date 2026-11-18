import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canDeleteProject,
  findProject,
  groupSessionsByProject,
  matchProjects,
  projectSubtitle,
  sessionsForProject,
  sortProjects,
  visibleProjects,
  visibleSessions,
} from '../src/domain/project_tree.js';

const sessions = [
  { id: 'a', projectKey: 'p1', title: 'Alzheimer QC' },
  { id: 'b', projectKey: 'p1', title: 'Report' },
  { id: 'c', projectKey: 'p2', title: 'Other' },
  { id: 'orphan', projectKey: null, title: 'Orphan' },
];

test('groupSessionsByProject buckets by the derived projectKey and drops ungrouped sessions', () => {
  const grouped = groupSessionsByProject(sessions);
  assert.deepEqual(Object.keys(grouped).sort(), ['p1', 'p2']);
  assert.deepEqual(sessionsForProject(grouped, 'p1').map((s) => s.id), ['a', 'b']);
  assert.deepEqual(sessionsForProject(grouped, 'missing'), []);
});

test('groupSessionsByProject falls back to projectPath when projectKey is absent', () => {
  const legacy = [{ id: 'x', projectPath: '/ws/demo', title: 'Legacy payload' }];
  const grouped = groupSessionsByProject(legacy, new Map([['/ws/demo', 'demo']]));
  assert.deepEqual(grouped.demo.map((s) => s.id), ['x']);
  assert.deepEqual(groupSessionsByProject(legacy), {}, '没有 projectKey 也没有映射时不硬塞分组');
});

test('sortProjects puts running projects first, then most recent activity', () => {
  const sorted = sortProjects([
    { key: 'a', title: 'A', runningCount: 0, lastActivityAt: '2026-01-01T00:00:00.000Z' },
    { key: 'b', title: 'B', runningCount: 2, lastActivityAt: '2025-01-01T00:00:00.000Z' },
    { key: 'c', title: 'C', runningCount: 0, lastActivityAt: '2026-05-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((project) => project.key), ['b', 'c', 'a']);
});

test('visibleSessions limits the tree but always keeps running sessions', () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}` }));
  const collapsed = visibleSessions(rows, { limit: 5, runningIds: new Set(['s7']) });
  assert.deepEqual(collapsed.visible.map((s) => s.id), ['s0', 's1', 's2', 's3', 's4', 's7']);
  assert.equal(collapsed.hidden, 3);

  const expanded = visibleSessions(rows, { limit: 5, expanded: true });
  assert.equal(expanded.visible.length, 9);
  assert.equal(expanded.hidden, 0);

  const short = visibleSessions(rows.slice(0, 3), { limit: 5 });
  assert.equal(short.hidden, 0);
});

test('matchProjects keeps a project whole when its name matches, otherwise only matching sessions', () => {
  const projects = [{ key: 'p1', title: 'Alzheimer' }, { key: 'p2', title: 'Other' }];
  const grouped = groupSessionsByProject(sessions);

  const byName = matchProjects(projects, grouped, 'alzheimer');
  assert.deepEqual(byName.projects.map((p) => p.key), ['p1']);
  assert.equal(byName.sessionsByProject.p1.length, 2, '项目名命中时保留全部会话');

  const bySession = matchProjects(projects, grouped, 'report');
  assert.deepEqual(bySession.projects.map((p) => p.key), ['p1']);
  assert.deepEqual(bySession.sessionsByProject.p1.map((s) => s.id), ['b']);

  const empty = matchProjects(projects, grouped, '');
  assert.equal(empty.projects.length, 2);
});

test('project helpers describe state and refuse deleting a busy project', () => {
  assert.equal(projectSubtitle({ sessionCount: 3, runningCount: 1 }), '3 · 运行中 1');
  assert.equal(projectSubtitle({ sessionCount: 0, runningCount: 0 }), '0');
  assert.equal(canDeleteProject({ runningCount: 0 }), true);
  assert.equal(canDeleteProject({ runningCount: 1 }), false);
  assert.equal(findProject([{ key: 'a' }], 'a')?.key, 'a');
  assert.equal(findProject([{ key: 'a' }], 'missing'), null);
});

test('visibleProjects bounds a long sidebar but keeps the current and running projects', () => {
  const projects = Array.from({ length: 20 }, (_, index) => ({
    key: `p${index}`,
    title: `P${index}`,
    runningCount: index === 15 ? 1 : 0,
  }));

  const collapsed = visibleProjects(projects, { limit: 5, currentKey: 'p18' });
  assert.deepEqual(collapsed.visible.map((p) => p.key), ['p0', 'p1', 'p2', 'p3', 'p4', 'p15', 'p18'], '补回的项目保持原排序，不挪到末尾');
  assert.equal(collapsed.hidden, 13);

  const expanded = visibleProjects(projects, { limit: 5, expanded: true });
  assert.equal(expanded.visible.length, 20);
  assert.equal(expanded.hidden, 0);

  const short = visibleProjects(projects.slice(0, 3), { limit: 5 });
  assert.equal(short.hidden, 0);
  assert.equal(visibleProjects(undefined).visible.length, 0);
});
