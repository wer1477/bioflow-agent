export const SHELL_CORE_TOOL_ID = 'shell';
export const FILE_CORE_TOOL_ID = 'file';
export const SEARCH_CORE_TOOL_ID = 'search';
export const EXEC_COMMAND_TOOL_NAME = 'exec_command';
export const SHELL_OUTPUT_TOOL_NAME = 'shell_output';
export const SHELL_KILL_TOOL_NAME = 'shell_kill';
export const EXECUTE_PYTHON_TOOL_NAME = 'execute_python';
export const READ_FILE_TOOL_NAME = 'read_file';
export const WRITE_FILE_TOOL_NAME = 'write_file';
export const EDIT_FILE_TOOL_NAME = 'edit_file';
export const APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const GLOB_TOOL_NAME = 'glob';
export const GREP_TOOL_NAME = 'grep';
export const WEB_FETCH_TOOL_NAME = 'web_fetch';
export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const PLANNING_TOOL_NAME = 'planning';
/**
 * One CoreTool definition, two public tools: `toollibrary` browses the two-level
 * capability catalog and `toolload` loads one concrete capability from it.
 */
export const TOOLLIBRARY_CORE_TOOL_ID = 'toollibrary';
export const TOOLLIBRARY_TOOL_NAME = 'toollibrary';
export const TOOLLOAD_TOOL_NAME = 'toolload';
export const KNOWLEDGEBASE_TOOL_NAME = 'knowledgebase';
export const SUBAGENT_TOOL_NAME = 'subagent';
/** Team messaging: one tool, intent chosen by the `action` discriminator. */
export const TEAM_MESSAGE_CORE_TOOL_ID = 'team_message';
export const TEAM_MESSAGE_TOOL_NAME = 'team_message';
export const GOAL_CORE_TOOL_ID = 'goal';
export const GET_GOAL_TOOL_NAME = 'get_goal';
export const CREATE_GOAL_TOOL_NAME = 'create_goal';
export const UPDATE_GOAL_TOOL_NAME = 'update_goal';
