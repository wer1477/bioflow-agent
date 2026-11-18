import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readKnowledgeBaseEntryForView } from '../src/agent/core_tools/knowledgebase_executor.js';

type BookFiles = Record<string, string | Buffer>;

async function withKnowledgeBase<T>(files: BookFiles, callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bioflow-knowledgebase-view-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function entry(name: string, description: string, body = `# ${name}\n\n知识正文。`): string {
  return ['---', `name: "${name}"`, `description: "${description}"`, '---', '', body].join('\n');
}

const INDEX_FIXTURE = [
  '# 知识库领域索引',
  '',
  '- 科学通用：科学研究方法、统计与数据规范。',
  '',
].join('\n');

const FIGURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('viewer returns the full body and resource metadata without inlining resource content', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '科学通用/假设检验/resources/notes.md': '# 备注\n\n只展示元数据。\n',
    '科学通用/假设检验/resources/figure.png': FIGURE_BYTES,
  }, (root) => {
    const result = readKnowledgeBaseEntryForView('科学通用/假设检验', { root });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.id, '科学通用/假设检验');
    assert.equal(result.entry.name, '假设检验');
    assert.equal(result.entry.description, 'P 值与显著性检验的基础。');
    assert.ok(result.entry.content.includes('知识正文。'));
    assert.deepEqual(result.entry.resources.map((resource) => resource.path), [
      '科学通用/假设检验/resources/figure.png',
      '科学通用/假设检验/resources/notes.md',
    ]);
    const markdownResource = result.entry.resources.find((resource) => resource.path.endsWith('notes.md'));
    assert.equal(markdownResource?.mimeType, 'text/markdown');
    assert.equal(markdownResource?.encoding, 'utf8');
    assert.equal(markdownResource ? 'content' in markdownResource : true, false);
    const binaryResource = result.entry.resources.find((resource) => resource.path.endsWith('figure.png'));
    assert.equal(binaryResource?.encoding, 'binary');
    assert.equal(binaryResource?.size, FIGURE_BYTES.byteLength);
  });
});

test('viewer keeps entries outside the runtime inline budget complete', async () => {
  const longBody = `# 长条目\n\n${'知识'.repeat(12000)}`;
  assert.ok(longBody.length > 20000);
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/长条目/skill.md': entry('长条目', '很长的正文。', longBody),
  }, (root) => {
    const result = readKnowledgeBaseEntryForView('科学通用/长条目', { root });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.content.length, longBody.trim().length);
  });
});

test('viewer reports unknown domains and entries as not_found', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    const unknownDomain = readKnowledgeBaseEntryForView('不存在领域/条目', { root });
    assert.equal(unknownDomain.ok, false);
    if (!unknownDomain.ok) assert.equal(unknownDomain.reason, 'not_found');

    const unknownEntry = readKnowledgeBaseEntryForView('科学通用/不存在条目', { root });
    assert.equal(unknownEntry.ok, false);
    if (!unknownEntry.ok) assert.equal(unknownEntry.reason, 'not_found');
  });
});

test('viewer rejects malformed ids and path traversal as invalid_id', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    for (const badId of ['', '只有领域', '科学通用/假设检验/额外层级', '科学通用/..', '../etc/passwd', '科学通用/假设检验\u0000']) {
      const result = readKnowledgeBaseEntryForView(badId, { root });
      assert.equal(result.ok, false, `expected "${badId}" to be rejected`);
      if (!result.ok) assert.equal(result.reason, 'invalid_id', `expected "${badId}" to be an invalid id`);
    }
  });
});

test('viewer reports malformed entries instead of throwing', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/坏条目/skill.md': '没有 frontmatter 的正文。',
  }, (root) => {
    const result = readKnowledgeBaseEntryForView('科学通用/坏条目', { root });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'malformed');
      assert.ok(result.error.includes('frontmatter'));
    }
  });
});
