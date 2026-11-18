import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { createWorkspaceArtifact } from '../config/workspace_artifact_store.js';
import { writeProjectFile } from '../config/project_files.js';
import { resolveToolRoot } from './project_paths.js';
import { normalizeTodoItems, PanelValidationError, type TodoItem } from '../conversation_panels.js';

function missingConversationResult(): string {
  return JSON.stringify({ ok: false, error: 'A conversation bound to a project directory is required before using project tools.' });
}

/**
 * Validate the to-do list a tool call submitted.
 *
 * Two rules go beyond the shared normalizer: the list must not be empty (an empty
 * replacement means "clear", which `action=complete` already says explicitly), and at
 * most one item may be `in_progress`. The runtime executes tools one at a time, so a
 * second active task is always a modelling mistake — failing loudly keeps the durable
 * list honest instead of letting the UI pick an arbitrary "current" row.
 */
function readTodoList(value: unknown): TodoItem[] {
  const todos = normalizeTodoItems(value);
  if (!todos.length) {
    throw new PanelValidationError('update_todo requires at least one todo item', 'TODO_EMPTY');
  }
  const active = todos.filter((todo) => todo.status === 'in_progress').length;
  if (active > 1) {
    throw new PanelValidationError(
      `at most one todo may be in_progress (got ${active})`,
      'TODO_MULTIPLE_IN_PROGRESS',
    );
  }
  return todos;
}

/** Same contract as `readTodoList`, but a plan draft may legitimately carry no list. */
function readOptionalTodoList(value: unknown): TodoItem[] {
  try {
    return normalizeTodoItems(value);
  } catch {
    return [];
  }
}


export function executePlanningTool(args: Record<string, unknown>, context: CoreToolExecutionContext): string {
  const action = String(args.action || '').trim();
  const title = String(args.title || '').trim() || '任务规划';

  if (action === 'clarify') {
    const questions = normalizePlanningQuestions(args.questions);
    if (!questions.length) {
      return JSON.stringify({ ok: false, error: 'planning clarify requires at least one question.' });
    }
    return JSON.stringify({
      ok: true,
      action,
      uiEvent: {
        type: 'planning_panel',
        panel: 'clarify',
        status: 'waiting',
        title,
        questions,
      },
      instruction: 'Stop after showing this panel. Wait for the user confirmation message before continuing.',
    });
  }

  if (action === 'publish_plan') {
    if (!context.conversationId) return missingConversationResult();
    const markdown = String(args.markdown || '').trim();
    if (!markdown) {
      return JSON.stringify({ ok: false, error: 'planning publish_plan requires markdown content.' });
    }
    const fileName = normalizePlanFileName(args.file_name || title);
    const projectPath = resolveToolRoot(context);
    const relativePath = `planning/${fileName}`;
    const file = writeProjectFile(projectPath, relativePath, markdown);
    const artifact = createWorkspaceArtifact({
      conversationId: context.conversationId,
      scope: 'planning',
      planId: null,
      executionId: null,
      type: 'plan',
      title: fileName,
      path: relativePath,
      mimeType: file.mimeType,
      summary: title,
      tags: ['planning', 'plan-md'],
      status: 'ready',
      createdByAgentId: context.agent?.id || null,
      metadata: { source: 'planning-core-tool' },
    });
    return JSON.stringify({
      ok: true,
      action,
      file: {
        id: artifact.id,
        title: artifact.title,
        path: file.absolutePath,
        workspacePath: relativePath,
        type: artifact.type,
        mimeType: artifact.mimeType,
      },
      uiEvent: {
        type: 'planning_panel',
        panel: 'plan',
        status: 'waiting',
        title,
        markdown,
        filePath: relativePath,
        todos: readOptionalTodoList(args.todos),
      },
      instruction: 'Stop after publishing this plan. Continue only after the user approves it or provides modification feedback.',
    });
  }

  if (action === 'update_todo') {
    let todos: TodoItem[];
    try {
      todos = readTodoList(args.todos);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return JSON.stringify({
      ok: true,
      action,
      uiEvent: {
        type: 'planning_panel',
        panel: 'todo',
        status: 'active',
        title,
        todos,
        note: String(args.note || '').trim(),
      },
    });
  }

  if (action === 'complete') {
    return JSON.stringify({
      ok: true,
      action,
      uiEvent: {
        type: 'planning_panel',
        panel: 'todo',
        status: 'complete',
        title,
        todos: [],
        note: String(args.note || '').trim(),
      },
    });
  }

  return JSON.stringify({ ok: false, error: 'planning action must be clarify, publish_plan, update_todo, or complete.' });
}


function normalizePlanningQuestions(value: unknown): Array<{ id: string; question: string; options: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = isPlainRecord(item) ? item : {};
      const question = String(record.question || '').trim();
      const options = Array.isArray(record.options)
        ? record.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 3)
        : [];
      if (!question || options.length !== 3) return null;
      const id = String(record.id || `q${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || `q${index + 1}`;
      return { id, question, options };
    })
    .filter(Boolean) as Array<{ id: string; question: string; options: string[] }>;
}


function normalizePlanFileName(value: unknown): string {
  const base = String(value || 'plan')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[<>:"|?*\u0000-\u001f\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plan';
  return `${base}.md`;
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
