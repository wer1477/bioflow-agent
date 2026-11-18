import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../api.js';
import {
  LLM_PROTOCOLS,
  THINKING_FORMATS,
  budgetLadderFor,
  describeLevelMap,
  describeModel,
  defaultModelFor,
  levelsToMap,
  modelsForProvider,
  parseLevelMapText,
  planImport,
  serializeLevelMap,
  thinkingFormatLabel,
} from '../../domain/llm_options.js';
import { selectPresetDraft } from '../../domain/llm_preset_draft.js';
import { CloseIcon } from '../common/icons.jsx';
import { Field } from './fields.jsx';

/**
 * Provider editor.
 *
 * Two rules shape this screen: a provider owns the credential, and a model is a row inside
 * it. Nothing here picks a model for a role — that is the role page — and nothing here
 * guesses a model's limits: a value is reported by the catalog, reported by the endpoint,
 * or typed by the operator.
 */
export function LlmSettings({ settings, applySettingsResponse, toast, userScope = false, userLlm = null, onUserLlmChange }) {
  // 普通用户走 /api/me/llm：系统预置（只读）+ 自己的 provider；管理员/开发实例仍用全局配置。
  const scoped = userScope ? userLlm?.data : null;
  const scopedProviders = scoped ? [...(scoped.systemProviders || []), ...(scoped.providers || [])] : [];
  const providers = userScope
    ? scopedProviders.map((provider) => ({
      ...provider,
      model: provider.defaultModelId || provider.models?.[0]?.id || '',
      isDefault: provider.id === 'dgx',
    }))
    : (settings.llmProviders || []);
  const llmModels = userScope
    ? Object.fromEntries(scopedProviders.map((provider) => [provider.id, provider.models || []]))
    : (settings.llmModels || {});
  const readOnlyProviders = new Set(userScope ? (scoped?.systemProviders || []).map((provider) => provider.id) : []);

  const applyResponse = (response) => {
    if (userScope) onUserLlmChange?.(response?.settings);
    else applySettingsResponse(response);
  };

  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState('');
  const [presets, setPresets] = useState(null);
  const [presetQuery, setPresetQuery] = useState('');

  const openEditor = (provider) => {
    setPresetQuery('');
    setEditor(provider
      ? { mode: 'edit', draft: draftFromProvider(provider, llmModels[provider.id] || []), drafts: {} }
      : { mode: 'create', draft: emptyDraft(), drafts: {} });
  };

  const closeEditor = () => setEditor(null);

  useEffect(() => {
    if (!editor) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setEditor(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor]);

  useEffect(() => {
    if (editor?.mode !== 'create' || presets) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const body = await apiJson('/api/config/manage/llm/catalog');
        if (!cancelled) setPresets(body.providers || []);
      } catch {
        if (!cancelled) setPresets([]);
      }
    })();
    return () => { cancelled = true; };
  }, [editor, presets]);

  const filteredPresets = useMemo(() => {
    const needle = presetQuery.trim().toLowerCase();
    const rows = presets || [];
    return needle ? rows.filter((row) => `${row.id} ${row.name} ${row.api || ''}`.toLowerCase().includes(needle)) : rows;
  }, [presets, presetQuery]);

  // The whole block scrolls as one list, so there is no slice: the dialog can show every
  // catalog provider, and the count next to the search box always reads "all / all".
  const featuredPresets = useMemo(() => filteredPresets.filter((preset) => preset.featured), [filteredPresets]);
  const morePresets = useMemo(() => filteredPresets.filter((preset) => !preset.featured), [filteredPresets]);

  const patchDraft = (patch) => setEditor((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const applyPreset = async (preset) => {
    // A preset is a provider identity, not just an endpoint: switching replaces name, URL, key and
    // model rows — keeping the previous ones is how a DeepSeek URL ended up labelled "智谱 GLM".
    // The draft left behind is remembered, so switching back restores it.
    const selection = selectPresetDraft(editor, preset);
    if (!selection.draft) return;
    setEditor((current) => (current ? { ...current, draft: selection.draft, drafts: selection.drafts } : current));
    if (!selection.loadModels) return;
    setBusy('catalog');
    try {
      const body = await apiJson(`/api/config/manage/llm/catalog/${encodeURIComponent(preset.id)}`);
      const rows = catalogRowsToDraft(body.provider?.models || [], selection.draft.thinkingFormat);
      // Replace, don't merge: the previous provider's models are not a subset of this one.
      // Ignore a late response if the user already picked another preset.
      setEditor((current) => (current && current.draft.presetId === preset.id ? {
        ...current,
        draft: {
          ...current.draft,
          models: rows,
          defaultModelId: rows[0]?.id || '',
        },
      } : current));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取目录失败。');
    } finally {
      setBusy('');
    }
  };

  const updateModel = (modelId, patch) => {
    setEditor((current) => (current ? {
      ...current,
      draft: {
        ...current.draft,
        models: current.draft.models.map((model) => (model.id === modelId ? { ...model, ...patch } : model)),
      },
    } : current));
  };

  const probeEndpoint = async (withLevelsFor) => {
    const draft = editor.draft;
    setBusy(withLevelsFor ? `levels:${withLevelsFor}` : 'probe');
    try {
      const request = {
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        protocol: draft.protocol || 'openai-completions',
        ...(withLevelsFor ? { model: withLevelsFor, probeThinkingLevels: true } : {}),
      };
      const body = userScope
        ? await apiJson(
          editor.mode === 'edit' && !draft.apiKey.trim()
            ? `/api/me/llm/providers/${encodeURIComponent(draft.id)}/probe`
            : '/api/me/llm/probe',
          { method: 'POST', body: JSON.stringify(request) },
        )
        : await apiJson('/api/config/manage/llm/probe', {
          method: 'POST',
          body: JSON.stringify(request),
        });
      if (withLevelsFor) {
        // The endpoint names its own levels in the refusal; when it does not, nothing is filled.
        if (body.thinkingLevelsSource === 'endpoint-error' && body.thinkingLevels?.length) {
          updateModel(withLevelsFor, { levelsText: serializeLevelMap(levelsToMap(body.thinkingLevels, draft.thinkingFormat)) });
          toast.success(`端点声明了 ${body.thinkingLevels.length} 个档位。`);
        } else {
          toast.info('端点没有声明可用档位，请手工填写。');
        }
        return;
      }
      if (!body.ok) {
        toast.error(describeProbeError(body.error));
        return;
      }
      const rows = body.models.map((model) => ({
        id: model.id,
        label: model.id,
        contextWindowTokens: model.maxModelLen ? String(model.maxModelLen) : '',
        levelsText: '',
        defaultLevel: '',
        source: 'probe',
      }));
      const { toAdd, skipped } = planImport(editor.draft.models, rows);
      setEditor((current) => (current ? {
        ...current,
        draft: {
          ...current.draft,
          models: [...current.draft.models, ...toAdd],
          defaultModelId: current.draft.defaultModelId || toAdd[0]?.id || '',
        },
      } : current));
      toast.success(skipped.length ? `新增 ${toAdd.length} 个，跳过 ${skipped.length} 个已存在的。` : `新增 ${toAdd.length} 个模型。`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '探测失败。');
    } finally {
      setBusy('');
    }
  };

  const addManualModel = () => {
    setEditor((current) => (current ? {
      ...current,
      draft: {
        ...current.draft,
        models: [...current.draft.models, { id: '', label: '', contextWindowTokens: '', levelsText: '', defaultLevel: '', source: 'manual' }],
      },
    } : current));
  };

  const removeModel = (modelId) => {
    setEditor((current) => (current ? {
      ...current,
      draft: {
        ...current.draft,
        models: current.draft.models.filter((model) => model.id !== modelId),
        defaultModelId: current.draft.defaultModelId === modelId ? '' : current.draft.defaultModelId,
      },
    } : current));
  };

  const save = async (event) => {
    event.preventDefault();
    const payload = draftToPayload(editor.draft);
    if (!payload.models.length) {
      toast.error('至少需要一个模型：探测端点、从目录导入或手工添加。');
      return;
    }
    setBusy('save');
    try {
      const endpoint = userScope
        ? (editor.mode === 'edit' ? `/api/me/llm/providers/${encodeURIComponent(editor.draft.id)}` : '/api/me/llm/providers')
        : (editor.mode === 'edit' ? `/api/config/manage/llm/${encodeURIComponent(editor.draft.id)}` : '/api/config/manage/llm');
      const response = await apiJson(endpoint, {
        method: editor.mode === 'edit' ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      applyResponse(response);
      toast.success(editor.mode === 'edit' ? 'LLM 配置已更新。' : 'LLM 配置已创建。');
      closeEditor();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存 LLM 配置失败。');
    } finally {
      setBusy('');
    }
  };

  const remove = async (providerId) => {
    if (!window.confirm(`确定删除供应商 ${providerId}？仍有 Agent 绑定时会先被拦下。`)) return;
    setBusy(`remove:${providerId}`);
    try {
      const endpoint = userScope
        ? `/api/me/llm/providers/${encodeURIComponent(providerId)}`
        : `/api/config/manage/llm/${encodeURIComponent(providerId)}`;
      applyResponse(await apiJson(endpoint, { method: 'DELETE' }));
      toast.success('LLM 配置已删除。');
    } catch (err) {
      const references = userScope ? undefined : err?.payload?.references;
      if (references) {
        if (!window.confirm(`仍有 ${references} 个 Agent 绑定该供应商。删除后它们会失去模型绑定，确定继续？`)) return;
        try {
          applySettingsResponse(await apiJson(`/api/config/manage/llm/${encodeURIComponent(providerId)}?force=1`, { method: 'DELETE' }));
          toast.success('LLM 配置已删除。');
        } catch (retryError) {
          toast.error(retryError instanceof Error ? retryError.message : '删除失败。');
        }
        return;
      }
      toast.error(err instanceof Error ? err.message : '删除失败。');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="settings-layout manage-settings-layout llm-settings-layout configuration-canvas">
      <section className="panel llm-provider-panel">
        <div className="panel-heading">
          <div>
            <h3>LLM 供应商</h3>
            <p className="hint">供应商持有端点与密钥，模型挂在供应商下面。角色用哪个模型在 Agent 配置里选。</p>
            {userScope && <p className="hint">系统预置只读；你自己的供应商密钥加密保存在服务端，界面只显示掩码。</p>}
          </div>
          <button className="primary-button" type="button" onClick={() => openEditor(null)}>新建供应商</button>
        </div>
        {userScope && !scoped && <p className="hint">正在加载你的 LLM 配置…</p>}
        {(!userScope || scoped) && !providers.length && <p className="hint">还没有供应商。新建后填一次 API Key，就能用目录里的模型清单。</p>}
        <div className="llm-provider-list">
          {providers.map((provider) => {
            const models = modelsForProvider(llmModels, provider.id);
            return (
              <article key={provider.id} className="llm-provider-card">
                <header className="llm-provider-head">
                  <div>
                    <strong>{provider.id}</strong>
                    <span>{thinkingFormatLabel(provider.thinkingFormat)} · {provider.baseUrl}</span>
                  </div>
                  <div className="summary-actions">
                    {provider.isDefault && <span className="badge">默认</span>}
                    {readOnlyProviders.has(provider.id) ? (
                      <span className="badge">系统预置</span>
                    ) : (
                      <>
                        <button className="secondary-button" type="button" onClick={() => openEditor(provider)}>编辑</button>
                        <button className="danger-button" type="button" disabled={busy === `remove:${provider.id}`} onClick={() => remove(provider.id)}>删除</button>
                      </>
                    )}
                  </div>
                </header>
                <div className="llm-model-chips">
                  {models.length ? models.map((model) => (
                    <span key={model.id} className={`llm-chip${model.id === provider.model ? ' is-default' : ''}`} title={describeModel(model)}>
                      {model.label || model.id}
                    </span>
                  )) : <span className="hint">该供应商还没有模型</span>}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {editor && (
        <div className="llm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <section className="llm-dialog llm-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="llm-dialog-title">
            <div className="llm-dialog-heading">
              <div>
                <span className="section-kicker">PROVIDER</span>
                <h3 id="llm-dialog-title">{editor.mode === 'edit' ? `编辑 ${editor.draft.id}` : '新建供应商'}</h3>
                <p>只填 API Key 也能用：目录已知的端点会带出模型清单。</p>
              </div>
              <button className="llm-dialog-close" type="button" onClick={closeEditor} aria-label="关闭" data-tooltip="关闭"><CloseIcon /></button>
            </div>
            <form className="stack llm-dialog-form" onSubmit={save}>
              {/* The action bar leads the scroll area: the model list can be long, and
                  saving should never require scrolling to the end of it. */}
              <div className="llm-dialog-actions">
                <button className="secondary-button" type="button" onClick={closeEditor}>取消</button>
                <button className="primary-button" type="submit" disabled={busy === 'save'}>{busy === 'save' ? '保存中…' : editor.mode === 'edit' ? '保存修改' : '创建供应商'}</button>
              </div>
              <fieldset className="config-section">
                <legend><span className="config-section-index">01</span><span><strong>端点与凭据</strong><small>供应商是唯一持有密钥的地方。</small></span></legend>
                {editor.mode === 'create' && (
                  <div className="llm-preset-block">
                    <label className="field">
                      <span>从目录选择（{presets === null ? '加载中…' : `${featuredPresets.length + morePresets.length} / ${presets.length}`}）</span>
                      <input value={presetQuery} placeholder="搜索供应商，如 deepseek、qwen、anthropic" onChange={(event) => setPresetQuery(event.target.value)} />
                      <small>主流供应商优先展示；其余来自 models.dev 目录。</small>
                    </label>
                    {/* One scroll area for both groups: two nested scrollers read as two
                        different lists, and the second one hid how much of the catalog it held. */}
                    <div className="llm-preset-scroll">
                      {presets !== null && featuredPresets.length > 0 && (
                        <div className="llm-preset-group">
                          <span className="llm-preset-group-title">主流供应商</span>
                          <div className="llm-preset-grid">
                            {featuredPresets.map((preset) => (
                              <button key={preset.id} type="button" className={`llm-preset${editor.draft.presetId === preset.id ? ' active' : ''}`} onClick={() => applyPreset(preset)}>
                                <strong>{preset.name}</strong>
                                <span>{preset.modelCount ? `${preset.modelCount} 个模型` : '需探测端点'}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {presets !== null && morePresets.length > 0 && (
                        <div className="llm-preset-group">
                          <span className="llm-preset-group-title">更多供应商（models.dev）</span>
                          <div className="llm-preset-grid">
                            {morePresets.map((preset) => (
                              <button key={preset.id} type="button" className={`llm-preset${editor.draft.presetId === preset.id ? ' active' : ''}`} onClick={() => applyPreset(preset)}>
                                <strong>{preset.name}</strong>
                                <span>{preset.modelCount ? `${preset.modelCount} 个模型` : '需探测端点'}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {presets !== null && !featuredPresets.length && !morePresets.length && <span className="hint">没有匹配的供应商，可以直接手填端点。</span>}
                  </div>
                )}
                <div className="form-grid">
                  <Field label="名称" value={editor.draft.name} onChange={(value) => patchDraft({ name: value })} />
                  <Field label="Base URL" value={editor.draft.baseUrl} onChange={(value) => patchDraft({ baseUrl: value })} />
                  <label className="field wide">
                    <span>API Key</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={editor.draft.apiKey}
                      placeholder={editor.mode === 'edit' ? '留空以保持当前密钥' : '粘贴 API Key，或填 ${ENV_NAME}'}
                      onChange={(event) => patchDraft({ apiKey: event.target.value })}
                    />
                    <small>{userScope ? '密钥加密保存在服务端数据库，界面与接口只返回掩码。' : `密钥只写进本机 .env，配置里保留 ${'${NAME}'} 引用。`}</small>
                  </label>
                  <label className="field">
                    <span>思考格式</span>
                    <select value={editor.draft.thinkingFormat} onChange={(event) => patchDraft({ thinkingFormat: event.target.value })}>
                      {THINKING_FORMATS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    <small>{THINKING_FORMATS.find((option) => option.id === editor.draft.thinkingFormat)?.hint}</small>
                  </label>
                  <label className="field">
                    <span>协议</span>
                    <select value={editor.draft.protocol || 'openai-completions'} onChange={(event) => patchDraft({ protocol: event.target.value })}>
                      {LLM_PROTOCOLS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    <small>{LLM_PROTOCOLS.find((option) => option.id === (editor.draft.protocol || 'openai-completions'))?.hint}</small>
                  </label>
                </div>
                <div className="button-row">
                  <button className="secondary-button" type="button" disabled={busy === 'probe'} onClick={() => probeEndpoint()}>
                    {busy === 'probe' ? '探测中…' : '探测端点模型'}
                  </button>
                  {editor.draft.thinkingFormat === 'anthropic-budget' && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setEditor((current) => ({
                        ...current,
                        draft: {
                          ...current.draft,
                          models: current.draft.models.map((model) => ({
                            ...model,
                            levelsText: serializeLevelMap(budgetLadderFor(parseLevels(model.levelsText))),
                          })),
                        },
                      }))}
                    >
                      按档位名生成预算阶梯
                    </button>
                  )}
                </div>
              </fieldset>

              <fieldset className="config-section">
                <legend><span className="config-section-index">02</span><span><strong>模型清单</strong><small>每个模型一行；上下文与档位来自目录、端点或手填。</small></span></legend>
                {!editor.draft.models.length && <p className="hint">还没有模型。可以「探测端点模型」、选目录预设后导入，或手工添加。</p>}
                <div className="llm-model-editor">
                  {editor.draft.models.map((model, index) => (
                    <div key={`${model.id}-${index}`} className="llm-model-row">
                      <div className="llm-model-row-head">
                        <label className="field grow">
                          <span>模型 ID</span>
                          <input value={model.id} onChange={(event) => updateModel(model.id, { id: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>上下文</span>
                          <input type="number" value={model.contextWindowTokens} onChange={(event) => updateModel(model.id, { contextWindowTokens: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>默认档位</span>
                          <select value={model.defaultLevel} onChange={(event) => updateModel(model.id, { defaultLevel: event.target.value })}>
                            <option value="">（不指定）</option>
                            {parseLevels(model.levelsText).map((level) => <option key={level} value={level}>{level}</option>)}
                          </select>
                        </label>
                        <div className="button-row">
                          <button className="secondary-button" type="button" disabled={!model.id || busy === `levels:${model.id}`} onClick={() => probeEndpoint(model.id)}>
                            {busy === `levels:${model.id}` ? '探测中…' : '探测档位'}
                          </button>
                          <button className="danger-button" type="button" onClick={() => removeModel(model.id)}>移除</button>
                        </div>
                      </div>
                      <label className="field wide">
                        <span>思考档位（每行 <code>档位=发送值</code>；相同值只写档位名）</span>
                        <textarea
                          className="code-box llm-levels-box"
                          rows={2}
                          value={model.levelsText}
                          placeholder={editor.draft.thinkingFormat === 'anthropic-budget' ? 'low=1024\nhigh=16384' : 'low\nhigh\nmax=xhigh'}
                          onChange={(event) => updateModel(model.id, { levelsText: event.target.value })}
                        />
                      </label>
                      <span className="llm-model-source">
                        {sourceLabel(model.source)}
                        {model.levelsText ? ` · ${describeLevelMap(parseLevelMapText(model.levelsText, { numeric: editor.draft.thinkingFormat === 'anthropic-budget' }))}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={addManualModel}>手动添加模型</button>
                  <label className="field">
                    <span>默认模型</span>
                    <select value={editor.draft.defaultModelId} onChange={(event) => patchDraft({ defaultModelId: event.target.value })}>
                      <option value="">（第一个模型）</option>
                      {editor.draft.models.filter((model) => model.id).map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
                    </select>
                  </label>
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function emptyDraft() {
  return {
    id: '',
    presetId: 'custom',
    name: '',
    baseUrl: '',
    apiKey: '',
    thinkingFormat: 'openai-effort',
    protocol: 'openai-completions',
    defaultModelId: '',
    models: [],
  };
}

function draftFromProvider(provider, models) {
  return {
    id: provider.id,
    presetId: provider.presetId || 'custom',
    name: provider.name || provider.id,
    baseUrl: provider.baseUrl || '',
    apiKey: '',
    thinkingFormat: provider.thinkingFormat || 'openai-effort',
    protocol: provider.protocol || 'openai-completions',
    defaultModelId: defaultModelFor(provider, models),
    models: models.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      contextWindowTokens: model.contextWindowTokens ? String(model.contextWindowTokens) : '',
      levelsText: serializeLevelMap(model.reasoningEfforts || {}),
      defaultLevel: model.defaultThinkingLevel || '',
      source: model.metadataSource || 'manual',
    })),
  };
}

function catalogRowsToDraft(models, format) {
  return models.map((model) => ({
    id: model.id,
    label: model.name || model.id,
    contextWindowTokens: model.contextWindowTokens ? String(model.contextWindowTokens) : '',
    levelsText: serializeLevelMap(levelsToMap(Object.keys(model.reasoningEfforts || {}), format)),
    defaultLevel: Object.keys(model.reasoningEfforts || {})[0] || '',
    source: 'catalog',
  }));
}

function draftToPayload(draft) {
  const numeric = draft.thinkingFormat === 'anthropic-budget';
  return {
    presetId: draft.presetId || 'custom',
    name: draft.name.trim() || draft.baseUrl,
    baseUrl: draft.baseUrl.trim(),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    thinkingFormat: draft.thinkingFormat,
    protocol: draft.protocol || 'openai-completions',
    defaultModelId: draft.defaultModelId || draft.models[0]?.id || '',
    models: draft.models
      .filter((model) => model.id.trim())
      .map((model) => {
        const reasoningEfforts = parseLevelMapText(model.levelsText, { numeric });
        const levels = Object.keys(reasoningEfforts);
        return {
          id: model.id.trim(),
          ...(model.label && model.label !== model.id ? { label: model.label } : {}),
          ...(Number(model.contextWindowTokens) > 0 ? { contextWindowTokens: Number(model.contextWindowTokens) } : {}),
          ...(levels.length ? { reasoningEfforts } : {}),
          ...(levels.length && model.defaultLevel && levels.includes(model.defaultLevel) ? { defaultThinkingLevel: model.defaultLevel } : {}),
          metadataSource: model.source || 'manual',
        };
      }),
  };
}

function parseLevels(text) {
  return Object.keys(parseLevelMapText(text, { numeric: false }));
}

function sourceLabel(source) {
  if (source === 'catalog') return '来源：目录';
  if (source === 'probe') return '来源：端点探测';
  return '来源：手填';
}

function describeProbeError(error) {
  if (!error) return '探测失败。';
  if (error.kind === 'auth') return `密钥被拒绝：${error.message}`;
  if (error.kind === 'timeout') return error.message;
  if (error.kind === 'unsupported') return error.message;
  return `无法连接端点：${error.message}`;
}
