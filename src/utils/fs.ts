import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}
