import { parse as parseYaml } from 'yaml';
import type { PlanStep } from './contracts.js';

/**
 * Parses the one machine-readable `plan-steps` block a Researcher appends to a design
 * document. There is deliberately no Markdown heuristic and no model call here: a missing
 * or invalid block is a visible failure, not a guessed step list.
 */

export type PlanStepsParseResult =
  | { ok: true; steps: PlanStep[] }
  | { ok: false; reason: 'missing_plan_steps' | 'invalid_plan_steps'; message: string };

const BLOCK = /```plan-steps[^\n]*\r?\n([\s\S]*?)```/;
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_STEPS = 64;
const MAX_LIST_ITEMS = 8;
const MAX_CONSTRAINTS = 6;

class InvalidPlanSteps extends Error {}

export function parsePlanSteps(markdown: string): PlanStepsParseResult {
  const text = String(markdown ?? '');
  const match = BLOCK.exec(text);
  if (!match) {
    if (text.includes('```plan-steps')) {
      return { ok: false, reason: 'invalid_plan_steps', message: 'the plan-steps block is not closed with ```' };
    }
    return {
      ok: false,
      reason: 'missing_plan_steps',
      message: 'append a ```plan-steps block with a version and steps array to the design document',
    };
  }

  let document: unknown;
  try {
    document = parseYaml(match[1]);
  } catch (error) {
    return { ok: false, reason: 'invalid_plan_steps', message: `YAML: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    return { ok: true, steps: readDocument(document) };
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_plan_steps',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function readDocument(value: unknown): PlanStep[] {
  const record = recordValue(value, 'plan-steps');
  if (record.version !== 1) throw new InvalidPlanSteps('version must be 1');
  const rawSteps = record.steps;
  if (!Array.isArray(rawSteps)) throw new InvalidPlanSteps('steps must be an array');
  if (rawSteps.length === 0) throw new InvalidPlanSteps('steps must not be empty');
  if (rawSteps.length > MAX_STEPS) throw new InvalidPlanSteps(`steps must contain at most ${MAX_STEPS} items`);

  const seen = new Set<string>();
  return rawSteps.map((item, index) => {
    const step = readStep(item, index);
    if (seen.has(step.id)) throw new InvalidPlanSteps(`steps[${index}].id duplicates ${JSON.stringify(step.id)}`);
    seen.add(step.id);
    return step;
  });
}

function readStep(value: unknown, index: number): PlanStep {
  const prefix = `steps[${index}]`;
  const record = recordValue(value, prefix);
  const id = stringValue(record.id, `${prefix}.id`, 1, 32);
  if (!STEP_ID.test(id)) {
    throw new InvalidPlanSteps(`${prefix}.id must match ${STEP_ID.source}`);
  }
  const goal = stringValue(record.goal, `${prefix}.goal`, 1, 200);
  const inputs = stringList(record.inputs, `${prefix}.inputs`, MAX_LIST_ITEMS, 120);
  const outputs = stringList(record.outputs, `${prefix}.outputs`, MAX_LIST_ITEMS, 120);
  const constraints = optionalStringList(record.constraints, `${prefix}.constraints`, MAX_CONSTRAINTS, 80);
  const currentToolId = optionalStringValue(record.current_tool, `${prefix}.current_tool`, 200);
  const currentApproach = optionalStringValue(record.current_approach, `${prefix}.current_approach`, 200);
  return { id, goal, inputs, outputs, currentToolId, currentApproach, constraints };
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPlanSteps(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new InvalidPlanSteps(`${field} must be a string`);
  const text = value.trim();
  if (text.length < min) throw new InvalidPlanSteps(`${field} must not be empty`);
  if (text.length > max) throw new InvalidPlanSteps(`${field} is longer than ${max} characters`);
  return text;
}

function optionalStringValue(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidPlanSteps(`${field} must be a string or null`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new InvalidPlanSteps(`${field} is longer than ${max} characters`);
  return text;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new InvalidPlanSteps(`${field} must be an array`);
  if (value.length > maxItems) throw new InvalidPlanSteps(`${field} must contain at most ${maxItems} items`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`, 1, maxLength));
}

function optionalStringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  return stringList(value, field, maxItems, maxLength);
}
