/**
 * Daily conversation log + auto-summarize + compaction.
 *
 * 1. Every message is appended to `data/logs/YYYY-MM-DD.txt` (zero token cost).
 * 2. On the first message of a new day, yesterday's log is sent to the LLM
 *    for summarization and saved as a `daily:YYYY-MM-DD` memory entry.
 * 3. When daily entries exceed 5, they are merged into a single weekly summary.
 */
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { memoryStore } from './memory.js';
import { executorStore } from './executor-store.js';

const LOGS_DIR = join(process.cwd(), 'data', 'logs');
const MAX_DAILY_ENTRIES = 5;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function timeStr(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function logFilePath(dateStr: string): string {
  return join(LOGS_DIR, `${dateStr}.txt`);
}

class DailyLog {
  private lastDate: string | null = null;
  private summarizing = false;

  /**
   * Append a message to today's log file.
   * On day boundary, trigger yesterday's summarization.
   */
  async logMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      const today = todayStr();

      // Day boundary detection → summarize yesterday
      if (this.lastDate && this.lastDate !== today && !this.summarizing) {
        void this.summarizeDay(this.lastDate);
      }
      this.lastDate = today;

      // Append to log file
      await mkdir(LOGS_DIR, { recursive: true });
      const line = `[${timeStr()}] ${role}: ${content}\n`;
      const filePath = logFilePath(today);

      // appendFile semantics via read-then-write (node has appendFile too)
      let existing = '';
      try {
        existing = await readFile(filePath, 'utf8');
      } catch {
        // File doesn't exist yet
      }
      await writeFile(filePath, existing + line, 'utf8');
    } catch (err) {
      console.error(`[DailyLog] Failed to log message: ${err}`);
    }
  }

  /**
   * Summarize a specific day's log and save to long-term memory.
   * Called automatically on day boundary, or manually via /log summary.
   */
  async summarizeDay(dateStr?: string): Promise<string | null> {
    if (this.summarizing) return null;
    this.summarizing = true;

    try {
      const target = dateStr ?? yesterdayStr();
      const filePath = logFilePath(target);

      // Check if log file exists
      try {
        await stat(filePath);
      } catch {
        console.log(`[DailyLog] No log file for ${target}, skipping summarization`);
        return null;
      }

      const logContent = await readFile(filePath, 'utf8');
      if (!logContent.trim()) {
        console.log(`[DailyLog] Empty log for ${target}, skipping`);
        return null;
      }

      // Check if already summarized
      const entries = await memoryStore.getAll();
      if (entries.some((e) => e.title === `daily:${target}`)) {
        console.log(`[DailyLog] Already summarized ${target}, skipping`);
        return null;
      }

      // Get LLM adapter (lazy import to avoid circular dependency)
      const { getAdapter } = await import('../core/ask-dispatcher.js');
      const engine = await executorStore.getDefaultEngine();
      const adapter = getAdapter(engine);

      const prompt = [
        '你是一个记忆提炼助手。从以下对话日志中提取当日的关键结论、决策和变更。',
        '规则：',
        '- 只保留结论/决策/事实性变更，不要过程描述',
        '- 用中文输出，按话题分条，每条一行',
        '- 总长度不超过 150 字',
        '- 如果没有值得记录的内容，输出：无重要事项',
        '- 直接输出结果，不要前缀说明',
        '',
        `日期：${target}`,
        '对话日志：',
        logContent,
      ].join('\n');

      const summary = await adapter.ask(prompt);
      const trimmed = summary.trim();

      if (trimmed === '无重要事项' || !trimmed) {
        console.log(`[DailyLog] No notable items for ${target}`);
        // Still delete the log file
        await unlink(filePath).catch(() => {});
        return null;
      }

      // Save as daily memory entry
      await memoryStore.add(`daily:${target}`, trimmed);
      console.log(`[DailyLog] Saved daily summary for ${target}`);

      // Delete processed log file
      await unlink(filePath).catch(() => {});

      // Check if compaction needed
      await this.maybeCompact();

      return trimmed;
    } catch (err) {
      console.error(`[DailyLog] Summarization failed: ${err}`);
      return null;
    } finally {
      this.summarizing = false;
    }
  }

  /**
   * Merge daily entries into a weekly summary when count exceeds threshold.
   */
  async maybeCompact(): Promise<void> {
    try {
      const entries = await memoryStore.getAll();
      const dailyEntries = entries.filter((e) => e.title.startsWith('daily:'));

      if (dailyEntries.length <= MAX_DAILY_ENTRIES) return;

      console.log(`[DailyLog] ${dailyEntries.length} daily entries, compacting...`);

      // Sort by date
      dailyEntries.sort((a, b) => a.title.localeCompare(b.title));
      const firstDate = dailyEntries[0].title.replace('daily:', '');
      const lastDate = dailyEntries[dailyEntries.length - 1].title.replace('daily:', '');

      const combined = dailyEntries
        .map((e) => `[${e.title.replace('daily:', '')}] ${e.content}`)
        .join('\n');

      // Get LLM adapter
      const { getAdapter } = await import('../core/ask-dispatcher.js');
      const engine = await executorStore.getDefaultEngine();
      const adapter = getAdapter(engine);

      const prompt = [
        '你是一个记忆压缩助手。将以下多日摘要合并为一条周报。',
        '规则：',
        '- 合并重复信息，保留关键结论和决策',
        '- 用中文输出，按话题分条',
        '- 总长度不超过 300 字',
        '- 直接输出结果，不要前缀说明',
        '',
        '多日摘要：',
        combined,
      ].join('\n');

      const merged = await adapter.ask(prompt);
      const trimmed = merged.trim();

      // Remove individual daily entries
      const removed = await memoryStore.removeByTitlePrefix('daily:');
      console.log(`[DailyLog] Removed ${removed.length} daily entries`);

      // Add merged weekly entry
      await memoryStore.add(`weekly:${firstDate}~${lastDate}`, trimmed);
      console.log(`[DailyLog] Created weekly summary: ${firstDate}~${lastDate}`);
    } catch (err) {
      console.error(`[DailyLog] Compaction failed: ${err}`);
    }
  }

  /** Check if a log file exists for a given date. */
  async hasLog(dateStr: string): Promise<boolean> {
    try {
      await stat(logFilePath(dateStr));
      return true;
    } catch {
      return false;
    }
  }

  /** Get the logs directory path. */
  getLogsDir(): string {
    return LOGS_DIR;
  }
}

export const dailyLog = new DailyLog();
