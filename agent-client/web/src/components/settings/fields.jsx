export function Field({ label, value, onChange, type = 'text', disabled = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function SelectField({ label, value, rows = [], onChange, disabled = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select>
    </label>
  );
}

/**
 * A select over `{value,label,detail?,disabled?}` rows. The LLM pickers need a remark per
 * option (a model's limits, a provider's default model) that `SelectField`'s `{id,name}`
 * shape cannot carry.
 */
export function OptionsSelect({ label, value, options = [], onChange, disabled = false, hint = '' }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.detail ? `${option.label} · ${option.detail}` : option.label}
          </option>
        ))}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function PlainSelect({ label, value, rows = [], onChange, disabled = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {rows.map((row) => <option key={row} value={row}>{row}</option>)}
      </select>
    </label>
  );
}

export function SummaryRows({ rows = [], format, onDelete, actions }) {
  if (!rows.length) return <p className="hint">暂无配置</p>;
  return (
    <div className="summary-list">
      {rows.map((item) => (
        <div key={item.id || item.name} className="summary-row">
          <div>
            <strong>{item.name}</strong>
            <span>{format(item)}</span>
          </div>
          <div className="summary-actions">
            <span className="badge">{item.id || ''}</span>
            {actions && actions(item)}
            {onDelete && <button className="danger-button" type="button" onClick={() => onDelete(item.id)}>删除</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function agentDraft(agent) {
  return {
    name: agent?.name || '',
    description: agent?.description || '',
    llmProviderId: agent?.llmProviderId || '',
    llmModelId: agent?.llmModelId || '',
    llmThinkingLevel: agent?.llmThinkingLevel || '',
    securityMode: agent?.securityMode || 'approval',
    prompt: agent?.systemPrompt || '',
    coreToolIds: agent?.coreToolIds || [],
    knowledgeEntryIds: agent?.knowledgeEntryIds || [],
    mcpServerIds: agent?.mcpServerIds || [],
    skillIds: agent?.skillIds || [],
  };
}
