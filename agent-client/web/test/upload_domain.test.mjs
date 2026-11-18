import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHUNK_UPLOAD_THRESHOLD,
  averageUploadSpeed,
  fingerprintMatches,
  formatUploadEta,
  formatUploadSpeed,
  nextUploadChunks,
  shouldChunkUpload,
  uploadChunkCount,
  uploadChunkLength,
  uploadFingerprint,
  uploadPercent,
  uploadReceivedBytes,
  uploadRetryDelay,
} from '../src/domain/upload.js';

const MB = 1024 * 1024;

test('only files above the threshold take the chunked path', () => {
  assert.equal(shouldChunkUpload(0), false);
  assert.equal(shouldChunkUpload(CHUNK_UPLOAD_THRESHOLD), false);
  assert.equal(shouldChunkUpload(CHUNK_UPLOAD_THRESHOLD + 1), true);
  assert.equal(shouldChunkUpload(10 * 1024 * MB), true);
  assert.equal(shouldChunkUpload(undefined), false);
});

test('chunk arithmetic covers exact multiples and short tails', () => {
  assert.equal(uploadChunkCount(17 * MB, 16 * MB), 2);
  assert.equal(uploadChunkCount(32 * MB, 16 * MB), 2);
  assert.equal(uploadChunkCount(1, 16 * MB), 1);
  assert.equal(uploadChunkCount(0, 16 * MB), 0);

  assert.equal(uploadChunkLength(0, 17 * MB, 16 * MB), 16 * MB);
  assert.equal(uploadChunkLength(1, 17 * MB, 16 * MB), 1 * MB);
  assert.equal(uploadChunkLength(1, 32 * MB, 16 * MB), 16 * MB);
  assert.equal(uploadChunkLength(9, 17 * MB, 16 * MB), 0);

  const received = new Set([0, 1]);
  assert.equal(uploadReceivedBytes(received, 17 * MB, 16 * MB), 17 * MB);
  assert.equal(uploadPercent(0, 100), 0);
  assert.equal(uploadPercent(50, 100), 50);
  assert.equal(uploadPercent(150, 100), 100);
  assert.equal(uploadPercent(10, 0), 0);
});

test('the next batch skips received and in-flight chunks', () => {
  const received = new Set([0, 1, 4]);
  const inFlight = new Set([2]);
  assert.deepEqual(nextUploadChunks(received, inFlight, 6, 2), [3, 5]);
  assert.deepEqual(nextUploadChunks(received, inFlight, 6, 0), []);
  assert.deepEqual(nextUploadChunks(new Set(), new Set(), 2, 5), [0, 1]);
});

test('fingerprints require the same name, size and modification time', () => {
  const task = { name: 'reads.fastq.gz', size: 9 * MB, lastModified: 1700000000000 };
  assert.equal(uploadFingerprint({ name: 'reads.fastq.gz', size: 9 * MB, lastModified: 1700000000000 }), 'reads.fastq.gz|9437184|1700000000000');
  assert.equal(fingerprintMatches(task, { name: 'reads.fastq.gz', size: 9 * MB, lastModified: 1700000000000 }), true);
  assert.equal(fingerprintMatches(task, { name: 'reads.fastq.gz', size: 9 * MB, lastModified: 1800000000000 }), false);
  assert.equal(fingerprintMatches(task, { name: 'other.fastq.gz', size: 9 * MB, lastModified: 1700000000000 }), false);
  assert.equal(fingerprintMatches(task, { name: 'reads.fastq.gz', size: 8 * MB, lastModified: 1700000000000 }), false);
  // 某些浏览器不给 lastModified：不能因此拒绝续传。
  assert.equal(fingerprintMatches(task, { name: 'reads.fastq.gz', size: 9 * MB, lastModified: 0 }), true);
});

test('retry backoff doubles and is capped', () => {
  assert.equal(uploadRetryDelay(1), 1000);
  assert.equal(uploadRetryDelay(2), 2000);
  assert.equal(uploadRetryDelay(3), 4000);
  assert.equal(uploadRetryDelay(10), 30000);
});

test('speed uses the recent sample window and stays zero when unknown', () => {
  const samples = [
    { at: 0, bytes: 0 },
    { at: 1000, bytes: MB },
    { at: 2000, bytes: 2 * MB },
  ];
  assert.equal(averageUploadSpeed(samples, 2000, 5000), MB);
  assert.equal(averageUploadSpeed(samples, 2000, 500), 0);
  assert.equal(averageUploadSpeed([], 2000), 0);
  assert.equal(averageUploadSpeed([{ at: 5, bytes: 10 }], 2000), 0);
});

test('speed and ETA are formatted for the dock', () => {
  assert.equal(formatUploadSpeed(0), '0 B/s');
  assert.equal(formatUploadSpeed(1024), '1.0 KB/s');
  assert.equal(formatUploadSpeed(1024 * MB), '1.00 GB/s');
  assert.equal(formatUploadEta(0), '—');
  assert.equal(formatUploadEta(9), '9s');
  assert.equal(formatUploadEta(65), '1m 05s');
  assert.equal(formatUploadEta(3661), '1h 01m');
});
