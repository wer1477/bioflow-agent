import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ProjectFileConflictError,
  readProjectFile,
  writeProjectFile,
} from '../src/agent/config/project_files.js';
import { createTempProject } from './helpers/project_fixture.js';

test('reading a file reports size, version, and no truncation', () => {
  const project = createTempProject('read');
  try {
    fs.writeFileSync(path.join(project.projectPath, 'notes.txt'), 'one\ntwo\n', 'utf8');
    const file = readProjectFile(project.projectPath, 'notes.txt');
    assert.equal(file.content, 'one\ntwo\n');
    assert.equal(file.encoding, 'utf8');
    assert.equal(file.binary, false);
    assert.equal(file.truncated, false);
    assert.equal(file.size, Buffer.byteLength('one\ntwo\n'));
    assert.match(file.version, /^\d+:\d+(\.\d+)?$/);
  } finally {
    project.cleanup();
  }
});

test('reading with maxBytes truncates long text at a line boundary and marks the file read-only', () => {
  const project = createTempProject('truncate');
  try {
    const longLine = 'x'.repeat(400);
    const content = Array.from({ length: 40 }, (_, index) => `${index}-${longLine}`).join('\n');
    fs.writeFileSync(path.join(project.projectPath, 'big.tsv'), content, 'utf8');

    const file = readProjectFile(project.projectPath, 'big.tsv', { maxBytes: 512 });
    assert.equal(file.truncated, true);
    assert.ok(file.content.length <= 512);
    assert.ok(file.content.endsWith('\n'), 'truncation keeps complete lines');
    assert.equal(file.size, Buffer.byteLength(content));
  } finally {
    project.cleanup();
  }
});

test('reading a binary file past the cap returns metadata without content', () => {
  const project = createTempProject('binary');
  try {
    const bytes = Buffer.alloc(4096, 7);
    fs.writeFileSync(path.join(project.projectPath, 'image.png'), bytes);

    const file = readProjectFile(project.projectPath, 'image.png', { maxBytes: 512 });
    assert.equal(file.encoding, 'base64');
    assert.equal(file.binary, true);
    assert.equal(file.truncated, true);
    assert.equal(file.content, '');
    assert.equal(file.size, 4096);
  } finally {
    project.cleanup();
  }
});

test('a base version that still matches lets the write through and rotates the version', () => {
  const project = createTempProject('write');
  try {
    fs.writeFileSync(path.join(project.projectPath, 'report.md'), 'first', 'utf8');
    const before = readProjectFile(project.projectPath, 'report.md');

    const after = writeProjectFile(project.projectPath, 'report.md', 'second', { baseVersion: before.version });
    assert.notEqual(after.version, before.version);
    assert.equal(readProjectFile(project.projectPath, 'report.md').content, 'second');
  } finally {
    project.cleanup();
  }
});

test('a stale base version refuses to overwrite the other writer', () => {
  const project = createTempProject('conflict');
  try {
    fs.writeFileSync(path.join(project.projectPath, 'report.md'), 'mine', 'utf8');
    const stale = readProjectFile(project.projectPath, 'report.md');
    // Another writer (the agent) lands between the read and the save.
    fs.writeFileSync(path.join(project.projectPath, 'report.md'), 'theirs', 'utf8');

    assert.throws(
      () => writeProjectFile(project.projectPath, 'report.md', 'mine-again', { baseVersion: stale.version }),
      (error: unknown) => {
        assert.ok(error instanceof ProjectFileConflictError);
        assert.equal(error.currentVersion, readProjectFile(project.projectPath, 'report.md').version);
        return true;
      },
    );
    assert.equal(readProjectFile(project.projectPath, 'report.md').content, 'theirs');
  } finally {
    project.cleanup();
  }
});

test('creating a file is refused when the path appeared since the read', () => {
  const project = createTempProject('create');
  try {
    assert.equal(readProjectFileSafe(project.projectPath, 'new.txt'), null);
    fs.writeFileSync(path.join(project.projectPath, 'new.txt'), 'surprise', 'utf8');

    assert.throws(
      () => writeProjectFile(project.projectPath, 'new.txt', 'mine', { baseVersion: null }),
      ProjectFileConflictError,
    );
    assert.equal(readProjectFile(project.projectPath, 'new.txt').content, 'surprise');
  } finally {
    project.cleanup();
  }
});

test('writes without a base version keep the agent behaviour of unconditional writes', () => {
  const project = createTempProject('agent');
  try {
    const info = writeProjectFile(project.projectPath, 'nested/plan.md', 'body');
    assert.equal(info.path, 'nested/plan.md');
    assert.equal(readProjectFile(project.projectPath, 'nested/plan.md').content, 'body');
  } finally {
    project.cleanup();
  }
});

function readProjectFileSafe(projectPath: string, relativePath: string): string | null {
  try {
    return readProjectFile(projectPath, relativePath).content;
  } catch {
    return null;
  }
}
