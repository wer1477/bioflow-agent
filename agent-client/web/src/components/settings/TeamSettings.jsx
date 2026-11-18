import { useEffect, useState } from 'react';
import { apiJson } from '../../api.js';
import { Field, PlainSelect, SelectField } from './fields.jsx';

/**
 * Team-level policy. Role membership is fixed, so this page edits routing and concurrency
 * only; each role's model, prompt and capability bindings live on the Agent page.
 */
export function TeamSettings({ settings, applySettingsResponse, toast }) {
  const team = settings.team || {};
  const roles = settings.agents || [];
  const [draft, setDraft] = useState(() => draftFor(team));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFor(team));
  }, [team.leadRoleId, team.router?.engine, team.router?.fallbackRoleId, team.limits?.maxConcurrentDispatches]);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      applySettingsResponse(await apiJson('/api/config/manage/team', {
        method: 'PUT',
        body: JSON.stringify(draft),
      }));
      toast.success('团队策略已保存并重载。');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请检查配置后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-layout agent-settings-layout configuration-canvas">
      <section className="panel agent-directory-panel">
        <div className="panel-heading agent-directory-heading">
          <div>
            <span className="section-kicker">TEAM ROSTER</span>
            <h3>角色</h3>
          </div>
          <span className="count-badge">{roles.length}</span>
        </div>
        <div className="agent-menu">
          {roles.map((role) => (
            <button key={role.id} type="button" className={role.id === team.leadRoleId ? 'active' : ''} disabled>
              <strong>{role.label || role.id}</strong>
              <span>{role.id === team.leadRoleId ? `${role.name} · 负责人` : role.name}</span>
            </button>
          ))}
        </div>
        <p className="team-hint">角色的模型、指令与能力绑定在「Agent 配置」页修改。</p>
      </section>
      <section className="panel agent-editor-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">TEAM POLICY</span>
            <h3>团队策略</h3>
          </div>
          <div className="button-row">
            <button className="primary-button" type="submit" form="teamForm" disabled={saving}>{saving ? '保存中…' : '保存策略'}</button>
          </div>
        </div>
        <form id="teamForm" className="stack" onSubmit={save}>
          <fieldset className="config-section">
            <legend>
              <span className="config-section-index">01</span>
              <span><strong>路由</strong><small>决定一条用户消息交给哪个角色。</small></span>
            </legend>
            <div className="form-grid">
              <SelectField
                label="路由引擎"
                value={draft.router.engine}
                rows={ROUTER_ENGINES}
                onChange={(value) => setDraft({ ...draft, router: { ...draft.router, engine: value } })}
              />
              <SelectField
                label="兜底角色"
                value={draft.router.fallbackRoleId}
                rows={roles.map((role) => ({ id: role.id, name: role.label || role.id }))}
                onChange={(value) => setDraft({ ...draft, router: { ...draft.router, fallbackRoleId: value } })}
              />
              <SelectField
                label="负责人"
                value={draft.leadRoleId}
                rows={roles.map((role) => ({ id: role.id, name: role.label || role.id }))}
                onChange={(value) => setDraft({ ...draft, leadRoleId: value })}
              />
            </div>
            <p className="team-hint">
              always-pi：所有消息交给负责人。rules+llm 与 biod 为预留引擎，未接入时会自动回落到兜底角色。
            </p>
          </fieldset>
          <fieldset className="config-section">
            <legend>
              <span className="config-section-index">02</span>
              <span><strong>委派</strong><small>只限制同时进行的委派数量，不限制总工作量。</small></span>
            </legend>
            <div className="form-grid">
              <Field
                label="并行委派上限"
                value={String(draft.limits.maxConcurrentDispatches)}
                onChange={(value) => setDraft({ ...draft, limits: { ...draft.limits, maxConcurrentDispatches: Number(value) || 1 } })}
              />
            </div>
            <p className="team-hint">
              负责人（{roles.find((role) => role.id === team.leadRoleId)?.label || 'PI'}）可以用 team_message 把任务派给其他角色；
              对方在自己的会话里执行，结束后交回负责人验收。
            </p>
          </fieldset>
        </form>
      </section>
    </div>
  );
}

const ROUTER_ENGINES = [
  { id: 'always-pi', name: 'always-pi（全部交给负责人）' },
  { id: 'rules+llm', name: 'rules+llm（规则优先，模型兜底）' },
  { id: 'biod', name: 'biod（本地决策模型）' },
];

function draftFor(team) {
  return {
    leadRoleId: team.leadRoleId || 'pi',
    router: {
      engine: team.router?.engine || 'always-pi',
      fallbackRoleId: team.router?.fallbackRoleId || 'pi',
    },
    limits: {
      maxConcurrentDispatches: team.limits?.maxConcurrentDispatches || 3,
    },
  };
}
