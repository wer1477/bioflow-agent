import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CATALOG_NAME = 'catalog.json';

export function catalogPath(dataDir) {
  return path.join(path.resolve(dataDir), CATALOG_NAME);
}

export async function loadCatalog(dataDir) {
  const filePath = catalogPath(dataDir);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.datasets)) throw new Error('unsupported schema');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schema_version: 1, datasets: [] };
    throw new Error(`Cannot read catalog ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export function datasetId({ source, assembly, version }) {
  return `${source}--${assembly}--${version}`.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

export async function upsertDataset(dataDir, dataset, { force = false } = {}) {
  const catalog = await loadCatalog(dataDir);
  const existingIndex = catalog.datasets.findIndex((item) => item.id === dataset.id);
  if (existingIndex >= 0 && !force) throw new Error(`Dataset ${dataset.id} already exists in ${catalogPath(dataDir)}. Provide --force after reviewing it.`);
  if (existingIndex >= 0) catalog.datasets[existingIndex] = dataset;
  else catalog.datasets.push(dataset);
  catalog.datasets.sort((left, right) => left.id.localeCompare(right.id));
  await writeJsonAtomic(catalogPath(dataDir), catalog);
  return catalog;
}
