/**
 * Pure helpers behind the LLM and role settings pages.
 *
 * They live here rather than inside the components so the option-building rules — which
 * model a role may pick, which levels that model offers, what an import would add — can be
 * tested without a DOM.
 */

export const THINKING_FORMATS = [
  { id: 'openai-effort', label: 'reasoning_effort', hint: 'OpenAI 系 / sglang / DeepSeek：发送档位名' },
  { id: 'anthropic-budget', label: 'thinking.budget_tokens', hint: 'Claude 系：发送 token 预算（数字）' },
  { id: 'none', label: '不发送', hint: '完全不携带思考参数' },
];

/**
 * Wire protocols one provider can speak. The default is the historical OpenAI-compatible
 * transport; the other two are opt-in because they change the request shape and only work
 * against the vendor's own endpoint.
 */
export const LLM_PROTOCOLS = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions', hint: '默认；绝大多数 OpenAI 兼容端点与网关' },
  { id: 'anthropic-messages', label: 'Anthropic Messages', hint: 'Claude 原生：cache_control 断点与 thinking 预算真实生效' },
  { id: 'openai-responses', label: 'OpenAI Responses', hint: 'OpenAI 新协议；只有官方端点或支持的网关可用' },
];

export function protocolLabel(protocol) {
  return LLM_PROTOCOLS.find((option) => option.id === protocol)?.label || LLM_PROTOCOLS[0].label;
}

/** A ladder the user confirms; nothing is applied without that confirmation. */
export const BUDGET_LADDER = { low: 1024, medium: 4096, high: 16384, max: 32768 };

export function thinkingFormatLabel(format) {
  return THINKING_FORMATS.find((option) => option.id === format)?.label || format || 'openai-effort';
}

/** Levels a provider may declare for a model, in the order the backend reported them. */
export function levelNames(model) {
  return Array.isArray(model?.thinkingLevels) ? model.thinkingLevels : [];
}

export function modelsForProvider(llmModels, providerId) {
  const models = providerId ? llmModels?.[providerId] : null;
  return Array.isArray(models) ? models : [];
}

/**
 * Select options keep the current value even when it no longer exists, so a stale binding
 * is visible and replaceable instead of silently reading as an empty picker.
 */
export function withCurrentOption(options, currentId, missingLabel = '（已失效）') {
  const rows = Array.isArray(options) ? options : [];
  if (!currentId || rows.some((row) => row.value === currentId)) return rows;
  return [{ value: currentId, label: `${currentId} ${missingLabel}`, disabled: true }, ...rows];
}

export function providerOptions(llmProviders) {
  return (llmProviders || []).map((provider) => ({
    value: provider.id,
    label: `${provider.name || provider.id}`,
    detail: provider.model,
  }));
}

export function modelOptions(models) {
  return (models || []).map((model) => ({
    value: model.id,
    label: model.label || model.id,
    detail: describeModel(model),
  }));
}

export function levelOptions(levels) {
  return (levels || []).map((level) => ({ value: level, label: level }));
}

export function describeModel(model) {
  const parts = [];
  if (model?.contextWindowTokens) parts.push(`${formatTokens(model.contextWindowTokens)} 上下文`);
  const levels = levelNames(model);
  if (levels.length) parts.push(`${levels.length} 档思考`);
  if (model?.capabilities?.images) parts.push('图片');
  if (model?.capabilities?.tools) parts.push('工具');
  return parts.join(' · ');
}

/** An import adds rows; it never proposes changes to rows already configured. */
export function planImport(existingModels, incomingModels) {
  const existing = new Set((existingModels || []).map((model) => model.id));
  const toAdd = [];
  const skipped = [];
  for (const model of incomingModels || []) {
    if (!model?.id) continue;
    if (existing.has(model.id)) skipped.push(model.id);
    else toAdd.push(model);
  }
  return { toAdd, skipped };
}

/** The default model of a provider, as the backend would resolve it. */
export function defaultModelFor(provider, models) {
  const rows = models || [];
  const preferred = provider?.defaultModelId || provider?.model;
  if (preferred && rows.some((model) => model.id === preferred)) return preferred;
  return rows[0]?.id || '';
}

/** A role's model picker is scoped to the provider it is bound to. */
export function roleModelSelection(agent, llmProviders, llmModels) {
  const providerId = agent?.llmProviderId || '';
  const models = modelsForProvider(llmModels, providerId);
  const provider = (llmProviders || []).find((row) => row.id === providerId);
  const modelId = agent?.llmModelId || defaultModelFor(provider, models);
  const model = models.find((row) => row.id === modelId);
  const levels = levelNames(model);
  const level = agent?.llmThinkingLevel || (levels.length ? levels[0] : '');
  return { providerId, models, modelId, levels, level };
}

/** Level map for a provider that speaks token budgets, offered as an explicit action. */
export function budgetLadderFor(levels) {
  const rows = Array.isArray(levels) && levels.length ? levels : Object.keys(BUDGET_LADDER);
  const mapped = {};
  for (const level of rows) mapped[level] = BUDGET_LADDER[level] || 4096;
  return mapped;
}

export function requiresNumericLevels(format) {
  return format === 'anthropic-budget';
}

/** Names a level map's values, so the editor can show `levels → wire` at a glance. */
export function describeLevelMap(reasoningEfforts) {
  const entries = Object.entries(reasoningEfforts || {});
  if (!entries.length) return '未声明档位';
  return entries.map(([level, wire]) => (level === wire ? level : `${level}→${wire}`)).join(' · ');
}

/**
 * The level map is edited as `level=wire` lines because that is exactly what it is: a small
 * dictionary whose keys are for people and whose values go on the wire.
 */
export function parseLevelMapText(text, { numeric = false } = {}) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const separator = raw.indexOf('=');
    const level = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
    if (!level) continue;
    const wire = separator >= 0 ? raw.slice(separator + 1).trim() : level;
    if (numeric) {
      const number = Number(wire);
      if (Number.isFinite(number) && number > 0) map[level] = Math.floor(number);
      continue;
    }
    map[level] = wire || level;
  }
  return map;
}

export function serializeLevelMap(map) {
  return Object.entries(map || {})
    .map(([level, wire]) => (String(wire) === level ? level : `${level}=${wire}`))
    .join('\n');
}

/** A probed level list becomes an identity map (or a budget ladder) the user can edit. */
export function levelsToMap(levels, format) {
  const map = {};
  for (const level of levels || []) map[level] = format === 'anthropic-budget' ? (BUDGET_LADDER[level] || 4096) : level;
  return map;
}

function formatTokens(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '';
  if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`;
  if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
  return String(number);
}
