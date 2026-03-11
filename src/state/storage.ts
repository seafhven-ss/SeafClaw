import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_DIR = join(process.cwd(), '.daemon-state');

export function getStateDir(): string {
  return STATE_DIR;
}

export async function readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const filePath = join(STATE_DIR, fileName);
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile(fileName: string, value: unknown): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const filePath = join(STATE_DIR, fileName);
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}
