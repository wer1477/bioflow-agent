import { MoonIcon, SunIcon, SystemThemeIcon } from '../common/icons.jsx';

const THEME_OPTIONS = [
  { id: 'light', label: '浅色', Icon: SunIcon },
  { id: 'dark', label: '深色', Icon: MoonIcon },
  { id: 'system', label: '跟随系统', Icon: SystemThemeIcon },
];

/** 收起时机的两档，语义见 domain/turn_process.js 的 resolveTurnProcessOpen。默认档排在前面。 */
const COLLAPSE_TIMING_OPTIONS = [
  { id: 'completion', label: '回答结束后', hint: '一结束就收起，只留结果与用时。' },
  { id: 'nextInput', label: '下次有新消息时', hint: '刚完成的一轮保持展开，你能直接看到过程。' },
];

/**
 * 通用设置页：「账号」（仅登录鉴权打开时显示）+「外观」+「对话」三组。
 * 账号信息放在主题选择上方；外观与对话偏好都存在本机浏览器，选中即时生效，没有保存按钮。
 * 选中态跟的是「用户选的偏好」，不是当前解析出来的主题——选「跟随系统」时它依然是选中项。
 */
export function GeneralSettingsView({ preference, onPreferenceChange, collapseTiming, onCollapseTimingChange, account }) {
  const authenticated = Boolean(account?.enabled && account?.user);
  return (
    <section className="view active" id="generalSettingsView">
      <header className="main-header settings-header">
        <div>
          <h2>通用设置</h2>
          <p>账号信息、外观与对话展示偏好</p>
        </div>
      </header>
      <div className="settings-workspace">
        {authenticated && (
          <section className="settings-group" aria-labelledby="account-title">
            <h3 className="settings-group-title" id="account-title">账号</h3>
            <div className="account-card">
              <div className="account-card-identity">
                <strong>{account.user.email}</strong>
                <span>
                  {account.user.role === 'admin' ? '管理员' : '普通用户'}
                  {account.user.createdAt ? ` · 注册于 ${formatDate(account.user.createdAt)}` : ''}
                </span>
              </div>
              <div className="account-card-actions">
                <button className="secondary-button" type="button" onClick={account.onChangePassword}>修改密码</button>
                <button className="secondary-button" type="button" onClick={account.onLogout}>退出登录</button>
              </div>
            </div>
          </section>
        )}
        <section className="settings-group" aria-labelledby="appearance-title">
          <h3 className="settings-group-title" id="appearance-title">外观</h3>
          <div className="theme-cubes" role="group" aria-labelledby="appearance-title">
            {THEME_OPTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className="theme-cube"
                type="button"
                aria-pressed={preference === id}
                onClick={() => onPreferenceChange(id)}
              >
                <Icon />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-group" aria-labelledby="conversation-title">
          <h3 className="settings-group-title" id="conversation-title">对话</h3>
          <div className="settings-field">
            <span className="settings-field-label" id="collapse-timing-label">工作步骤收起时机</span>
            <p className="settings-field-hint">
              任务结束后，一次 run 的过程（工具调用、思维链、中间叙述）会折成答案上方的一行。
              失败或被你中止的轮次永远保持展开。
            </p>
            <div className="choice-group" role="group" aria-labelledby="collapse-timing-label">
              {COLLAPSE_TIMING_OPTIONS.map(({ id, label, hint }) => (
                <button
                  key={id}
                  className="choice-option"
                  type="button"
                  aria-pressed={collapseTiming === id}
                  onClick={() => onCollapseTimingChange(id)}
                >
                  <span className="choice-option-label">{label}</span>
                  <span className="choice-option-hint">{hint}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}
