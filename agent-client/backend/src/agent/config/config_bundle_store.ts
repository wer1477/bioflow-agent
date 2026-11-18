import { getRawLLMProviders, replaceLLMProviders } from './llm_config_store.js';
import { getAllMCPServers, replaceMCPServers, type MCPServer } from './mcp_config_store.js';
import { createSystemPrompt, getAllSystemPrompts, getSystemPrompt, updateSystemPrompt, type SystemPrompt } from './prompt_config_store.js';
import { createSkill, getAllSkills, type Skill } from './skill_config_store.js';

export interface ExportData {
  llmProviders: Record<string, unknown>[];
  mcpServers: MCPServer[];
  systemPrompts: SystemPrompt[];
  skills: Skill[];
  version: string;
}

export function exportAllConfig(): ExportData {
  return {
    llmProviders: getRawLLMProviders(),
    mcpServers: getAllMCPServers(),
    systemPrompts: getAllSystemPrompts(),
    skills: getAllSkills(),
    version: '0.1.0',
  };
}

/** Imports into the same file-backed configuration sources used by the runtime. */
export function importConfig(data: ExportData): void {
  if (data.llmProviders) replaceLLMProviders(data.llmProviders);
  if (data.mcpServers) replaceMCPServers(data.mcpServers);

  const existingSkills = new Set(getAllSkills().map((skill) => skill.id));
  for (const skill of data.skills || []) {
    if (existingSkills.has(skill.id)) continue;
    createSkill({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      resources: skill.resources,
      enabled: skill.enabled,
      promptId: skill.promptId,
      examples: skill.examples,
      isBuiltin: skill.isBuiltin,
    });
  }

  for (const prompt of data.systemPrompts || []) {
    const existing = getSystemPrompt(prompt.id);
    if (existing) {
      updateSystemPrompt(prompt.id, prompt);
    } else {
      createSystemPrompt({
        name: prompt.name,
        description: prompt.description,
        content: prompt.content,
        tags: prompt.tags,
        variables: prompt.variables,
        isDefault: prompt.isDefault,
      });
    }
  }
}
