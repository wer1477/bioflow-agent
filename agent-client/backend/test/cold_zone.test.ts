import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractEvidenceLines,
  fidelityScore,
  firstSentence,
  planColdZone,
  renderArchiveIndex,
  resolveTailTokenLimit,
  splitColdZone,
  DEFAULT_COLD_ZONE_POLICY,
  type ColdZoneGroup,
  type TokenEstimator,
} from '../src/agent/context/cold_zone.js';
import { packChatMessages } from '../src/agent/context/cold_zone_pack.js';

/** Rough but monotonic: the pipeline only compares sizes, it never needs exact counts. */
const estimateTokens: TokenEstimator = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / 3));
};

function estimateMessage(message: { role?: string; content?: unknown }): number {
  return 4 + estimateTokens(message);
}

function packed(messages: Array<Record<string, unknown>>) {
  return packChatMessages(messages as never, { estimateTokens, estimateMessage });
}

test('a tool result is packed with the call that owns it', () => {
  const groups = packed([
    { role: 'user', content: 'run it' },
    {
      role: 'assistant',
      content: 'running',
      tool_calls: [{ id: 'c1', function: { name: 'exec_command', arguments: '{"command":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '/project/out.bam written' },
    { role: 'assistant', content: 'done' },
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].kind, 'user');
  assert.equal(groups[1].kind, 'assistant');
  assert.equal(groups[1].messages.length, 2, 'the result must not be separated from its call');
  assert.deepEqual(groups[1].toolNames, ['exec_command']);
  assert.match(groups[1].argsPreview, /"command":"ls"/);
});

test('a result with no owning call is its own group, not a fabricated pairing', () => {
  const groups = packed([{ role: 'tool', tool_call_id: 'orphan', content: 'a result nobody claimed' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'tool-orphan');
});

test('evidence lines are the paths, commands and failures, capped', () => {
  const text = [
    'Alright, let me look at the alignment.',
    '/tmp/bioflow-run/out.bam was written by the aligner',
    'samtools sort -@8 -o out.bam in.bam',
    'IndexError: no such file or directory',
    'This sentence is ordinary prose with no exact value in it.',
  ].join('\n');

  const lines = extractEvidenceLines(text);
  assert.equal(lines.length, 3, 'one line per signal, capped at three');
  assert.match(lines[0], /out\.bam/);
  assert.match(lines[1], /samtools sort/);
  assert.match(lines[2], /IndexError/);
  assert.ok(lines.every((line) => line.length <= 160));
});

test('fidelity separates exact content from prose', () => {
  const exact = '/project/results/de.tsv\nsamtools sort -@8\nError: exit code 1';
  const prose = 'I looked at the files and everything seems in order so far.';
  assert.ok(fidelityScore(exact) > fidelityScore(prose));
  assert.equal(fidelityScore(''), 0);
  assert.ok(fidelityScore(exact) <= 1);
});

test('the first sentence survives whitespace and stays short', () => {
  const sentence = firstSentence('  第一句是目标。第二句是细节。  '.replace(/\n/g, ' '));
  assert.equal(sentence, '第一句是目标。');
  assert.ok(firstSentence('x'.repeat(500)).length <= 121);
});

test('the tail walk-back never strands a tool result without its call', () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'calling' },
    { role: 'tool', content: 't'.repeat(400) },
    { role: 'tool', content: 't'.repeat(400) },
    { role: 'user', content: 'thanks' },
  ];
  const { cold, tail } = splitColdZone(messages, 200, estimateTokens, estimateMessage);
  assert.equal(tail[0].role, 'assistant', 'the cut must move back to the owning message');
  assert.equal(cold.length, 1);
});

test('user prompts never enter the cold-zone quota and older ones shrink to a line', () => {
  const groups: ColdZoneGroup[] = [];
  for (let index = 0; index < 20; index += 1) {
    groups.push({
      seq: index,
      kind: 'user',
      messages: [],
      toolNames: [],
      argsPreview: '',
      outcome: 'unknown',
      producedFiles: [],
      blobRefs: [],
      text: `问题 ${index}：${'细节'.repeat(100)}`,
      summaryText: '',
      sizeTokens: 200,
      evidenceLines: [],
      fidelity: 0,
      score: 0,
    });
  }

  // 20k window: user budget is 5% = 1000 tokens, i.e. five of these groups.
  const plan = planColdZone(groups, { contextWindowTokens: 20_000, estimateTokens });
  const full = plan.kept.filter((group) => group.render === 'full');
  const condensed = plan.kept.filter((group) => group.render === 'first-line');
  assert.equal(plan.kept.length, 20, 'every user prompt stays in the request in some form');
  assert.equal(full.length, 15, 'ten newest are always whole, five fit the budget');
  assert.equal(condensed.length, 5);
});

test('a group below the threshold leaves the context and is named in the index', () => {
  const groups = packed([
    { role: 'assistant', content: '/project/old.bam was written' },
    { role: 'assistant', content: 'current work' },
  ]);
  const plan = planColdZone(groups, {
    contextWindowTokens: 100_000,
    estimateTokens,
    scorer: (group) => (group.seq === 0 ? 0.1 : 0.9),
  });

  assert.equal(plan.archived.length, 1);
  assert.equal(plan.archived[0].disposition, 'index');
  assert.equal(plan.archiveIndex.length, 1);
  assert.match(plan.archiveIndex[0], /^\[#0\]/);
});

test('the verbatim quota is a token budget, not a group count', () => {
  const groups = packed([
    { role: 'assistant', content: `big ${'b'.repeat(3_000)}` },
    { role: 'assistant', content: `small ${'s'.repeat(30)}` },
  ]);
  // 100k window -> 2% = 2k tokens. The big group is ~1k tokens and fits; a second copy would
  // not. The point is that the plan records the cost it spent, so callers can assert on it.
  const plan = planColdZone(groups, { contextWindowTokens: 100_000, estimateTokens });
  assert.ok(plan.stats.keptTokens <= 2_000);
  assert.ok(plan.kept.length >= 1);
});

test('kept groups are written back in original order regardless of score', () => {
  const groups = packed([
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'assistant', content: 'third' },
  ]);
  const plan = planColdZone(groups, {
    contextWindowTokens: 100_000,
    estimateTokens,
    scorer: () => 0.9,
  });
  const seqs = plan.kept.map((group) => group.seq);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
});

test('checkpoint mode folds the verbatim channels into the summary', () => {
  const messages = [
    { role: 'assistant', content: 'samtools sort -@8 -o /project/out.bam in.bam' },
    { role: 'assistant', content: 'the run is nearly done' },
  ];

  // A request plan would keep both: the exact command is an evidence line, the prose fits
  // the quota. A checkpoint has no request to write into, so the same groups must be
  // summarised or the checkpoint silently skips them.
  const requestPlan = planColdZone(packed(messages), { contextWindowTokens: 100_000, estimateTokens });
  const checkpointPlan = planColdZone(packed(messages), {
    contextWindowTokens: 100_000,
    estimateTokens,
    mode: 'checkpoint',
  });

  assert.ok(requestPlan.kept.length >= 1);
  assert.equal(checkpointPlan.kept.length, 0);
  assert.equal(checkpointPlan.summarised.length, requestPlan.kept.length + requestPlan.summarised.length);
});

test('the archive index stops at its entry and token caps', () => {
  const groups = packed(
    Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', content: `step ${index}` })),
  );
  const policy = { ...DEFAULT_COLD_ZONE_POLICY, maxArchiveEntries: 2 };
  const lines = renderArchiveIndex(groups, estimateTokens, policy);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /3 more archived/);
});

test('a tail limit shrinks with the window instead of eating it', () => {
  assert.equal(resolveTailTokenLimit(1_000_000), 30_000);
  assert.equal(resolveTailTokenLimit(128_000), 20_000);
  assert.equal(resolveTailTokenLimit(32_000), 8_000);
  assert.equal(resolveTailTokenLimit(20_000), 5_000);
});
