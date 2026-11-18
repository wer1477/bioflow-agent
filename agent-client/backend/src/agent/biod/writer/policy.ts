import type {
  AuditFinding,
  ClaimAudit,
  EvidenceAudit,
  ManuscriptAuditThresholds,
  ParsedClaim,
  Priority,
} from './contracts.js';

export interface ClaimPolicyInput {
  claim: ParsedClaim;
  edges: EvidenceAudit[];
  thresholds: ManuscriptAuditThresholds;
}

/**
 * Aggregate edge-level signals into one claim-level finding.
 *
 * The audit is a risk screen. "no_issue_found" means the rules found no obvious problem;
 * it is never a certification that the claim is true.
 */
export function decideClaim(input: ClaimPolicyInput): ClaimAudit {
  const { claim, edges, thresholds } = input;
  const flags = new Set<string>();
  if (claim.stale) flags.add('stale_claim');
  if (claim.sectionMismatch) flags.add('section_mismatch');

  if (claim.stale) {
    return buildClaimAudit(claim, edges, {
      finding: 'stale_claim',
      priority: 'P1',
      confidence: 1,
      reasons: ['claim_text is not present in the manuscript; update the matrix'],
      actions: ['update_matrix'],
      flags: [...flags],
    });
  }

  const realEdges = edges.filter((edge) => edge.evidenceType !== 'none');
  const noneRows = claim.rows.filter((row) => row.evidenceType === 'none');
  if (!realEdges.length || noneRows.length === claim.rows.length) {
    const needsData = claim.writerStatus === 'needs-data' || noneRows.some((row) => row.writerStatus === 'needs-data');
    return buildClaimAudit(claim, edges, {
      finding: needsData ? 'needs_data' : 'missing_evidence',
      priority: priorityFor(claim, needsData ? 'needs_data' : 'missing_evidence'),
      confidence: 0.95,
      reasons: [needsData ? 'no evidence; writer marked needs-data' : 'no evidence is attached to this claim'],
      actions: needsData ? ['add_data'] : ['add_citation'],
      flags: [...flags, 'no_evidence'],
    });
  }

  const mismatch = realEdges.find(
    (edge) =>
      (edge.relation === 'contradicts' || edge.relation === 'unrelated')
      && edge.confidence >= thresholds.tauMismatch,
  );
  const blocking = realEdges.find((edge) => edge.precheck.blocking);
  const overclaim = realEdges.find(
    (edge) => edge.overclaim.length > 0 && edge.confidence >= thresholds.overclaimConfidence,
  );
  const allSupported = realEdges.every(
    (edge) =>
      edge.relation === 'supports'
      && !edge.precheck.blocking
      && edge.overclaim.length === 0
      && edge.confidence >= thresholds.minConfidence,
  );
  const allUnverifiable = realEdges.every((edge) => edge.relation === 'unverifiable');

  let finding: AuditFinding;
  if (mismatch) finding = 'support_mismatch';
  else if (blocking || allUnverifiable) finding = 'unverifiable';
  else if (allSupported) finding = 'no_issue_found';
  else if (overclaim) finding = 'overclaim';
  else finding = 'check_support';

  if (mismatch) flags.add('evidence_mismatch');
  if (blocking) flags.add('precheck_blocked');
  if (overclaim) flags.add('overclaim');
  for (const edge of realEdges) {
    for (const item of edge.precheck.issues) {
      if (item.severity === 'P0' || item.severity === 'P1') flags.add(item.code);
    }
  }

  const writerStatusConflict =
    (claim.writerStatus === 'supported' && finding !== 'no_issue_found')
    || (claim.writerStatus === 'unsupported' && finding === 'no_issue_found');
  if (writerStatusConflict) flags.add('status_conflict');

  const confidence = Math.max(...realEdges.map((edge) => edge.confidence), 0);
  const reasons = [
    ...(mismatch ? ['an evidence edge contradicts or is unrelated to the claim'] : []),
    ...(blocking ? [`precheck blocked: ${blocking.precheck.issues.map((item) => item.code).join(', ')}`] : []),
    ...(overclaim ? [`overclaim flags: ${overclaim.overclaim.join(', ')}`] : []),
    ...(allSupported ? ['all evidence edges look supportive under the current rules'] : []),
    ...(!mismatch && !blocking && !overclaim && !allSupported ? ['support relation is partial or uncertain'] : []),
    ...(writerStatusConflict ? [`writer_status=${claim.writerStatus} conflicts with audit finding=${finding}`] : []),
  ];

  return buildClaimAudit(claim, edges, {
    finding,
    priority: priorityFor(claim, finding, realEdges),
    confidence: Number(confidence.toFixed(3)),
    reasons,
    actions: actionsFor(finding),
    flags: [...flags],
  });
}

function buildClaimAudit(
  claim: ParsedClaim,
  edges: EvidenceAudit[],
  values: {
    finding: AuditFinding;
    priority: Priority;
    confidence: number;
    reasons: string[];
    actions: string[];
    flags: string[];
  },
): ClaimAudit {
  return {
    claimId: claim.claimId,
    section: claim.section,
    claimText: claim.claimText,
    claimType: claim.claimType,
    writerStatus: claim.writerStatus,
    finding: values.finding,
    priority: values.priority,
    confidence: values.confidence,
    edges,
    reasons: values.reasons,
    actions: values.actions,
    flags: [...new Set(values.flags)],
    fallback: edges.some((edge) => edge.fallback),
  };
}

function priorityFor(claim: ParsedClaim, finding: AuditFinding, edges: EvidenceAudit[] = []): Priority {
  if (finding === 'no_issue_found') return 'none';
  const highStakesSection = claim.section === 'title' || claim.section === 'abstract' || claim.section === 'conclusion';
  const severe = finding === 'support_mismatch'
    || finding === 'missing_evidence'
    || finding === 'needs_data'
    || finding === 'overclaim'
    || finding === 'unverifiable';
  if (highStakesSection && severe) return 'P0';
  if (claim.writerStatus === 'supported' && (finding === 'support_mismatch' || finding === 'missing_evidence' || finding === 'unverifiable')) {
    return 'P0';
  }
  if (edges.some((edge) => edge.precheck.issues.some((item) => item.severity === 'P0'))) return 'P0';
  if (finding === 'stale_claim') return 'P1';
  if (finding === 'check_support' || finding === 'overclaim' || finding === 'unverifiable') return 'P1';
  if (finding === 'missing_evidence' || finding === 'needs_data') return 'P1';
  return 'P2';
}

function actionsFor(finding: AuditFinding): string[] {
  switch (finding) {
    case 'support_mismatch':
      return ['read_source', 'replace_citation', 'soften_claim'];
    case 'overclaim':
      return ['soften_claim', 'narrow_scope'];
    case 'missing_evidence':
      return ['add_citation'];
    case 'needs_data':
      return ['add_data'];
    case 'unverifiable':
      return ['fix_locator', 'read_source'];
    case 'check_support':
      return ['read_source'];
    case 'stale_claim':
      return ['update_matrix'];
    case 'no_issue_found':
    default:
      return ['no_action'];
  }
}
