import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHash, parseHash } from '../src/domain/route.js';

test('parseHash understands the route shapes', () => {
  assert.deepEqual(parseHash(''), { name: 'root' });
  assert.deepEqual(parseHash('#/'), { name: 'root' });
  assert.deepEqual(parseHash('#/projects'), { name: 'projects' });
  assert.deepEqual(parseHash('#/settings'), { name: 'settings' });
  assert.deepEqual(parseHash('#/settings/general'), { name: 'settings', section: 'general' });
  assert.deepEqual(parseHash('#/settings/agent'), { name: 'settings', section: 'agent' });
  assert.deepEqual(parseHash('#/projects/demo'), { name: 'project', projectKey: 'demo' });
  assert.deepEqual(parseHash('#/projects/demo/sessions/abc-1'), { name: 'session', projectKey: 'demo', sessionId: 'abc-1' });
  assert.deepEqual(parseHash('#/login'), { name: 'login' });
  assert.deepEqual(parseHash('#/register'), { name: 'register' });
  assert.deepEqual(parseHash('#/forgot'), { name: 'forgot' });
});

test('parseHash decodes escaped project keys and tolerates unknown shapes', () => {
  assert.deepEqual(parseHash(`#/projects/${encodeURIComponent('_751F__4FE1_')}`), { name: 'project', projectKey: '_751F__4FE1_' });
  assert.deepEqual(parseHash('#/whatever'), { name: 'projects' });
  assert.deepEqual(parseHash('#/projects/demo/sessions'), { name: 'project', projectKey: 'demo' });
  // 未知的设置子路径归一到 Agent 设置，避免出现渲染不出来的空白页。
  assert.deepEqual(parseHash('#/settings/whatever'), { name: 'settings', section: 'agent' });
});

test('buildHash round-trips through parseHash', () => {
  const routes = [
    { name: 'projects' },
    { name: 'settings', section: 'agent' },
    { name: 'settings', section: 'general' },
    { name: 'project', projectKey: 'demo' },
    { name: 'session', projectKey: 'demo', sessionId: 'abc-1' },
    { name: 'session', projectKey: '中文项目', sessionId: 'abc-1' },
    { name: 'login' },
    { name: 'register' },
    { name: 'forgot' },
  ];
  for (const route of routes) {
    assert.deepEqual(parseHash(buildHash(route)), route);
  }
});

test('a bare settings route canonicalizes to the Agent section', () => {
  // `#/settings` 只在入口出现，App 会把它 replace 成这里给出的规范形式。
  assert.equal(buildHash({ name: 'settings' }), '#/settings/agent');
  assert.equal(buildHash({ name: 'settings', section: 'general' }), '#/settings/general');
  assert.equal(buildHash({ name: 'settings', section: 'agent' }), '#/settings/agent');
});
