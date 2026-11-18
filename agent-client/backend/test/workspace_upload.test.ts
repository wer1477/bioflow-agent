import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import projectsRouter from '../src/http/routes/projects.js';
import { readProjectFile } from '../src/agent/config/project_files.js';
import { removeProject } from '../src/agent/config/project_registry.js';
import { createProject } from '../src/agent/config/project_service.js';

function startTestServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/projects', projectsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server has no port.');
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('project upload accepts a binary file larger than the JSON request limit', async () => {
  const server = await startTestServer();
  const project = createProject(`upload-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  try {
    const file = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const response = await fetch(`${server.origin}/api/projects/${encodeURIComponent(project.key)}/files/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-workspace-file-name': encodeURIComponent('large-input.bin'),
        'x-workspace-path': encodeURIComponent('data/large-input.bin'),
      },
      body: file,
    });

    assert.equal(response.status, 201);
    const stored = readProjectFile(project.path, 'data/large-input.bin');
    assert.equal(stored.encoding, 'base64');
    assert.deepEqual(Buffer.from(stored.content, 'base64'), file);
  } finally {
    await server.close();
    fs.rmSync(project.path, { recursive: true, force: true });
    removeProject(project.key);
  }
});

test('a conversation cannot be created without a project', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no project' }),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json()).error), /project/i);
  } finally {
    await server.close();
  }
});

test('a conversation created in a project stays out of the project directory', async () => {
  const server = await startTestServer();
  const project = createProject(`session-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  let conversationId = '';
  try {
    const created = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'project session', project: project.key }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    conversationId = body.conversation.id;
    assert.equal(body.conversation.projectPath, project.path);

    // The project directory is created empty and stays empty: session state
    // lives in the central store.
    assert.deepEqual(fs.readdirSync(project.path), []);

    const listed = await fetch(`${server.origin}/api/conversations?project=${encodeURIComponent(project.key)}`);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.conversations.map((conversation: { id: string }) => conversation.id), [conversationId]);
  } finally {
    if (conversationId) await fetch(`${server.origin}/api/conversations/${conversationId}`, { method: 'DELETE' });
    await server.close();
    fs.rmSync(project.path, { recursive: true, force: true });
    removeProject(project.key);
  }
});
