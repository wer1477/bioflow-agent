import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../api.js';

const EVENT_LABELS = {
  register: '注册',
  login: '登录',
  login_failed: '登录失败',
  logout: '退出',
  code_sent: '发送验证码',
  password_reset: '重置密码',
  password_changed: '修改密码',
  admin_granted: '授予管理员',
  admin_disable: '禁用账号',
  admin_enable: '启用账号',
  admin_revoke_sessions: '强制下线',
  admin_password_reset_sent: '发送重置邮件',
};

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 管理员最小能力面：用户列表 + 最近审计。
 *
 * 刻意不展示用户 provider 的 key、会话内容或项目数据；管理员能做的只有禁用/启用、
 * 强制下线、触发重置邮件，以及查看审计。
 */
export function AdminUsersView({ toast, account }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, log] = await Promise.all([
        apiJson(`/api/admin/users?q=${encodeURIComponent(search)}`),
        apiJson('/api/admin/audit?limit=50'),
      ]);
      setUsers(list.users || []);
      setTotal(list.total || 0);
      setAudit(log.entries || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载用户失败。');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, work, success) => {
    setBusy(key);
    try {
      await work();
      toast.success(success);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试。');
    } finally {
      setBusy('');
    }
  };

  const toggleStatus = (user) => {
    const disabling = user.status === 'active';
    if (disabling && !window.confirm(`确定禁用 ${user.email}？该账号的会话会立即失效。`)) return;
    run(
      `status:${user.id}`,
      () => apiJson(`/api/admin/users/${encodeURIComponent(user.id)}/${disabling ? 'disable' : 'enable'}`, { method: 'POST' }),
      disabling ? '账号已禁用。' : '账号已启用。',
    );
  };

  const revokeSessions = (user) => {
    if (!window.confirm(`强制下线 ${user.email} 的所有会话？`)) return;
    run(
      `revoke:${user.id}`,
      () => apiJson(`/api/admin/users/${encodeURIComponent(user.id)}/sessions/revoke`, { method: 'POST' }),
      '已强制下线。',
    );
  };

  const sendReset = (user) => {
    if (!window.confirm(`向 ${user.email} 发送重置密码验证码？`)) return;
    run(
      `reset:${user.id}`,
      () => apiJson(`/api/admin/users/${encodeURIComponent(user.id)}/password-reset`, { method: 'POST' }),
      '重置邮件已发送。',
    );
  };

  const selfEmail = account?.user?.email;

  return (
    <div className="settings-layout admin-settings-layout configuration-canvas">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">USERS</span>
            <h3>用户管理</h3>
            <p className="hint">禁用会立即注销该账号的所有会话；重置密码只发送验证码，新密码由用户自己设置。</p>
          </div>
          <form className="admin-toolbar" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}>
            <input value={query} placeholder="按邮箱搜索" onChange={(event) => setQuery(event.target.value)} />
            <button className="secondary-button" type="submit">搜索</button>
            <button className="secondary-button" type="button" onClick={load} disabled={loading}>刷新</button>
          </form>
        </div>
        {loading && !users.length ? <p className="hint">正在加载用户…</p> : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>注册时间</th>
                  <th>最近登录</th>
                  <th>活跃会话</th>
                  <th>Provider</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>{user.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>
                      <span className={`admin-status${user.status === 'disabled' ? ' is-disabled' : ''}`}>
                        {user.status === 'disabled' ? '已禁用' : '正常'}
                      </span>
                    </td>
                    <td>{formatTime(user.createdAt)}</td>
                    <td>{formatTime(user.lastLoginAt)}</td>
                    <td>{user.activeSessions}</td>
                    <td>{user.providerCount}</td>
                    <td>
                      <div className="admin-actions">
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={user.email === selfEmail || busy === `status:${user.id}`}
                          onClick={() => toggleStatus(user)}
                        >
                          {user.status === 'disabled' ? '启用' : '禁用'}
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy === `revoke:${user.id}`}
                          onClick={() => revokeSessions(user)}
                        >
                          强制下线
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={user.status === 'disabled' || busy === `reset:${user.id}`}
                          onClick={() => sendReset(user)}
                        >
                          发送重置邮件
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!users.length && <p className="hint">没有匹配的账号。</p>}
          </div>
        )}
        <p className="hint">共 {total} 个账号。</p>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">AUDIT</span>
            <h3>审计日志</h3>
            <p className="hint">保留 30 天；这里只显示最近 50 条。</p>
          </div>
        </div>
        {!audit.length ? <p className="hint">暂无审计记录。</p> : (
          <div className="admin-table-scroll">
            <table className="admin-table audit-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th>邮箱</th>
                  <th>IP</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatTime(entry.at)}</td>
                    <td>{EVENT_LABELS[entry.event] || entry.event}</td>
                    <td>{entry.email || '—'}</td>
                    <td>{entry.ip || '—'}</td>
                    <td>{entry.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
