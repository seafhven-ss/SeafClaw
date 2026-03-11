import { taskManager } from './manager.js';
import { opencodeAdapter } from '../runtimes/opencode.js';
import type { RuntimeAdapter } from '../runtimes/base.js';
import { spawnTask, type TaskHandle } from '../runtimes/claudecode.js';
import { sendMessage } from '../telegram/bot.js';
import { chunkText, formatChunks } from '../utils/chunk.js';

// ── CC background task handles ───────────────────────────────────────────────
// Maps taskId → TaskHandle for process lifecycle management (/cc cancel, etc.)
const ccHandles: Map<string, TaskHandle> = new Map();

// ── Prompt prefixes ───────────────────────────────────────────────────────────

const RUN_PREFIX =
  '[READ-ONLY MODE] Analyze and respond to the following request. ' +
  'You MUST NOT create, modify, delete, or write any files. ' +
  'Only read, inspect, explain, or suggest:\n\n';

/**
 * PLAN_PREFIX is intentionally strong: the AI must not write files.
 * The plan will be shown to the user for approval before any writes happen.
 */
const PLAN_PREFIX =
  '[PLANNING MODE — NO FILE WRITES ALLOWED] ' +
  'Generate a detailed step-by-step modification plan for the task below. ' +
  'List every file to change, the exact changes to make, and the reason for each change. ' +
  'You MUST NOT create, modify, or delete any files during this step. ' +
  'Output the plan text only:\n\n';

const APPLY_PREFIX =
  '[APPLY MODE] Implement the following approved modification plan exactly as described. ' +
  'Make all the file changes listed in the plan:\n\n';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notify(chatId: number, text: string): Promise<void> {
  const chunks = chunkText(text);
  const parts = formatChunks(chunks);
  for (const part of parts) {
    await sendMessage(chatId, part);
  }
}

/**
 * Race a promise against an AbortSignal.
 * When the signal fires, the returned promise rejects immediately — the
 * underlying HTTP call is not cancelled at the network level (the SDK does
 * not expose AbortSignal support), but the runner stops waiting for it and
 * discards the result.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Task cancelled', 'AbortError'));
      return;
    }

    const onAbort = (): void => {
      reject(new DOMException('Task cancelled', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function isCancelledOrAborted(taskId: string, err?: unknown): boolean {
  if (taskManager.get(taskId)?.status === 'cancelled') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

// ── Executors ─────────────────────────────────────────────────────────────────

/**
 * Execute a /op run task: read-only ask to OpenCode.
 */
export async function executeRun(taskId: string): Promise<void> {
  const task = taskManager.get(taskId);
  if (!task) return;

  const ctrl = new AbortController();
  taskManager.registerAbort(taskId, ctrl);
  taskManager.update(taskId, { status: 'running' });

  try {
    const answer = await raceAbort(
      opencodeAdapter.ask(RUN_PREFIX + task.prompt),
      ctrl.signal,
    );

    taskManager.clearAbort(taskId);

    if (isCancelledOrAborted(taskId)) return;

    taskManager.update(taskId, { status: 'done', result: answer });
    await notify(task.chatId, `Task #${taskId} done:\n\n${answer}`);
  } catch (err) {
    taskManager.clearAbort(taskId);
    if (isCancelledOrAborted(taskId, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: msg });
    await sendMessage(task.chatId, `Task #${taskId} failed:\n${msg}`);
  }
}

/**
 * Execute the plan phase of an /op edit task.
 * MUST NOT write any files — only produces a text plan.
 * Transitions to waiting_confirm on success.
 */
export async function executeEditPlan(taskId: string): Promise<void> {
  const task = taskManager.get(taskId);
  if (!task) return;

  const ctrl = new AbortController();
  taskManager.registerAbort(taskId, ctrl);
  taskManager.update(taskId, { status: 'running' });

  try {
    const plan = await raceAbort(
      opencodeAdapter.ask(PLAN_PREFIX + task.prompt),
      ctrl.signal,
    );

    taskManager.clearAbort(taskId);

    if (isCancelledOrAborted(taskId)) return;

    // Store plan and wait for /approve — no file writes happen here
    taskManager.update(taskId, { status: 'waiting_confirm', plan });

    const msg =
      `Task #${taskId} — Plan ready:\n\n${plan}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `/approve ${taskId} — execute\n` +
      `/deny ${taskId} — cancel`;
    await notify(task.chatId, msg);
  } catch (err) {
    taskManager.clearAbort(taskId);
    if (isCancelledOrAborted(taskId, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: msg });
    await sendMessage(task.chatId, `Task #${taskId} plan failed:\n${msg}`);
  }
}

/**
 * Execute the apply phase of an /op edit task.
 * Only called after the user has explicitly issued /approve.
 * Status is already set to 'running' by handleApprove before dispatch.
 */
export async function executeEditApply(taskId: string): Promise<void> {
  const task = taskManager.get(taskId);
  if (!task || !task.plan) return;

  const ctrl = new AbortController();
  taskManager.registerAbort(taskId, ctrl);
  // Status is already 'running' (set atomically by handleApprove)

  try {
    const applyPrompt =
      APPLY_PREFIX + task.plan + '\n\nOriginal task: ' + task.prompt;
    const result = await raceAbort(
      opencodeAdapter.ask(applyPrompt),
      ctrl.signal,
    );

    taskManager.clearAbort(taskId);

    if (isCancelledOrAborted(taskId)) return;

    taskManager.update(taskId, { status: 'done', result });
    await notify(task.chatId, `Task #${taskId} applied:\n\n${result}`);
  } catch (err) {
    taskManager.clearAbort(taskId);
    if (isCancelledOrAborted(taskId, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: msg });
    await sendMessage(task.chatId, `Task #${taskId} apply failed:\n${msg}`);
  }
}

// ── Generic adapter executor (kept for /cx and other adapters) ───────────────

/**
 * Execute a task using any RuntimeAdapter's ask() method.
 * Uses the adapter's built-in timeout — suitable for short-lived tasks only.
 */
export async function executeAdapterRun(
  taskId: string,
  adapter: RuntimeAdapter,
): Promise<void> {
  const task = taskManager.get(taskId);
  if (!task) return;

  const ctrl = new AbortController();
  taskManager.registerAbort(taskId, ctrl);
  taskManager.update(taskId, { status: 'running' });

  try {
    const answer = await raceAbort(adapter.ask(task.prompt), ctrl.signal);

    taskManager.clearAbort(taskId);
    if (isCancelledOrAborted(taskId)) return;

    taskManager.update(taskId, { status: 'done', result: answer });
    await notify(task.chatId, `Task #${taskId} done (${adapter.name}):\n\n${answer}`);
  } catch (err) {
    taskManager.clearAbort(taskId);
    if (isCancelledOrAborted(taskId, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: msg });
    await sendMessage(task.chatId, `Task #${taskId} failed:\n${msg}`);
  }
}

// ── Claude Code background task executor ─────────────────────────────────────

/**
 * Execute a /cc task as a true background process.
 * Spawns `claude -p` with NO timeout. Output streams to a log file.
 * The child process runs until completion, cancellation, or failure.
 */
export async function executeCcTask(taskId: string): Promise<void> {
  console.log(`[CC] executeCcTask called for #${taskId} — using spawnTask (NO timeout)`);
  const task = taskManager.get(taskId);
  if (!task) return;

  let handle: TaskHandle;
  try {
    handle = await spawnTask(task.prompt, taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: `Spawn failed: ${msg}` });
    await sendMessage(task.chatId, `Task #${taskId} failed to start:\n${msg}`);
    return;
  }

  // Store handle for /cc cancel and /cc logs
  ccHandles.set(taskId, handle);
  taskManager.update(taskId, {
    status: 'running',
    logPath: handle.logPath,
  });

  console.log(`[CC] Task #${taskId} spawned (PID ${handle.pid}), log: ${handle.logPath}`);

  try {
    const result = await handle.done;

    ccHandles.delete(taskId);

    // Check if already cancelled while we were awaiting
    if (taskManager.get(taskId)?.status === 'cancelled') return;

    taskManager.update(taskId, { status: 'done', result });
    await notify(task.chatId, `Task #${taskId} done (Claude Code):\n\n${result}`);
  } catch (err) {
    ccHandles.delete(taskId);

    if (taskManager.get(taskId)?.status === 'cancelled') return;

    const msg = err instanceof Error ? err.message : String(err);
    taskManager.update(taskId, { status: 'failed', error: msg });
    await sendMessage(task.chatId, `Task #${taskId} failed:\n${msg}`);
  }
}

/**
 * Kill the Claude CLI child process for a given task.
 * Called by /cc cancel. Returns true if a process was killed.
 */
export function killCcTask(taskId: string): boolean {
  const handle = ccHandles.get(taskId);
  if (!handle) return false;
  handle.kill();
  ccHandles.delete(taskId);
  return true;
}

/**
 * Get the log file path for a CC task (if it has one).
 */
export function getCcTaskLogPath(taskId: string): string | undefined {
  return ccHandles.get(taskId)?.logPath ?? taskManager.get(taskId)?.logPath;
}
