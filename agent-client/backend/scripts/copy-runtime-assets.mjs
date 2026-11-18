import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'agent', 'core_tools', 'assets');
const target = path.join(root, 'dist', 'agent', 'core_tools', 'assets');
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
