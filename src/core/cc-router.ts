/**
 * Claude Code router — handles all /cc subcommands including background tasks.
 */
import { readFile } from 'node:fs/promises';
import { claudecodeAdapter } from '../runtimes/claudecode.js';
import { requestStore } from '../state/request-store.js';
import { taskManager, formatTaskLine, statusEmoji } from '../tasks/manager.js';
import { executeCcTask, killCcTask, getCcTaskLogPath } from '../tasks/runner.js';
import { chunkText, formatChunks } from '../utils/chunk.js';

export interface RouteResult {
  messages: string[];
  error?: boolean;
}

export async function routeCcCommand(
  args: string,
  chatId: number,
  fromUserId: number,
): Promise<RouteResult> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? '';
  const subArgs = parts.slice(1).join(' ');

  switch (sub) {
    case 'status':
      return handleStatus();

    case 'ask':
      return handleAsk(subArgs);

    case 'task':
      return handleTask(subArgs, chatId, fromUserId);

    case 'task-status':
      return handleTaskStatus(subArgs, fromUserId);

    case 'logs':
      return handleLogs(subArgs, fromUserId);

    case 'cancel':
      return handleCancel(subArgs, fromUserId);

    case 'tasks':
      return handleTasks(fromUserId);

    case '':
    case 'help':
      return {
        messages: [
          [
            'Claude Code commands:',
            '/cc status              — Check Claude Code CLI',
            '/cc ask <q>             — Ask Claude Code (sync, 2min limit)',
            '/cc task <description>  — Run background task (no timeout)',
            '/cc task-status <id>    — Check task status',
            '/cc logs <id>           — View task output (streaming)',
            '/cc cancel <id>         — Cancel a task (kills process)',
            '/cc tasks               — List recent tasks',
          ].join('\n'),
        ],
      };

    default:
      return {
        messages: [`Unknown subcommand: ${sub}\nUse /cc help for available commands.`],
        error: true,
      };
  }
}

// ── status ───────────────────────────────────────────────────────────────────

async function handleStatus(): Promise<RouteResult> {
  try {
    const s = await claudecodeAdapter.getStatus();
    const lines = [
      `Runtime: ${s.name}`,
      `Status: ${s.online ? 'online' : 'offline'}`,
    ];
    if (s.version)     lines.push(`Version: ${s.version}`);
    if (s.projectPath) lines.push(`Project: ${s.projectPath}`);
    if (s.error)       lines.push(`Error: ${s.error}`);
    return { messages: [lines.join('\n')] };
  } catch (err) {
    return {
      messages: [`Status check failed: ${err instanceof Error ? err.message : String(err)}`],
      error: true,
    };
  }
}

// ── ask (sync, waits for response with timeout) ─────────────────────────────

async function handleAsk(question: string): Promise<RouteResult> {
  if (!question.trim()) {
    return {
      messages: ['Usage: /cc ask <your question>\nExample: /cc ask what files are in this project?'],
      error: true,
    };
  }

  const request = await requestStore.create('cc', question);
  try {
    await requestStore.markRunning(request.requestId);
    console.log(`[ClaudeCode] ask: ${question}`);
    const response = await claudecodeAdapter.ask(question);
    await requestStore.markCompleted(request.requestId, response);
    return { messages: formatChunks(chunkText(response)) };
  } catch (err) {
    await requestStore.markFailed(
      request.requestId,
      err instanceof Error ? err.message : String(err),
    );
    return {
      messages: [`Ask failed: ${err instanceof Error ? err.message : String(err)}`],
      error: true,
    };
  }
}

// ── task (async background, no timeout) ─────────────────────────────────────

function handleTask(description: string, chatId: number, fromUserId: number): RouteResult {
  if (!description.trim()) {
    return {
      messages: ['Usage: /cc task <task description>\nExample: /cc task refactor the utils module'],
      error: true,
    };
  }

  const task = taskManager.create('run', description, chatId, fromUserId);

  // Fire-and-forget: spawns claude CLI with no timeout, notifies on completion
  void executeCcTask(task.id);

  return {
    messages: [
      [
        `Task #${task.id} created`,
        `Prompt: ${description.length > 100 ? description.slice(0, 97) + '...' : description}`,
        `Use /cc task-status ${task.id} to check progress`,
        `Use /cc logs ${task.id} to view live output`,
      ].join('\n'),
    ],
  };
}

// ── task-status ──────────────────────────────────────────────────────────────

function handleTaskStatus(taskId: string, fromUserId: number): RouteResult {
  const id = taskId.trim();
  if (!id) {
    return { messages: ['Usage: /cc task-status <taskId>'], error: true };
  }

  const task = taskManager.get(id);
  if (!task) {
    return { messages: [`Task #${id} not found.`], error: true };
  }
  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} not found or access denied.`], error: true };
  }

  const lines = [
    `Task: #${task.id}`,
    `Status: ${statusEmoji(task.status)} ${task.status}`,
    `Created: ${task.createdAt.toISOString()}`,
    `Prompt: ${task.prompt.length > 120 ? task.prompt.slice(0, 117) + '...' : task.prompt}`,
  ];
  if (task.logPath) lines.push(`Log: ${task.logPath}`);
  if (task.error) lines.push(`Error: ${task.error}`);

  return { messages: [lines.join('\n')] };
}

// ── logs (read streaming log file) ──────────────────────────────────────────

async function handleLogs(taskId: string, fromUserId: number): Promise<RouteResult> {
  const id = taskId.trim();
  if (!id) {
    return { messages: ['Usage: /cc logs <taskId>'], error: true };
  }

  const task = taskManager.get(id);
  if (!task) {
    return { messages: [`Task #${id} not found.`], error: true };
  }
  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} not found or access denied.`], error: true };
  }

  // Try to read the log file
  const logPath = getCcTaskLogPath(id);
  if (logPath) {
    try {
      const content = await readFile(logPath, 'utf8');
      if (!content.trim()) {
        return { messages: [`Task #${id} — log file exists but is empty (still starting).`] };
      }
      // Show last ~4000 chars to avoid Telegram message limits
      const tail = content.length > 4000 ? '...\n' + content.slice(-4000) : content;
      const status = task.status === 'running' ? ' (still running)' : '';
      return { messages: formatChunks(chunkText(`Logs for #${id}${status}:\n\n${tail}`)) };
    } catch {
      // File not yet created or read error — fall through
    }
  }

  // Fallback: show result/error from task record
  if (task.result) {
    return { messages: formatChunks(chunkText(`Output for #${id}:\n\n${task.result}`)) };
  }
  if (task.error) {
    return { messages: [`Task #${id} error:\n${task.error}`] };
  }
  if (task.status === 'queued' || task.status === 'running') {
    return { messages: [`Task #${id} is ${task.status}. No output yet.`] };
  }

  return { messages: ['No logs available.'] };
}

// ── cancel (kills the child process) ────────────────────────────────────────

function handleCancel(taskId: string, fromUserId: number): RouteResult {
  const id = taskId.trim();
  if (!id) {
    return { messages: ['Usage: /cc cancel <taskId>'], error: true };
  }

  const task = taskManager.get(id);
  if (!task) {
    return { messages: [`Task #${id} not found.`], error: true };
  }
  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} not found or access denied.`], error: true };
  }

  const cancellable = ['queued', 'running'];
  if (!cancellable.includes(task.status)) {
    return { messages: [`Task #${id} cannot be cancelled — status: ${task.status}`], error: true };
  }

  // Kill the actual child process
  const killed = killCcTask(id);
  // Also update task manager state
  taskManager.cancel(id);

  return {
    messages: [
      `Task #${id} cancelled.${killed ? ' Child process killed.' : ''}`,
    ],
  };
}

// ── tasks (list recent) ─────────────────────────────────────────────────────

function handleTasks(fromUserId: number): RouteResult {
  const all = taskManager.recent(20);
  const mine = all.filter((t) => t.fromUserId === fromUserId);
  if (mine.length === 0) {
    return { messages: ['No Claude Code tasks yet.'] };
  }

  const lines = mine.slice(0, 10).map((t) => `${statusEmoji(t.status)} ${formatTaskLine(t)}`);
  return { messages: [`Recent Claude Code tasks:\n\n${lines.join('\n')}`] };
}
