import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../api.js';

const PAGE_SIZE = 50;
const CATEGORY_LABELS = {
  bug: '问题反馈',
  feature: '功能建议',
  other: '其他',
};
const STATUS_LABELS = {
  open: '待处理',
  resolved: '已处理',
};

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 管理员反馈收件箱：只读列表 + 分页加载。
 *
 * 不提供修改/删除；反馈内容保持用户原文，联系方式与账号信息分开显示。
 */
export function FeedbackInboxView({ toast }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson(`/api/admin/feedback?limit=${PAGE_SIZE}&offset=0`);
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total) || 0);
    } catch (error) {
      toast?.error(error instanceof Error ? error.message : '加载反馈失败。');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await apiJson(`/api/admin/feedback?limit=${PAGE_SIZE}&offset=${items.length}`);
      setItems((previous) => [...previous, ...(Array.isArray(data.items) ? data.items : [])]);
      setTotal(Number(data.total) || 0);
    } catch (error) {
      toast?.error(error instanceof Error ? error.message : '加载更多反馈失败。');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="settings-layout configuration-canvas">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">FEEDBACK</span>
            <h3>意见反馈</h3>
            <p className="hint">只读收件箱；登录用户从账户菜单提交，按时间倒序显示。</p>
          </div>
          <div className="admin-toolbar">
            <button className="secondary-button" type="button" onClick={load} disabled={loading || loadingMore}>刷新</button>
          </div>
        </div>
        {loading && !items.length ? <p className="hint">正在加载反馈…</p> : null}
        {!loading && !items.length ? <p className="hint">还没有收到反馈。</p> : null}
        {items.length ? (
          <div className="admin-table-scroll">
            <table className="admin-table feedback-inbox-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>分类</th>
                  <th>内容</th>
                  <th>联系方式</th>
                  <th>用户</th>
                  <th>页面</th>
                  <th>版本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.createdAt)}</td>
                    <td>{CATEGORY_LABELS[item.category] || item.category}</td>
                    <td className="feedback-content-cell">{item.content}</td>
                    <td>{item.contact || '—'}</td>
                    <td>{item.email || item.userId || '—'}</td>
                    <td>{item.page || '—'}</td>
                    <td>{item.appVersion || '—'}</td>
                    <td>{STATUS_LABELS[item.status] || item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="hint">
          共 {total} 条{items.length < total ? `，已显示 ${items.length} 条` : ''}。
        </p>
        {items.length < total ? (
          <button className="secondary-button" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        ) : null}
      </section>
    </div>
  );
}
