import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../api.js';
import { AssistantMarkdown } from '../../assistant_markdown.js';

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read-only browser for the curated knowledge base.
 *
 * The domain/entry tree comes from `GET /api/settings`; one entry's body and resource
 * list are fetched on demand from `GET /api/knowledgebase/entry`. Nothing here writes
 * configuration: the disk tree stays the source of truth.
 */
export function KnowledgebaseSettings({ knowledgeBase }) {
  const domains = knowledgeBase?.domains || [];
  const warnings = knowledgeBase?.warnings || [];
  const [activeDomainName, setActiveDomainName] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState('');
  const [query, setQuery] = useState('');
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const activeDomain = domains.find((domain) => domain.name === activeDomainName) || domains[0];
  const normalizedQuery = query.trim().toLowerCase();
  const entries = useMemo(() => {
    const list = activeDomain?.entries || [];
    if (!normalizedQuery) return list;
    return list.filter((item) => [item.name, item.description, item.id]
      .map((value) => String(value || '').toLowerCase())
      .some((value) => value.includes(normalizedQuery)));
  }, [activeDomain, normalizedQuery]);

  useEffect(() => {
    setSelectedEntryId('');
    setEntry(null);
    setError('');
  }, [activeDomain?.name]);

  useEffect(() => {
    if (!selectedEntryId) return undefined;
    const token = requestRef.current + 1;
    requestRef.current = token;
    setLoading(true);
    setError('');
    apiJson(`/api/knowledgebase/entry?id=${encodeURIComponent(selectedEntryId)}`)
      .then((data) => {
        if (requestRef.current !== token) return;
        setEntry(data?.entry || null);
      })
      .catch((err) => {
        if (requestRef.current !== token) return;
        setEntry(null);
        setError(err instanceof Error ? err.message : '读取条目失败。');
      })
      .finally(() => {
        if (requestRef.current === token) setLoading(false);
      });
    return undefined;
  }, [selectedEntryId]);

  const totalEntries = useMemo(() => domains.reduce((sum, domain) => sum + domain.entries.length, 0), [domains]);

  return (
    <section className="configuration-canvas knowledgebase-canvas">
      <header className="configuration-intro">
        <div>
          <span className="section-kicker">KNOWLEDGE INDEX</span>
          <h3>Knowledgebase</h3>
          <p>按领域组织的知识条目；浏览正文与资源清单，只读，不修改磁盘内容。</p>
        </div>
        <div className="configuration-metrics" aria-label="知识库概览">
          <span><b>{domains.length}</b> 领域</span>
          <span><b>{totalEntries}</b> 条目</span>
          {warnings.length > 0 && <span><b>{warnings.length}</b> 提示</span>}
        </div>
      </header>
      {warnings.length > 0 && <p className="capability-warnings" role="status">{warnings.join('；')}</p>}
      <div className="kb-layout">
        <aside className="panel kb-domains">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">DOMAINS</span>
              <h3>领域</h3>
            </div>
            <span className="count-badge">{domains.length}</span>
          </div>
          {!domains.length ? <p className="hint">知识库目录为空。</p> : (
            <div className="agent-menu">
              {domains.map((domain) => (
                <button
                  key={domain.name}
                  type="button"
                  className={domain.name === activeDomain?.name ? 'active' : ''}
                  onClick={() => {
                    setActiveDomainName(domain.name);
                    setQuery('');
                  }}
                >
                  <strong>{domain.name}</strong>
                  <span>{domain.description || '未提供领域描述'} · {domain.entries.length} 条</span>
                </button>
              ))}
            </div>
          )}
        </aside>
        <section className="panel kb-entries">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">ENTRIES</span>
              <h3>{activeDomain?.name || '条目'}</h3>
            </div>
            <span className="count-badge">{entries.length}</span>
          </div>
          <label className="field kb-search">
            <span>搜索条目</span>
            <input type="search" value={query} placeholder="名称 / 描述 / ID" onChange={(event) => setQuery(event.target.value)} />
          </label>
          {!entries.length ? <p className="hint">没有匹配的条目。</p> : (
            <div className="agent-menu kb-entry-menu">
              {entries.map((item) => (
                <button key={item.id} type="button" className={item.id === selectedEntryId ? 'active' : ''} onClick={() => setSelectedEntryId(item.id)}>
                  <strong>{item.name}</strong>
                  <span>{item.description || item.id}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="panel kb-detail">
          {!selectedEntryId && <p className="hint">从中间列表选择一个条目，查看正文与资源。</p>}
          {selectedEntryId && loading && <p className="hint">正在读取条目…</p>}
          {selectedEntryId && error && <p className="save-feedback error" role="alert">{error}</p>}
          {entry && (
            <>
              <div className="kb-detail-heading">
                <div>
                  <span className="section-kicker">KNOWLEDGE ENTRY</span>
                  <h3>{entry.name}</h3>
                  <code className="kb-detail-id">{entry.id}</code>
                </div>
                <span className="badge">{entry.resources?.length || 0} 资源</span>
              </div>
              {entry.description && <p className="kb-detail-description">{entry.description}</p>}
              {entry.warnings?.length > 0 && <p className="capability-warnings">{entry.warnings.join('；')}</p>}
              <div className="kb-markdown"><AssistantMarkdown content={entry.content || ''} /></div>
              {entry.resources?.length > 0 && (
                <section className="kb-resources">
                  <h4>资源清单</h4>
                  <ul>
                    {entry.resources.map((resource) => (
                      <li key={resource.path}>
                        <code>{resource.path}</code>
                        <span>{formatSize(resource.size)}{resource.mimeType ? ` · ${resource.mimeType}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
