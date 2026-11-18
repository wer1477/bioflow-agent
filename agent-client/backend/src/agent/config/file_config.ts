import fs from 'node:fs'; import path from 'node:path';
import { CONFIG_ROOT } from '../../paths.js';

export function readConfig(file: string): any { const target = path.join(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT, file); if (!fs.existsSync(target)) return []; return JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')); }
export function writeConfig(file: string, value: unknown): void { const target = path.join(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT, file); fs.mkdirSync(path.dirname(target), { recursive: true }); const tmp = `${target}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, target); }
