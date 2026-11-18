import { useEffect, useState } from 'react';
import { forgotPassword, login, register, requestCode, resetPassword } from '../../auth/client.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESEND_SECONDS = 60;

const HEADINGS = {
  login: { title: '登录', subtitle: '使用邮箱和密码登录你的账号。' },
  register: { title: '创建账号', subtitle: '邮箱即账号，验证码验证通过后设置密码。' },
  forgot: { title: '重置密码', subtitle: '通过邮箱验证码设置新密码。' },
};

export function AuthView({ route, onNavigate, onAuthenticated }) {
  const mode = route === 'register' || route === 'forgot' ? route : 'login';
  const heading = HEADINGS[mode];
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <header className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">B</span>
          <div>
            <h1>Bioflow Agent</h1>
            <p>生物信息分析 Agent 工作台</p>
          </div>
        </header>
        <div className="auth-heading">
          <h2>{heading.title}</h2>
          <p>{heading.subtitle}</p>
        </div>
        {mode === 'login' && <LoginForm onAuthenticated={onAuthenticated} onNavigate={onNavigate} />}
        {mode === 'register' && <RegisterForm onAuthenticated={onAuthenticated} onNavigate={onNavigate} />}
        {mode === 'forgot' && <ForgotForm onNavigate={onNavigate} />}
      </main>
      <p className="auth-footnote">Bioflow · 仅用于科研数据分析</p>
    </div>
  );
}

function LoginForm({ onAuthenticated, onNavigate }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    const value = email.trim();
    if (!value) {
      setError('请输入邮箱。');
      return;
    }
    if (!password) {
      setError('请输入密码。');
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(value, password, remember);
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field label="邮箱">
        <input
          id="auth-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoFocus
        />
      </Field>
      <Field label="密码">
        <input
          id="auth-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="至少 8 位"
        />
      </Field>
      <label className="auth-remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <span>记住我 30 天</span>
      </label>
      {error && <Message type="error">{error}</Message>}
      <button className="primary-button auth-submit" type="submit" disabled={submitting}>
        {submitting ? '登录中…' : '登录'}
      </button>
      <div className="auth-links">
        <LinkButton onClick={() => onNavigate({ name: 'forgot' })}>忘记密码？</LinkButton>
        <LinkButton onClick={() => onNavigate({ name: 'register' })}>创建账号</LinkButton>
      </div>
    </form>
  );
}

function RegisterForm({ onAuthenticated, onNavigate }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cooldown, startCooldown] = useCooldown(RESEND_SECONDS);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSendCode = async () => {
    setError('');
    setNotice('');
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setError('请先填写正确的邮箱。');
      return;
    }
    setSending(true);
    try {
      await requestCode(value, 'register');
      setNotice('验证码已发送，请检查邮箱（含垃圾邮件）。');
      startCooldown();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '验证码发送失败。');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setError('请输入正确的邮箱。');
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError('请输入 6 位数字验证码。');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位。');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      const result = await register(value, password, code.trim());
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '注册失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field label="邮箱">
        <input
          id="auth-register-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoFocus
        />
      </Field>
      <Field label="邮箱验证码">
        <div className="auth-code-row">
          <input
            id="auth-register-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6 位数字"
          />
          <button className="secondary-button" type="button" onClick={handleSendCode} disabled={sending || cooldown > 0}>
            {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中…' : '获取验证码'}
          </button>
        </div>
      </Field>
      <Field label="设置密码">
        <input
          id="auth-register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="至少 8 位"
        />
      </Field>
      <Field label="确认密码">
        <input
          id="auth-register-confirm"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="再输入一次"
        />
      </Field>
      {notice && <Message type="success">{notice}</Message>}
      {error && <Message type="error">{error}</Message>}
      <button className="primary-button auth-submit" type="submit" disabled={submitting}>
        {submitting ? '创建中…' : '创建账号'}
      </button>
      <div className="auth-links">
        <span />
        <LinkButton onClick={() => onNavigate({ name: 'login' })}>已有账号，去登录</LinkButton>
      </div>
    </form>
  );
}

function ForgotForm({ onNavigate }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cooldown, startCooldown] = useCooldown(RESEND_SECONDS);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState(false);

  const handleSendCode = async () => {
    setError('');
    setNotice('');
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setError('请先填写正确的邮箱。');
      return;
    }
    setSending(true);
    try {
      await forgotPassword(value);
      // 后端对未注册邮箱也返回成功，避免枚举；文案保持一致。
      setNotice('如果该邮箱已注册，验证码已发送。');
      startCooldown();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '验证码发送失败。');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setError('请输入正确的邮箱。');
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError('请输入 6 位数字验证码。');
      return;
    }
    if (password.length < 8) {
      setError('新密码至少 8 位。');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword(value, code.trim(), password);
      setFinished(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '重置失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  };

  if (finished) {
    return (
      <div className="auth-form">
        <Message type="success">密码已重置，所有旧登录状态已失效。</Message>
        <button className="primary-button auth-submit" type="button" onClick={() => onNavigate({ name: 'login' })}>
          使用新密码登录
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field label="邮箱">
        <input
          id="auth-forgot-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoFocus
        />
      </Field>
      <Field label="邮箱验证码">
        <div className="auth-code-row">
          <input
            id="auth-forgot-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6 位数字"
          />
          <button className="secondary-button" type="button" onClick={handleSendCode} disabled={sending || cooldown > 0}>
            {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中…' : '获取验证码'}
          </button>
        </div>
      </Field>
      <Field label="新密码">
        <input
          id="auth-forgot-password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="至少 8 位"
        />
      </Field>
      <Field label="确认新密码">
        <input
          id="auth-forgot-confirm"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="再输入一次"
        />
      </Field>
      {notice && <Message type="success">{notice}</Message>}
      {error && <Message type="error">{error}</Message>}
      <button className="primary-button auth-submit" type="submit" disabled={submitting}>
        {submitting ? '提交中…' : '重置密码'}
      </button>
      <div className="auth-links">
        <span />
        <LinkButton onClick={() => onNavigate({ name: 'login' })}>返回登录</LinkButton>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Message({ type, children }) {
  return (
    <p className={`auth-message auth-message-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

function LinkButton({ onClick, children }) {
  return (
    <button className="auth-link" type="button" onClick={onClick}>
      {children}
    </button>
  );
}

function useCooldown(seconds) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  return [remaining, () => setRemaining(seconds)];
}
