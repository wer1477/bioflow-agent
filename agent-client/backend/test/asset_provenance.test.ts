import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assetVersion,
  clearAssetProvenanceCache,
  readAssetProvenance,
} from '../src/agent/core_tools/asset_provenance.js';
import { readSkillDirectory } from '../src/agent/config/skill_config_store.js';
import { collectToolLibraryCandidates } from '../src/agent/core_tools/toollibrary_executor.js';
import { executeKnowledgeBase, listKnowledgeBaseCandidates } from '../src/agent/core_tools/knowledgebase_executor.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-provenance-'));
}

test('declared assetVersion is used and provenance is readable', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify({
    schemaVersion: 1,
    assetVersion: 'asset-v3',
    sourceRun: 'run-123',
    sourceTrace: 'trace/abc.ndjson',
    verification: { command: 'pytest', result: 'pass' },
  }));
  clearAssetProvenanceCache();
  assert.equal(assetVersion(dir), 'asset-v3');
  assert.equal(readAssetProvenance(dir)?.sourceRun, 'run-123');
});

test('missing version falls back to a sha256 of the provenance file', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify({ schemaVersion: 1, sourceRun: 'run-9' }));
  clearAssetProvenanceCache();
  assert.match(assetVersion(dir) ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('missing, malformed, and oversized provenance are absent, not invented', () => {
  const dir = tempDir();
  clearAssetProvenanceCache();
  assert.equal(assetVersion(dir), undefined);
  fs.writeFileSync(path.join(dir, 'provenance.json'), '{not json');
  clearAssetProvenanceCache();
  assert.equal(assetVersion(dir), undefined);
  assert.equal(readAssetProvenance(dir), null);
});


test('a Skill produced by readSkillDirectory carries its real directory and version', () => {
  const skillDir = tempDir();
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: prov-skill\ndescription: Does a thing.\n---\n\n# Body\n');
  fs.writeFileSync(path.join(skillDir, 'provenance.json'), JSON.stringify({
    schemaVersion: 1,
    assetVersion: 'prov-v1',
    sourceRun: 'run-42',
    sourceTrace: 'trace/42.ndjson',
    inputs: [{ path: 'data/in.csv', sha256: 'abc' }],
    verification: { command: 'python3 verify.py', result: 'pass' },
  }));
  clearAssetProvenanceCache();
  const skill = readSkillDirectory(skillDir, {});
  assert.equal(skill.directory, path.resolve(skillDir));

  const root = tempDir();
  fs.writeFileSync(path.join(root, 'index.md'), '- Test Domain: test entries\n');
  fs.mkdirSync(path.join(root, 'Test Domain'));
  fs.writeFileSync(path.join(root, 'Test Domain', 'index.md'), '- prov-skill（skill：prov-skill）：Does a thing.\n');
  const candidates = collectToolLibraryCandidates({
    root,
    skills: [skill],
    mcpServers: [],
    mcpTools: new Map(),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].version, 'prov-v1');
});

test('knowledge entries expose the same provenance version path', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'skill.md'), '# Domains\n\n- Domain: test knowledge\n');
  fs.mkdirSync(path.join(root, 'Domain', 'Entry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Domain', 'Entry', 'skill.md'), '---\nname: Entry\ndescription: Knowledge entry.\n---\n\n# Body\n');
  fs.writeFileSync(path.join(root, 'Domain', 'Entry', 'provenance.json'), JSON.stringify({
    schemaVersion: 1,
    assetVersion: 'kb-v2',
    sourceRun: 'kb-run',
  }));
  clearAssetProvenanceCache();
  const { candidates } = listKnowledgeBaseCandidates({ root });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].version, 'kb-v2');
  const read = executeKnowledgeBase({ action: 'read', entry: 'Domain/Entry' }, { root });
  assert.equal(read.ok, true);
  assert.equal(read.version, 'kb-v2');
});
