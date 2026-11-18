import assert from 'node:assert/strict';
import test from 'node:test';
import {
  knowledgeBaseDomainState,
  knowledgeBaseSelection,
  toggleId,
  toggleKnowledgeBaseDomain,
  toggleToolLibraryDomain,
  toolLibraryDomainGroup,
  toolLibraryDomainState,
  toolLibrarySelection,
} from '../src/domain/agent_config_view.js';

const domain = {
  name: 'Omics',
  description: 'Single-cell analysis.',
  entries: [
    { kind: 'skill', id: 'scanpy', name: 'scanpy', available: true, enabled: true },
    { kind: 'skill', id: 'removed', name: 'removed', available: false, enabled: false },
    { kind: 'mcp', id: 'context7_query-docs', name: 'Context7 query', available: true, enabled: true, serverId: 'context7', serverName: 'context7' },
    { kind: 'mcp', id: 'context7_resolve', name: 'Context7 resolve', available: true, enabled: true, serverId: 'context7', serverName: 'context7' },
    { kind: 'mcp', id: 'gone_tool', name: 'Gone', available: false, enabled: false, serverId: null, serverName: null },
  ],
};

test('toggleId adds and removes ids without reordering survivors', () => {
  assert.deepEqual(toggleId(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(toggleId(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleId(undefined, 'a'), ['a']);
});

test('a domain groups skills and de-duplicates MCP tools by server', () => {
  const group = toolLibraryDomainGroup(domain);
  assert.deepEqual(group.skills.map((skill) => skill.id), ['scanpy', 'removed']);
  assert.equal(group.servers.length, 1);
  assert.equal(group.servers[0].serverId, 'context7');
  assert.deepEqual(group.servers[0].tools, ['Context7 query', 'Context7 resolve']);
  assert.deepEqual(group.unresolved.map((entry) => entry.id), ['gone_tool']);
});

test('domain state counts only bindable entries', () => {
  const empty = toolLibraryDomainState(domain, [], []);
  assert.equal(empty.total, 2);
  assert.equal(empty.selected, 0);
  assert.equal(empty.checked, false);

  const partial = toolLibraryDomainState(domain, ['scanpy'], []);
  assert.equal(partial.selected, 1);

  const full = toolLibraryDomainState(domain, ['scanpy'], ['context7']);
  assert.equal(full.selected, 2);
  assert.equal(full.checked, true);
});

test('toggling a domain selects bindable entries and clears stale ones', () => {
  const selected = toggleToolLibraryDomain(domain, ['removed'], ['stale-server']);
  assert.deepEqual(selected.skillIds.sort(), ['removed', 'scanpy']);
  assert.deepEqual(selected.mcpServerIds.sort(), ['context7', 'stale-server']);

  const cleared = toggleToolLibraryDomain(domain, selected.skillIds, selected.mcpServerIds);
  assert.deepEqual(cleared.skillIds, []);
  // The stale server is not part of this domain, so clearing the domain leaves it alone.
  assert.deepEqual(cleared.mcpServerIds, ['stale-server']);
});

test('select-all covers every bindable entry across domains', () => {
  const other = {
    name: 'Unclassified',
    entries: [{ kind: 'mcp', id: 'tavily', name: 'tavily', available: true, enabled: true, serverId: 'tavily', serverName: 'tavily' }],
  };
  assert.deepEqual(toolLibrarySelection([domain, other]), {
    skillIds: ['scanpy'],
    mcpServerIds: ['context7', 'tavily'],
  });
});

test('knowledgebase helpers select entries per domain', () => {
  const domains = [
    {
      name: 'Bioinformatics',
      entries: [
        { id: 'Bioinformatics/anndata', name: 'anndata' },
        { id: 'Bioinformatics/pysam', name: 'pysam' },
      ],
    },
    { name: 'General Science', entries: [{ id: 'General Science/p-values', name: 'p-values' }] },
  ];

  assert.deepEqual(knowledgeBaseSelection(domains), [
    'Bioinformatics/anndata',
    'Bioinformatics/pysam',
    'General Science/p-values',
  ]);

  const empty = knowledgeBaseDomainState(domains[0], []);
  assert.deepEqual(empty, { total: 2, selected: 0, checked: false, indeterminate: false });

  const partial = knowledgeBaseDomainState(domains[0], ['Bioinformatics/anndata']);
  assert.equal(partial.selected, 1);
  assert.equal(partial.checked, false);
  assert.equal(partial.indeterminate, true);

  const full = knowledgeBaseDomainState(domains[0], knowledgeBaseSelection(domains));
  assert.equal(full.selected, 2);
  assert.equal(full.checked, true);
  assert.equal(full.indeterminate, false);
});

test('toggling a knowledge domain selects or clears that domain only', () => {
  const domains = [
    { name: 'Bioinformatics', entries: [{ id: 'bio/a' }, { id: 'bio/b' }] },
    { name: 'General Science', entries: [{ id: 'gs/c' }] },
  ];
  assert.deepEqual(toggleKnowledgeBaseDomain(domains[0], ['gs/c']).sort(), ['bio/a', 'bio/b', 'gs/c']);
  assert.deepEqual(toggleKnowledgeBaseDomain(domains[0], ['bio/a', 'bio/b', 'gs/c']), ['gs/c']);
  assert.deepEqual(toggleKnowledgeBaseDomain(domains[0], ['stale/entry']).sort(), ['bio/a', 'bio/b', 'stale/entry']);
  assert.deepEqual(knowledgeBaseSelection([]), []);
});
