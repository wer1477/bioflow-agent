import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executeKnowledgeBase,
  listKnowledgeBaseCandidates,
  listKnowledgeBaseDomainNames,
  listKnowledgeBaseEntryIds,
  readKnowledgeBaseDomains,
} from '../src/agent/core_tools/knowledgebase_executor.js';

type BookFiles = Record<string, string | Buffer>;

async function withKnowledgeBase<T>(files: BookFiles, callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bioflow-knowledgebase-'));
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
  '- 生物信息学：测序、组学数据与分析流程。',
  '',
].join('\n');

test('index lists domains with descriptions and entry counts', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '科学通用/样本量/skill.md': entry('样本量', '实验设计中的样本量估算。'),
    '生物信息学/文件格式/skill.md': entry('文件格式', '常见组学数据格式。'),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'index' }, { root });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'index');
    assert.deepEqual(result.domains, [
      { name: '科学通用', description: '科学研究方法、统计与数据规范。', entries: 2 },
      { name: '生物信息学', description: '测序、组学数据与分析流程。', entries: 1 },
    ]);
    assert.deepEqual(result.warnings, []);
  });
});

test('index reports unlisted domains and index rows without a directory', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '临床医学/诊断/skill.md': entry('诊断', '临床诊断知识。'),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'index' }, { root });

    assert.equal(result.ok, true);
    const domains = result.domains as Array<{ name: string; description: string; entries: number }>;
    assert.deepEqual(domains.map((domain) => domain.name), ['科学通用', '临床医学']);
    assert.equal(domains[1]?.description, '');
    assert.equal(domains[1]?.entries, 1);
    const warnings = result.warnings as string[];
    assert.ok(warnings.some((warning) => warning.startsWith('unlisted_domain: "临床医学"')));
    assert.ok(warnings.some((warning) => warning.startsWith('unknown_domain: "生物信息学"')));
  });
});

test('index falls back to empty descriptions when knowledgebase/skill.md is missing', async () => {
  await withKnowledgeBase({
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'index' }, { root });

    assert.equal(result.ok, true);
    const domains = result.domains as Array<{ description: string }>;
    assert.equal(domains[0]?.description, '');
    assert.ok((result.warnings as string[]).some((warning) => warning.startsWith('missing_index:')));
  });
});

test('index deduplicates repeated index rows', async () => {
  await withKnowledgeBase({
    'skill.md': ['- 科学通用：第一版描述。', '- 科学通用：第二版描述。'].join('\n'),
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'index' }, { root });

    const domains = result.domains as Array<{ description: string }>;
    assert.equal(domains[0]?.description, '第一版描述。');
    assert.ok((result.warnings as string[]).some((warning) => warning.startsWith('duplicate_index_domain:')));
  });
});

test('catalog sorts entries by name and reports paging metadata', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '生物信息学/乙/skill.md': entry('乙条目', '第二个。'),
    '生物信息学/甲/skill.md': entry('甲条目', '第一个。'),
    '生物信息学/丙/skill.md': entry('丙条目', '第三个。'),
  }, (root) => {
    const first = executeKnowledgeBase({ action: 'catalog', domain: '生物信息学', limit: 2 }, { root });
    assert.equal(first.ok, true);
    assert.equal(first.total, 3);
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 2);
    assert.equal(first.has_more, true);
    const firstEntries = first.entries as Array<{ id: string; name: string }>;
    assert.deepEqual(firstEntries.map((item) => item.name), ['丙条目', '乙条目']);

    const second = executeKnowledgeBase({ action: 'catalog', domain: '生物信息学', offset: 2, limit: 2 }, { root });
    assert.equal(second.has_more, false);
    assert.deepEqual((second.entries as Array<{ id: string }>).map((item) => item.id), ['生物信息学/甲']);
  });
});

test('catalog skips malformed entries and reports duplicate names', async () => {
  const broken = ['---', 'name: broken', 'description: ', '---', ''].join('\n');
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '生物信息学/好/skill.md': entry('同名条目', '正常条目。'),
    '生物信息学/另一条/skill.md': entry('同名条目', '另一个同名条目。'),
    '生物信息学/坏/skill.md': broken,
    '生物信息学/缺文件/readme.md': '# not an entry',
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'catalog', domain: '生物信息学' }, { root });

    assert.equal(result.ok, true);
    assert.equal(result.total, 2);
    const warnings = result.warnings as string[];
    assert.ok(warnings.some((warning) => warning.startsWith('malformed_entry: "生物信息学/坏"')));
    assert.ok(warnings.some((warning) => warning.startsWith('duplicate_entry_name:')));
  });
});

test('catalog validates the domain argument', async () => {
  await withKnowledgeBase({ 'skill.md': INDEX_FIXTURE }, (root) => {
    const missing = executeKnowledgeBase({ action: 'catalog' }, { root });
    assert.equal(missing.ok, false);
    assert.match(String(missing.error), /requires a domain/);

    const unknown = executeKnowledgeBase({ action: 'catalog', domain: '不存在的领域' }, { root });
    assert.equal(unknown.ok, false);
    assert.match(String(unknown.error), /was not found/);
  });
});

test('read returns the body and inlines small text resources', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '生物信息学/文件格式/skill.md': entry('文件格式', '常见组学数据格式。', '# 文件格式\n\nFASTA 与 FASTQ。'),
    '生物信息学/文件格式/resources/速查表.md': '| 格式 | 用途 |\n| --- | --- |\n| FASTA | 序列 |',
    '生物信息学/文件格式/resources/示意图.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'read', entry: '生物信息学/文件格式' }, { root });

    assert.equal(result.ok, true);
    assert.equal(result.id, '生物信息学/文件格式');
    assert.equal(result.name, '文件格式');
    assert.equal(result.content, '# 文件格式\n\nFASTA 与 FASTQ。');
    const resources = result.resources as Array<Record<string, unknown>>;
    assert.equal(resources.length, 2);
    const table = resources.find((resource) => String(resource.path).endsWith('速查表.md'));
    assert.equal(table?.mimeType, 'text/markdown');
    assert.match(String(table?.content), /FASTA/);
    const image = resources.find((resource) => String(resource.path).endsWith('示意图.png'));
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.encoding, 'binary');
    assert.equal(image?.content, undefined);
    assert.deepEqual(result.warnings, []);
  });
});

test('read warns about oversized bodies and executable resources', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/长文/skill.md': entry('长文', '很长的一篇知识。', 'x'.repeat(29000)),
    '科学通用/长文/resources/run.py': 'print("hello")',
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'read', entry: '科学通用/长文' }, { root });

    assert.equal(result.ok, true);
    const warnings = result.warnings as string[];
    assert.ok(warnings.some((warning) => warning.startsWith('body_exceeds_budget:')));
    assert.ok(warnings.some((warning) => warning.startsWith('executable_resource:')));
  });
});

test('read accepts domain + entry as an alternative to a full id', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    const result = executeKnowledgeBase({ action: 'read', domain: '科学通用', entry: '假设检验' }, { root });
    assert.equal(result.ok, true);
    assert.equal(result.id, '科学通用/假设检验');
  });
});

test('read rejects unknown ids and path traversal attempts', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
  }, (root) => {
    const unknownEntry = executeKnowledgeBase({ action: 'read', entry: '科学通用/不存在' }, { root });
    assert.equal(unknownEntry.ok, false);
    assert.match(String(unknownEntry.error), /was not found/);

    const unknownDomain = executeKnowledgeBase({ action: 'read', entry: '临床医学/诊断' }, { root });
    assert.equal(unknownDomain.ok, false);
    assert.match(String(unknownDomain.error), /Domain "临床医学" was not found/);

    for (const badId of ['../../etc/passwd', '科学通用/../../skills', 'a/b/c', '科学通用/']) {
      const result = executeKnowledgeBase({ action: 'read', entry: badId }, { root });
      assert.equal(result.ok, false, `${badId} should be rejected`);
    }
  });
});

test('unknown actions and missing roots fail loudly', async () => {
  await withKnowledgeBase({ 'skill.md': INDEX_FIXTURE }, (root) => {
    const result = executeKnowledgeBase({ action: 'delete' }, { root });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /Unknown knowledgebase action/);
  });

  const missingRoot = path.join(os.tmpdir(), `bioflow-missing-knowledgebase-${process.pid}`);
  assert.throws(() => executeKnowledgeBase({ action: 'index' }, { root: missingRoot }), /knowledgebase root not found/);
});

test('agent entry scope filters index, catalog and read', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '科学通用/样本量/skill.md': entry('样本量', '实验设计中的样本量估算。'),
    '生物信息学/文件格式/skill.md': entry('文件格式', '常见组学数据格式。'),
  }, (root) => {
    const scoped = { root, entries: ['科学通用/假设检验'] };
    const index = executeKnowledgeBase({ action: 'index' }, scoped);
    assert.deepEqual((index.domains as Array<{ name: string }>).map((domain) => domain.name), ['科学通用']);
    assert.deepEqual(index.domains, [{ name: '科学通用', description: '科学研究方法、统计与数据规范。', entries: 1 }]);

    const allowed = executeKnowledgeBase({ action: 'catalog', domain: '科学通用' }, scoped);
    assert.equal(allowed.ok, true);
    // Only the selected sibling is listed; the unselected one stays out of the catalog.
    assert.deepEqual((allowed.entries as Array<{ id: string }>).map((item) => item.id), ['科学通用/假设检验']);
    assert.equal(allowed.total, 1);

    const blockedCatalog = executeKnowledgeBase({ action: 'catalog', domain: '生物信息学' }, scoped);
    assert.equal(blockedCatalog.ok, false);
    assert.match(String(blockedCatalog.error), /is not enabled for this agent/);

    const blockedSibling = executeKnowledgeBase({ action: 'read', entry: '科学通用/样本量' }, scoped);
    assert.equal(blockedSibling.ok, false);
    assert.match(String(blockedSibling.error), /is not enabled for this agent/);

    const blockedRead = executeKnowledgeBase({ action: 'read', entry: '生物信息学/文件格式' }, scoped);
    assert.equal(blockedRead.ok, false);
    assert.match(String(blockedRead.error), /is not enabled for this agent/);

    const unscoped = executeKnowledgeBase({ action: 'index' }, { root });
    assert.equal((unscoped.domains as unknown[]).length, 2);
  });
});

test('an empty agent scope exposes no domains and no catalog candidates', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '生物信息学/文件格式/skill.md': entry('文件格式', '常见组学数据格式。'),
  }, (root) => {
    const scoped = { root, entries: [] as string[] };
    const index = executeKnowledgeBase({ action: 'index' }, scoped);
    assert.equal(index.ok, true);
    assert.deepEqual(index.domains, []);
    assert.match(String(index.note), /No knowledge entries are enabled/);

    const { candidates } = listKnowledgeBaseCandidates(scoped);
    assert.deepEqual(candidates, []);

    const { candidates: filtered } = listKnowledgeBaseCandidates({ root, entries: ['科学通用/假设检验'] });
    assert.deepEqual(filtered.map((candidate) => candidate.id), ['科学通用/假设检验']);
  });
});

test('static domain readers expose the full curated tree for settings', async () => {
  await withKnowledgeBase({
    'skill.md': INDEX_FIXTURE,
    '科学通用/假设检验/skill.md': entry('假设检验', 'P 值与显著性检验的基础。'),
    '生物信息学/文件格式/skill.md': entry('文件格式', '常见组学数据格式。'),
  }, (root) => {
    assert.deepEqual(listKnowledgeBaseDomainNames({ root }), ['科学通用', '生物信息学']);
    assert.deepEqual(listKnowledgeBaseEntryIds({ root }), ['科学通用/假设检验', '生物信息学/文件格式']);
    const { domains, warnings } = readKnowledgeBaseDomains({ root });
    assert.deepEqual(domains.map((domain) => domain.name), ['科学通用', '生物信息学']);
    assert.deepEqual(domains[0]?.entries.map((item) => item.id), ['科学通用/假设检验']);
    assert.deepEqual(warnings, []);
  });
});
