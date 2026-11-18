import type {
  EvidenceRow,
  HypothesisCard,
  PremiseVerdict,
  SearcherArtifacts,
} from './contracts.js';

export interface ArtifactIssue {
  path: string;
  message: string;
}

export interface SearcherArtifactParse {
  ok: boolean;
  artifacts: SearcherArtifacts;
  issues: ArtifactIssue[];
}

/**
 * Parse the Searcher's structured artifacts without throwing. Free-text `hypotheses.md`
 * is deliberately not accepted: the framework has no candidate set to score otherwise.
 */
export function parseSearcherArtifacts(input: unknown): SearcherArtifactParse {
  const issues: ArtifactIssue[] = [];
  const record = isRecord(input) ? input : {};
  if (!isRecord(input)) issues.push({ path: '$', message: 'artifacts must be an object' });

  const hypotheses: HypothesisCard[] = Array.isArray(record.hypotheses)
    ? record.hypotheses
      .map((value, index) => parseHypothesis(value, `hypotheses[${index}]`, issues))
      .filter((value): value is HypothesisCard => Boolean(value))
    : [];
  if (!hypotheses.length) issues.push({ path: 'hypotheses', message: 'at least one hypothesis card is required' });

  const evidence: EvidenceRow[] = Array.isArray(record.evidence)
    ? record.evidence
      .map((value, index) => parseEvidence(value, `evidence[${index}]`, issues))
      .filter((value): value is EvidenceRow => Boolean(value))
    : [];

  const knownGaps = new Set(stringArray(record.gaps));
  const knownEvidence = new Set(evidence.map((row) => row.id));
  for (const card of hypotheses) {
    for (const gapId of card.gapIds) {
      if (gapId !== 'GAP_NEW' && knownGaps.size && !knownGaps.has(gapId)) {
        issues.push({ path: `hypotheses.${card.id}.gapIds`, message: `unknown gap id "${gapId}"` });
      }
    }
    for (const link of card.evidenceLinks) {
      if (!knownEvidence.has(link.eid)) {
        issues.push({ path: `hypotheses.${card.id}.evidenceLinks`, message: `unknown evidence id "${link.eid}"` });
      }
    }
  }

  const premiseVerdicts: PremiseVerdict[] | undefined = Array.isArray(record.premiseVerdicts)
    ? record.premiseVerdicts
      .map((value, index) => parseVerdict(value, `premiseVerdicts[${index}]`, issues))
      .filter((value): value is PremiseVerdict => Boolean(value))
    : undefined;

  const rerankScores = isRecord(record.rerankScores)
    ? Object.fromEntries(
      Object.entries(record.rerankScores)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
        .map(([key, value]) => [key, Number(value)]),
    )
    : undefined;

  const artifacts: SearcherArtifacts = {
    rq: typeof record.rq === 'string' ? record.rq : undefined,
    reviewSummary: typeof record.reviewSummary === 'string' ? record.reviewSummary : undefined,
    gaps: Array.isArray(record.gaps) ? record.gaps.filter((value): value is string => typeof value === 'string') : undefined,
    hypotheses,
    evidence,
    premiseVerdicts,
    rerankScores,
  };
  return { ok: issues.length === 0, artifacts, issues };
}

function parseHypothesis(value: unknown, path: string, issues: ArtifactIssue[]): HypothesisCard | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: 'hypothesis card must be an object' });
    return undefined;
  }
  const id = stringValue(value.id);
  const claim = stringValue(value.claim);
  const gapIds = stringArray(value.gapIds);
  const predictions = Array.isArray(value.predictions)
    ? value.predictions.map((prediction) => parsePrediction(prediction)).filter((prediction): prediction is NonNullable<typeof prediction> => Boolean(prediction))
    : [];
  const evidenceLinks = Array.isArray(value.evidenceLinks)
    ? value.evidenceLinks.map((link) => parseEvidenceLink(link)).filter((link): link is NonNullable<typeof link> => Boolean(link))
    : [];
  if (!id) issues.push({ path: `${path}.id`, message: 'id is required' });
  if (!claim) issues.push({ path: `${path}.claim`, message: 'claim is required' });
  if (!gapIds.length) issues.push({ path: `${path}.gapIds`, message: 'at least one gap id is required' });
  if (!predictions.length) issues.push({ path: `${path}.predictions`, message: 'at least one prediction is required' });
  if (!evidenceLinks.length) issues.push({ path: `${path}.evidenceLinks`, message: 'at least one evidence link is required' });
  if (!stringArray(value.alternatives).length) issues.push({ path: `${path}.alternatives`, message: 'at least one alternative is required' });
  if (!id || !claim) return undefined;
  const premises = Array.isArray(value.premises)
    ? value.premises.map((premise) => parsePremise(premise)).filter((premise): premise is NonNullable<typeof premise> => Boolean(premise))
    : undefined;
  return {
    id,
    rqId: stringValue(value.rqId),
    gapIds,
    claim,
    mechanism: stringValue(value.mechanism),
    premises,
    predictions,
    evidenceLinks,
    alternatives: stringArray(value.alternatives),
    dataNeeded: stringValue(value.dataNeeded),
    feasibility: isRecord(value.feasibility) ? value.feasibility as HypothesisCard['feasibility'] : undefined,
    noveltyArgument: stringValue(value.noveltyArgument),
    expectedImpact: stringValue(value.expectedImpact),
    noveltyProxy: isRecord(value.noveltyProxy) ? value.noveltyProxy as HypothesisCard['noveltyProxy'] : undefined,
    risks: stringArray(value.risks),
  };
}

function parsePremise(value: unknown): NonNullable<HypothesisCard['premises']>[number] | undefined {
  if (!isRecord(value)) return undefined;
  const pid = stringValue(value.pid);
  const text = stringValue(value.text);
  if (!pid || !text) return undefined;
  const type = value.type;
  return {
    pid,
    text,
    type: type === 'empirical' || type === 'mechanistic' || type === 'feasibility' || type === 'inferential' ? type : undefined,
  };
}

function parsePrediction(value: unknown): HypothesisCard['predictions'][number] | undefined {
  if (!isRecord(value)) return undefined;
  const text = stringValue(value.text);
  if (!text) return undefined;
  return {
    text,
    readout: stringValue(value.readout),
    direction: stringValue(value.direction),
    falsifier: stringValue(value.falsifier),
  };
}

function parseEvidenceLink(value: unknown): HypothesisCard['evidenceLinks'][number] | undefined {
  if (!isRecord(value)) return undefined;
  const eid = stringValue(value.eid);
  const relation = value.relation;
  if (!eid || (relation !== 'supports' && relation !== 'conflicts' && relation !== 'neutral')) return undefined;
  return { eid, relation };
}

function parseEvidence(value: unknown, path: string, issues: ArtifactIssue[]): EvidenceRow | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: 'evidence row must be an object' });
    return undefined;
  }
  const id = stringValue(value.id);
  const locator = stringValue(value.locator);
  if (!id) issues.push({ path: `${path}.id`, message: 'id is required' });
  if (!locator) issues.push({ path: `${path}.locator`, message: 'locator is required' });
  if (!id || !locator) return undefined;
  return {
    id,
    claimId: stringValue(value.claimId),
    sourceType: stringValue(value.sourceType),
    locator,
    snippet: stringValue(value.snippet),
    studyDesign: stringValue(value.studyDesign),
    effect: stringValue(value.effect),
    limitations: stringValue(value.limitations),
    retractionStatus: stringValue(value.retractionStatus),
    context: isRecord(value.context) ? value.context as EvidenceRow['context'] : undefined,
  };
}

function parseVerdict(value: unknown, path: string, issues: ArtifactIssue[]): PremiseVerdict | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: 'verdict must be an object' });
    return undefined;
  }
  const hypId = stringValue(value.hypId);
  const pid = stringValue(value.pid);
  const verdict = value.verdict;
  const evidenceId = stringValue(value.evidenceId) ?? '';
  if (!hypId || !pid) {
    issues.push({ path, message: 'hypId and pid are required' });
    return undefined;
  }
  if (verdict !== 'supported' && verdict !== 'contradicted' && verdict !== 'unknown') {
    issues.push({ path: `${path}.verdict`, message: 'verdict must be supported/contradicted/unknown' });
    return undefined;
  }
  return {
    hypId,
    pid,
    verdict,
    confidence: typeof value.confidence === 'number' ? value.confidence : 0,
    evidenceId,
    reasonCode: stringValue(value.reasonCode),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
