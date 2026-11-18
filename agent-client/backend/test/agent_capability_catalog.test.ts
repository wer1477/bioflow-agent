import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildKnowledgeBaseConfigCatalog,
  buildToolLibraryConfigCatalog,
  publicToolPrefix,
  resolveMcpServer,
} from '../src/agent/config/agent_capability_catalog.js';
import { UNCLASSIFIED_DOMAIN_NAME } from '../src/agent/core_tools/toollibrary_executor.js';

type Files = Record<string, string>;

async function withRoot<T>(files: Files, callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bioflow-capability-catalog-'));
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

const TOOL_LIBRARY_FILES: Files = {
  'index.md': [
    '- Scientific Search：Search and external data.',
    '- Omics：Single-cell analysis.',
  ].join('\n') + '\n',
  'Scientific Search/index.md': [
    '- Context7（mcp：context7_resolve-library-id）：Resolve a library id.',
    '- Lost tool（mcp：gone_tool）：An entry whose server no longer exists.',
  ].join('\n') + '\n',
  'Omics/index.md': [
    '- Scanpy（skill：scanpy）：Single-cell analysis.',
    '- Missing skill（skill：removed）：A stale catalog entry.',
  ].join('\n') + '\n',
};

const skills = [
  { id: 'scanpy', name: 'scanpy', description: 'Single-cell analysis.', enabled: true },
  { id: 'bio-unlisted', name: 'bio-unlisted', description: 'Unlisted skill.', enabled: false },
];

const servers = [
  { id: 'context7', name: 'context7', description: 'Library docs.', enabled: true },
  { id: 'tavily', name: 'tavily', description: 'Web search provider.', enabled: true },
];

test('tool library catalog groups entries by domain and resolves MCP servers', async () => {
  await withRoot(TOOL_LIBRARY_FILES, (root) => {
    const { domains, warnings } = buildToolLibraryConfigCatalog({ root, skills, servers });
    assert.deepEqual(warnings, []);
    assert.deepEqual(domains.map((domain) => domain.name), ['Scientific Search', 'Omics', UNCLASSIFIED_DOMAIN_NAME]);

    const search = domains[0];
    assert.equal(search?.entries[0]?.kind, 'mcp');
    assert.equal(search?.entries[0]?.serverId, 'context7');
    assert.equal(search?.entries[0]?.available, true);
    assert.equal(search?.entries[1]?.serverId, null);
    assert.equal(search?.entries[1]?.available, false);

    const omics = domains[1];
    assert.equal(omics?.entries[0]?.kind, 'skill');
    assert.equal(omics?.entries[0]?.available, true);
    assert.equal(omics?.entries[0]?.enabled, true);
    assert.equal(omics?.entries[1]?.available, false);

    const unclassified = domains[2];
    assert.deepEqual(unclassified?.entries.map((entry) => entry.id), ['bio-unlisted', 'tavily']);
    assert.deepEqual(unclassified?.entries.map((entry) => entry.kind), ['skill', 'mcp']);
  });
});

test('tool library catalog keeps unlisted MCP servers reachable', async () => {
  await withRoot(TOOL_LIBRARY_FILES, (root) => {
    const { domains } = buildToolLibraryConfigCatalog({ root, skills, servers: [...servers, { id: 'biomcp', name: 'biomcp', description: '', enabled: true }] });
    const unclassified = domains.find((domain) => domain.name === UNCLASSIFIED_DOMAIN_NAME);
    assert.deepEqual(unclassified?.entries.map((entry) => entry.serverId).filter(Boolean).sort(), ['biomcp', 'tavily']);
  });
});

test('tool library catalog degrades to warnings when the root is missing', () => {
  const root = path.join(os.tmpdir(), `bioflow-missing-toollibrary-${process.pid}`);
  const { domains, warnings } = buildToolLibraryConfigCatalog({ root, skills: [], servers: [] });
  assert.deepEqual(domains, []);
  assert.ok(warnings.some((warning) => warning.startsWith('missing_root:')));
});

test('resolveMcpServer matches the sanitized public prefix and prefers the longest name', () => {
  assert.equal(publicToolPrefix('context7'), 'context7_');
  assert.equal(publicToolPrefix('my server'), 'my_server_');
  assert.equal(publicToolPrefix(''), '');

  const list = [
    { id: 'bio', name: 'bio' },
    { id: 'biomcp', name: 'biomcp' },
  ];
  assert.equal(resolveMcpServer('biomcp_search', list)?.id, 'biomcp');
  assert.equal(resolveMcpServer('bio_search', list)?.id, 'bio');
  assert.equal(resolveMcpServer('unrelated_tool', list), null);
});

test('knowledge base catalog lists every domain with read-only entries', async () => {
  await withRoot({
    'skill.md': [
      '- General Science：Statistics and methods.',
      '- Bioinformatics：Omics knowledge.',
    ].join('\n') + '\n',
    'General Science/hypothesis-testing/skill.md': ['---', 'name: "Hypothesis testing"', 'description: "P values."', '---', '', 'Body.'].join('\n'),
    'Bioinformatics/anndata/skill.md': ['---', 'name: "AnnData"', 'description: "Data format."', '---', '', 'Body.'].join('\n'),
  }, (root) => {
    const { domains, warnings } = buildKnowledgeBaseConfigCatalog({ root });
    assert.deepEqual(warnings, []);
    assert.deepEqual(domains.map((domain) => domain.name), ['General Science', 'Bioinformatics']);
    assert.deepEqual(domains[0]?.entries.map((entry) => entry.id), ['General Science/hypothesis-testing']);
    assert.equal(domains[1]?.description, 'Omics knowledge.');
  });
});
