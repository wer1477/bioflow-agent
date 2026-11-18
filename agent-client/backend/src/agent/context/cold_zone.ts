/**
 * Cold-zone triage: everything between the fixed head and the verbatim tail.
 *
 * The zone holds history the next assembly would otherwise drop, so every message in it
 * has to end somewhere explicit. There are four destinations, and the difference between
 * them is how much of the original survives:
 *
 * - `keep`      the whole group, structure intact (tool call + its results)
 * - `evidence`  only the lines that cannot be paraphrased: paths, commands, error strings
 * - `index`     one line plus a blob pointer; the text leaves the context entirely
 * - `summarise` handed to the summariser
 *
 * Rules decide the mechanical part (packing, metadata, evidence lines, fidelity, quotas).
 * A ranker decides the one thing rules cannot: whether a group still matters for the task
 * in progress. In this round the ranker is a deterministic prior so the pipeline can run
 * with no model; a learned scorer can replace `score` later without touching anything else.
 *
 * The module is pure: it takes an `estimateTokens` function and returns a plan. It never
 * reads or writes storage, which is what makes the routing testable without fixtures.
 */

export interface ColdZonePolicy {
  /** Verbatim tail kept at the end of a compacted request. */
  tailRatio: number;
  tailFloorTokens: number;
  tailCeilingTokens: number;
  tailMaxWindowRatio: number;
  /** Verbatim (or evidence) budget for groups rescued out of the cold zone. */
  evidenceQuotaRatio: number;
  evidenceQuotaMaxTokens: number;
  maxVerbatimGroups: number;
  /** User prompts are kept outside the cold-zone quota: they are instructions, not evidence. */
  userPromptQuotaRatio: number;
  userPromptQuotaMaxTokens: number;
  userPromptRecentCount: number;
  /** Below this score a group leaves the context entirely. */
  dropThreshold: number;
  summaryBudgetTokens: number;
  archiveIndexBudgetTokens: number;
  maxArchiveEntries: number;
}

export const DEFAULT_COLD_ZONE_POLICY: ColdZonePolicy = {
  tailRatio: 0.03,
  tailFloorTokens: 20_000,
  tailCeilingTokens: 40_000,
  /**
   * A quarter, not a half: the floor is 20k, and on a 32k-window that floor would otherwise
   * claim most of the budget before the fixed head is counted at all. At 128k and above the
   * floor is already below a quarter, so this cap only binds where the floor would be absurd.
   */
  tailMaxWindowRatio: 0.25,
  evidenceQuotaRatio: 0.02,
  evidenceQuotaMaxTokens: 4_000,
  maxVerbatimGroups: 12,
  userPromptQuotaRatio: 0.05,
  userPromptQuotaMaxTokens: 8_000,
  userPromptRecentCount: 10,
  dropThreshold: 0.25,
  summaryBudgetTokens: 3_000,
  archiveIndexBudgetTokens: 1_000,
  maxArchiveEntries: 80,
};

export type TokenEstimator = (value: unknown) => number;

export type ColdZoneKind = 'user' | 'assistant' | 'tool-orphan';

export type ColdZoneDisposition = 'keep' | 'evidence' | 'index' | 'summarise';

/** How a kept group is written back into the request. */
export type ColdZoneRender = 'full' | 'evidence' | 'first-line';

/**
 * One triage candidate.
 *
 * `messages` stays opaque so both callers can keep their own record type: the runtime
 * holds chat-completion messages, the run-end path holds stored conversation messages.
 */
export interface ColdZoneGroup<T = unknown> {
  seq: number;
  kind: ColdZoneKind;
  messages: T[];
  toolNames: string[];
  argsPreview: string;
  outcome: 'ok' | 'error' | 'unknown';
  producedFiles: string[];
  blobRefs: string[];
  text: string;
  /** Bounded, structure-preserving text handed to the summariser. */
  summaryText: string;
  sizeTokens: number;
  evidenceLines: string[];
  fidelity: number;
  score: number;
  disposition?: ColdZoneDisposition;
  render?: ColdZoneRender;
  costTokens?: number;
}

export interface ColdZonePlan<T = unknown> {
  kept: ColdZoneGroup<T>[];
  summarised: ColdZoneGroup<T>[];
  archived: ColdZoneGroup<T>[];
  archiveIndex: string[];
  stats: {
    groups: number;
    kept: number;
    summarised: number;
    archived: number;
    keptTokens: number;
    userPromptTokens: number;
  };
}

/** Tail size for a window: proportional, floored, and capped so a small window stays usable. */
export function resolveTailTokenLimit(contextWindowTokens: number, policy: ColdZonePolicy = DEFAULT_COLD_ZONE_POLICY): number {
  const proportional = Math.floor(contextWindowTokens * policy.tailRatio);
  const floored = Math.max(proportional, policy.tailFloorTokens);
  const capped = Math.min(floored, policy.tailCeilingTokens);
  return Math.max(1, Math.min(capped, Math.floor(contextWindowTokens * policy.tailMaxWindowRatio)));
}

/** Verbatim budget for rescued cold-zone groups. */
export function resolveColdZoneQuota(contextWindowTokens: number, policy: ColdZonePolicy = DEFAULT_COLD_ZONE_POLICY): number {
  return Math.max(0, Math.min(policy.evidenceQuotaMaxTokens, Math.floor(contextWindowTokens * policy.evidenceQuotaRatio)));
}

/** Verbatim budget for user prompts, counted separately from the cold-zone quota. */
export function resolveUserPromptQuota(contextWindowTokens: number, policy: ColdZonePolicy = DEFAULT_COLD_ZONE_POLICY): number {
  return Math.max(0, Math.min(policy.userPromptQuotaMaxTokens, Math.floor(contextWindowTokens * policy.userPromptQuotaRatio)));
}

/**
 * Split a message list into the verbatim tail and the cold zone before it.
 *
 * The walk-back never leaves a `tool` message stranded at the head of the tail: a result
 * without its call is a structurally invalid request, so the cut moves back over the run
 * of tool messages and takes their owner with it.
 */
export function splitColdZone<T extends { role: string }>(
  messages: readonly T[],
  tailTokens: number,
  estimateTokens: TokenEstimator,
  estimateMessage: (message: T) => number,
): { cold: T[]; tail: T[] } {
  let start = messages.length;
  let used = 0;
  while (start > 0) {
    const candidate = messages[start - 1];
    const size = estimateMessage(candidate);
    if (start < messages.length && used + size > tailTokens) break;
    start -= 1;
    used += size;
  }
  while (start > 0 && messages[start]?.role === 'tool') start -= 1;
  return { cold: messages.slice(0, start), tail: messages.slice(start) };
}

const MAX_EVIDENCE_LINES_PER_GROUP = 3;
const MAX_EVIDENCE_LINE_CHARS = 160;
const KEEP_WHOLE_TOKENS = 800;
const FIRST_LINE_CHARS = 120;

const ABSOLUTE_PATH = /(?:^|[\s"'(=])\/(?:[\w.@+-]+\/)+[\w.@+-]+/;
const DATA_FILE = /\.(?:bam|bai|sam|vcf|vcf\.gz|tbi|tsv|csv|h5ad|h5|fa|fasta|fq|fastq|fai|bed|gff3?|gtf|pdf|png|jpe?g|svg|json|jsonl|ya?ml|md|txt|py|r|R|sh|rds|rda|npy|xlsx)\b/i;
const SHELL_COMMAND = /(?:^|\s)(?:samtools|bcftools|bwa|bowtie2?|hisat2|star|salmon|kallisto|featureCounts|htseq-count|gatk|picard|bedtools|macs2|seurat|scanpy|Rscript|python3?|pip3?|conda|mamba|micromamba|git|npm|npx|node|make|cmake|docker|singularity|sbatch|srun|nextflow|snakemake|wget|curl|tar|gzip|unzip|mkdir|rm|cp|mv|cd|ls|cat|head|tail|grep|awk|sed|sort|uniq|wc|chmod)\b/i;
const SHELL_OPERATOR = /\s(?:&&|\|\||\|)\s/;
const REDIRECT = /\s>>?\s/;
const ERROR_SIGNAL = /\b(?:error|panic|traceback|exception|fatal|failed|failure|no such file|not found|permission denied|segmentation fault|killed|oom)\b|exit(?:ed)?\s+(?:code\s+)?[1-9]/i;
const NUMERIC_CONCLUSION = /\b(?:p|q|padj|fdr|log2fc|log2foldchange|fold change)\b\s*[=<>:]?\s*-?\d|=\s*-?\d+(?:\.\d+)?\s*%|-?\d+\.\d+\s*(?:%|fold)/i;

/** Text of a message whose content may be a string or a list of content parts. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Lines worth keeping word for word.
 *
 * The summariser paraphrases, and a paraphrase of a path or an error string is a wrong
 * path or a wrong error string. Those lines are lifted out before anything is summarised
 * so the detail survives in a form that is still exact.
 */
export function extractEvidenceLines(text: string, limit = MAX_EVIDENCE_LINES_PER_GROUP): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 600) continue;
    if (!isEvidenceLine(line)) continue;
    const clip = line.length > MAX_EVIDENCE_LINE_CHARS ? `${line.slice(0, MAX_EVIDENCE_LINE_CHARS)}…` : line;
    if (seen.has(clip)) continue;
    seen.add(clip);
    lines.push(clip);
    if (lines.length >= limit) break;
  }
  return lines;
}

function isEvidenceLine(line: string): boolean {
  return ABSOLUTE_PATH.test(line)
    || DATA_FILE.test(line)
    || SHELL_OPERATOR.test(line)
    || REDIRECT.test(line)
    || (SHELL_COMMAND.test(line) && /\s-{1,2}[\w-]/.test(line))
    || ERROR_SIGNAL.test(line)
    || NUMERIC_CONCLUSION.test(line);
}

/**
 * How much of this text cannot survive a paraphrase.
 *
 * A high score means "if it stays in the context, keep the exact bytes"; a low score means
 * prose that a summary represents faithfully. It is a rule, not a model: every signal here
 * is detectable by pattern, and the routing decision it feeds must be reproducible.
 */
export function fidelityScore(text: string): number {
  if (!text) return 0;
  let score = 0;
  if (ABSOLUTE_PATH.test(text)) score += 0.35;
  if (SHELL_COMMAND.test(text) || SHELL_OPERATOR.test(text)) score += 0.3;
  if (NUMERIC_CONCLUSION.test(text)) score += 0.2;
  if (ERROR_SIGNAL.test(text)) score += 0.25;
  if (text.length > 2_000) score += 0.1;
  return Math.min(1, Math.round(score * 100) / 100);
}

/** First sentence, for the condensed form of an old user prompt. */
export function firstSentence(text: string, limit = FIRST_LINE_CHARS): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (!normalised) return '';
  const match = /^[^。！？!?\n]{1,400}[。！？!?]?/.exec(normalised);
  const sentence = (match ? match[0] : normalised).trim();
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}

export interface BaselineScoreInput {
  kind: ColdZoneKind;
  outcome: 'ok' | 'error' | 'unknown';
  position: number;
  total: number;
}

/**
 * Deterministic prior used when no learned ranker is configured.
 *
 * Newer groups and groups carrying a decision or a failure outrank old successful
 * exploration. It exists so the pipeline never needs a model to produce a defensible
 * ordering; a fitted scorer is measured against this, not instead of it.
 */
export function baselineScore({ kind, outcome, position, total }: BaselineScoreInput): number {
  const recency = total <= 1 ? 1 : position / (total - 1);
  const base = kind === 'assistant' ? 0.9 : kind === 'user' ? 1 : 0.5;
  const weighted = outcome === 'error' ? Math.max(base, 0.7) : base;
  return Math.round((0.6 * recency + 0.4 * weighted) * 100) / 100;
}

export interface PlanColdZoneOptions<T = unknown> {
  policy?: ColdZonePolicy;
  contextWindowTokens: number;
  estimateTokens: TokenEstimator;
  /** Optional learned ranker; absent means `baselineScore`. */
  scorer?: (group: ColdZoneGroup<T>) => number;
  /**
   * What the plan is for.
   *
   * - `request` (default): the plan will be written back into a request, so `keep` and
   *   `evidence` are the destinations that preserve content verbatim.
   * - `checkpoint`: the plan will be persisted as a summary, and no request is being built.
   *   Nothing can be "kept for the next call", so those two channels would compute a
   *   destination nothing consumes — every group that survives the threshold goes to the
   *   summariser instead, which widens what the checkpoint actually covers.
   */
  mode?: 'request' | 'checkpoint';
}

/**
 * Decide where each group goes.
 *
 * Order matters:
 * 1. user prompts are kept outside the quota — an instruction is never paraphrased;
 * 2. the drop threshold removes low-value groups (they become index lines, not deletions);
 * 3. the remaining candidates fill the verbatim quota in score order, preferring evidence
 *    lines when a group is too large or too precise to keep whole;
 * 4. everything else is summarised.
 */
export function planColdZone<T>(groups: ColdZoneGroup<T>[], options: PlanColdZoneOptions<T>): ColdZonePlan<T> {
  const policy = options.policy || DEFAULT_COLD_ZONE_POLICY;
  const mode = options.mode || 'request';
  const total = groups.length;
  const quota = resolveColdZoneQuota(options.contextWindowTokens, policy);
  const userQuota = resolveUserPromptQuota(options.contextWindowTokens, policy);

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    group.score = options.scorer
      ? options.scorer(group)
      : baselineScore({ kind: group.kind, outcome: group.outcome, position: index, total });
  }

  const userGroups = groups.filter((group) => group.kind === 'user');
  const candidates = groups.filter((group) => group.kind !== 'user');

  // User prompts: newest N stay whole; older ones shrink to their first sentence once the
  // quota is exceeded. The order of the tiering is recency, not score — a new instruction
  // outweighs an old one regardless of what it says.
  let userTokens = 0;
  const userBudget = userQuota;
  const recentCutoff = Math.max(0, userGroups.length - policy.userPromptRecentCount);
  for (let index = 0; index < userGroups.length; index += 1) {
    const group = userGroups[index];
    const size = group.sizeTokens;
    if (userBudget > 0 && userTokens + size <= userBudget) {
      group.disposition = 'keep';
      group.render = 'full';
      group.costTokens = size;
      userTokens += size;
      continue;
    }
    if (index >= recentCutoff) {
      group.disposition = 'keep';
      group.render = 'full';
      group.costTokens = size;
      userTokens += size;
      continue;
    }
    group.disposition = 'keep';
    group.render = 'first-line';
    group.costTokens = options.estimateTokens(firstSentence(group.text));
    userTokens += group.costTokens || 0;
  }

  const ranked = [...candidates].sort((left, right) => right.score - left.score);
  const kept: ColdZoneGroup<T>[] = [];
  const archived: ColdZoneGroup<T>[] = [];
  const summarised: ColdZoneGroup<T>[] = [];
  let used = 0;

  for (const group of ranked) {
    if (group.score < policy.dropThreshold) {
      group.disposition = 'index';
      group.costTokens = 0;
      archived.push(group);
      continue;
    }
    if (mode === 'checkpoint') {
      // Nothing outlives the request here: the checkpoint is the only artefact, so a group
      // that would have been kept verbatim has nowhere to go but the summary.
      group.disposition = 'summarise';
      summarised.push(group);
      continue;
    }
    const evidenceTokens = evidenceCost(group, options.estimateTokens);
    const preferEvidence = group.fidelity >= 0.5 || group.sizeTokens > KEEP_WHOLE_TOKENS;
    const render: ColdZoneRender = preferEvidence && group.evidenceLines.length ? 'evidence' : 'full';
    const cost = render === 'evidence' ? evidenceTokens : group.sizeTokens;
    const fits = kept.length < policy.maxVerbatimGroups && used + cost <= quota;
    if (!fits) {
      group.disposition = 'summarise';
      summarised.push(group);
      continue;
    }
    group.disposition = render === 'evidence' ? 'evidence' : 'keep';
    group.render = render;
    group.costTokens = cost;
    used += cost;
    kept.push(group);
  }

  const archiveIndex = renderArchiveIndex(archived, options.estimateTokens, policy);

  return {
    kept: [...userGroups.filter((group) => group.disposition !== 'index'), ...kept].sort((left, right) => left.seq - right.seq),
    summarised: summarised.sort((left, right) => left.seq - right.seq),
    archived: archived.sort((left, right) => left.seq - right.seq),
    archiveIndex,
    stats: {
      groups: groups.length,
      kept: kept.length,
      summarised: summarised.length,
      archived: archived.length,
      keptTokens: used,
      userPromptTokens: userTokens,
    },
  };
}

function evidenceCost(group: ColdZoneGroup, estimateTokens: TokenEstimator): number {
  if (!group.evidenceLines.length) return group.sizeTokens;
  return estimateTokens(group.evidenceLines.join('\n'));
}

/**
 * One line per archived group, plus a pointer.
 *
 * The context no longer contains this content, so the model cannot know it happened
 * unless something says so. The index is that "something": small enough to be cheap,
 * specific enough that the archive can be reopened without a search.
 */
export function renderArchiveIndex(
  archived: ColdZoneGroup[],
  estimateTokens: TokenEstimator,
  policy: ColdZonePolicy = DEFAULT_COLD_ZONE_POLICY,
): string[] {
  const lines: string[] = [];
  let tokens = 0;
  for (const group of archived) {
    if (lines.length >= policy.maxArchiveEntries) break;
    const line = renderArchiveLine(group);
    const size = estimateTokens(line);
    if (lines.length && tokens + size > policy.archiveIndexBudgetTokens) break;
    lines.push(line);
    tokens += size;
  }
  const dropped = archived.length - lines.length;
  if (dropped > 0) lines.push(`(${dropped} more archived group(s) omitted.)`);
  return lines;
}

function renderArchiveLine(group: ColdZoneGroup): string {
  const tool = group.toolNames[0] || (group.kind === 'assistant' ? 'assistant' : 'tool');
  const args = group.argsPreview ? ` ${truncate(group.argsPreview, 60)}` : '';
  const outcome = group.outcome === 'error' ? 'failed' : group.outcome === 'ok' ? 'ok' : 'unknown';
  const files = group.producedFiles.length ? ` -> ${group.producedFiles.slice(0, 2).join(', ')}` : '';
  return `[#${group.seq}] ${tool}${args} (${outcome})${files}`;
}

function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
