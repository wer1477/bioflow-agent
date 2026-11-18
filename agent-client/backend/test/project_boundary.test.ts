import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assessProjectBoundary } from '../src/agent/project_boundary.js';

const projectPath = '/workspace/demo-project';

test('paths inside the project pass the boundary check', () => {
  assert.equal(assessProjectBoundary('approval', projectPath, { file_path: 'analysis/run.py' }), null);
  assert.equal(assessProjectBoundary('approval', projectPath, { workdir: path.join(projectPath, 'data') }), null);
  assert.equal(assessProjectBoundary('approval', projectPath, { path: '.' }), null);
});

test('paths outside the project ask for approval instead of resolving silently', () => {
  const relative = assessProjectBoundary('approval', projectPath, { file_path: '../secrets.txt' });
  assert.equal(relative?.decision, 'ask');
  assert.equal(relative?.risk, 'unknown');
  assert.match(String(relative?.reason), /outside the project directory/);

  const absolute = assessProjectBoundary('approval', projectPath, { path: '/etc' });
  assert.equal(absolute?.decision, 'ask');

  const sibling = assessProjectBoundary('approval', projectPath, { workdir: '/workspace/other-project' });
  assert.equal(sibling?.decision, 'ask');
});

test('the guard stays out of the way when it has no project or no mode', () => {
  assert.equal(assessProjectBoundary('unrestricted', projectPath, { path: '/etc' }), null);
  assert.equal(assessProjectBoundary('approval', null, { path: '/etc' }), null);
  assert.equal(assessProjectBoundary('approval', projectPath, {}), null);
});
