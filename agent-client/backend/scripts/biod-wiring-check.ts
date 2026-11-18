/**
 * biod2 sidecar 接线自检（Node 侧）。
 *
 * 用途：不经过大模型，直接按 bioflow agent 的真实调用路径打 9 个决策点各一次，
 * 确认 biod.json / .env / supervisor / Node 客户端契约与服务端一致。
 *
 *   cd agent-client/backend && ./node_modules/.bin/tsx scripts/biod-wiring-check.ts
 *
 * 退出码 0 表示全部端点可用；非 0 会打印失败项。副作用：向
 * workspace/.runtime/biod-decisions.jsonl 追加决策记录（与真实请求一致）。
 */
import { BiodService, loadBiodConfig } from '../src/agent/biod/index.js';
import { RoleHeadClient } from '../src/agent/biod/head_client.js';

type Row = { point: string; route: string; ok: boolean; detail: string };

const TOOL_IDS = ['bio-seq', 'bio-fetch', 'context7_query-docs', 'lit-review', 'bioinformatics/scanpy'];
const KB_IDS = [
  'Bioinformatics/anndata',
  'Bioinformatics/scanpy',
  'General Science/multiple-testing-and-false-discovery-rate',
];

const STATE = '用 scanpy 读入 h5ad，过滤低质量细胞并做标准化和降维，直接给出可执行命令。';

function brief(value: unknown, limit = 150): string {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function main(): Promise<number> {
  const config = loadBiodConfig();
  console.log('config:', brief({
    enabled: config.enabled,
    baseUrl: config.service.baseUrl,
    entry: config.runtime.entry,
    ckptDir: config.runtime.ckptDir,
    expectedVersion: config.model.expectedVersion,
    stateMaxChars: config.state.maxChars,
  }, 400));
  if (!config.enabled) {
    console.error('biod is disabled in config');
    return 1;
  }

  const service = new BiodService({ config });
  await service.start();
  const status = service.getStatus();
  console.log('status:', brief(status));
  if (!status.ready) {
    console.error('biod service is not ready');
    return 1;
  }

  const rows: Row[] = [];
  const add = (point: string, route: string, ok: boolean, detail: string) => {
    rows.push({ point, route, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${point.padEnd(24)} ${route.padEnd(28)} ${detail}`);
  };

  const toolCandidates = TOOL_IDS.map((id) => ({ id, name: id, description: id }));
  const kbCandidates = KB_IDS.map((id) => ({ id, name: id, description: id }));

  const tool = await service.decideTool({ state: STATE, candidates: toolCandidates, role: 'researcher' });
  add('tool_select', 'BiodService.decideTool', tool.ok,
    brief(tool.ok ? { chosen: tool.chosen, confidence: tool.confidence, modelVersion: tool.modelVersion } : tool));

  const kb = await service.decideKnowledge({ state: '单细胞差异表达用哪个包，多重检验怎么校正', candidates: kbCandidates, role: 'researcher' });
  add('kb_select', 'BiodService.decideKnowledge', kb.ok,
    brief(kb.ok ? { chosen: kb.chosen, confidence: kb.confidence, latencyMs: kb.latencyMs } : kb));

  const groups = await service.scoreGroups({
    state: '整理 qPCR 结果',
    groups: [
      { id: '1', name: 'run', description: '运行 qPCR 脚本，输出 12 个样本 Ct 表' },
      { id: '2', name: 'conclusion', description: '结论：18S 内参稳定，目标基因上调 2.3 倍' },
    ],
  });
  add('context_retention', 'BiodService.scoreGroups', groups.ok,
    brief(groups.ok ? groups.scores : groups));

  const baseUrl = config.service.baseUrl;
  const heads = new RoleHeadClient({ baseUrl, timeoutMs: config.service.requestTimeoutMs });

  const roleResp = await fetch(`${baseUrl}/v1/decide/role_select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: '这份稿子 Methods 太薄，帮我看看缺什么' }),
    signal: AbortSignal.timeout(config.service.requestTimeoutMs),
  }).then((r) => r.json());
  add('role_select', 'POST /v1/decide/role_select', Boolean(roleResp?.ok),
    brief({ role: roleResp?.role, confidence: roleResp?.confidence }));

  const relayResp = await fetch(`${baseUrl}/v1/decide/relay_select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'reviewer',
      to: 'writer',
      why: 'Methods lacks assay details.',
      body: 'Add storage duration, freeze-thaw count and tube type.',
    }),
    signal: AbortSignal.timeout(config.service.requestTimeoutMs),
  }).then((r) => r.json());
  add('relay_select', 'POST /v1/decide/relay_select', Boolean(relayResp?.ok),
    brief({ verdict: relayResp?.verdict, confidence: relayResp?.confidence }));

  const premise = await heads.scorePairs('premise_judge', [{
    id: 'wiring-pj',
    unit: 'claim',
    left: 'The knockout reduces tumour growth by 40%.',
    right: 'Xenograft volumes were measured weekly for four weeks.',
    context: 'results',
  }]);
  add('s2.premise', 'RoleHeadClient.scorePairs(premise)', premise.ok,
    brief(premise.ok ? premise.value.items?.[0] : premise));

  const r1 = await heads.decideTool(STATE, TOOL_IDS);
  add('r1.plan-audit', 'RoleHeadClient.decideTool', r1.ok,
    brief(r1.ok ? { chosen: r1.value.chosen, confidence: r1.value.confidence } : r1));

  const flag = await heads.scorePairs('overclaim_flag', [{
    id: 'wiring-w1',
    claim: 'This proves the drug is curative in all patients.',
    evidence: 'Response rate was 31% in a single-arm phase 2 study.',
    context: 'discussion',
  }]);
  add('w1.claim-evidence-audit', 'RoleHeadClient.scorePairs(overclaim)', flag.ok,
    brief(flag.ok ? flag.value.items?.[0] : flag));

  add('v1.issue-triage', 'role_select + scorePairs(premise)',
    Boolean(roleResp?.ok) && premise.ok, 'composite of the two calls above');

  const failed = rows.filter((r) => !r.ok);
  console.log(`\nwiring: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — ${rows.length} checks`);
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
