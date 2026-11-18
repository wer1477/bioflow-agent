import { useEffect, useRef, useState } from 'react';
import { changePassword } from '../../auth/client.js';

/** 账户菜单 / 通用设置里的「修改密码」。成功后撤销其它设备的会话。 */
export function ChangePasswordDialog({ open, onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const firstInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setFinished(false);
    firstInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (!currentPassword) {
      setError('请输入当前密码。');
      return;
    }
    if (newPassword.length < 8) {
      setError('新密码至少 8 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setFinished(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '修改失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="auth-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <header>
          <h3 id="change-password-title">修改密码</h3>
          <button className="auth-dialog-close" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {finished ? (
          <>
            <p className="auth-message auth-message-success" role="status">密码已更新，其他设备上的登录已失效。</p>
            <div className="auth-dialog-actions">
              <button className="primary-button" type="button" onClick={onClose}>完成</button>
            </div>
          </>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label className="auth-field">
              <span>当前密码</span>
              <input
                ref={firstInputRef}
                id="change-current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>新密码</span>
              <input
                id="change-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="至少 8 位"
              />
            </label>
            <label className="auth-field">
              <span>确认新密码</span>
              <input
                id="change-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            {error && <p className="auth-message auth-message-error" role="alert">{error}</p>}
            <div className="auth-dialog-actions">
              <button className="secondary-button" type="button" onClick={onClose}>取消</button>
              <button className="primary-button" type="submit" disabled={submitting}>
                {submitting ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
