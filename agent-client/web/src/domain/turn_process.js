// 整轮折叠的纯逻辑：把一条 assistant 消息的 parts 分成「过程」与「结果」，
// 以及折叠行的文案、步数、开合判定。
// 无 React 依赖，保持可单测（与 domain/ 下其余模块同样的约定）。

/** 过程里「要人操作」的行。整轮收起时它们不参与折叠，永远留在可见区。 */
const PINNED_PART_TYPES = new Set(['planning', 'security_approval']);

/** 折叠时机的两个取值；缺省与非法值都按「回答结束后」处理。 */
export const COLLAPSE_TIMINGS = ['nextInput', 'completion'];

/**
 * 默认时机：任务一结束就收起，只留结果与用时。
 *
 * 这就是需求的原话——"完成任务后将过程折叠，只展示结果"。曾经想过默认「下次有新消息时」
 * （别在用户正读答案时把内容塌掉），但那样一轮多步任务跑完之后过程一直摊着，用户读到的是
 * "折叠没生效"。想反过来的人可以在通用设置里改成那一档。
 */
export const DEFAULT_COLLAPSE_TIMING = 'completion';

function isPinnedPart(part) {
  return PINNED_PART_TYPES.has(part?.type);
}

/**
 * 一段叙述是否被消息正文承认。
 *
 * 叙述 part 有两类来源：从 `model_response` 投影出来的（正文里必然有），以及后端直接
 * emit 的 `info` 事件（正文里没有）。运行时 banner 属于后者，但它已经在投影层被
 * `isBackendStatusEvent` 摘掉（见 domain/trace.js）。
 *
 * 判据仍然保留：历史数据里可能还有别的 `info` 事件（旧版本写入的、或后端将来新增的），
 * 拿"正文里找得到"这一条兜住它们——与 `findUnrenderedNarration` 是同一套语义，不要各写
 * 一份。
 */
export function isAccountedNarration(content, part) {
  if (part?.type !== 'text') return false;
  const body = String(content || '');
  const text = String(part.content || '').trim();
  if (!body || !text) return false;
  return body.includes(text);
}

/**
 * 把 parts 分成过程区与结果区。
 *
 * 边界 = **末尾那一段被正文承认的叙述**：从后往前收，直到遇到第一个不是结果的东西
 * （工具行 / 思维链 / 计划面板 / 安全审批）就停。结果区 = 那一段，过程区 = 其余全部。
 *
 * 这条判据不是"最后一个 `trace` 行"：run 的典型尾部是
 * `tool_call_result → thinking → 最终答案`，那时思维链排在最后一个工具行之后。
 * 按 trace 划界会把它划进结果区，收起一轮之后答案上方就露出一行可点开的「思考」
 * ——过程漏进了结果，正好和"折起来只留结果"相反。
 *
 * 两条护栏：
 *   1. 末尾没有结果（最后一个是工具行或思维链）→ 不折叠，否则收起一个空壳。
 *   2. 过程区必须非空。判据刻意**不是**"过程里有工具行"：一次纯问答的过程是
 *      `[思维链]`，它照样该折起来——否则思维链与 System context 会永远摊在答案上方，
 *      恰恰是"过程简化"要消掉的东西。
 *
 * @returns {{ foldable: boolean, process: unknown[], pinned: unknown[], result: unknown[] }}
 *   `process` 是折叠区（含 pinned 行）；`pinned` 是其中必须永远可见的子集；`result` 是
 *   结果区——按上面的收法，它只可能含被正文承认的文字块。
 *   不可折时 `process` 为空、`result` 是全部 parts——调用方无需分支即可全量渲染。
 */
export function splitTurnProcess(parts = [], content = '') {
  const list = Array.isArray(parts) ? parts : [];
  const all = { foldable: false, process: [], pinned: [], result: list };

  let start = list.length;
  while (start > 0 && isAccountedNarration(content, list[start - 1])) start -= 1;
  // 末尾没有结果：这一轮没有可以留在折叠行之下的东西。
  if (start === list.length) return all;
  // 整条消息都是结果：没有过程可折，一个点开是空的折叠行比没有更糟。
  if (start === 0) return all;

  const process = list.slice(0, start);
  return { foldable: true, process, pinned: process.filter(isPinnedPart), result: list.slice(start) };
}

/** 一次 run 是否「成功结束」。折叠与步数文案共用这一条判据，不要各写一份。 */
export function isCompletedRun(run) {
  return run?.status === 'completed' && Boolean(run.completedAt);
}

/**
 * 应当保持展开的那一轮在 `messages` 里的下标；没有则 -1。
 *
 * 判据是「列表最后一条恰好是一个成功结束的回答」。用户一发出下一条消息（哪怕只是本地的
 * 乐观行）最后一条就不再是回答，"最新"这个身份随之让出——这就是「下次有新消息时」的
 * 字面语义。已经排队的消息算作用户已经发出，避免 run 被占用而回退时上一轮先收起再弹开。
 */
export function latestCompletedIndex(messages = [], { pendingInput = false } = {}) {
  if (pendingInput) return -1;
  const list = Array.isArray(messages) ? messages : [];
  const index = list.length - 1;
  const last = list[index];
  return last?.role === 'assistant' && isCompletedRun(last.toolCalls?.run) ? index : -1;
}

/** 把毫秒格式化成 `12s` / `1m 23s` / `1h 2m`；不足 1 秒按 1 秒算。 */
export function formatElapsed(ms) {
  const total = Math.max(1000, Math.round(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/**
 * run 的时长文案。时间戳缺失或非法时返回空串——历史会话里可能有没写这两个字段的
 * 消息，降级成只显示"已完成"即可，不能因此把折叠行整个弄没。
 */
export function formatRunDuration(startedAt, completedAt) {
  const start = Date.parse(startedAt || '');
  const end = Date.parse(completedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  return formatElapsed(end - start);
}

/**
 * 过程里的工具步数。
 *
 * 只数带稳定 `callId` 的 trace 行：plan / mcp_status / runtime / artifact 这些行没有
 * callId，它们不是"工具调用"，数进来会让步数虚高（见 domain/trace.js 的 toolCallId）。
 */
export function countSteps(parts = []) {
  let total = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type === 'trace' && part.item?.callId) total += 1;
  }
  return total;
}

/**
 * 折叠行主文案：`已完成 · 用时 1m 23s · 12 步`，缺时长或步数为零时省略对应段。
 *
 * 前置条件：只给**成功结束**的轮次用（"已完成"是写死的）。失败与中断的轮次不折叠，
 * 它们的措辞归 runStatusLabel 管。
 */
export function turnProcessLabel({ startedAt, completedAt, steps } = {}) {
  const rows = ['已完成'];
  const duration = formatRunDuration(startedAt, completedAt);
  if (duration) rows.push(`用时 ${duration}`);
  const count = Number(steps) || 0;
  if (count > 0) rows.push(`${count} 步`);
  return rows.join(' · ');
}

function shortReason(error) {
  const text = String(error || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * 非折叠行的运行状态文案。
 *
 * 用户主动中断的 run 在持久化里是 `status: 'error'` + `error: 'Run cancelled by user.'`
 * + `interruptedAt`；真正的失败也走 `status: 'error'`，但**不带** `interruptedAt`
 * （见 backend persist 的分支）。两者必须分开说，否则"我按了停止"会被读成出错、
 * 真正的出错会被读成"我自己停的"。
 */
export function runStatusLabel(run) {
  if (!run?.status) return '';
  if (run.status === 'completed') return '已完成';
  // 事件流里已经有 `cancelled` 这个状态；今天它不会落到消息记录上（会落成 error），
  // 但持久化一旦改成直接写 cancelled，这里不能把它当成"还在跑"。
  if (run.status === 'cancelled') return '已停止';
  if (run.status === 'error') {
    if (run.interruptedAt) return '已停止';
    const reason = shortReason(run.error);
    return reason ? `处理失败 · ${reason}` : '处理失败';
  }
  return '运行中';
}

/**
 * 解析一轮过程的开合状态。
 *
 * 展开优先级：不可折 → 手动记录 → 时机。
 * 时机只有两档：`completion` 一结束就收；`nextInput` 让最新一个成功轮次保持展开，
 * 直到下一条消息把"最新"这个身份让出去。
 */
export function resolveTurnProcessOpen({ foldable = false, completed = false, timing = DEFAULT_COLLAPSE_TIMING, isLatest = false, override } = {}) {
  if (!foldable || !completed) return true;
  if (override === true || override === false) return override;
  if (timing === 'completion') return false;
  return Boolean(isLatest);
}
