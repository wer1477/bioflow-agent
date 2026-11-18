import { SETTINGS_TABS } from '../../constants.js';
import { AgentSettings } from './AgentSettings.jsx';
import { KnowledgebaseSettings } from './KnowledgebaseSettings.jsx';
import { LlmSettings } from './LlmSettings.jsx';
import { TeamSettings } from './TeamSettings.jsx';
import { AdminUsersView } from './AdminUsersView.jsx';
import { FeedbackInboxView } from './FeedbackInboxView.jsx';
import { ToolLibrarySettings } from './ToolLibrarySettings.jsx';

/**
 * 设置控制台。登录鉴权打开时按角色裁剪：
 * - 普通用户看不到「团队」「用户与审计」「意见反馈」；Tool Library / Knowledgebase 保持可见。
 * - 管理员看到全部 tab。
 * - 鉴权关闭（开发实例）时行为与原来一致，但反馈属于登录版能力，始终不出现。
 */
export function SettingsView({ tab, onTabChange, settings, selectedAgentId, onSelectedAgentChange, onReload, applySettingsResponse, toast, account, userLlm }) {
  const authEnabled = Boolean(account?.enabled);
  const isAdmin = !authEnabled || account?.user?.role === 'admin';
  const userScope = !isAdmin;
  const tabs = SETTINGS_TABS.filter(([id]) => {
    if (id === 'feedback') return authEnabled && isAdmin;
    return isAdmin || !['team', 'admin'].includes(id);
  });
  const activeTab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const agentCount = settings?.agents?.length || 0;
  const skillCount = settings?.skills?.length || 0;
  return (
    <section className="view active" id="settingsView">
      <header className="main-header settings-header">
        <div>
          <span className="section-kicker">CONFIGURATION CONSOLE</span>
          <h2>Agent 设置</h2>
          <p>配置会写回后端配置文件并重新加载运行时上下文</p>
        </div>
        <div className="settings-header-actions">
          {settings && <div className="runtime-status" aria-label="当前配置已就绪">
            <span className="status-dot" aria-hidden="true" />
            <span>配置就绪</span>
            <span className="runtime-status-detail">{agentCount} Agents · {skillCount} Skills</span>
          </div>}
          <button className="secondary-button" type="button" onClick={onReload}>重载配置</button>
        </div>
      </header>
      <nav className="settings-tabs" aria-label="设置分类">
        {tabs.map(([id, label]) => (
          <button key={id} className={`settings-tab${activeTab === id ? ' active' : ''}`} type="button" aria-current={activeTab === id ? 'page' : undefined} onClick={() => onTabChange(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-workspace">
        {!settings ? <section className="panel">正在加载设置</section> : (
          <>
            {activeTab === 'agent' && (
              <AgentSettings
                settings={settings}
                selectedAgentId={selectedAgentId}
                onSelectedAgentChange={onSelectedAgentChange}
                applySettingsResponse={applySettingsResponse}
                toast={toast}
                userScope={userScope}
                userLlm={userLlm}
              />
            )}
            {activeTab === 'team' && <TeamSettings settings={settings} applySettingsResponse={applySettingsResponse} toast={toast} />}
            {activeTab === 'llm' && (
              <LlmSettings
                settings={settings}
                applySettingsResponse={applySettingsResponse}
                toast={toast}
                userScope={userScope}
                userLlm={userLlm}
                onUserLlmChange={userLlm?.apply}
              />
            )}
            {activeTab === 'library' && <ToolLibrarySettings library={settings.toolLibrary} />}
            {activeTab === 'knowledgebase' && <KnowledgebaseSettings knowledgeBase={settings.knowledgeBase} />}
            {activeTab === 'admin' && <AdminUsersView toast={toast} account={account} />}
            {activeTab === 'feedback' && <FeedbackInboxView toast={toast} />}
          </>
        )}
      </div>
    </section>
  );
}
