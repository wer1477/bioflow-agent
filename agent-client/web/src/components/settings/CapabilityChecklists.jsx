import {
  knowledgeBaseDomainState,
  knowledgeBaseSelection,
  toggleId,
  toggleKnowledgeBaseDomain,
  toggleToolLibraryDomain,
  toolLibraryDomainState,
  toolLibrarySelection,
} from '../../domain/agent_config_view.js';

/**
 * CoreTool picker.
 *
 * CoreTools are the process-side tool families of the backend registry. Only the checked
 * ones are loaded for this agent, so the list starts empty for a new agent. The capability
 * families (Tool Library, Knowledge Base) are the exception: they stay resident either way,
 * and checking one only routes selection to biod instead of the model.
 */
export function CoreToolChecklist({ tools = [], selected = [], onChange, disabled = false }) {
  const selectedSet = new Set(selected || []);
  return (
    <div className="field wide capability-field">
      <div className="checklist-toolbar">
        <span className="checklist-label">CoreTool</span>
        <div className="button-row">
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => onChange(tools.map((tool) => tool.id))}>全选</button>
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => onChange([])}>清空</button>
        </div>
      </div>
      <p className="field-hint">CoreTool 按 Agent 显式启用；未勾选时不加载。Tool Library 与 Knowledge Base 例外：始终注入角色上下文，勾选时由 biod 决策选择，未勾选时退化为模型自行浏览选择。</p>
      {tools.length ? (
        <div className="checklist coretool-checklist">
          {tools.map((tool) => (
            <label key={tool.id} className="check-item" title={`${tool.name}（${tool.id}）：${tool.description}`}>
              <input type="checkbox" checked={selectedSet.has(tool.id)} disabled={disabled} onChange={() => onChange(toggleId(selected, tool.id))} />
              <span className="capability-name">{tool.name}</span>
              {tool.alwaysAvailable && (
                <span
                  className="capability-badge"
                  title={selectedSet.has(tool.id) ? '始终可用；已勾选，默认由 biod 决策选择' : '始终可用；未勾选，由模型自行选择'}
                >
                  {selectedSet.has(tool.id) ? 'biod 决策' : '模型选择'}
                </span>
              )}
            </label>
          ))}
        </div>
      ) : <p className="hint">暂无 CoreTool</p>}
    </div>
  );
}

/**
 * ToolLibrary picker, grouped by curated capability domain.
 *
 * Skills bind one id at a time; an MCP entry binds the configured server it belongs to, so
 * toggling any of that server's tools in any domain reflects everywhere. The fallback
 * `Unclassified` domain keeps configured-but-unlisted capabilities visible so saving the
 * form never unbinds them silently.
 */
export function ToolLibraryChecklist({ domains = [], warnings = [], skillIds = [], mcpServerIds = [], onSkillsChange, onServersChange, disabled = false }) {
  const all = toolLibrarySelection(domains);
  const selectAll = () => {
    onSkillsChange(all.skillIds);
    onServersChange(all.mcpServerIds);
  };
  return (
    <div className="field wide capability-field">
      <div className="checklist-toolbar">
        <span className="checklist-label">ToolLibrary</span>
        <div className="button-row">
          <button className="secondary-button" type="button" disabled={disabled} onClick={selectAll}>全选</button>
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => { onSkillsChange([]); onServersChange([]); }}>清空</button>
        </div>
      </div>
      <p className="field-hint">按工具库领域展示：技能按条目绑定，MCP 按服务器绑定（勾选后该服务器的全部工具可用）。</p>
      {warnings.length > 0 && <p className="capability-warnings">目录提示：{warnings.slice(0, 3).join('；')}</p>}
      <div className="checklist grouped-checklist">
        {domains.map((domain) => {
          const state = toolLibraryDomainState(domain, skillIds, mcpServerIds);
          return (
            <div key={domain.name} className="checklist-group">
              <label className="domain-group-heading">
                <input
                  type="checkbox"
                  checked={state.checked}
                  disabled={disabled}
                  onChange={() => {
                    const next = toggleToolLibraryDomain(domain, skillIds, mcpServerIds);
                    onSkillsChange(next.skillIds);
                    onServersChange(next.mcpServerIds);
                  }}
                />
                <div>
                  <strong>{domain.name}</strong>
                  <span>{state.selected}/{state.total} 项已绑定</span>
                </div>
              </label>
              {domain.description && <p className="domain-description">{domain.description}</p>}
              <div className="checklist-grid compact-skill-grid capability-grid">
                {state.skills.map((skill) => (
                  <label key={`skill:${skill.id}`} className={`check-item capability-item${skill.available ? '' : ' unavailable'}`} title={skill.description}>
                    <input type="checkbox" checked={(skillIds || []).includes(skill.id)} disabled={disabled} onChange={() => onSkillsChange(toggleId(skillIds, skill.id))} />
                    <span className="capability-name">{skill.name}</span>
                    {!skill.available && <span className="capability-badge danger">目录缺失</span>}
                    {skill.available && !skill.enabled && <span className="capability-badge">已停用</span>}
                  </label>
                ))}
                {state.servers.map((server) => (
                  <label
                    key={`server:${server.serverId}`}
                    className={`check-item capability-item${server.available ? '' : ' unavailable'}`}
                    title={`${server.name}：${server.tools.join('、')}`}
                  >
                    <input type="checkbox" checked={(mcpServerIds || []).includes(server.serverId)} disabled={disabled} onChange={() => onServersChange(toggleId(mcpServerIds, server.serverId))} />
                    <span className="capability-name">{server.name}</span>
                    <span className="capability-badge mcp">MCP · {server.tools.length}</span>
                  </label>
                ))}
                {state.unresolved.map((entry) => (
                  <label key={`unresolved:${entry.id}`} className="check-item capability-item unavailable" title={entry.description}>
                    <input type="checkbox" checked={false} disabled readOnly />
                    <span className="capability-name">{entry.name}</span>
                    <span className="capability-badge danger">无对应服务器</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * KnowledgeBase picker, grouped by curated knowledge domain.
 *
 * Unlike the domain-level binding it replaces, every knowledge entry is its own checkbox:
 * the knowledgebase tool can only select and read the entries checked here. The domain box
 * selects or clears the whole group and shows a partial state when only some entries are in.
 */
export function KnowledgeBaseChecklist({ domains = [], warnings = [], selected = [], onChange, disabled = false }) {
  const selectedSet = new Set(selected || []);
  const allEntryIds = knowledgeBaseSelection(domains);
  return (
    <div className="field wide capability-field">
      <div className="checklist-toolbar">
        <span className="checklist-label">KnowledgeBase</span>
        <div className="button-row">
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => onChange(allEntryIds)}>全选</button>
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => onChange([])}>清空</button>
        </div>
      </div>
      <p className="field-hint">按知识域展示；条目可单独勾选，知识库工具只会检索已勾选的条目。</p>
      {warnings.length > 0 && <p className="capability-warnings">目录提示：{warnings.slice(0, 3).join('；')}</p>}
      <div className="checklist grouped-checklist">
        {domains.map((domain) => {
          const state = knowledgeBaseDomainState(domain, selected);
          return (
            <div key={domain.name} className="checklist-group">
              <label className="domain-group-heading">
                <input
                  type="checkbox"
                  checked={state.checked}
                  disabled={disabled}
                  ref={(node) => { if (node) node.indeterminate = state.indeterminate; }}
                  onChange={() => onChange(toggleKnowledgeBaseDomain(domain, selected))}
                />
                <div>
                  <strong>{domain.name}</strong>
                  <span>{state.selected}/{state.total} 条已选</span>
                </div>
              </label>
              {domain.description && <p className="domain-description">{domain.description}</p>}
              <div className="checklist-grid compact-skill-grid capability-grid">
                {(domain.entries || []).map((entry) => (
                  <label key={entry.id} className="check-item capability-item" title={entry.description || entry.id}>
                    <input type="checkbox" checked={selectedSet.has(entry.id)} disabled={disabled} onChange={() => onChange(toggleId(selected, entry.id))} />
                    <span className="capability-name">{entry.name}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
