import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import {
  createConversation,
  getConversation,
} from '../src/agent/config/conversation_service.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import { describeTeam, ensureRoleSession } from '../src/agent/team/team_service.js';
import { findSessionProjectKey } from '../src/agent/config/conversation_file_store.js';
import { llmOverridesFilePath } from '../src/agent/config/session_paths.js';
import { getAllLLMProviders, type LLMProvider } from '../src/agent/config/llm_config_store.js';
import {
  clearSessionLlmOverride,
  readSessionLlmOverride,
  resolveSessionRootId,
  setSessionLlmOverride,
} from '../src/agent/config/session_llm_override_store.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * The shipped providers read their credentials from the environment, and `resolve()`
 * interpolates them. Tests only need the reference to exist, never a real key.
 */
function satisfyCredentialReferences(): void {
  for (const provider of getAllLLMProviders()) {
    for (const match of (provider.apiKey || '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (process.env[match[1]] === undefined) process.env[match[1]] = 'test-key';
    }
  }
}

/**
 * A provider no other role resolves with right now, so "the override changed the answer"
 * is visible. Expectations are derived from a live resolution rather than from
 * `agents.json`: config-editing suites rewrite that file while this one runs, and a value
 * read before the override can be stale by the time the overridden run resolves.
 */
function alternateProvider(exclude: Set<string>): LLMProvider {
  const provider = getAllLLMProviders().find((candidate) => candidate.model && !exclude.has(candidate.id));
  assert.ok(provider, 'the configuration has a provider outside the excluded set');
  return provider;
}

function overrideTriple(provider: LLMProvider): { providerId: string; modelId: string; thinkingLevel?: string } {
  return {
    providerId: provider.id,
    modelId: provider.model,
    ...(provider.thinkingLevelName ? { thinkingLevel: provider.thinkingLevelName } : {}),
  };
}

satisfyCredentialReferences();

function overridesFile(rootId: string): string {
  const projectKey = findSessionProjectKey(rootId);
  assert.ok(projectKey, 'the root has a session directory');
  return llmOverridesFilePath(projectKey, rootId);
}

async function withServer(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('session overrides round-trip per role and never touch the shared config', (t) => {
  const project = createTempProject('llm-override-store');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const alternate = alternateProvider(new Set());

  assert.equal(readSessionLlmOverride(root.id, 'pi'), null);

  setSessionLlmOverride(root.id, 'pi', overrideTriple(alternate));
  setSessionLlmOverride(root.id, 'searcher', { providerId: alternate.id, modelId: alternate.model });

  const pi = readSessionLlmOverride(root.id, 'pi');
  assert.equal(pi?.providerId, alternate.id);
  assert.equal(pi?.modelId, alternate.model);
  assert.equal(pi?.thinkingLevel, alternate.thinkingLevelName);
  assert.equal(readSessionLlmOverride(root.id, 'searcher')?.thinkingLevel, undefined);
  assert.equal(readSessionLlmOverride(root.id, 'writer'), null);

  // One file per session, keyed by role, and nothing is written into the shared config.
  const raw = JSON.parse(fs.readFileSync(overridesFile(root.id), 'utf8')) as { schemaVersion: number; roles: Record<string, unknown> };
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(Object.keys(raw.roles).sort(), ['pi', 'searcher']);

  assert.equal(clearSessionLlmOverride(root.id, 'pi'), true);
  assert.equal(clearSessionLlmOverride(root.id, 'pi'), false);
  assert.equal(readSessionLlmOverride(root.id, 'pi'), null);
  assert.equal(readSessionLlmOverride(root.id, 'searcher')?.providerId, alternate.id);
});

test('a broken overrides file degrades to "no override" instead of failing the session', (t) => {
  const project = createTempProject('llm-override-broken');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const alternate = alternateProvider(new Set());

  fs.mkdirSync(path.dirname(overridesFile(root.id)), { recursive: true });
  fs.writeFileSync(overridesFile(root.id), '{ not json', 'utf8');
  assert.equal(readSessionLlmOverride(root.id, 'pi'), null);

  // An unknown role in a hand-edited file is dropped rather than trusted.
  fs.writeFileSync(overridesFile(root.id), JSON.stringify({
    schemaVersion: 1,
    roles: { hacker: { providerId: alternate.id }, pi: { providerId: alternate.id, modelId: alternate.model } },
  }), 'utf8');
  assert.equal(readSessionLlmOverride(root.id, 'pi')?.modelId, alternate.model);
  assert.equal(readSessionLlmOverride(root.id, 'hacker' as never), null);
});

test('the override wins over the role binding, and only for its own role', (t) => {
  const project = createTempProject('llm-override-resolve');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const piSession = ensureRoleSession(root.id, 'pi');
  const searcherSession = ensureRoleSession(root.id, 'searcher');

  const before = agentContextResolver.resolve({ conversationId: piSession.id, agentId: 'pi' });
  const alternate = alternateProvider(new Set([before.llmProvider.id]));

  setSessionLlmOverride(root.id, 'pi', overrideTriple(alternate));

  const after = agentContextResolver.resolve({ conversationId: piSession.id, agentId: 'pi' });
  assert.equal(after.llmProvider.id, alternate.id, 'the session override replaces the binding');
  assert.equal(after.llm.model, alternate.model);
  if (alternate.thinkingWire !== undefined) {
    assert.equal(after.llm.thinking?.wire, alternate.thinkingWire);
  }

  // The other role keeps its own resolution: the override is keyed by role, not by session.
  const other = agentContextResolver.resolve({ conversationId: searcherSession.id, agentId: 'searcher' });
  assert.equal(readSessionLlmOverride(root.id, 'searcher'), null);
  assert.notEqual(other.llmProvider.id, alternate.id);

  clearSessionLlmOverride(root.id, 'pi');
  const restored = agentContextResolver.resolve({ conversationId: piSession.id, agentId: 'pi' });
  assert.notEqual(restored.llmProvider.id, alternate.id, 'clearing falls back to the binding');
});

test('a delegated child inherits the model of the role that created it', (t) => {
  const project = createTempProject('llm-override-child');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const piSession = ensureRoleSession(root.id, 'pi');
  const parentBefore = agentContextResolver.resolve({ conversationId: piSession.id, agentId: 'pi' });
  const alternate = alternateProvider(new Set([parentBefore.llmProvider.id]));
  setSessionLlmOverride(root.id, 'pi', overrideTriple(alternate));

  const child = createConversation({
    title: 'Subagent · probe',
    projectPath: project.projectPath,
    parentConversationId: piSession.id,
    agentId: 'pi',
    subagentDepth: 1,
  });
  assert.equal(resolveSessionRootId(child.id), root.id, 'the walk crosses the role session');

  const context = agentContextResolver.resolve({ conversationId: child.id, agentId: 'pi' });
  assert.equal(context.llmProvider.id, alternate.id);
  assert.equal(context.llm.model, alternate.model);
});

test('the team view reports each role selection with its source', (t) => {
  const project = createTempProject('llm-override-view');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const before = describeTeam(root.id);
  assert.ok(before);
  const pi = before.roles.find((role) => role.id === 'pi');
  assert.equal(pi?.llm.source, 'role');
  assert.equal(pi?.llm.override, null);
  assert.equal(pi?.llm.routable, true);
  assert.ok(pi?.llm.selection.providerId);

  const alternate = alternateProvider(new Set([pi?.llm.selection.providerId]));
  setSessionLlmOverride(root.id, 'pi', overrideTriple(alternate));

  const after = describeTeam(root.id);
  const updated = after?.roles.find((role) => role.id === 'pi');
  assert.equal(updated?.llm.source, 'session');
  assert.equal(updated?.llm.selection.providerId, alternate.id);
  assert.equal(updated?.llm.selection.modelId, alternate.model);
  assert.equal(updated?.llm.selection.thinkingLevel, alternate.thinkingLevelName);
  assert.equal(updated?.llm.override?.providerId, alternate.id);
  assert.equal(after?.roles.find((role) => role.id === 'searcher')?.llm.override, null);
});

test('the team view keeps a saved selection that no longer resolves', (t) => {
  const project = createTempProject('llm-override-stale');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  // Hand-edited: a provider that was deleted after the picker wrote it.
  fs.mkdirSync(path.dirname(overridesFile(root.id)), { recursive: true });
  fs.writeFileSync(overridesFile(root.id), JSON.stringify({
    schemaVersion: 1,
    roles: { pi: { providerId: 'ghost', modelId: 'ghost-model', updatedAt: new Date().toISOString() } },
  }), 'utf8');

  const team = describeTeam(root.id);
  const pi = team?.roles.find((role) => role.id === 'pi');
  assert.equal(pi?.llm.routable, false);
  assert.equal(pi?.llm.source, 'session');
  assert.equal(pi?.llm.selection.providerId, 'ghost');
  assert.equal(pi?.llm.selection.modelId, 'ghost-model');
});

test('PUT and DELETE /:id/llm-override validate the triple and the role', async (t) => {
  const origin = await withServer(t);
  const project = createTempProject('llm-override-route');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const piSession = ensureRoleSession(root.id, 'pi');
  const searcherSession = ensureRoleSession(root.id, 'searcher');
  const alternate = alternateProvider(new Set());

  const put = await fetch(`${origin}/api/conversations/${root.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(overrideTriple(alternate)),
  });
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.override.providerId, alternate.id);
  const pi = body.team.roles.find((role: { id: string }) => role.id === 'pi');
  assert.equal(pi.llm.source, 'session');
  assert.equal(pi.llm.selection.modelId, alternate.model);

  const unknownProvider = await fetch(`${origin}/api/conversations/${root.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'ghost', modelId: alternate.model }),
  });
  assert.equal(unknownProvider.status, 400);

  const unknownModel = await fetch(`${origin}/api/conversations/${root.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: alternate.id, modelId: 'not-a-model' }),
  });
  assert.equal(unknownModel.status, 400);

  const unknownLevel = await fetch(`${origin}/api/conversations/${root.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: alternate.id, modelId: alternate.model, thinkingLevel: 'not-a-level' }),
  });
  assert.equal(unknownLevel.status, 400);

  // A role session speaks for its own role only.
  const wrongRole = await fetch(`${origin}/api/conversations/${searcherSession.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleId: 'writer', ...overrideTriple(alternate) }),
  });
  assert.equal(wrongRole.status, 400);

  // The role session writes the same slot the root reads.
  const viaRoleSession = await fetch(`${origin}/api/conversations/${piSession.id}/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(overrideTriple(alternate)),
  });
  assert.equal(viaRoleSession.status, 200);
  assert.equal(readSessionLlmOverride(root.id, 'pi')?.modelId, alternate.model);

  const del = await fetch(`${origin}/api/conversations/${root.id}/llm-override?roleId=pi`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(readSessionLlmOverride(root.id, 'pi'), null);
  const deleted = await del.json();
  assert.equal(deleted.team.roles.find((role: { id: string }) => role.id === 'pi').llm.source, 'role');

  const missing = await fetch(`${origin}/api/conversations/does-not-exist/llm-override`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: alternate.id }),
  });
  assert.equal(missing.status, 404);
});
