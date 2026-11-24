import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetFor } from '../src/agent/biod/framework/budget.js';
import { loadBiodConfig } from '../src/agent/biod/config.js';
import type { BiodConfig } from '../src/agent/biod/config.js';
import { BiodService } from '../src/agent/biod/service.js';
import {
  DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  type IssueAuditRequest,
  type IssuePremiseRow,
  type IssueTriageScorer,
  type OwnerSignal,
  type PairSignal,
  type PremiseAuditResult,
  type PremiseSignal,
} from '../src/agent/biod/reviewer/contracts.js';
import { ISSUE_COLUMNS, parseIssueMatrix } from '../src/agent/biod/reviewer/issues.js';
import { locateAnchor, parseDocument, searchAbsenceTerms } from '../src/agent/biod/reviewer/document.js';
import { runIssuePrecheck, summarizePrecheck, type PremiseCheck } from '../src/agent/biod/reviewer/precheck.js';
import {
  fitIssueAuditBudget,
  renderOwnerState,
  renderPairState,
  renderPremiseState,
} from '../src/agent/biod/reviewer/renderer.js';
import { HeuristicIssueTriageScorer, MockIssueTriageScorer } from '../src/agent/biod/reviewer/scorers.js';
import { buildQueue, decideIssue, decideOwner, decidePremise } from '../src/agent/biod/reviewer/policy.js';
import { rankByPairwise } from '../src/agent/biod/reviewer/rank.js';
import { auditIssues } from '../src/agent/biod/reviewer/audit.js';
import { executeIssueAuditTool } from '../src/agent/biod/reviewer/tool.js';

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const DOCUMENT = `# Marker X drives T-cell exhaustion

## Abstract

We report that marker X predicts response to therapy in humans.

## Methods

We enrolled 40 patients. We fitted an adjusted multivariable Cox model for the primary comparison.

Sample size was estimated at 40 events.

## Results

Treatment increased marker X (log2FC = 1.8, FDR = 0.01) in the treatment group.

Figure 2 shows marker X increased after treatment.

Figure 3 shows marker X decreased after treatment.

## Discussion

These data demonstrate that marker X drives exhaustion.

## References

Marker X drives exhaustion. J Immunol 2020.
`;

const ADJUSTED_QUOTE = 'We fitted an adjusted multivariable Cox model for the primary comparison.';
const INCREASE_QUOTE = 'Figure 2 shows marker X increased after treatment.';
const DECREASE_QUOTE = 'Figure 3 shows marker X decreased after treatment.';
const CAUSAL_QUOTE = 'These data demonstrate that marker X drives exhaustion.';
const ABSTRACT_QUOTE = 'We report that marker X predicts response to therapy in humans.';

type RowInput = Partial<Record<(typeof ISSUE_COLUMNS)[number], string>>;

function issueRow(overrides: RowInput): string {
  return ISSUE_COLUMNS.map((column) => escapeCsv(overrides[column] ?? '')).join(',');
}

function issuesCsv(rows: RowInput[]): string {
  return [ISSUE_COLUMNS.join(','), ...rows.map(issueRow)].join('\n');
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function baseIssue(overrides: RowInput): RowInput {
  return {
    section: 'results',
    issue_type: 'statistical',
    severity_claim: 'blocking',
    issue_text: 'A test issue about the analysis.',
    owner_suggested: 'researcher',
    ...overrides,
  };
}

/** A minimal, valid issue matrix used by the audit/tool tests. */
function sampleIssues(): string {
  return issuesCsv([
    // Blocking statistical issue whose premise the document contradicts -> P0.
    baseIssue({
      issue_id: 'I001',
      section: 'methods',
      issue_text: 'The primary model is not adjusted for confounders.',
      premise_id: 'P1',
      premise_kind: 'passage',
      premise_text: 'The primary model is described as unadjusted.',
      anchor_locator: 'Methods para 1',
      anchor_quote: ADJUSTED_QUOTE,
    }),
    // Important absence premise: the claimed missing content is actually reported -> P1.
    baseIssue({
      issue_id: 'I002',
      issue_type: 'methodological',
      severity_claim: 'important',
      section: 'methods',
      issue_text: 'The manuscript never reports a sample size or power calculation.',
      premise_id: 'P1',
      premise_kind: 'absence',
      premise_text: 'The manuscript does not report a sample size estimate.',
      anchor_locator: 'Methods',
      search_terms: 'sample size|power calculation',
    }),
    // Blocking conflict premise that holds -> premises_hold, no check priority.
    baseIssue({
      issue_id: 'I003',
      issue_type: 'claim_support',
      severity_claim: 'blocking',
      owner_suggested: 'writer',
      section: 'results',
      issue_text: 'The two figures report contradictory effect directions.',
      premise_id: 'P1',
      premise_kind: 'conflict',
      premise_text: 'The two figures report opposite directions for the same comparison.',
      anchor_locator: 'Fig. 2',
      anchor_quote: INCREASE_QUOTE,
      anchor_quote_2: DECREASE_QUOTE,
    }),
    // Verbatim premise that holds.
    baseIssue({
      issue_id: 'I004',
      issue_type: 'claim_support',
      severity_claim: 'important',
      owner_suggested: 'writer',
      section: 'discussion',
      issue_text: 'The causal claim is stronger than the evidence.',
      premise_id: 'P1',
      premise_kind: 'passage',
      premise_text: 'These data demonstrate that marker X drives exhaustion.',
      anchor_locator: 'Discussion para 1',
      anchor_quote: CAUSAL_QUOTE,
    }),
    // No checkable premise; duplicate of I006.
    baseIssue({
      issue_id: 'I005',
      issue_type: 'methodological',
      severity_claim: 'important',
      section: 'methods',
      issue_text: 'Sample size justification is missing.',
      premise_id: 'NONE',
      premise_kind: 'none',
    }),
    baseIssue({
      issue_id: 'I006',
      issue_type: 'methodological',
      severity_claim: 'important',
      section: 'methods',
      issue_text: 'Sample size justification is missing.',
      premise_id: 'NONE',
      premise_kind: 'none',
    }),
  ]);
}

function request(overrides: Partial<IssueAuditRequest> = {}): IssueAuditRequest {
  return {
    requestId: 'req-v1',
    runId: 'run-v1',
    role: 'reviewer',
    documentPath: 'manuscript/manuscript.md',
    issuesPath: 'review/issues.csv',
    documentContent: DOCUMENT,
    issuesContent: sampleIssues(),
    mode: 'assist',
    budget: budgetFor('issue-audit'),
    thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS },
    context: { sessionId: 'session-v1', rolePromptVersion: 'reviewer', rendererVersion: 'v1' },
    ...overrides,
  };
}

function config(overrides: Partial<BiodConfig> = {}): BiodConfig {
  return {
    enabled: false,
    service: {
      baseUrl: 'http://127.0.0.1:9999',
      autoStart: false,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 200,
      contextTimeoutMs: 200,
    },
    runtime: { device: 'cpu', dtype: 'float32' },
    model: { expectedVersion: 'test' },
    decisionPoints: {
      tool_select: { mode: 'off', tau: 0.5 },
      kb_select: { mode: 'off', tau: 0.5, topK: 3 },
      context_retention: { mode: 'off', maxGroups: 32 },
      role_select: { mode: 'off', tau: 0.6 },
      relay_select: { mode: 'off', floor: 0.75 },
    },
    framework: {
      enabled: true,
      defaultMode: 'off',
      decisionPoints: {},
      reviewer: {
        enabled: true,
        thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS },
        decisionPoints: {
          'v1.issue-triage': { mode: 'assist', scorer: 'heuristic', budget: 'issue-audit' },
        },
      },
    },
    state: { maxChars: 220 },
    warnings: [],
    ...overrides,
  };
}

function tempProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-v1-'));
  tempDirectories.push(directory);
  return directory;
}

function writeProject(projectPath: string, document = DOCUMENT, issues = sampleIssues()): void {
  fs.mkdirSync(path.join(projectPath, 'manuscript'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'review'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'manuscript/manuscript.md'), document, 'utf8');
  fs.writeFileSync(path.join(projectPath, 'review/issues.csv'), issues, 'utf8');
}

function premiseCheck(overrides: Partial<PremiseCheck> & { premise: IssuePremiseRow }): PremiseCheck {
  return { flags: [], ...overrides };
}

function row(overrides: Partial<IssuePremiseRow> = {}): IssuePremiseRow {
  return {
    issueId: 'I001',
    section: 'methods',
    issueText: 'The primary model is not adjusted for confounders.',
    issueType: 'statistical',
    severityClaim: 'blocking',
    premiseId: 'P1',
    premiseKind: 'passage',
    premiseText: 'The primary model is described as unadjusted.',
    anchorLocator: 'Methods para 1',
    anchorQuote: ADJUSTED_QUOTE,
    anchorQuote2: '',
    searchTerms: [],
    notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// contracts / parsing
// ---------------------------------------------------------------------------

test('parseIssueMatrix parses one row per issue-premise and splits search terms', () => {
  const csv = issuesCsv([
    baseIssue({
      issue_id: 'I001',
      section: 'methods',
      issue_text: 'The model is not adjusted.',
      premise_id: 'P1',
      premise_kind: 'passage',
      premise_text: 'The model is described as unadjusted.',
      anchor_locator: 'Methods',
      anchor_quote: ADJUSTED_QUOTE,
    }),
    baseIssue({
      issue_id: 'I001',
      section: 'methods',
      issue_text: 'The model is not adjusted.',
      premise_id: 'P2',
      premise_kind: 'absence',
      premise_text: 'No confounder list is reported.',
      anchor_locator: 'Methods',
      search_terms: 'confounder|adjusted for| multivariable ',
    }),
  ]);
  const parsed = parseIssueMatrix(csv);
  if (!parsed.ok) throw new Error(parsed.message);
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0].premises.length, 2);
  assert.deepEqual(parsed.issues[0].premises[1].searchTerms, ['confounder', 'adjusted for', 'multivariable']);
  assert.equal(parsed.issues[0].ownerSuggested, 'researcher');
  assert.equal(parsed.rows.length, 2);
});

test('parseIssueMatrix rejects malformed matrices with a line number', () => {
  const missingColumn = parseIssueMatrix('issue_id,section\nI001,results');
  assert.equal(missingColumn.ok, false);
  if (!missingColumn.ok) assert.match(missingColumn.message, /missing column/);

  const badEnum = parseIssueMatrix(issuesCsv([baseIssue({
    issue_id: 'I001',
    severity_claim: 'critical',
    premise_id: 'NONE',
    premise_kind: 'none',
  })]));
  assert.equal(badEnum.ok, false);
  if (!badEnum.ok) assert.match(badEnum.message, /severity_claim/);

  const duplicatePremise = parseIssueMatrix(issuesCsv([
    baseIssue({ issue_id: 'I001', premise_id: 'P1', premise_kind: 'absence', premise_text: 'x is absent from the text', search_terms: 'x' }),
    baseIssue({ issue_id: 'I001', premise_id: 'P1', premise_kind: 'absence', premise_text: 'x is absent from the text', search_terms: 'x' }),
  ]));
  assert.equal(duplicatePremise.ok, false);
  if (!duplicatePremise.ok) assert.match(duplicatePremise.message, /duplicate premise/);

  const inconsistent = parseIssueMatrix(issuesCsv([
    baseIssue({ issue_id: 'I001', issue_text: 'first text', premise_id: 'P1', premise_kind: 'absence', premise_text: 'x is absent', search_terms: 'x' }),
    baseIssue({ issue_id: 'I001', issue_text: 'different text', premise_id: 'P2', premise_kind: 'absence', premise_text: 'x is absent', search_terms: 'x' }),
  ]));
  assert.equal(inconsistent.ok, false);
  if (!inconsistent.ok) assert.match(inconsistent.message, /inconsistent/);

  const passageWithoutQuote = parseIssueMatrix(issuesCsv([baseIssue({
    issue_id: 'I001',
    premise_id: 'P1',
    premise_kind: 'passage',
    premise_text: 'the quote exists',
  })]));
  assert.equal(passageWithoutQuote.ok, false);
  if (!passageWithoutQuote.ok) assert.match(passageWithoutQuote.message, /anchor_quote/);

  const noneWithContent = parseIssueMatrix(issuesCsv([baseIssue({
    issue_id: 'I001',
    premise_id: 'NONE',
    premise_kind: 'none',
    anchor_quote: 'leftover quote',
  })]));
  assert.equal(noneWithContent.ok, false);
  if (!noneWithContent.ok) assert.match(noneWithContent.message, /premise_kind=none/);

  const tooMany = parseIssueMatrix(
    issuesCsv([1, 2].map((index) => baseIssue({
      issue_id: `I00${index}`,
      premise_id: 'NONE',
      premise_kind: 'none',
    }))),
    { maxIssues: 1 },
  );
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.message, /issue count exceeds/);
});

test('parseDocument maps headings, paragraphs and reference lists', () => {
  const document = parseDocument(DOCUMENT);
  assert.equal(document.title, 'Marker X drives T-cell exhaustion');
  assert.ok(document.sectionNames.includes('methods'));
  assert.ok(document.sectionNames.includes('discussion'));
  const references = document.sections.find((section) => section.isReferences);
  assert.ok(references, 'reference section is detected so absence search can skip it');
  const methods = document.sections.find((section) => section.section === 'methods');
  assert.equal(methods?.paragraphs.length, 2);
});

// ---------------------------------------------------------------------------
// deterministic precheck
// ---------------------------------------------------------------------------

test('locateAnchor requires a verbatim quote and keeps anchor text free of neighbours', () => {
  const document = parseDocument(DOCUMENT);
  const exact = locateAnchor(document, INCREASE_QUOTE, 1200);
  assert.equal(exact.found, true);
  assert.equal(exact.section, 'results');
  assert.equal(exact.anchorText, INCREASE_QUOTE);
  assert.ok((exact.passage ?? '').includes(DECREASE_QUOTE), 'passage window includes the neighbour paragraph');

  const paraphrased = locateAnchor(document, 'Marker X went up after treatment.', 1200);
  assert.equal(paraphrased.found, false);
  assert.ok(paraphrased.missingFragments.length > 0);

  const fragments = locateAnchor(document, 'We enrolled 40 patients…Sample size was estimated at 40 events.', 1200);
  assert.equal(fragments.found, true, 'ellipsis fragments must all be present in one section');

  const ambiguousDocument = parseDocument(`# T\n\n## Abstract\n\n${CAUSAL_QUOTE}\n\n## Discussion\n\n${CAUSAL_QUOTE}\n`);
  const ambiguous = locateAnchor(ambiguousDocument, CAUSAL_QUOTE, 1200);
  assert.equal(ambiguous.ambiguous, true);
});

test('searchAbsenceTerms skips reference lists and reports the first hit', () => {
  const document = parseDocument(DOCUMENT);
  const hit = searchAbsenceTerms(document, ['sample size', 'power calculation']);
  assert.equal(hit.hit?.term, 'sample size');
  assert.equal(hit.hit?.section, 'methods');

  const onlyReferences = searchAbsenceTerms(document, ['J Immunol']);
  assert.equal(onlyReferences.hit, undefined, 'a reference entry does not count as reported content');
  const miss = searchAbsenceTerms(document, ['power calculation', 'registrar approval']);
  assert.equal(miss.hit, undefined);
});

test('runIssuePrecheck flags missing anchors, missing sections and duplicate issues', () => {
  const csv = issuesCsv([
    baseIssue({
      issue_id: 'I001',
      section: 'supplementary',
      issue_text: 'The quote is not in the document.',
      premise_id: 'P1',
      premise_kind: 'passage',
      premise_text: 'The document says this.',
      anchor_locator: 'Supp. 1',
      anchor_quote: 'This sentence does not exist anywhere in the document at all.',
    }),
    baseIssue({
      issue_id: 'I002',
      section: 'results',
      issue_text: 'The manuscript never reports a sample size or power calculation.',
      premise_id: 'P1',
      premise_kind: 'absence',
      premise_text: 'No sample size is reported.',
      search_terms: 'sample size',
    }),
    baseIssue({
      issue_id: 'I003',
      section: 'results',
      issue_text: 'The manuscript never reports a sample size or power calculation.',
      premise_id: 'P1',
      premise_kind: 'absence',
      premise_text: 'No sample size is reported.',
      search_terms: 'sample size',
    }),
  ]);
  const parsed = parseIssueMatrix(csv);
  if (!parsed.ok) throw new Error(parsed.message);
  const document = parseDocument(DOCUMENT);
  const checks = runIssuePrecheck({
    issues: parsed.issues,
    document,
    duplicateThreshold: DEFAULT_ISSUE_TRIAGE_THRESHOLDS.duplicateThreshold,
    maxPassageChars: 1200,
  });
  const first = checks[0];
  assert.ok(first.flags.includes('anchor_missing'));
  assert.ok(first.flags.includes('section_missing'));
  assert.deepEqual(checks[1].duplicates, ['I003']);
  const summary = summarizePrecheck(checks);
  assert.equal(summary.anchorsMissing, 1);
  assert.equal(summary.sectionsMissing, 1);
  assert.equal(summary.duplicateIssues, 2);
  assert.equal(summary.absenceHits, 2);
});

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

test('renderers keep the short state inside the v0 budget and expose all fields otherwise', () => {
  const parsed = parseIssueMatrix(sampleIssues());
  if (!parsed.ok) throw new Error(parsed.message);
  const issue = parsed.issues[0];
  const premise = issue.premises[0];
  const document = parseDocument(DOCUMENT);
  const anchor = locateAnchor(document, premise.anchorQuote, 1200);

  const full = renderPremiseState({
    issue,
    premise,
    passage: anchor.passage ?? '',
    variant: 'full',
  });
  assert.match(full.state, /\[角色：reviewer\]\[DP:v1\.issue-triage\]\[check:premise\]/);
  assert.ok(full.state.includes(premise.premiseText));
  assert.ok(full.state.includes('Do not grade the issue'));

  const short = renderPremiseState({ issue, premise, passage: anchor.passage ?? '', variant: 'short' });
  assert.ok(short.state.length <= 220, 'short state must stay inside the v0 character budget');

  const owner = renderOwnerState({ issue, premiseStatus: 'premise_contradicted' });
  assert.ok(owner.state.includes('Premise status: premise_contradicted'));
  assert.ok(owner.state.includes('searcher=literature/prior work'));

  const pair = renderPairState({ a: issue, b: parsed.issues[1], title: 'Marker X drives T-cell exhaustion' });
  assert.ok(pair.state.includes('Answer a / b / tie'));
});

test('fitIssueAuditBudget clips an oversized state and reports truncation', () => {
  const state = `[role:reviewer] ${'x'.repeat(2_000)}`;
  const fitted = fitIssueAuditBudget(state, { ...budgetFor('issue-audit'), maxStateTokens: 100 });
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.state.length < state.length);
});

// ---------------------------------------------------------------------------
// heuristic scorer
// ---------------------------------------------------------------------------

test('heuristic premise treats "unadjusted" vs "adjusted" as a contradiction', async () => {
  const scorer = new HeuristicIssueTriageScorer();
  const signal = await scorer.scorePremise({
    issue: issueFrom(row()),
    premise: row(),
    passage: ADJUSTED_QUOTE,
  });
  assert.equal(signal.abstain, false);
  assert.ok(signal.scores.contradicted > signal.scores.holds);
  assert.ok(signal.confidence >= DEFAULT_ISSUE_TRIAGE_THRESHOLDS.tauContradicted);
  assert.ok(signal.reasons.some((reason) => reason.includes('contrast')));
});

test('heuristic premise detects direction and number conflicts, and abstains when too short', async () => {
  const scorer = new HeuristicIssueTriageScorer();
  const direction = await scorer.scorePremise({
    issue: issueFrom(row({ premiseText: 'Treatment increased marker X.' })),
    premise: row({ premiseText: 'Treatment increased marker X.' }),
    passage: 'Treatment decreased marker X in the same comparison.',
  });
  assert.ok(direction.scores.contradicted > direction.scores.holds);

  const number = await scorer.scorePremise({
    issue: issueFrom(row({ premiseText: 'The effect size was 2.5.' })),
    premise: row({ premiseText: 'The effect size was 2.5.' }),
    passage: 'The reported effect size was 1.8 in the primary model.',
  });
  assert.ok(number.scores.contradicted > number.scores.holds);

  const holds = await scorer.scorePremise({
    issue: issueFrom(row()),
    premise: row({ premiseText: ABSTRACT_QUOTE }),
    passage: ABSTRACT_QUOTE,
  });
  assert.ok(holds.scores.holds > holds.scores.contradicted);

  const short = await scorer.scorePremise({
    issue: issueFrom(row({ premiseText: 'short' })),
    premise: row({ premiseText: 'short' }),
    passage: 'tiny',
  });
  assert.equal(short.abstain, true);
});

test('heuristic conflict holds on opposite directions and stays unresolved without a signal', async () => {
  const scorer = new HeuristicIssueTriageScorer();
  const opposite = await scorer.scorePremise({
    issue: issueFrom(row()),
    premise: row({ premiseKind: 'conflict' }),
    passage: INCREASE_QUOTE,
    passage2: DECREASE_QUOTE,
  });
  assert.ok(opposite.scores.holds > opposite.scores.unresolved);

  const same = await scorer.scorePremise({
    issue: issueFrom(row()),
    premise: row({ premiseKind: 'conflict' }),
    passage: INCREASE_QUOTE,
    passage2: 'Figure 3 shows marker X increased after treatment as well.',
  });
  assert.ok(same.scores.contradicted > same.scores.holds, 'consistent passages contradict the "they conflict" premise');
});

test('heuristic owner maps issue types and reports a low margin route', async () => {
  const scorer = new HeuristicIssueTriageScorer();
  const writing = await scorer.scoreOwner({
    issue: issueFrom(row({ issueType: 'writing', issueText: 'The abstract needs wording changes in the first sentence.' })),
    premiseStatus: 'premises_hold',
  });
  assert.equal(topOwner(writing), 'writer');

  const stats = await scorer.scoreOwner({
    issue: issueFrom(row({ issueType: 'statistical' })),
    premiseStatus: 'premise_contradicted',
  });
  assert.equal(topOwner(stats), 'researcher');

  const scope = await scorer.scoreOwner({
    issue: issueFrom(row({ issueType: 'scope', issueText: 'The scope claim is broader than the measured population.' })),
    premiseStatus: 'premises_hold',
  });
  const route = decideOwner({
    issue: issueFrom(row({ issueType: 'scope', issueText: 'The scope claim is broader than the measured population.' })),
    premiseStatus: 'premises_hold',
    signal: scope,
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(route.undecided, true);
  assert.equal(route.owner, 'pi');
});

test('heuristic pair prefers the higher blocking weight and ties inside the margin', async () => {
  const scorer = new HeuristicIssueTriageScorer({ pairMargin: 0.05 });
  const strict = await scorer.scorePair({
    a: issueFrom(row({ issueType: 'statistical', severityClaim: 'blocking' })),
    b: issueFrom(row({ issueId: 'I002', issueType: 'writing', severityClaim: 'blocking' })),
    title: 't',
  });
  assert.ok(strict.scores.a > strict.scores.b);

  const tied = await scorer.scorePair({
    a: issueFrom(row()),
    b: issueFrom(row({ issueId: 'I002' })),
    title: 't',
  });
  assert.ok(tied.scores.tie >= tied.scores.a);
});

// ---------------------------------------------------------------------------
// policy / rank
// ---------------------------------------------------------------------------

test('decidePremise downgrades a weak contradiction to unresolved', () => {
  const check = premiseCheck({
    premise: row(),
    anchor: {
      found: true,
      section: 'methods',
      paragraphIndex: 0,
      passage: ADJUSTED_QUOTE,
      anchorText: ADJUSTED_QUOTE,
      ambiguous: false,
      missingFragments: [],
    },
  });
  const weak: PremiseSignal = {
    scores: { holds: 0.2, contradicted: 0.75, unresolved: 0.05 },
    confidence: 0.6,
    abstain: false,
    reasons: ['test'],
    latencyMs: 0,
  };
  const result = decidePremise({
    check,
    signal: weak,
    thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS, tauContradicted: 0.65 },
  });
  assert.equal(result.verdict, 'unresolved');

  const strong = decidePremise({
    check,
    signal: { ...weak, confidence: 0.8 },
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(strong.verdict, 'contradicted');
});

test('decideIssue assigns check priorities and actions, never a severity grade', () => {
  const contradicted: PremiseAuditResult = {
    premiseId: 'P1',
    kind: 'passage',
    premiseText: 'p',
    anchorLocator: 'l',
    verdict: 'contradicted',
    scores: { holds: 0, contradicted: 0.9, unresolved: 0.1 },
    confidence: 0.9,
    reasons: ['contradicted'],
    passage: 'passage',
    flags: ['premise_contradicted'],
    truncated: false,
    fallback: false,
  };
  const owner = decidedOwner('writer');
  const p0 = decideIssue({
    issue: issueFrom(row({ severityClaim: 'blocking' })),
    premises: [contradicted],
    owner,
    precheckFlags: [],
    duplicates: [],
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(p0.priority, 'P0');
  assert.equal(p0.finding, 'premise_contradicted');
  assert.ok(p0.actions.includes('re_read_passage'));
  assert.ok(!('severity' in p0), 'the audit never emits a severity grade field');

  const important = decideIssue({
    issue: issueFrom(row({ severityClaim: 'important' })),
    premises: [contradicted],
    owner,
    precheckFlags: [],
    duplicates: [],
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(important.priority, 'P1');

  const suggestion = decideIssue({
    issue: issueFrom(row({ severityClaim: 'suggestion' })),
    premises: [contradicted],
    owner,
    precheckFlags: [],
    duplicates: [],
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(suggestion.priority, 'P2');

  const holds = decideIssue({
    issue: issueFrom(row({ severityClaim: 'blocking' })),
    premises: [{ ...contradicted, verdict: 'holds', flags: [] }],
    owner,
    precheckFlags: [],
    duplicates: [],
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  assert.equal(holds.priority, 'none');
  assert.deepEqual(holds.actions, ['no_action']);
});

test('buildQueue orders by check priority, then pairwise rank', () => {
  const parsed = parseIssueMatrix(sampleIssues());
  if (!parsed.ok) throw new Error(parsed.message);
  const owner = decidedOwner('writer');
  const make = (index: number, verdict: PremiseAuditResult['verdict']) => decideIssue({
    issue: parsed.issues[index],
    premises: [{
      premiseId: 'P1',
      kind: 'passage',
      premiseText: 'p',
      anchorLocator: 'l',
      verdict,
      scores: { holds: 0.2, contradicted: 0.5, unresolved: 0.3 },
      confidence: 0.9,
      reasons: ['test'],
      flags: [],
      truncated: false,
      fallback: false,
    }],
    owner,
    precheckFlags: [],
    duplicates: [],
    thresholds: DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  });
  const first = { ...make(0, 'contradicted'), rank: 2 as number | undefined };
  const second = { ...make(1, 'unresolved'), rank: 1 as number | undefined };
  const third = make(2, 'holds');
  const queue = buildQueue([third, first, second]);
  assert.deepEqual(queue.map((entry) => entry.issueId), ['I001', 'I002', 'I003']);
});

test('rankByPairwise aggregates wins, keeps input order for ties and caps candidates', async () => {
  const parsed = parseIssueMatrix(sampleIssues());
  if (!parsed.ok) throw new Error(parsed.message);
  const outcome = await rankByPairwise({
    issues: parsed.issues.slice(0, 3),
    maxCandidates: 2,
    compare: async (a, b) => ({
      a: a.issueId,
      b: b.issueId,
      verdict: 'a',
      confidence: 0.8,
      reasons: ['test'],
      fallback: false,
    }),
  });
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.comparisons.length, 1);
  assert.deepEqual(outcome.ranked.map((entry) => entry.issueId), ['I001', 'I002']);
  assert.deepEqual(outcome.deferred, ['I003']);
  assert.equal(outcome.ranked[0].wins, 1);
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

test('auditIssues produces a bounded triage report and leaves the inputs untouched', async () => {
  const csv = sampleIssues();
  const result = await auditIssues(request({ issuesContent: csv }), {
    scorer: new HeuristicIssueTriageScorer(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const summary = result.report.summary;
  assert.equal(summary.totalIssues, 6);
  assert.equal(summary.totalPremises, 6);
  assert.equal(summary.p0, 1, 'contradicted + blocking is P0');
  assert.equal(summary.p1, 1, 'absence hit on an important issue is P1');
  assert.equal(summary.premiseContradicted, 2);
  assert.equal(summary.premisesHold, 2);
  assert.equal(summary.noPremise, 2);
  assert.equal(summary.duplicates, 2);
  assert.equal(result.report.queue[0].issueId, 'I001');
  assert.equal(result.report.queue[0].priority, 'P0');

  assert.ok(result.markdown.includes('## P0 · premise contradicted — re-read before acting'));
  assert.ok(result.markdown.includes('check priorities, not issue severities'));
  assert.ok(result.markdown.includes('## Not judged'));
  assert.equal(result.report.requestId, 'req-v1');
  assert.equal(csv, sampleIssues(), 'the issue matrix is not modified');
});

test('auditIssues fails open when a scorer throws or times out', async () => {
  const throwing: IssueTriageScorer = {
    modelVersion: 'throwing',
    variant: 'full',
    async scorePremise() {
      throw new Error('boom');
    },
    async scoreOwner() {
      throw new Error('boom');
    },
    async scorePair() {
      throw new Error('boom');
    },
  };
  const result = await auditIssues(request(), { scorer: throwing });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const issue = result.report.issues.find((entry) => entry.issueId === 'I001');
  assert.equal(issue?.premises[0].verdict, 'unresolved');
  assert.equal(issue?.premises[0].fallback, true);
  assert.ok(issue?.flags.includes('premise_fallback'));
  assert.ok(result.report.fallback);

  const hanging: IssueTriageScorer = {
    modelVersion: 'hanging',
    variant: 'full',
    scorePremise: () => new Promise<PremiseSignal>(() => {}),
    scoreOwner: () => new Promise<OwnerSignal>(() => {}),
    scorePair: () => new Promise<PairSignal>(() => {}),
  };
  const timedOut = await auditIssues(
    request({ budget: { ...budgetFor('issue-audit'), timeoutMs: 20 } }),
    { scorer: hanging },
  );
  assert.equal(timedOut.ok, true);
  if (timedOut.ok) {
    const premier = timedOut.report.issues[0].premises[0];
    assert.equal(premier.verdict, 'unresolved');
    assert.ok(premier.reasons.some((reason) => reason.includes('timed out')));
  }
});

test('auditIssues defers issues beyond maxScoredIssues and caps pairwise candidates', async () => {
  const deferred = await auditIssues(
    request({ thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS, maxScoredIssues: 1 } }),
    { scorer: new HeuristicIssueTriageScorer() },
  );
  assert.equal(deferred.ok, true);
  if (deferred.ok) {
    assert.equal(deferred.report.summary.deferred, 5);
    assert.ok(deferred.report.issues.some((issue) => issue.finding === 'deferred'));
    assert.equal(deferred.report.summary.p0, 1, 'the first issue is still audited');
  }

  // Three blocking issues whose premises hold -> pairwise runs, but only two candidates.
  const csv = issuesCsv([1, 2, 3].map((index) => baseIssue({
    issue_id: `I00${index}`,
    section: 'results',
    issue_type: 'statistical',
    issue_text: `Distinct statistical concern number ${index} about the primary model.`,
    premise_id: 'P1',
    premise_kind: 'passage',
    premise_text: INCREASE_QUOTE,
    anchor_locator: 'Results',
    anchor_quote: INCREASE_QUOTE,
  })));
  const capped = await auditIssues(
    request({
      issuesContent: csv,
      thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS, maxPairwiseIssues: 2 },
    }),
    { scorer: new HeuristicIssueTriageScorer() },
  );
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.equal(capped.report.pairwise.candidates, 2);
    assert.equal(capped.report.pairwise.comparisons, 1);
    assert.equal(capped.report.pairwise.truncated, true);
    assert.ok(capped.report.issues.some((issue) => issue.flags.includes('pairwise_deferred')));
  }
});

test('auditIssues rejects a missing matrix or document with a typed reason', async () => {
  const empty = await auditIssues(request({ issuesContent: '' }), {
    scorer: new HeuristicIssueTriageScorer(),
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'empty_issues');

  const missingDocument = await auditIssues(request({ documentContent: '   ' }), {
    scorer: new HeuristicIssueTriageScorer(),
  });
  assert.equal(missingDocument.ok, false);
  if (!missingDocument.ok) assert.equal(missingDocument.reason, 'missing_manuscript');
});

// ---------------------------------------------------------------------------
// tool / service / config / dispatcher
// ---------------------------------------------------------------------------

test('executeIssueAuditTool writes the report under review/ and never edits the inputs', async () => {
  const projectPath = tempProject();
  writeProject(projectPath);
  const ledgerFile = path.join(projectPath, 'issue-audit.jsonl');
  const service = new BiodService({
    config: config(),
    issueAuditLedgerFile: ledgerFile,
    environment: {},
  });
  const result = JSON.parse(await executeIssueAuditTool({}, {
    projectPath,
    agentId: 'reviewer',
    service,
    requestId: 'req-tool',
    runId: 'run-tool',
    sessionId: 'session-tool',
    rolePromptVersion: 'reviewer',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.reportPath, 'review/issue-audit-manuscript.md');
  assert.equal(result.summary.p0, 1);
  assert.ok(fs.existsSync(path.join(projectPath, 'review/issue-audit-manuscript.md')));
  assert.equal(fs.readFileSync(path.join(projectPath, 'manuscript/manuscript.md'), 'utf8'), DOCUMENT);
  assert.equal(fs.readFileSync(path.join(projectPath, 'review/issues.csv'), 'utf8'), sampleIssues());
  const ledger = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  assert.equal(ledger.length, 1);
  assert.equal(JSON.parse(ledger[0]).decisionPoint, 'v1.issue-triage');
  assert.equal(JSON.parse(ledger[0]).budgetProfile, 'issue-audit');
});

test('executeIssueAuditTool is reviewer-only, fails open, and supports shadow mode', async () => {
  const projectPath = tempProject();
  writeProject(projectPath);
  const service = new BiodService({ config: config(), environment: {} });

  const denied = JSON.parse(await executeIssueAuditTool({}, {
    projectPath,
    agentId: 'writer',
    service,
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'v',
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'not_authorized');

  const unsupported = JSON.parse(await executeIssueAuditTool({ path: 'manuscript/manuscript.txt' }, {
    projectPath,
    agentId: 'reviewer',
    service,
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'v',
  }));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, 'unsupported_manuscript_format');

  fs.rmSync(path.join(projectPath, 'review/issues.csv'));
  const missing = JSON.parse(await executeIssueAuditTool({}, {
    projectPath,
    agentId: 'reviewer',
    service,
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'v',
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_issues');

  const shadowProject = tempProject();
  writeProject(shadowProject);
  const shadowConfig = config();
  shadowConfig.framework!.reviewer!.decisionPoints['v1.issue-triage'] = {
    mode: 'shadow',
    scorer: 'heuristic',
    budget: 'issue-audit',
  };
  const shadowService = new BiodService({
    config: shadowConfig,
    issueAuditLedgerFile: path.join(shadowProject, 'ledger.jsonl'),
    environment: {},
  });
  const shadow = JSON.parse(await executeIssueAuditTool({}, {
    projectPath: shadowProject,
    agentId: 'reviewer',
    service: shadowService,
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'v',
  }));
  assert.equal(shadow.ok, true);
  assert.equal(shadow.shadow, true);
  assert.equal(shadow.reportPath, undefined);
  assert.ok(!fs.existsSync(path.join(shadowProject, 'review/issue-audit-manuscript.md')));
});

test('BiodService.runIssueAudit is disabled unless framework and reviewer are enabled', async () => {
  const projectPath = tempProject();
  const input = {
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'v',
    documentPath: 'manuscript/manuscript.md',
    issuesPath: 'review/issues.csv',
    documentContent: DOCUMENT,
    issuesContent: sampleIssues(),
  };

  const disabledConfig = config();
  disabledConfig.framework!.reviewer!.enabled = false;
  const disabled = await new BiodService({ config: disabledConfig, environment: {} }).runIssueAudit(input);
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.reason, 'disabled');

  const offConfig = config();
  offConfig.framework!.reviewer!.decisionPoints['v1.issue-triage'] = { mode: 'off', budget: 'issue-audit' };
  const off = await new BiodService({ config: offConfig, environment: {} }).runIssueAudit(input);
  assert.equal(off.ok, false);
  if (!off.ok) assert.equal(off.reason, 'disabled');

  const enabled = await new BiodService({
    config: config(),
    issueAuditLedgerFile: path.join(projectPath, 'ledger.jsonl'),
    environment: {},
  }).runIssueAudit(input);
  assert.equal(enabled.ok, true);
  if (enabled.ok) {
    assert.equal(enabled.report.modelVersion, 'heuristic-v1-v1');
    assert.equal(enabled.report.summary.p0, 1);
  }
});

test('biod config rejects an unsupported reviewer mode and warns on unknown thresholds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-v1-config-'));
  try {
    fs.writeFileSync(path.join(directory, 'biod.json'), JSON.stringify({
      enabled: true,
      framework: {
        enabled: true,
        reviewer: {
          enabled: true,
          decisionPoints: {
            'v1.issue-triage': { mode: 'cascade', scorer: 'heuristic', budget: 'issue-audit' },
          },
          thresholds: { minConfidence: 0.5, nope: 1 },
        },
      },
    }));
    const parsed = loadBiodConfig(directory, {});
    assert.equal(parsed.framework?.reviewer?.decisionPoints['v1.issue-triage']?.mode, 'off');
    assert.equal(parsed.framework?.reviewer?.thresholds.minConfidence, 0.5);
    assert.ok(parsed.warnings.some((warning) => warning.includes('v1.issue-triage.mode')));
    assert.ok(parsed.warnings.some((warning) => warning.includes('thresholds.nope')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function issueFrom(overrides: Partial<IssuePremiseRow>) {
  const premise = row(overrides);
  return {
    issueId: premise.issueId,
    section: premise.section,
    issueText: premise.issueText,
    issueType: premise.issueType,
    severityClaim: premise.severityClaim,
    ...(premise.ownerSuggested ? { ownerSuggested: premise.ownerSuggested } : {}),
    premises: [premise],
    duplicates: [],
  };
}

function decidedOwner(owner: 'searcher' | 'researcher' | 'writer' | 'reviewer' | 'pi') {
  return {
    owner,
    confidence: 0.7,
    scores: { searcher: 0.1, researcher: 0.1, writer: 0.6, reviewer: 0.1, pi: 0.1 },
    alternatives: [],
    undecided: false,
    disagreesWithSuggestion: false,
    reasons: [],
    fallback: false,
  };
}

function topOwner(signal: OwnerSignal): string {
  let best = 'pi';
  for (const role of Object.keys(signal.scores) as Array<keyof typeof signal.scores>) {
    if (signal.scores[role] > signal.scores[best as keyof typeof signal.scores]) best = role;
  }
  return best;
}
