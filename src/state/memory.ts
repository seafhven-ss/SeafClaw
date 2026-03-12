/**
 * Long-term memory — persisted as a Markdown file (data/MEMORY.md).
 * Each entry is a numbered section with a title and token estimate.
 *
 * Format:
 *   ## #1 标题 [~N tokens]
 *   内容文本
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const MEMORY_FILE = join(process.cwd(), 'data', 'MEMORY.md');

export interface MemoryEntry {
  id: number;
  title: string;
  content: string;
  tokens: number;
}

/** Rough token estimate: ~1 token per 2 CJK chars, ~1 token per 4 latin chars. */
function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x2e80 ? 0.5 : 0.25;
  }
  return Math.max(1, Math.ceil(count));
}

function parseMemoryFile(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const sections = raw.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    // Try structured format: ## #N 标题 [~N tokens]
    const structured = section.match(/^#(\d+)\s+(.+?)(?:\s+\[~\d+\s*tokens?\])?\s*\n([\s\S]*)/);
    if (structured) {
      const content = structured[3].trim();
      entries.push({
        id: parseInt(structured[1], 10),
        title: structured[2].trim(),
        content,
        tokens: estimateTokens(content),
      });
      continue;
    }

    // Freeform format: ## Any heading text
    const freeform = section.match(/^(.+?)\s*\n([\s\S]*)/);
    if (freeform) {
      const title = freeform[1].replace(/^[\d.]+\s*/, '').trim();
      const content = freeform[2].trim();
      if (!content) continue;
      entries.push({
        id: entries.length + 1,
        title,
        content,
        tokens: estimateTokens(content),
      });
    }
  }

  return entries;
}

function serializeEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => `## #${e.id} ${e.title} [~${e.tokens} tokens]\n${e.content}`)
    .join('\n\n')
    + '\n';
}

class MemoryStore {
  private entries: MemoryEntry[] | null = null;

  async load(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(MEMORY_FILE, 'utf8');
      this.entries = parseMemoryFile(raw);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        this.entries = [];
      } else {
        throw err;
      }
    }
    return this.entries;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.entries === null) await this.load();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    await writeFile(MEMORY_FILE, serializeEntries(this.entries ?? []), 'utf8');
  }

  private nextId(): number {
    if (!this.entries || this.entries.length === 0) return 1;
    return Math.max(...this.entries.map((e) => e.id)) + 1;
  }

  async getAll(): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return [...this.entries!];
  }

  async getContextString(): Promise<string> {
    await this.ensureLoaded();
    if (this.entries!.length === 0) return '';
    return this.entries!.map((e) => `[Memory #${e.id}: ${e.title}] ${e.content}`).join('\n');
  }

  async totalTokens(): Promise<number> {
    await this.ensureLoaded();
    return this.entries!.reduce((sum, e) => sum + e.tokens, 0);
  }

  async add(title: string, content: string): Promise<MemoryEntry> {
    await this.ensureLoaded();
    const entry: MemoryEntry = {
      id: this.nextId(),
      title,
      content,
      tokens: estimateTokens(content),
    };
    this.entries!.push(entry);
    await this.persist();
    return entry;
  }

  async remove(id: number): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.entries!.length;
    this.entries = this.entries!.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    await this.persist();
    return true;
  }

  async removeByTitlePrefix(prefix: string): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    const removed = this.entries!.filter((e) => e.title.startsWith(prefix));
    if (removed.length > 0) {
      this.entries = this.entries!.filter((e) => !e.title.startsWith(prefix));
      await this.persist();
    }
    return removed;
  }

  async clear(): Promise<number> {
    await this.ensureLoaded();
    const count = this.entries!.length;
    this.entries = [];
    await this.persist();
    return count;
  }

  getFilePath(): string {
    return MEMORY_FILE;
  }
}

export const memoryStore = new MemoryStore();
