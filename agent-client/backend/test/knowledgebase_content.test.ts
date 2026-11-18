import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executeKnowledgeBase } from '../src/agent/core_tools/knowledgebase_executor.js';
import { KNOWLEDGEBASE_ROOT } from '../src/paths.js';

const EXECUTABLE_EXTENSIONS = new Set(['.py', '.sh', '.js', '.mjs', '.ts', '.ps1', '.exe', '.bat', '.cmd', '.ipynb', '.r']);

test('the repository knowledgebase index is complete and consistent with its directories', () => {
  assert.equal(fs.existsSync(KNOWLEDGEBASE_ROOT), true, 'agent-client/knowledgebase must exist');

  const result = executeKnowledgeBase({ action: 'index' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [], 'the domain index must cover every domain directory and list no missing directories');

  const domains = result.domains as Array<{ name: string; description: string; entries: number }>;
  assert.ok(domains.length >= 2, 'at least two domains are expected');
  assert.deepEqual(domains.map((domain) => domain.name).sort(), ['General Science', 'Bioinformatics', 'Research Platforms and Data Integration'].sort());
  for (const domain of domains) {
    assert.ok(domain.description.trim(), `domain "${domain.name}" needs a description in knowledgebase/skill.md`);
    assert.ok(domain.entries > 0, `domain "${domain.name}" needs at least one entry`);
  }
});

test('every repository knowledge entry honors the knowledgebase content contract', () => {
  const index = executeKnowledgeBase({ action: 'index' });
  const domains = index.domains as Array<{ name: string }>;
  let entryCount = 0;
  let entriesWithResources = 0;

  for (const domain of domains) {
    const catalog = executeKnowledgeBase({ action: 'catalog', domain: domain.name, limit: 200 });
    assert.equal(catalog.ok, true, `catalog for ${domain.name} must succeed`);
    assert.deepEqual(catalog.warnings, [], `catalog for ${domain.name} must not report warnings`);
    assert.equal(catalog.has_more, false, `domain ${domain.name} must fit in one catalog page`);

    const entries = catalog.entries as Array<{ id: string; name: string; description: string }>;
    assert.equal(entries.length, catalog.total);
    const ids = entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `entry ids in ${domain.name} must be unique`);
    const names = entries.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, `entry names in ${domain.name} must be unique`);

    for (const summary of entries) {
      entryCount += 1;
      assert.ok(summary.description.trim(), `${summary.id} needs a non-empty description`);
      assert.equal(fs.existsSync(path.join(KNOWLEDGEBASE_ROOT, summary.id, 'skill.md')), true, `${summary.id}/skill.md must exist`);

      const entry = executeKnowledgeBase({ action: 'read', entry: summary.id });
      assert.equal(entry.ok, true, `reading ${summary.id} must succeed`);
      assert.deepEqual(entry.warnings, [], `${summary.id} must stay within the authoring budgets`);
      const content = String(entry.content);
      assert.ok(content.length > 0, `${summary.id} needs a non-empty body`);
      assert.ok(content.length <= 28000, `${summary.id} body is ${content.length} chars; the budget is 28000`);

      const resources = entry.resources as Array<{ path: string }>;
      if (resources.length) entriesWithResources += 1;
      const resourcesDirectory = path.join(KNOWLEDGEBASE_ROOT, summary.id, 'resources');
      const resourceFiles = fs.existsSync(resourcesDirectory) ? walkFiles(resourcesDirectory) : [];
      for (const file of resourceFiles) {
        assert.equal(
          EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase()),
          false,
          `${path.relative(KNOWLEDGEBASE_ROOT, file)} must not be executable; the knowledgebase only stores viewable material`,
        );
      }
    }
  }

  assert.ok(entryCount >= 28, `expected at least 28 knowledge entries after the migration, found ${entryCount}`);
  assert.ok(entriesWithResources >= 1, 'at least one seeded entry must carry viewable resources');
});

function walkFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    return entry.isFile() ? [target] : [];
  });
}
