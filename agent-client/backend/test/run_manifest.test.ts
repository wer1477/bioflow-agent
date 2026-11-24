import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EnvironmentSnapshot } from '../src/agent/provenance/environment_snapshot.js';
import {
  buildRunManifest,
  finalizeRunManifest,
  readRunManifest,
  renderRunManifestMarkdown,
} from '../src/agent/provenance/run_manifest.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createAgentRun, getAgentRun, updateAgentRun, type AgentRun } from '../src/agent/config/run_store.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import type { TranscriptRecord } from '../src/agent/transcript_log.js';
import { createTempProject } from './helpers/project_fixture.js';

const ENVIRONMENT: EnvironmentSnapshot = {
  schemaVersion: 1,
  capturedAt: '2026-11-05T00:00:00.000Z',
  host: 'test-host',
  platform: 'linux-x64',
  node: 'v22.12.0',
  code: { repositoryRoot: '/repo', available: true, commit: 'abc1234', branch: 'main', dirty: false },
  python: { executable: '/repo/.bioenv/bin/python', version: '3.12.15', packages: { numpy: '2.3.5' } },
  r: null,
  warnings: [],
};

function runFixture(): AgentRun {
  return {
    id: 'run-1',
    conversationId: 'conversation-1',
    assistantMessageId: null,
    agentId: 'pi',
    parentRunId: null,
    parentStepId: null,
    status: 'completed',
    stopReason: 'final_answer',
    error: '',
    plan: {},
    loadedTools: [],
    loadedSkills: [],
    summary: 'done',
    metadata: {},
    startedAt: '2026-11-05T00:00:00.000Z',
    completedAt: '2026-11-05T00:01:00.000Z',
    updatedAt: '2026-11-05T00:01:00.000Z',
  };
}

function record(overrides: Partial<TranscriptRecord>): TranscriptRecord {
  return {
    schemaVersion: 1,
    eventId: `event-${Math.random()}`,
    sequence: 1,
    createdAt: '2026-11-05T00:00:05.000Z',
    conversationId: 'conversation-1',
    runId: 'run-1',
    type: 'tool_call',
    data: {},
    ...overrides,
  };
}

test('folds tool calls and hashes produced artifacts', async () => {
  const project = createTempProject('run-manifest-build');
  try {
    const artifact = path.join(project.projectPath, 'results', 'out.csv');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, 'gene,logfc\ng1,1.5\n', 'utf8');
    const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    const args = { path: 'results/out.csv', content: 'gene,logfc\ng1,1.5\n' };

    const records: TranscriptRecord[] = [
      record({
        sequence: 1,
        data: { callId: 'call-1', toolName: 'write_file', turnIndex: 2, parsedArguments: args },
      }),
      record({
        type: 'tool_result',
        sequence: 2,
        data: {
          callId: 'call-1',
          toolName: 'write_file',
          durationMs: 12,
          isError: false,
          rawResult: { sha256: 'result-digest' },
          producedFiles: [artifact],
        },
      }),
    ];

    const manifest = await buildRunManifest({
      conversationId: 'conversation-1',
      run: runFixture(),
      records,
      environment: ENVIRONMENT,
      projectPath: project.projectPath,
      scanProject: false,
    });

    assert.equal(manifest.tools.length, 1);
    assert.equal(manifest.tools[0].name, 'write_file');
    assert.equal(manifest.tools[0].durationMs, 12);
    assert.equal(manifest.tools[0].resultSha256, 'result-digest');
    assert.match(manifest.tools[0].argumentsSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.artifacts[0].path, path.join('results', 'out.csv'));
    assert.equal(manifest.artifacts[0].sha256, expectedSha);
    assert.equal(manifest.artifacts[0].source, 'tool_output');
    assert.equal(manifest.code.commit, 'abc1234');

    const markdown = renderRunManifestMarkdown(manifest);
    assert.match(markdown, /abc1234/);
    assert.match(markdown, /results\/out\.csv/);
    assert.match(markdown, /scanpy|numpy/);
  } finally {
    project.cleanup();
  }
});

test('scans the project for files written during the run', async () => {
  const project = createTempProject('run-manifest-scan');
  try {
    const note = path.join(project.projectPath, 'analysis', 'notes.md');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, '# notes\n', 'utf8');
    const stale = path.join(project.projectPath, 'old.txt');
    fs.writeFileSync(stale, 'old\n', 'utf8');
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(stale, oldTime, oldTime);

    const manifest = await buildRunManifest({
      conversationId: 'conversation-1',
      run: runFixture(),
      records: [],
      environment: ENVIRONMENT,
      projectPath: project.projectPath,
      scanProject: true,
    });

    const paths = manifest.artifacts.map((artifact) => artifact.path);
    assert.ok(paths.includes(path.join('analysis', 'notes.md')), `notes.md missing from ${paths.join(', ')}`);
    assert.ok(!paths.includes('old.txt'), 'files older than the run must not be attributed to it');
    assert.equal(manifest.artifacts.find((artifact) => artifact.path === path.join('analysis', 'notes.md'))?.source, 'project_scan');
  } finally {
    project.cleanup();
  }
});

test('writes a manifest next to the session and reads it back', async () => {
  const project = createTempProject('run-manifest-finalize');
  const conversation = createConversation({ title: 'manifest', projectPath: project.projectPath });
  const run = createAgentRun({ conversationId: conversation.id, agentId: 'pi', status: 'completed' });
  try {
    const artifact = path.join(project.projectPath, 'result.csv');
    fs.writeFileSync(artifact, 'a,b\n1,2\n', 'utf8');
    const recorder = createTranscriptRecorder(conversation.id, run.id);
    assert.ok(recorder);
    recorder.recordToolCall({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'write_file',
      rawArguments: JSON.stringify({ path: 'result.csv' }),
      parsedArguments: { path: 'result.csv' },
    });
    recorder.recordToolResult({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'write_file',
      rawResult: '{"ok":true}',
      modelVisibleResult: '{"ok":true}',
      durationMs: 3,
      producedFiles: [artifact],
    });
    recorder.end('completed');
    updateAgentRun(conversation.id, run.id, {
      status: 'completed',
      stopReason: 'final_answer',
      completedAt: new Date().toISOString(),
    });

    const first = await finalizeRunManifest({
      conversationId: conversation.id,
      runId: run.id,
      environment: ENVIRONMENT,
      scanProject: false,
    });
    assert.ok(first && fs.existsSync(first), 'manifest file must exist');
    const manifest = await readRunManifest(conversation.id, run.id);
    assert.ok(manifest);
    assert.equal(manifest.run.id, run.id);
    assert.equal(manifest.tools[0].name, 'write_file');
    assert.equal(manifest.artifacts[0].path, 'result.csv');
    assert.ok(manifest.transcript?.sha256, 'transcript hash must be recorded');
    assert.equal(getAgentRun(conversation.id, run.id)?.metadata?.manifestPath, first);

    const second = await finalizeRunManifest({
      conversationId: conversation.id,
      runId: run.id,
      environment: ENVIRONMENT,
      scanProject: false,
    });
    assert.equal(second, first, 'finalize must be idempotent');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('declared input provenance populates manifest.inputs with verified hashes', async () => {
  const project = createTempProject('run-manifest-inputs');
  try {
    const input = path.join(project.projectPath, 'data', 'counts.csv');
    fs.mkdirSync(path.dirname(input), { recursive: true });
    const body = 'gene,c1\nA,1\n';
    fs.writeFileSync(input, body, 'utf8');
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    fs.mkdirSync(path.join(project.projectPath, '.bioflow'), { recursive: true });
    fs.writeFileSync(path.join(project.projectPath, '.bioflow', 'inputs.json'), JSON.stringify({
      inputs: [{ path: 'data/counts.csv', sha256: digest, version: 'input-v1' }],
    }), 'utf8');

    const manifest = await buildRunManifest({
      conversationId: 'conversation-1',
      run: runFixture(),
      records: [],
      environment: ENVIRONMENT,
      projectPath: project.projectPath,
      scanProject: false,
    });

    assert.equal(manifest.inputs.length, 1);
    assert.equal(manifest.inputs[0].path, path.join('data', 'counts.csv'));
    assert.equal(manifest.inputs[0].sha256, digest);
    assert.equal(manifest.inputs[0].version, 'input-v1');
    assert.equal(manifest.inputs[0].match, true);
    assert.deepEqual(manifest.warnings, []);
  } finally {
    project.cleanup();
  }
});

test('a declared input mismatch is visible instead of silently trusted', async () => {
  const project = createTempProject('run-manifest-input-mismatch');
  try {
    fs.mkdirSync(path.join(project.projectPath, 'data'), { recursive: true });
    fs.writeFileSync(path.join(project.projectPath, 'data', 'counts.csv'), 'a\n1\n', 'utf8');
    fs.mkdirSync(path.join(project.projectPath, '.bioflow'), { recursive: true });
    fs.writeFileSync(path.join(project.projectPath, '.bioflow', 'inputs.json'), JSON.stringify({
      inputs: [{ path: 'data/counts.csv', sha256: '0'.repeat(64) }],
    }), 'utf8');
    const manifest = await buildRunManifest({
      conversationId: 'conversation-1',
      run: runFixture(),
      records: [],
      environment: ENVIRONMENT,
      projectPath: project.projectPath,
      scanProject: false,
    });
    assert.equal(manifest.inputs[0].match, false);
    assert.ok(manifest.warnings.some((warning) => warning.startsWith('input_sha256_mismatch')));
  } finally {
    project.cleanup();
  }
});
