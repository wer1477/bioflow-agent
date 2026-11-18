import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AnalysisKernelManager } from '../src/agent/core_tools/analysis_kernel_manager.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject, type TempProject } from './helpers/project_fixture.js';
import { assessToolSecurity } from '../src/agent/security_policy.js';
import { EXECUTE_PYTHON_TOOL_NAME, buildAllCoreTools } from '../src/agent/core_tools_runtime.js';

/** Smallest valid 1x1 transparent PNG. */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function ids(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const project = createTempProject(`kernel-${label}`);
  const conversation = createConversation({ title: `kernel ${label}`, projectPath: project.projectPath });
  return { conversationId: conversation.id, projectPath: project.projectPath, runInstanceId: `run-${suffix}`, project };
}

async function cleanup(manager: AnalysisKernelManager, conversationId: string, project: TempProject) {
  await manager.cleanupAll();
  deleteConversation(conversationId);
  project.cleanup();
}

test('execute_python is registered and enters the existing approval gate as code execution', () => {
  assert.equal(buildAllCoreTools().some((tool) => tool.type === 'function' && tool.function.name === EXECUTE_PYTHON_TOOL_NAME), true);
  assert.deepEqual(assessToolSecurity('approval', EXECUTE_PYTHON_TOOL_NAME, { code: '1 + 1' }), {
    decision: 'ask',
    risk: 'unknown',
    reason: 'Approval mode requires confirmation for operations that are not recognized as read-only.',
  });
});

test('Python kernel persists across runs of one conversation and excludes arbitrary environment secrets', async () => {
  const manager = new AnalysisKernelManager();
  const { conversationId, projectPath, runInstanceId, project } = ids('state');
  const previousSecret = process.env.TEST_KERNEL_SECRET;
  process.env.TEST_KERNEL_SECRET = 'must-not-reach-kernel';
  try {
    const first = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'value = 41' });
    const second = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'value + 1' });
    // A later run of the same conversation resumes the same kernel: the whole
    // point of keying kernels by conversation instead of run instance.
    const nextRun = await manager.executePython({ conversationId, projectPath, runInstanceId: `${runInstanceId}-next-run`, code: 'value + 1' });
    const otherProject = createTempProject('kernel-state-project');
    const otherConversation = createConversation({ title: 'kernel other', projectPath: otherProject.projectPath });
    const isolated = await manager.executePython({ conversationId: otherConversation.id, projectPath: otherProject.projectPath, runInstanceId, code: '"value" in globals()' });
    deleteConversation(otherConversation.id);
    otherProject.cleanup();
    const environment = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'import os\nos.getenv("TEST_KERNEL_SECRET")' });

    assert.equal(first.ok, true);
    assert.equal(first.session, 'new');
    assert.equal(second.ok, true);
    assert.equal(second.session, 'resumed');
    assert.equal(second.resultPreview, '42');
    assert.equal(nextRun.ok, true);
    assert.equal(nextRun.session, 'resumed');
    assert.equal(nextRun.resultPreview, '42');
    assert.equal(isolated.resultPreview, 'False');
    assert.equal(environment.resultPreview, 'None');
  } finally {
    if (previousSecret === undefined) delete process.env.TEST_KERNEL_SECRET;
    else process.env.TEST_KERNEL_SECRET = previousSecret;
    await cleanup(manager, conversationId, project);
  }
});

test('timeout and abort terminate the kernel and the next cell gets a recreated session', async () => {
  const manager = new AnalysisKernelManager();
  const { conversationId, projectPath, runInstanceId, project } = ids('cancel');
  try {
    const timeout = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'while True: pass', timeoutMs: 50 });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error?.code, 'timeout');

    const recreated = await manager.executePython({ conversationId, projectPath, runInstanceId, code: '6 * 7' });
    assert.equal(recreated.ok, true);
    assert.equal(recreated.session, 'recreated');
    assert.equal(recreated.resultPreview, '42');

    const controller = new AbortController();
    const pending = manager.executePython({ conversationId, projectPath, runInstanceId, code: 'import time\ntime.sleep(10)', abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 40).unref();
    await assert.rejects(pending, { name: 'AbortError' });
    const afterAbort = await manager.executePython({ conversationId, projectPath, runInstanceId, code: '1 + 1' });
    assert.equal(afterAbort.session, 'recreated');
  } finally {
    await cleanup(manager, conversationId, project);
  }
});

test('per-session calls are serialized and matplotlib plots become workspace artifacts when available', async (t) => {
  const manager = new AnalysisKernelManager();
  const { conversationId, projectPath, runInstanceId, project } = ids('artifacts');
  try {
    const first = manager.executePython({ conversationId, projectPath, runInstanceId, code: 'import time\ntime.sleep(0.05)\nx = 7' });
    const second = manager.executePython({ conversationId, projectPath, runInstanceId, code: 'x * 6' });
    assert.equal((await first).ok, true);
    assert.equal((await second).resultPreview, '42');

    const matplotlib = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'import importlib.util\nimportlib.util.find_spec("matplotlib") is not None' });
    if (matplotlib.resultPreview !== 'True') {
      t.skip('matplotlib is not installed in the configured Python environment');
      return;
    }
    const plot = await manager.executePython({
      conversationId,
      projectPath,
      runInstanceId,
      code: 'import matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4])',
    });
    assert.equal(plot.ok, true);
    assert.equal(plot.artifacts.length, 1);
    assert.match(plot.artifacts[0].path, /^\.bioflow\/kernel\//);
  } finally {
    await cleanup(manager, conversationId, project);
  }
});

test('cleanupRun stays a compatibility no-op while cleanupConversation closes the kernel', async () => {
  const manager = new AnalysisKernelManager();
  const { conversationId, projectPath, runInstanceId, project } = ids('cleanup');
  try {
    const first = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'persisted = 7' });
    assert.equal(first.session, 'new');

    await manager.cleanupRun(runInstanceId);
    const afterRunCleanup = await manager.executePython({ conversationId, projectPath, runInstanceId: `${runInstanceId}-next`, code: 'persisted' });
    assert.equal(afterRunCleanup.ok, true);
    assert.equal(afterRunCleanup.session, 'resumed');
    assert.equal(afterRunCleanup.resultPreview, '7');

    await manager.cleanupConversation(conversationId);
    const afterConversationCleanup = await manager.executePython({ conversationId, projectPath, runInstanceId, code: '"persisted" in globals()' });
    assert.equal(afterConversationCleanup.session, 'recreated');
    assert.equal(afterConversationCleanup.resultPreview, 'False');
  } finally {
    await cleanup(manager, conversationId, project);
  }
});

test('at most four conversations keep a warm kernel; the least recently used one is evicted', async () => {
  const manager = new AnalysisKernelManager();
  const project = createTempProject('kernel-lru');
  const conversations = Array.from({ length: 5 }, (_value, index) => createConversation({ title: `kernel lru ${index}`, projectPath: project.projectPath }));
  try {
    for (let index = 0; index < conversations.length; index += 1) {
      const result = await manager.executePython({
        conversationId: conversations[index].id,
        projectPath: project.projectPath,
        runInstanceId: `run-${index}`,
        code: `value = ${index}`,
      });
      assert.equal(result.ok, true);
    }

    // Starting the fifth kernel evicted conversation #1, so its kernel must be
    // rebuilt (session=recreated) and lose its variables.
    const evicted = await manager.executePython({
      conversationId: conversations[0].id,
      projectPath: project.projectPath,
      runInstanceId: 'run-evicted',
      code: '"value" in globals()',
    });
    assert.equal(evicted.session, 'recreated');
    assert.equal(evicted.resultPreview, 'False');

    // The newest conversation is still warm.
    const warm = await manager.executePython({
      conversationId: conversations[4].id,
      projectPath: project.projectPath,
      runInstanceId: 'run-warm',
      code: 'value',
    });
    assert.equal(warm.session, 'resumed');
    assert.equal(warm.resultPreview, '4');
  } finally {
    await manager.cleanupAll();
    for (const conversation of conversations) deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('idle kernels are evicted by the TTL sweep while fresh ones survive', async () => {
  const manager = new AnalysisKernelManager();
  const { conversationId, projectPath, runInstanceId, project } = ids('ttl');
  try {
    const first = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'marker = 99' });
    assert.equal(first.session, 'new');

    // The default 30 minute TTL must not touch a kernel that was just used.
    await manager.cleanupIdleSessions();
    const warm = await manager.executePython({ conversationId, projectPath, runInstanceId, code: 'marker' });
    assert.equal(warm.session, 'resumed');
    assert.equal(warm.resultPreview, '99');

    // A zero threshold evicts immediately; the next execution reports recreated.
    await manager.cleanupIdleSessions(0);
    const recreated = await manager.executePython({ conversationId, projectPath, runInstanceId, code: '"marker" in globals()' });
    assert.equal(recreated.session, 'recreated');
    assert.equal(recreated.resultPreview, 'False');
  } finally {
    await cleanup(manager, conversationId, project);
  }
});

test('generated figures are attached as model images, bounded to four readable PNGs', async () => {
  const manager = new AnalysisKernelManager();
  const project = createTempProject('kernel-images');
  const conversation = createConversation({ title: 'kernel images', projectPath: project.projectPath });
  const runInstanceId = `run-images-${Date.now()}`;
  const cellId = crypto.randomUUID();
  const tempDir = path.join(project.projectPath, '.bioflow', 'kernel', '.tmp', runInstanceId, cellId);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const figureNames = Array.from({ length: 6 }, (_value, index) => `figure-${index + 1}.png`);
    for (const name of figureNames) fs.writeFileSync(path.join(tempDir, name), Buffer.from(TINY_PNG_BASE64, 'base64'));
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'not an image');
    const pending = { tempDir, runInstanceId, cellId, projectPath: project.projectPath, conversationId: conversation.id, session: 'new' };

    const readFigureImages = (manager as unknown as {
      readFigureImages(pending: unknown, figures: string[]): Promise<Array<{ mimeType: string; data: string; label?: string }>>;
    }).readFigureImages.bind(manager);
    const images = await readFigureImages(pending, [...figureNames, 'notes.txt', 'missing.png']);

    assert.equal(images.length, 4);
    for (const image of images) {
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.data, TINY_PNG_BASE64);
      assert.match(String(image.label), /^figure-\d+\.png$/);
    }
  } finally {
    await manager.cleanupAll();
    fs.rmSync(path.join(project.projectPath, '.bioflow'), { recursive: true, force: true });
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
