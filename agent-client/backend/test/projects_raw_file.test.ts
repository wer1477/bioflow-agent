import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import test from 'node:test';
import projectsRouter from '../src/http/routes/projects.js';
import { writeProjectFile, writeProjectFileBuffer } from '../src/agent/config/project_files.js';
import { removeProject } from '../src/agent/config/project_registry.js';
import { createProject } from '../src/agent/config/project_service.js';

function startTestServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
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

function createTestProject(): { key: string; path: string; cleanup: () => void } {
  const project = createProject(`raw-file-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  return {
    key: project.key,
    path: project.path,
    cleanup: () => {
      fs.rmSync(project.path, { recursive: true, force: true });
      removeProject(project.key);
    },
  };
}

function rawUrl(origin: string, key: string, query: Record<string, string>): string {
  return `${origin}/api/projects/${encodeURIComponent(key)}/files/raw?${new URLSearchParams(query).toString()}`;
}

test('raw endpoint streams a file with its project mime type, inline disposition and byte ranges', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const body = 'hello raw viewer\n';
  try {
    writeProjectFile(project.path, 'reports/notes.txt', body);

    const full = await fetch(rawUrl(server.origin, project.key, { path: 'reports/notes.txt' }));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'text/plain');
    assert.equal(full.headers.get('content-disposition'), 'inline');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), body);

    // PDF viewers and <img> seek with Range; the response must be a 206 stream, not the whole file.
    const partial = await fetch(rawUrl(server.origin, project.key, { path: 'reports/notes.txt' }), {
      headers: { range: 'bytes=0-4' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-4/${Buffer.byteLength(body)}`);
    assert.equal(await partial.text(), body.slice(0, 5));
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('raw endpoint serves pdfs and unknown binaries with the right type, and names downloads via rfc 5987', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const pdf = '%PDF-1.4\n%%EOF\n';
  try {
    writeProjectFileBuffer(project.path, '报告.pdf', Buffer.from(pdf));
    writeProjectFileBuffer(project.path, 'data/reads.bin', Buffer.from([0x01, 0x02, 0x03, 0x04]));

    const inline = await fetch(rawUrl(server.origin, project.key, { path: '报告.pdf' }));
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.equal(inline.headers.get('content-disposition'), 'inline');
    assert.equal(await inline.text(), pdf);

    const download = await fetch(rawUrl(server.origin, project.key, { path: '报告.pdf', download: '1' }));
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get('content-disposition'),
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
    );

    const binary = await fetch(rawUrl(server.origin, project.key, { path: 'data/reads.bin' }));
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0x01, 0x02, 0x03, 0x04]));
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('raw endpoint answers unknown projects, escaping paths, missing files and directories with json errors', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  try {
    const unknown = await fetch(rawUrl(server.origin, 'no-such-project', { path: 'notes.txt' }));
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'Project not found' });

    writeProjectFile(project.path, 'reports/notes.txt', 'x');

    const missing = await fetch(rawUrl(server.origin, project.key, { path: 'reports/missing.txt' }));
    assert.equal(missing.status, 400);
    assert.ok((missing.headers.get('content-type') || '').startsWith('application/json'));
    assert.deepEqual(await missing.json(), { error: 'Project file not found.' });

    const traversal = await fetch(rawUrl(server.origin, project.key, { path: '../escape.txt' }));
    assert.equal(traversal.status, 400);
    assert.deepEqual(await traversal.json(), { error: 'Project file path escapes the project directory.' });

    const directory = await fetch(rawUrl(server.origin, project.key, { path: 'reports' }));
    assert.equal(directory.status, 400);
    assert.deepEqual(await directory.json(), { error: 'Project path is a directory.' });

    const empty = await fetch(rawUrl(server.origin, project.key, { path: '' }));
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'A project file path is required.' });
  } finally {
    await server.close();
    project.cleanup();
  }
});
