import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import test from 'node:test';
import projectsRouter from '../src/http/routes/projects.js';
import { readProjectFile } from '../src/agent/config/project_files.js';
import { removeProject } from '../src/agent/config/project_registry.js';
import { createProject } from '../src/agent/config/project_service.js';
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../src/services/upload_service.js';

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
  const project = createProject(`chunk-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  return {
    key: project.key,
    path: project.path,
    cleanup: () => {
      fs.rmSync(project.path, { recursive: true, force: true });
      removeProject(project.key);
    },
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function putChunk(origin: string, key: string, id: string, index: number, body: Buffer): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/api/projects/${encodeURIComponent(key)}/uploads/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function initUpload(origin: string, key: string, path: string, size: number): Promise<{ status: number; body: any }> {
  return postJson(`${origin}/api/projects/${encodeURIComponent(key)}/uploads`, { path, size });
}

async function completeUpload(origin: string, key: string, id: string): Promise<{ status: number; body: any }> {
  return postJson(`${origin}/api/projects/${encodeURIComponent(key)}/uploads/${id}/complete`, {});
}

async function uploadStatus(origin: string, key: string, id: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/api/projects/${encodeURIComponent(key)}/uploads/${id}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('chunks can arrive out of order and completion produces the exact file', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x61);
  const second = Buffer.alloc(1024 * 1024, 0x62);
  try {
    const opened = await initUpload(server.origin, project.key, 'data/large-input.bin', first.length + second.length);
    assert.equal(opened.status, 201);
    const upload = opened.body.upload;
    assert.equal(upload.chunkSize, UPLOAD_CHUNK_BYTES);
    assert.equal(upload.chunkCount, 2);
    assert.deepEqual(upload.received, []);

    // Deliberately newest chunk first: the protocol is index-based, not append-only.
    const last = await putChunk(server.origin, project.key, upload.id, 1, second);
    assert.equal(last.status, 200);
    assert.equal(last.body.chunk.receivedBytes, second.length);
    const firstResponse = await putChunk(server.origin, project.key, upload.id, 0, first);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.body.chunk.receivedBytes, first.length + second.length);

    const status = await uploadStatus(server.origin, project.key, upload.id);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.upload.received, [0, 1]);

    const completed = await completeUpload(server.origin, project.key, upload.id);
    assert.equal(completed.status, 201);
    assert.equal(completed.body.file.path, 'data/large-input.bin');
    assert.equal(completed.body.file.size, first.length + second.length);

    const stored = readProjectFile(project.path, 'data/large-input.bin');
    assert.deepEqual(Buffer.from(stored.content, 'base64'), Buffer.concat([first, second]));

    // Completed sessions are gone: the temp file was renamed into the project.
    const gone = await uploadStatus(server.origin, project.key, upload.id);
    assert.equal(gone.status, 404);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('incomplete uploads can be inspected and resumed from the received offset', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x31);
  const second = Buffer.alloc(10, 0x32);
  const size = first.length + second.length;
  try {
    const opened = await initUpload(server.origin, project.key, 'resume.bin', size);
    const upload = opened.body.upload;
    await putChunk(server.origin, project.key, upload.id, 0, first);

    const interim = await uploadStatus(server.origin, project.key, upload.id);
    assert.deepEqual(interim.body.upload.received, [0]);
    assert.equal(interim.body.upload.receivedBytes, first.length);

    const early = await completeUpload(server.origin, project.key, upload.id);
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'UPLOAD_INCOMPLETE');

    const rest = await putChunk(server.origin, project.key, upload.id, 1, second);
    assert.equal(rest.status, 200);
    const completed = await completeUpload(server.origin, project.key, upload.id);
    assert.equal(completed.status, 201);

    const stored = readProjectFile(project.path, 'resume.bin');
    assert.deepEqual(Buffer.from(stored.content, 'base64'), Buffer.concat([first, second]));
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('a repeated chunk is idempotent and stays visible in the session list', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const chunk = Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x41);
  try {
    const opened = await initUpload(server.origin, project.key, 'repeat.bin', chunk.length + 1);
    const upload = opened.body.upload;

    await putChunk(server.origin, project.key, upload.id, 0, chunk);
    const duplicate = await putChunk(server.origin, project.key, upload.id, 0, chunk);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.chunk.receivedCount, 1);
    assert.equal(duplicate.body.chunk.receivedBytes, chunk.length);

    const response = await fetch(`${server.origin}/api/projects/${encodeURIComponent(project.key)}/uploads`);
    const list = await response.json();
    assert.equal(response.status, 200);
    assert.equal(list.uploads.length, 1);
    assert.equal(list.uploads[0].id, upload.id);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('chunk index and length are validated', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const chunk = Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x51);
  try {
    const opened = await initUpload(server.origin, project.key, 'validate.bin', chunk.length + 1);
    const upload = opened.body.upload;

    const wrongLength = await putChunk(server.origin, project.key, upload.id, 0, Buffer.alloc(1024, 0x52));
    assert.equal(wrongLength.status, 400);
    assert.equal(wrongLength.body.code, 'CHUNK_SIZE_MISMATCH');

    const wrongIndex = await putChunk(server.origin, project.key, upload.id, 5, chunk);
    assert.equal(wrongIndex.status, 400);
    assert.equal(wrongIndex.body.code, 'INVALID_CHUNK_INDEX');

    const status = await uploadStatus(server.origin, project.key, upload.id);
    assert.deepEqual(status.body.upload.received, []);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('upload paths stay inside the writable project area', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  try {
    const escape = await initUpload(server.origin, project.key, '../escape.bin', 1024);
    assert.equal(escape.status, 400);

    const runtime = await initUpload(server.origin, project.key, '.bioflow/session.bin', 1024);
    assert.equal(runtime.status, 400);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('files above the 10GB cap are rejected before any temp file is created', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  try {
    const response = await initUpload(server.origin, project.key, 'too-big.bin', MAX_UPLOAD_BYTES + 1);
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 'FILE_TOO_LARGE');

    const list = await (await fetch(`${server.origin}/api/projects/${encodeURIComponent(project.key)}/uploads`)).json();
    assert.deepEqual(list.uploads, []);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('cancelling removes the session and its temp data', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  try {
    const opened = await initUpload(server.origin, project.key, 'cancel.bin', 1024);
    const upload = opened.body.upload;
    const response = await fetch(`${server.origin}/api/projects/${encodeURIComponent(project.key)}/uploads/${upload.id}`, { method: 'DELETE' });
    assert.equal(response.status, 204);

    const gone = await uploadStatus(server.origin, project.key, upload.id);
    assert.equal(gone.status, 404);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('sessions are scoped to the project that created them', async () => {
  const server = await startTestServer();
  const first = createTestProject();
  const second = createTestProject();
  try {
    const opened = await initUpload(server.origin, first.key, 'scoped.bin', 1024);
    const upload = opened.body.upload;

    const foreign = await uploadStatus(server.origin, second.key, upload.id);
    assert.equal(foreign.status, 404);
    const foreignChunk = await putChunk(server.origin, second.key, upload.id, 0, Buffer.alloc(1024, 0x61));
    assert.equal(foreignChunk.status, 404);
  } finally {
    await server.close();
    first.cleanup();
    second.cleanup();
  }
});

test('two concurrent chunks are both persisted and completion succeeds', async () => {
  const server = await startTestServer();
  const project = createTestProject();
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x71);
  const second = Buffer.alloc(2048, 0x72);
  try {
    const opened = await initUpload(server.origin, project.key, 'parallel.bin', first.length + second.length);
    const upload = opened.body.upload;
    const [a, b] = await Promise.all([
      putChunk(server.origin, project.key, upload.id, 1, second),
      putChunk(server.origin, project.key, upload.id, 0, first),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    const status = await uploadStatus(server.origin, project.key, upload.id);
    assert.deepEqual(status.body.upload.received, [0, 1]);
    const completed = await completeUpload(server.origin, project.key, upload.id);
    assert.equal(completed.status, 201);

    const stored = readProjectFile(project.path, 'parallel.bin');
    assert.deepEqual(Buffer.from(stored.content, 'base64'), Buffer.concat([first, second]));
  } finally {
    await server.close();
    project.cleanup();
  }
});
