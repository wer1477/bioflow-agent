import { useCallback, useMemo, useState } from 'react';
import { apiJson } from '../api.js';

/** The role named by `team.leadRoleId`, falling back to the first configured role. */
function leadAgent(agents, team) {
  const leadRoleId = team?.leadRoleId;
  return agents.find((agent) => agent.id === leadRoleId);
}

export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');

  const agents = useMemo(() => settings?.agents || [], [settings]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || leadAgent(agents, settings?.team) || agents[0],
    [agents, selectedAgentId, settings],
  );

  const loadSettings = useCallback(async () => {
    const data = await apiJson('/api/settings');
    setSettings(data);
    setSelectedAgentId((previous) => {
      const rows = data.agents || [];
      if (rows.some((agent) => agent.id === previous)) return previous;
      return leadAgent(rows, data.team)?.id || rows[0]?.id || '';
    });
    return data;
  }, []);

  const applySettingsResponse = useCallback((data) => {
    const next = data?.settings || data;
    setSettings(next);
    setSelectedAgentId((previous) => {
      const rows = next?.agents || [];
      if (rows.some((agent) => agent.id === previous)) return previous;
      return leadAgent(rows, next?.team)?.id || rows[0]?.id || '';
    });
  }, []);

  const reloadSettings = useCallback(async () => {
    applySettingsResponse(await apiJson('/api/settings/reload', { method: 'POST' }));
  }, [applySettingsResponse]);

  return {
    settings,
    setSettings,
    selectedAgentId,
    setSelectedAgentId,
    agents,
    selectedAgent,
    loadSettings,
    applySettingsResponse,
    reloadSettings,
  };
}
