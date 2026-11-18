import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isProjectEditablePath,
  normalizeWorkspaceDirectory,
  projectUploadPath,
} from '../src/domain/workspace.js';

test('project files are editable anywhere except the runtime directory', () => {
  assert.equal(isProjectEditablePath('notes.txt'), true);
  assert.equal(isProjectEditablePath('runs/report.md'), true);
  assert.equal(isProjectEditablePath('.bioflow'), false);
  assert.equal(isProjectEditablePath('.bioflow/session.json'), false);
  assert.equal(isProjectEditablePath(''), false);
  assert.equal(isProjectEditablePath('   '), false);
  assert.equal(isProjectEditablePath(undefined), false);
  assert.equal(isProjectEditablePath('../escape.txt'), false);
  assert.equal(isProjectEditablePath('runs/../../escape.txt'), false);
});

test('upload target is the browsed directory, defaulting to the project root', () => {
  assert.equal(projectUploadPath({ name: 'sample.vcf' }), 'sample.vcf');
  assert.equal(projectUploadPath({ name: 'sample.vcf' }, 'runs/Data'), 'runs/Data/sample.vcf');
  assert.equal(projectUploadPath({ webkitRelativePath: 'panel/batch/counts.tsv' }, 'runs'), 'runs/panel/batch/counts.tsv');
});

test('upload paths cannot escape the project directory', () => {
  assert.equal(projectUploadPath({ name: 'a.txt' }, '../outside'), 'outside/a.txt');
  assert.equal(projectUploadPath({ name: '../a.txt' }), 'a.txt');
  assert.equal(projectUploadPath({ name: '' }), 'upload.bin');
  assert.equal(projectUploadPath({ name: 'we:ird?.txt' }, 'sub'), 'sub/we_ird_.txt');
});

test('directory normalization keeps paths relative and comparable', () => {
  assert.equal(normalizeWorkspaceDirectory(''), '');
  assert.equal(normalizeWorkspaceDirectory('runs/Data/'), 'runs/Data');
  assert.equal(normalizeWorkspaceDirectory('/runs//Data/'), 'runs/Data');
  assert.equal(normalizeWorkspaceDirectory('runs\\Data'), 'runs/Data');
  assert.equal(normalizeWorkspaceDirectory('runs/./Data'), 'runs/Data');
  assert.equal(normalizeWorkspaceDirectory('runs/../Data'), 'runs/Data');
  assert.equal(normalizeWorkspaceDirectory('..'), '');
  assert.equal(normalizeWorkspaceDirectory(undefined), '');
});
