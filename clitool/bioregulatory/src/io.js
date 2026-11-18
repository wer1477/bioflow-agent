import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  });
  return hash.digest('hex');
}

function fileNameFromUrl(url, fallback) {
  try {
    const name = path.basename(new URL(url).pathname);
    return name && name !== '/' ? name : fallback;
  } catch {
    return fallback;
  }
}

export async function downloadTo(url, destinationDir, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { accept: 'application/octet-stream,*/*;q=0.8' } });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${url}: HTTP ${response.status}.`);
  await fsp.mkdir(destinationDir, { recursive: true });
  const fileName = fileNameFromUrl(url, 'evidence.bed');
  const finalPath = path.join(destinationDir, fileName);
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath, { flags: 'wx' }));
  await fsp.rename(tempPath, finalPath);
  return finalPath;
}

export async function pathFromInputOrUrl({ input, url, destinationDir, fetchImpl }) {
  if (input) {
    const absolute = path.resolve(input);
    await fsp.access(absolute);
    await fsp.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, path.basename(absolute));
    await fsp.copyFile(absolute, destination);
    return destination;
  }
  return downloadTo(url, destinationDir, { fetchImpl });
}
