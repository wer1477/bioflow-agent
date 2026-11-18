import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOSAVE_DELAY_MS,
  activePathAfterClose,
  addOpenPath,
  autoSaveTargets,
  applyConflict,
  applyDraft,
  applyRemote,
  applySave,
  autoSavePreferenceValue,
  createFileSession,
  describeFileStatus,
  draftFor,
  dropDraft,
  parseAutoSavePreference,
  removeOpenPath,
  removeSession,
  renameSession,
  shouldAutoSave,
  stashDraft,
  upsertSession,
} from '../src/domain/file_edit.js';

function editableFile(overrides = {}) {
  return {
    path: 'runs/report.md',
    content: 'first',
    encoding: 'utf8',
    mimeType: 'text/markdown',
    version: '5:100',
    size: 5,
    mtimeMs: 100,
    canEdit: true,
    ...overrides,
  };
}

test('a fresh session starts clean and remembers the on-disk copy', () => {
  const session = createFileSession(editableFile());
  assert.equal(session.dirty, false);
  assert.equal(session.savedContent, 'first');
  assert.equal(session.version, '5:100');
  assert.equal(session.conflict, null);
  assert.equal(session.mimeType, 'text/markdown');
});

test('typing marks the session dirty and reverting the text clears it again', () => {
  const session = createFileSession(editableFile());
  const dirty = applyDraft(session, 'second');
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.content, 'second');
  assert.equal(dirty.savedContent, 'first');
  assert.equal(applyDraft(dirty, 'first').dirty, false);
  // 内容没变时返回同一个对象，避免无意义的重渲染。
  assert.equal(applyDraft(dirty, 'second'), dirty);
});

test('saving adopts the new version and clears the dirty flag', () => {
  const saved = applySave(applyDraft(createFileSession(editableFile()), 'second'), { version: '6:120', size: 6, mtimeMs: 120 });
  assert.equal(saved.dirty, false);
  assert.equal(saved.savedContent, 'second');
  assert.equal(saved.version, '6:120');
  assert.equal(saved.size, 6);
});

test('a remote update replaces a clean session but never a dirty one', () => {
  const clean = createFileSession(editableFile());
  const refreshed = applyRemote(clean, { content: 'theirs', version: '7:200', size: 6, mtimeMs: 200 });
  assert.equal(refreshed.content, 'theirs');
  assert.equal(refreshed.savedContent, 'theirs');
  assert.equal(refreshed.version, '7:200');

  const dirty = applyDraft(clean, 'mine');
  assert.equal(applyRemote(dirty, { content: 'theirs', version: '7:200' }), dirty);
});

test('a conflict is recorded without touching the draft', () => {
  const session = applyConflict(applyDraft(createFileSession(editableFile()), 'mine'), { version: '7:200', size: 6, mtimeMs: 200 });
  assert.equal(session.content, 'mine');
  assert.equal(session.dirty, true);
  assert.deepEqual(session.conflict, { version: '7:200', size: 6, mtimeMs: 200 });
});

test('auto save fires only for editable, dirty, conflict-free sessions', () => {
  const dirty = applyDraft(createFileSession(editableFile()), 'mine');
  assert.equal(shouldAutoSave(dirty, { autoSave: true }), true);
  assert.equal(shouldAutoSave(dirty, { autoSave: false }), false);
  assert.equal(shouldAutoSave(dirty, { autoSave: true, saving: true }), false);
  assert.equal(shouldAutoSave(createFileSession(editableFile()), { autoSave: true }), false);
  assert.equal(shouldAutoSave(applyConflict(dirty, { version: '9:1' }), { autoSave: true }), false);
  assert.equal(shouldAutoSave(applyDraft(createFileSession(editableFile({ canEdit: false })), 'x'), { autoSave: true }), false);
  assert.equal(shouldAutoSave(null, { autoSave: true }), false);
});

test('a truncated file is not treated as editable', () => {
  const session = createFileSession(editableFile({ truncated: true, canEdit: false }));
  assert.equal(shouldAutoSave(applyDraft(session, 'mine'), { autoSave: true }), false);
});

test('status label follows conflict > saving > dirty > saved', () => {
  const saved = createFileSession(editableFile());
  assert.deepEqual(describeFileStatus(saved), { label: '已保存', tone: 'saved' });
  assert.deepEqual(describeFileStatus(applyDraft(saved, 'x')), { label: '未保存', tone: 'dirty' });
  assert.deepEqual(describeFileStatus(applyDraft(saved, 'x'), { saving: true }), { label: '保存中…', tone: 'busy' });
  assert.deepEqual(describeFileStatus(applyConflict(applyDraft(saved, 'x'), { version: '1:1' })), { label: '磁盘已更新', tone: 'conflict' });
});

test('drafts survive switching files and disappear once dropped', () => {
  let drafts = new Map();
  const dirty = applyDraft(createFileSession(editableFile()), 'mine');
  drafts = stashDraft(drafts, dirty);
  assert.deepEqual(draftFor(drafts, 'runs/report.md'), { content: 'mine', version: '5:100' });

  // 干净的文件不进草稿表。
  const clean = createFileSession(editableFile({ path: 'other.md' }));
  assert.equal(stashDraft(drafts, clean), drafts);

  const dropped = dropDraft(drafts, 'runs/report.md');
  assert.equal(draftFor(dropped, 'runs/report.md'), null);
  assert.equal(draftFor(drafts, 'runs/report.md').content, 'mine');
});

test('auto-save preference only turns off on an explicit off value', () => {
  assert.equal(parseAutoSavePreference('off'), false);
  assert.equal(parseAutoSavePreference('on'), true);
  assert.equal(parseAutoSavePreference(null), true);
  assert.equal(parseAutoSavePreference('garbage'), true);
  assert.equal(autoSavePreferenceValue(false), 'off');
  assert.equal(autoSavePreferenceValue(true), 'on');
  assert.ok(AUTOSAVE_DELAY_MS >= 300);
});

test('opening a path appends a tab exactly once', () => {
  assert.deepEqual(addOpenPath([], 'a.md'), ['a.md']);
  assert.deepEqual(addOpenPath(['a.md'], 'b.md'), ['a.md', 'b.md']);
  assert.deepEqual(addOpenPath(['a.md'], 'a.md'), ['a.md']);
  assert.deepEqual(addOpenPath(['a.md'], ''), ['a.md']);
  assert.deepEqual(removeOpenPath(['a.md', 'b.md'], 'a.md'), ['b.md']);
});

test('closing a tab activates its left neighbour, else the right one, else the project tab', () => {
  assert.equal(activePathAfterClose(['a', 'b', 'c'], ['b']), 'a');
  assert.equal(activePathAfterClose(['a', 'b', 'c'], ['a']), 'b');
  assert.equal(activePathAfterClose(['a', 'b', 'c'], ['c']), 'b');
  assert.equal(activePathAfterClose(['a'], ['a']), '');
  assert.equal(activePathAfterClose([], ['a']), '');
});

test('closing a directory of tabs keeps a surviving neighbour active', () => {
  assert.equal(activePathAfterClose(['keep', 'dir/a', 'dir/b', 'last'], ['dir/a', 'dir/b']), 'keep');
  assert.equal(activePathAfterClose(['dir/a', 'dir/b', 'last'], ['dir/a', 'dir/b']), 'last');
  assert.equal(activePathAfterClose(['dir/a'], ['dir/a']), '');
});

test('session maps are immutable and keep drafts when a file is renamed', () => {
  const sessions = new Map();
  const a = { ...createFileSession(editableFile()), content: 'draft', dirty: true };
  const withA = upsertSession(sessions, a);
  assert.equal(sessions.size, 0, 'upsert 不修改原 Map');
  assert.equal(withA.get('runs/report.md').content, 'draft');

  const renamed = renameSession(withA, 'runs/report.md', 'runs/renamed.md');
  assert.equal(renamed.has('runs/report.md'), false);
  assert.equal(renamed.get('runs/renamed.md').path, 'runs/renamed.md');
  assert.equal(renamed.get('runs/renamed.md').content, 'draft');
  assert.equal(renamed.get('runs/renamed.md').dirty, true);

  assert.equal(removeSession(renamed, 'runs/renamed.md').size, 0);
  assert.equal(renameSession(renamed, 'missing.md', 'x.md'), renamed);
});

test('auto save targets only the sessions that should be written', () => {
  const clean = createFileSession(editableFile({ path: 'clean.md' }));
  const dirty = applyDraft(createFileSession(editableFile({ path: 'dirty.md' })), 'x');
  const conflicted = applyConflict(applyDraft(createFileSession(editableFile({ path: 'conflict.md' })), 'x'), { version: '1:1' });
  const readOnly = applyDraft(createFileSession(editableFile({ path: 'ro.md', canEdit: false })), 'x');
  const sessions = new Map([clean, dirty, conflicted, readOnly].map((session) => [session.path, session]));

  assert.deepEqual(autoSaveTargets(sessions, { autoSave: true }).map((s) => s.path), ['dirty.md']);
  assert.deepEqual(autoSaveTargets(sessions, { autoSave: false }), []);
  assert.deepEqual(autoSaveTargets(sessions, { autoSave: true, savingPaths: new Set(['dirty.md']) }), []);
  assert.deepEqual(autoSaveTargets(null, { autoSave: true }), []);
});
