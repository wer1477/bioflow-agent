import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sessionsRoot } from '../src/paths.js';
import { projectKeyForPath } from '../src/agent/config/session_paths.js';
import { createConversation, deleteConversation, getConversation } from '../src/agent/config/conversation_service.js';
import { createProject, listProjects, renameProject, restoreTrash, trashProject } from '../src/agent/config/project_service.js';
import { createTempProject } from './helpers/project_fixture.js';

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

test('a new project is an empty directory and sessions keep their state outside it', () => {
  const project = createProject(uniqueName('proj'));
  const conversation = createConversation({ title: 'first session', projectPath: project.path });
  try {
    assert.deepEqual(fs.readdirSync(project.path), [], 'project directories are created empty');
    const summary = listProjects().projects.find((item) => item.key === project.key);
    assert.equal(summary?.sessionCount, 1);
    assert.equal(summary?.runningCount, 0);
  } finally {
    deleteConversation(conversation.id);
    fs.rmSync(project.path, { recursive: true, force: true });
  }
});

test('renaming a project follows its sessions to the new key', () => {
  const name = uniqueName('rename');
  const project = createProject(name);
  const conversation = createConversation({ title: 'follow me', projectPath: project.path });
  const renamed = renameProject(project.key, `${name}-v2`);
  try {
    assert.equal(fs.existsSync(renamed.path), true);
    assert.equal(getConversation(conversation.id)?.projectPath, renamed.path);
    const summary = listProjects().projects.find((item) => item.key === renamed.key);
    assert.equal(summary?.sessionCount, 1);
  } finally {
    deleteConversation(conversation.id);
    fs.rmSync(renamed.path, { recursive: true, force: true });
  }
});

test('removing a project moves it to the trash and orphans its sessions', () => {
  const project = createProject(uniqueName('trash'));
  const conversation = createConversation({ title: 'orphaned', projectPath: project.path });
  const trashed = trashProject(project.key);
  try {
    assert.equal(fs.existsSync(trashed.path), true, 'removal never deletes data');
    assert.equal(fs.existsSync(project.path), false);

    const listed = listProjects();
    assert.equal(listed.projects.some((item) => item.key === project.key), false);
    assert.equal(listed.orphans.some((item) => item.id === conversation.id), true);

    const restored = restoreTrash(trashed.name);
    assert.equal(fs.existsSync(restored.path), true);
    // Restoring the same directory name re-groups the session automatically.
    assert.equal(listProjects().projects.find((item) => item.key === restored.key)?.sessionCount, 1);
    fs.rmSync(restored.path, { recursive: true, force: true });
  } finally {
    deleteConversation(conversation.id);
    fs.rmSync(trashed.path, { recursive: true, force: true });
  }
});

test('deleting the last session of a project removes its empty key directory', () => {
  const project = createTempProject('keysweep');
  const conversation = createConversation({ title: 'only session', projectPath: project.projectPath });
  const keyDirectory = path.join(sessionsRoot(), projectKeyForPath(project.projectPath));
  try {
    assert.equal(fs.existsSync(keyDirectory), true);
    deleteConversation(conversation.id);
    assert.equal(fs.existsSync(keyDirectory), false, 'empty project key directories must not accumulate');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
