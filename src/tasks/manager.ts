import { randomBytes } from 'node:crypto';
import type { Task, TaskStatus, TaskType } from './types.js';

const MAX_TASKS = 100;

class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private order: string[] = [];

  /**
   * AbortControllers live outside the Task record — they are runtime-only
   * handles, not part of the persisted task state.
   */
  private abortControllers: Map<string, AbortController> = new Map();

  private generateId(): string {
    return randomBytes(3).toString('hex'); // 6-char hex, e.g. "a3f2c1"
  }

  create(type: TaskType, prompt: string, chatId: number, fromUserId: number): Task {
    const id = this.generateId();
    const now = new Date();
    const task: Task = {
      id, type, prompt,
      status: 'queued',
      createdAt: now, updatedAt: now,
      chatId, fromUserId,
    };

    this.tasks.set(id, task);
    this.order.push(id);

    // Evict oldest when over cap
    if (this.order.length > MAX_TASKS) {
      const old = this.order.shift()!;
      this.tasks.delete(old);
      this.abortControllers.delete(old);
    }

    console.log(`[TaskManager] Created task #${id} type=${type} user=${fromUserId}`);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const updated: Task = { ...task, ...patch, updatedAt: new Date() };
    this.tasks.set(id, updated);
    console.log(`[TaskManager] Task #${id} → ${updated.status}`);
    return updated;
  }

  // ── AbortController registry ──────────────────────────────────────────────

  registerAbort(id: string, ctrl: AbortController): void {
    this.abortControllers.set(id, ctrl);
  }

  clearAbort(id: string): void {
    this.abortControllers.delete(id);
  }

  /**
   * Cancel a task: abort the in-flight HTTP call (if any) AND mark cancelled.
   * Returns the updated task, or undefined if not found / already terminal.
   */
  cancel(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const cancellable: TaskStatus[] = ['queued', 'running', 'waiting_confirm'];
    if (!cancellable.includes(task.status)) return undefined;

    // Signal the runner to stop waiting for OpenCode
    const ctrl = this.abortControllers.get(id);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(id);
    }

    return this.update(id, { status: 'cancelled' });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  recent(n: number = 10): Task[] {
    return this.order
      .slice(-n)
      .reverse()
      .map((id) => this.tasks.get(id)!)
      .filter(Boolean);
  }
}

export const taskManager = new TaskManager();

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatTaskLine(t: Task): string {
  const prompt = t.prompt.length > 36 ? t.prompt.slice(0, 33) + '...' : t.prompt;
  // ISO-like timestamp in local time: "2026-03-09 14:32"
  const d = t.createdAt;
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `#${t.id} [${t.type}] ${t.status} ${ts} — "${prompt}"`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function statusEmoji(status: TaskStatus): string {
  switch (status) {
    case 'queued':          return '⏳';
    case 'running':         return '⚙️';
    case 'waiting_confirm': return '❓';
    case 'done':            return '✅';
    case 'failed':          return '❌';
    case 'cancelled':       return '🚫';
  }
}
