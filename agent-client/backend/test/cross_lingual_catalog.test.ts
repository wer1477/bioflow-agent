import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { shortlistCandidates } from '../src/agent/biod/candidate_shortlist.js';
import { parseCatalogBullet } from '../src/agent/core_tools/toollibrary_executor.js';
import { listKnowledgeBaseCandidates } from '../src/agent/core_tools/knowledgebase_executor.js';
import type { BiodCandidate } from '../src/agent/biod/types.js';

/** Real curated catalog, not a hand-written Chinese fixture. */
function realTools(): BiodCandidate[] {
  const root = path.resolve(process.cwd(), '..', 'toollibrary');
  const rows: BiodCandidate[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'index.md');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const parsed = parseCatalogBullet(line);
      if (parsed) rows.push({ ...parsed, domain: entry.name });
    }
  }
  return rows;
}

test('real English catalog is large enough to exercise the shortlist', () => {
  const rows = realTools();
  assert.ok(rows.length >= 100, `expected >=100 real tools, got ${rows.length}`);
  assert.ok(rows.every((row) => !/[\p{Script=Han}]/u.test(row.description)), 'fixture must contain no CJK descriptions');
});

test('Chinese requests reach the real English tool catalog without hardcoding ids', () => {
  const rows = realTools();
  const cases: Array<[string, string[]]> = [
    ['差异表达分析与样本表头', ['bio-bulk', 'scanpy']],
    ['单细胞聚类', ['scanpy', 'bio-sc']],
    ['序列比对', ['bio-align']],
    ['变异注释', ['bio-variant-effect', 'bio-variant']],
  ];
  for (const [query, expected] of cases) {
    const result = shortlistCandidates(query, rows, 32);
    assert.equal(result.signal, 'lexical', `${query} must have lexical signal`);
    const ids = result.candidates.map((row) => row.id);
    assert.ok(expected.some((id) => ids.includes(id)), `${query} missed ${expected.join('/')} in top 32`);
  }
});

test('unknown Chinese vocabulary is still an explicit safe fallback', () => {
  const rows = realTools();
  const result = shortlistCandidates('请完成一个与目录完全无关的量子色动力学任务', rows, 32);
  assert.equal(result.signal, 'none');
  assert.equal(result.fallback, 'no_lexical_signal');
});

test('Chinese requests reach the real English knowledge catalog', () => {
  const root = path.resolve(process.cwd(), '..', 'knowledgebase');
  const { candidates } = listKnowledgeBaseCandidates({ root });
  assert.ok(candidates.length >= 38, `expected >=38 real entries, got ${candidates.length}`);
  const rows: BiodCandidate[] = candidates.map((row) => ({
    id: row.id, name: row.name, description: row.description, kind: 'kb',
  }));
  const result = shortlistCandidates('RNA-seq 分析流程', rows, 32);
  assert.equal(result.signal, 'lexical');
  assert.ok(result.candidates.some((row) => row.id === 'Bioinformatics/rna-seq-analysis-workflow-overview'));
});
