/**
 * 前缀缓存诊断：把一条会话的 transcript 摊平成「每步请求」的表，回答三个问题。
 *
 * 1. provider 到底报了多少步？（上报覆盖率——0% 命中与「没测」在旧口径下长得一样）
 * 2. 前缀在哪一步断的？（tools / system / head / full 四段哈希，分别对应四种失效原因）
 * 3. 断的那一步贵不贵？（prompt / cached / 首 token 延迟 / prefill ms per 1k tok）
 *
 * 只读：不写 transcript、不调模型。
 *
 * 用法：
 *   BIOFLOW_WORKSPACE_DIR=/path/to/bioflow-dev/agent-client/workspace \
 *     npx tsx scripts/cache_report.ts <conversationId> [--json]
 */
import { readTranscriptRecords } from '../src/agent/transcript_reader.js';

interface RequestRow {
  requestId: string;
  runId: string;
  at: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  ttftMs: number | null;
  prefillMsPerKTok: number | null;
  prefix: Record<string, string> | null;
  toolsCount: number | null;
}

interface SegmentChange {
  index: number;
  runId: string;
  segment: string;
  from: string;
  to: string;
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readUsage(event: Record<string, unknown>): { prompt: number | null; completion: number | null; cached: number | null } | null {
  const tokenUsage = event.tokenUsage as Record<string, unknown> | undefined;
  if (!tokenUsage) return null;
  const cached = tokenUsage.cachedPromptTokens;
  return {
    prompt: readNumber(tokenUsage.promptTokens),
    completion: readNumber(tokenUsage.completionTokens),
    cached: cached === null || cached === undefined ? null : readNumber(cached),
  };
}

function collectRows(records: readonly Record<string, any>[]): RequestRow[] {
  const rows = new Map<string, RequestRow>();
  let activeRequestId = '';

  for (const record of records) {
    const at = Date.parse(String(record.createdAt));
    if (record.type === 'model_request') {
      const requestId = String(record.requestId || record.eventId);
      activeRequestId = requestId;
      const data = (record.data || {}) as Record<string, any>;
      rows.set(requestId, {
        requestId,
        runId: String(record.runId || ''),
        at: Number.isFinite(at) ? at : 0,
        promptTokens: null,
        cachedTokens: null,
        completionTokens: null,
        ttftMs: null,
        prefillMsPerKTok: null,
        prefix: (data.prefixHash as Record<string, string>) || null,
        toolsCount: Array.isArray(data.tools) ? data.tools.length : data.tools === null ? 0 : null,
      });
      continue;
    }
    const row = rows.get(String(record.requestId || activeRequestId));
    if (!row) continue;
    const data = (record.data || {}) as Record<string, any>;
    if (record.type === 'model_chunk' && row.ttftMs === null) {
      const delta = data.chunk?.choices?.[0]?.delta;
      const hasOutput = Boolean(delta)
        && (typeof delta.content === 'string' && delta.content.length > 0
          || typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
          || Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
      if (hasOutput && Number.isFinite(at)) row.ttftMs = Math.max(0, at - row.at);
    } else if (record.type === 'engine_event') {
      const event = data.event as Record<string, any> | undefined;
      if (event?.type === 'loop_health' && event.reason === 'token_usage_observed') {
        const usage = readUsage(event);
        if (usage) {
          row.promptTokens = usage.prompt;
          row.completionTokens = usage.completion;
          row.cachedTokens = usage.cached;
        }
      }
    }
  }

  for (const row of rows.values()) {
    if (row.ttftMs !== null && row.promptTokens) {
      row.prefillMsPerKTok = row.ttftMs / (row.promptTokens / 1000);
    }
  }
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

/** Find the first request whose prefix segment differs from the previous request's. */
function findSegmentChanges(rows: readonly RequestRow[]): SegmentChange[] {
  const changes: SegmentChange[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1].prefix;
    const current = rows[index].prefix;
    if (!previous || !current) continue;
    for (const segment of ['tools', 'system', 'head', 'full']) {
      if (previous[segment] !== current[segment]) {
        changes.push({
          index,
          runId: rows[index].runId,
          segment,
          from: previous[segment] || '-',
          to: current[segment] || '-',
        });
      }
    }
  }
  return changes;
}

function formatRow(index: number, row: RequestRow): string {
  const share = row.promptTokens && row.cachedTokens !== null
    ? `${Math.round((row.cachedTokens / row.promptTokens) * 1000) / 10}%`
    : '--';
  const prefill = row.prefillMsPerKTok === null ? '--' : row.prefillMsPerKTok.toFixed(2);
  return [
    String(index).padStart(3),
    row.runId.slice(0, 8).padEnd(8),
    String(row.toolsCount ?? '-').padStart(5),
    String(row.promptTokens ?? '-').padStart(8),
    String(row.cachedTokens ?? '--').padStart(8),
    share.padStart(6),
    (row.ttftMs === null ? '--' : String(row.ttftMs)).padStart(6),
    prefill.padStart(8),
  ].join(' ');
}

function main(): void {
  const conversationId = process.argv[2] || '';
  if (!conversationId) {
    console.error('usage: npx tsx scripts/cache_report.ts <conversationId> [--json]');
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const { records, tornTail } = readTranscriptRecords(conversationId);
  const rows = collectRows(records);
  const reported = rows.filter((row) => row.cachedTokens !== null).length;
  const shared = rows.filter((row) => row.promptTokens && row.cachedTokens !== null);
  const hits = shared.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0);
  const prompts = shared.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0);
  const changes = findSegmentChanges(rows);

  if (asJson) {
    console.log(JSON.stringify({
      conversationId,
      tornTail,
      requests: rows.length,
      cacheReportedSteps: reported,
      cacheHitPercent: prompts > 0 ? Math.round((hits / prompts) * 1000) / 10 : null,
      segmentChanges: changes,
      rows,
    }, null, 2));
    return;
  }

  console.log(`conversation ${conversationId}`);
  console.log(`requests ${rows.length}   cache reported ${reported}/${rows.length}`
    + (rows.length ? ` (${Math.round((reported / rows.length) * 1000) / 10}%)` : ''));
  console.log(`over reported requests: cache hit ${prompts > 0 ? Math.round((hits / prompts) * 1000) / 10 : '--'}%`
    + ` of ${prompts} prompt tokens`);
  if (tornTail) console.log('WARNING: transcript tail is torn; the newest records may be incomplete');
  console.log('');
  console.log('  #  run      tools   prompt   cached  share   ttft  prefill');
  rows.forEach((row, index) => console.log(formatRow(index + 1, row)));

  console.log('');
  if (!changes.length) {
    console.log('prefix: no segment change across the whole conversation.');
  } else {
    console.log('prefix changes (first divergent request in each case):');
    for (const change of changes) {
      console.log(`  #${change.index + 1} run ${change.runId.slice(0, 8)}  ${change.segment}: ${change.from} -> ${change.to}`);
    }
    const bySegment = new Map<string, number>();
    for (const change of changes) bySegment.set(change.segment, (bySegment.get(change.segment) ?? 0) + 1);
    console.log(`  totals: ${[...bySegment].map(([segment, count]) => `${segment}=${count}`).join(' ')}`);
  }

  console.log('');
  const unreported = rows.length - reported;
  if (unreported > 0) {
    console.log(`note: ${unreported} request(s) carried no cache counter.`);
    console.log('      If the provider is declared cacheReport "hits-only", a missing counter is a miss;');
    console.log('      if it is "none", those requests are simply unknown and the percentage above covers');
    console.log('      only the reported subset — never compare it against the full prompt total.');
  }
}

main();
