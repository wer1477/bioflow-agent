import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../../api.js';

const CATEGORIES = [
  { id: 'bug', label: '问题反馈' },
  { id: 'feature', label: '功能建议' },
  { id: 'other', label: '其他' },
];

/**
 * 意见反馈弹窗：只负责收集与提交，内容由后端写入 SQLite。
 * 仅在登录态渲染；用户身份由会话自动附带，联系方式可以另外填写。
 */
export function FeedbackDialog({ open, onClose, user }) {
  const [category, setCategory] = useState('other');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCategory('other');
    setContent('');
    setContact(user?.email || '');
    setSubmitting(false);
    setError('');
    setDone(false);
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, user?.email]);

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

  const submit = async (event) => {
    event.preventDefault();
    const text = content.trim();
    if (!text) {
      setError('请填写反馈内容。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await apiJson('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          category,
          content: text,
          contact: contact.trim(),
          page: window.location.hash || window.location.pathname,
        }),
      });
      setDone(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '提交失败，请稍后再试。');
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
      <div className="auth-dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title">
        <header>
          <div>
            <span className="section-kicker">FEEDBACK</span>
            <h3 id="feedback-dialog-title">意见反馈</h3>
          </div>
          <button className="auth-dialog-close" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {done ? (
          <>
            <p className="auth-message auth-message-success" role="status">反馈已收到，感谢你的建议。</p>
            <div className="auth-dialog-actions">
              <button className="primary-button" type="button" onClick={onClose}>完成</button>
            </div>
          </>
        ) : (
          <form className="stack feedback-form" onSubmit={submit} noValidate>
            <label className="auth-field">
              <span>反馈类型</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="auth-field">
              <span>反馈内容</span>
              <textarea
                ref={textareaRef}
                rows={6}
                maxLength={5000}
                value={content}
                placeholder="遇到什么问题，或希望增加什么功能？"
                onChange={(event) => setContent(event.target.value)}
              />
              <small className="feedback-count">{content.length} / 5000</small>
            </label>
            <label className="auth-field">
              <span>联系方式（选填）</span>
              <input
                type="email"
                maxLength={200}
                value={contact}
                placeholder="邮箱或其他联系方式"
                onChange={(event) => setContact(event.target.value)}
              />
              <small>已附带账号：{user?.email || '当前登录账号'}</small>
            </label>
            {error && <p className="auth-message auth-message-error" role="alert">{error}</p>}
            <div className="auth-dialog-actions">
              <button className="secondary-button" type="button" onClick={onClose}>取消</button>
              <button className="primary-button" type="submit" disabled={submitting || !content.trim()}>
                {submitting ? '提交中…' : '提交反馈'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
