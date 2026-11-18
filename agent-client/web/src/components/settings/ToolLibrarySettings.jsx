import { useMemo, useState } from 'react';

const KIND_OPTIONS = [
  ['all', '全部'],
  ['skill', 'Skill'],
  ['mcp', 'MCP'],
];

const KIND_LABELS = { skill: 'Skill', mcp: 'MCP' };

function matchesQuery(entry, query) {
  if (!query) return true;
  return [entry.name, entry.description, entry.id, entry.domain]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(query));
}

function statusOf(entry) {
  if (!entry.available) return { tone: 'danger', label: '缺失' };
  if (!entry.enabled) return { tone: 'warn', label: '已停用' };
  return { tone: 'ok', label: '可加载' };
}

/**
 * Read-only view of the complete curated Tool Library catalog.
 *
 * The payload is the full domain projection from `GET /api/settings` (every curated
 * domain plus the runtime fallback domain), so this page never filters by agent
 * visibility and never writes configuration: bindings stay on the Agent settings page.
 */
export function ToolLibrarySettings({ library }) {
  const domains = library?.domains || [];
  const warnings = library?.warnings || [];
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [activeDomainName, setActiveDomainName] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const activeDomain = domains.find((domain) => domain.name === activeDomainName) || domains[0];

  const stats = useMemo(() => {
    let entries = 0;
    let skills = 0;
    let mcp = 0;
    let unavailable = 0;
    for (const domain of domains) {
      for (const entry of domain.entries) {
        entries += 1;
        if (entry.kind === 'skill') skills += 1;
        else if (entry.kind === 'mcp') mcp += 1;
        if (!entry.available || !entry.enabled) unavailable += 1;
      }
    }
    return { domains: domains.length, entries, skills, mcp, unavailable };
  }, [domains]);

  const visibleEntries = useMemo(() => {
    const source = normalizedQuery || !activeDomain
      ? domains.flatMap((domain) => domain.entries.map((entry) => ({ ...entry, domain: domain.name })))
      : activeDomain.entries.map((entry) => ({ ...entry, domain: activeDomain.name }));
    return source
      .filter((entry) => kind === 'all' || entry.kind === kind)
      .filter((entry) => matchesQuery(entry, normalizedQuery))
      .sort((left, right) => String(left.domain).localeCompare(String(right.domain)) || String(left.name).localeCompare(String(right.name)));
  }, [domains, activeDomain, kind, normalizedQuery]);

  return (
    <section className="configuration-canvas catalog-canvas">
      <header className="configuration-intro">
        <div>
          <span className="section-kicker">CAPABILITY CATALOG</span>
          <h3>Tool Library</h3>
          <p>按领域组织的完整能力目录，模型会按需加载。本页只读，能力绑定请到「Agent 配置」页修改。</p>
        </div>
        <div className="configuration-metrics" aria-label="能力目录概览">
          <span><b>{stats.domains}</b> 领域</span>
          <span><b>{stats.entries}</b> 条目</span>
          <span><b>{stats.skills}</b> Skill</span>
          <span className="configuration-metric-good"><i aria-hidden="true" />{stats.mcp} MCP</span>
          {stats.unavailable > 0 && <span><b>{stats.unavailable}</b> 不可用</span>}
        </div>
      </header>
      {warnings.length > 0 && <p className="capability-warnings" role="status">{warnings.join('；')}</p>}
      <div className="catalog-layout">
        <aside className="panel catalog-domains">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">DOMAINS</span>
              <h3>领域</h3>
            </div>
            <span className="count-badge">{domains.length}</span>
          </div>
          {!domains.length ? <p className="hint">尚未提供受控目录。</p> : (
            <div className="agent-menu">
              {domains.map((domain) => (
                <button
                  key={domain.name}
                  type="button"
                  className={!normalizedQuery && domain.name === activeDomain?.name ? 'active' : ''}
                  onClick={() => {
                    setActiveDomainName(domain.name);
                    setQuery('');
                  }}
                >
                  <strong>{domain.name}</strong>
                  <span>{domain.description || '未提供领域描述'} · {domain.entries.length} 项</span>
                </button>
              ))}
            </div>
          )}
        </aside>
        <section className="panel catalog-entries">
          <div className="catalog-toolbar">
            <label className="field catalog-search">
              <span>搜索能力</span>
              <input type="search" value={query} placeholder="名称 / 描述 / ID" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="catalog-kind-filter" role="group" aria-label="按能力类型过滤">
              {KIND_OPTIONS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>
              ))}
            </div>
          </div>
          <p className="catalog-context">
            {normalizedQuery
              ? `全库搜索「${query.trim()}」· ${visibleEntries.length} 项`
              : `${activeDomain?.name || '—'} · ${visibleEntries.length} 项${activeDomain?.description ? ` · ${activeDomain.description}` : ''}`}
          </p>
          {!visibleEntries.length ? <section className="configuration-empty"><strong>没有匹配的能力</strong><span>调整搜索词或类型过滤后重试。</span></section> : (
            <div className="catalog-entry-list">
              {visibleEntries.map((entry, index) => {
                const status = statusOf(entry);
                return (
                  <article className="catalog-entry" key={`${entry.domain}/${entry.id}`} style={{ '--entry-delay': `${Math.min(index, 12) * 24}ms` }}>
                    <div className="catalog-entry-topline">
                      <span className={`catalog-kind ${entry.kind}`}>{KIND_LABELS[entry.kind] || entry.kind}</span>
                      <span className={`catalog-status ${status.tone}`}>{status.label}</span>
                      {entry.kind === 'mcp' && entry.serverName && <span className="catalog-server">{entry.serverName}</span>}
                    </div>
                    <h4>{entry.name}</h4>
                    <code className="catalog-entry-id">{entry.id}</code>
                    <p>{entry.description || '未提供描述'}</p>
                    {(normalizedQuery || kind !== 'all') && <span className="catalog-entry-domain">{entry.domain}</span>}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
