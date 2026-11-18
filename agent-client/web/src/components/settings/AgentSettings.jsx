import { useEffect, useState } from 'react';
import { apiJson } from '../../api.js';
import { Field, OptionsSelect, PlainSelect, agentDraft } from './fields.jsx';
import {
  defaultModelFor,
  levelOptions,
  levelNames,
  modelOptions,
  modelsForProvider,
  providerOptions,
  withCurrentOption,
} from '../../domain/llm_options.js';
import { CoreToolChecklist, KnowledgeBaseChecklist, ToolLibraryChecklist } from './CapabilityChecklists.jsx';

/** Switching provider re-derives the model and level, so the three fields cannot drift apart. */
function selectProvider(draft, providerId, llmProviders, llmModels) {
  const models = modelsForProvider(llmModels, providerId);
  const provider = (llmProviders || []).find((row) => row.id === providerId);
  const modelId = defaultModelFor(provider, models);
  const levels = levelNames(models.find((model) => model.id === modelId));
  return { ...draft, llmProviderId: providerId, llmModelId: modelId, llmThinkingLevel: levels[0] || '' };
}

/** `/api/me/llm` 的模型条目是持久化形状，选择器需要 `thinkingLevels` 的名字列表。 */
function userModels(models) {
  return (models || []).map((model) => ({
    id: model.id,
    label: model.label || model.id,
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(model.reasoningEfforts && Object.keys(model.reasoningEfforts).length
      ? { thinkingLevels: Object.keys(model.reasoningEfforts) }
      : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  }));
}

/** 受限用户的草稿：LLM 三项取自己的角色覆盖，其余字段来自只读的 agents.json。 */
function restrictedDraft(agent, binding) {
  const base = agentDraft(agent);
  if (!binding) return base;
  return {
    ...base,
    llmProviderId: binding.providerId || '',
    llmModelId: binding.modelId || '',
    llmThinkingLevel: binding.thinkingLevel || '',
  };
}

export function AgentSettings({ settings, selectedAgentId, onSelectedAgentChange, applySettingsResponse, toast, userScope = false, userLlm = null }) {
  const agents = settings.agents || [];
  const leadRoleId = settings.team?.leadRoleId;
  const selected = agents.find((agent) => agent.id === selectedAgentId)
    || agents.find((agent) => agent.id === leadRoleId)
    || agents[0];

  // 普通用户只能改自己角色的 LLM 绑定；provider 集合 = 系统预置 + 自己的 provider。
  const scoped = userScope ? userLlm?.data : null;
  const scopedProviders = scoped ? [...(scoped.systemProviders || []), ...(scoped.providers || [])] : [];
  const llmProviders = userScope
    ? scopedProviders.map((provider) => ({
      ...provider,
      model: provider.defaultModelId || provider.models?.[0]?.id || '',
    }))
    : (settings.llmProviders || []);
  const llmModels = userScope
    ? Object.fromEntries(scopedProviders.map((provider) => [provider.id, userModels(provider.models)]))
    : (settings.llmModels || {});
  const binding = userScope && scoped
    ? (scoped.roleBindings || []).find((row) => row.roleId === selected?.id)
    : null;

  const [draft, setDraft] = useState(() => (userScope ? restrictedDraft(selected, binding) : agentDraft(selected)));
  const [saving, setSaving] = useState(false);

  // Key the reset on the record (and the user's binding), not the id: "重载配置" or a save
  // replaces the data, so the editor has to pick up the new bindings.
  useEffect(() => {
    setDraft(userScope ? restrictedDraft(selected, binding) : agentDraft(selected));
  }, [selected, userScope, scoped]);

  if (!selected) return <section className="panel">暂无 Agent</section>;

  // The three pickers are one binding: the model list belongs to the provider, and the level
  // list belongs to the model, so a stale pair is resolved the way the backend would.
  const providerModels = modelsForProvider(llmModels, draft.llmProviderId);
  const providerRecord = (llmProviders || []).find((provider) => provider.id === draft.llmProviderId);
  const modelValue = draft.llmModelId || defaultModelFor(providerRecord, providerModels);
  const providerLevels = levelNames(providerModels.find((model) => model.id === modelValue));
  const levelValue = draft.llmThinkingLevel || providerLevels[0] || '';
  const providerRows = withCurrentOption(providerOptions(llmProviders), draft.llmProviderId);
  const providerChoices = userScope
    ? [{ value: '', label: '跟随系统默认（不覆盖）' }, ...providerRows.filter((row) => row.value !== '')]
    : providerRows;

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (userScope) {
        const endpoint = `/api/me/llm/roles/${encodeURIComponent(selected.id)}`;
        const response = draft.llmProviderId
          ? await apiJson(endpoint, {
            method: 'PUT',
            body: JSON.stringify({
              providerId: draft.llmProviderId,
              ...(draft.llmModelId ? { modelId: draft.llmModelId } : {}),
              ...(draft.llmThinkingLevel ? { thinkingLevel: draft.llmThinkingLevel } : {}),
            }),
          })
          : await apiJson(endpoint, { method: 'DELETE' });
        userLlm?.apply?.(response);
        toast.success('LLM 绑定已保存。');
      } else {
        applySettingsResponse(await apiJson(`/api/config/manage/agents/${encodeURIComponent(selected.id)}`, {
          method: 'PUT',
          body: JSON.stringify(draft),
        }));
        toast.success('配置已保存并重载到运行时。');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请检查配置后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-layout agent-settings-layout configuration-canvas agent-configuration-canvas">
      <section className="panel agent-directory-panel">
        <div className="panel-heading agent-directory-heading">
          <div>
            <span className="section-kicker">AGENT DIRECTORY</span>
            <h3>Agents</h3>
          </div>
          <span className="count-badge">{agents.length}</span>
        </div>
        <div className="agent-menu">
          {agents.map((agent) => (
            <button key={agent.id} type="button" className={agent.id === selected.id ? 'active' : ''} onClick={() => onSelectedAgentChange(agent.id)}>
              <strong>{agent.label || agent.name}</strong>
              <span>{agent.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel agent-editor-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">PRIMARY RUNTIME</span>
            <h3>{selected.name}</h3>
          </div>
          <div className="button-row">
            <button className="primary-button" type="submit" form="agentForm" disabled={saving}>
              {saving ? '保存中…' : userScope ? '保存 LLM 绑定' : '保存配置'}
            </button>
          </div>
        </div>
        <form id="agentForm" className="stack" onSubmit={save}>
          <fieldset className="config-section">
            <legend><span className="config-section-index">01</span><span><strong>基本信息</strong><small>识别并描述当前 Agent 的职责。</small></span></legend>
            <div className="form-grid">
            <Field label="名称" value={draft.name} disabled={userScope} onChange={(value) => setDraft({ ...draft, name: value })} />
            <Field label="描述" value={draft.description} disabled={userScope} onChange={(value) => setDraft({ ...draft, description: value })} />
            </div>
          </fieldset>
          <fieldset className="config-section">
            <legend><span className="config-section-index">02</span><span><strong>运行策略</strong><small>定义模型、安全策略与执行权限。</small></span></legend>
            {userScope && <p className="field-hint">你只能调整供应商、模型与思考档位；其余配置由管理员维护。</p>}
            <div className="form-grid">
              <OptionsSelect
                label="供应商"
                value={draft.llmProviderId}
                options={providerChoices}
                onChange={(value) => setDraft(selectProvider(draft, value, llmProviders, llmModels))}
              />
              <OptionsSelect
                label="模型"
                value={modelValue}
                options={withCurrentOption(modelOptions(providerModels), modelValue)}
                onChange={(value) => setDraft({ ...draft, llmModelId: value })}
                disabled={!draft.llmProviderId}
                hint={draft.llmProviderId && !providerModels.length ? '该供应商还没有模型，去 LLM 配置里添加。' : ''}
              />
              <OptionsSelect
                label="思考档位"
                value={levelValue}
                options={withCurrentOption(levelOptions(providerLevels), levelValue)}
                onChange={(value) => setDraft({ ...draft, llmThinkingLevel: value })}
                disabled={!providerLevels.length}
                hint={providerLevels.length ? '档位名会被翻译成该供应商接受的发送值。' : '该模型没有声明思考档位，不会发送思考参数。'}
              />
              <PlainSelect
                label="安全模式"
                value={draft.securityMode}
                rows={['approval', 'auto', 'unrestricted']}
                disabled={userScope}
                onChange={(value) => setDraft({ ...draft, securityMode: value })}
              />
            </div>
          </fieldset>
          <fieldset className="config-section">
            <legend><span className="config-section-index">03</span><span><strong>指令与能力{userScope ? '（只读）' : ''}</strong><small>提供系统指令，并按域选择 CoreTool、能力与知识条目。</small></span></legend>
            <div className="form-grid">
            {!userScope && (
              <label className="field wide">
                <span>系统指令</span>
                <textarea className="code-box" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
              </label>
            )}
            <CoreToolChecklist
              tools={settings.coreTools || []}
              selected={draft.coreToolIds}
              disabled={userScope}
              onChange={(values) => setDraft({ ...draft, coreToolIds: values })}
            />
            <ToolLibraryChecklist
              domains={settings.toolLibrary?.domains || []}
              warnings={settings.toolLibrary?.warnings || []}
              skillIds={draft.skillIds}
              mcpServerIds={draft.mcpServerIds}
              disabled={userScope}
              onSkillsChange={(values) => setDraft({ ...draft, skillIds: values })}
              onServersChange={(values) => setDraft({ ...draft, mcpServerIds: values })}
            />
            <KnowledgeBaseChecklist
              domains={settings.knowledgeBase?.domains || []}
              warnings={settings.knowledgeBase?.warnings || []}
              selected={draft.knowledgeEntryIds}
              disabled={userScope}
              onChange={(values) => setDraft({ ...draft, knowledgeEntryIds: values })}
            />
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
