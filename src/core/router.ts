import { opencodeAdapter } from '../runtimes/opencode.js';
import type { RuntimeAdapter } from '../runtimes/base.js';
import { chunkText, formatChunks } from '../utils/chunk.js';
import { taskManager } from '../tasks/manager.js';
import { isHighRisk } from '../tasks/safety.js';
import { executeRun, executeEditPlan } from '../tasks/runner.js';
import { requestStore } from '../state/request-store.js';

export interface RouteResult {
  messages: string[];
  error?: boolean;
}

// Current active runtime (Stage 2: OpenCode only)
const activeRuntime: RuntimeAdapter = opencodeAdapter;

/**
 * Route /op commands to the appropriate handler.
 * @param args        Everything after "/op "
 * @param chatId      Chat to notify for async tasks
 * @param fromUserId  Telegram user ID (stored in task for ownership)
 */
export async function routeOpCommand(
  args: string,
  chatId: number,
  fromUserId: number,
): Promise<RouteResult> {
  const parts = args.trim().split(/\s+/);
  const subCommand = parts[0]?.toLowerCase() ?? '';
  const subArgs = parts.slice(1).join(' ');

  switch (subCommand) {
    case 'status':
      return handleStatus();

    case 'ask':
      return handleAsk(subArgs);

    case 'read':
      return handleRead(subArgs);

    case 'run':
      return handleRun(subArgs, chatId, fromUserId);

    case 'edit':
      return handleEdit(subArgs, chatId, fromUserId);

    case '':
    case 'help':
      return {
        messages: [
          [
            'OpenCode commands:',
            '/op status        — Check OpenCode connection',
            '/op ask <q>       — Ask OpenCode a question',
            '/op read <path>   — Read a file',
            '/op run <task>    — Run a read-only / low-risk task',
            '/op edit <task>   — Generate edit plan (requires /approve)',
          ].join('\n'),
        ],
      };

    default:
      return {
        messages: [`Unknown subcommand: ${subCommand}\nUse /op help for available commands.`],
        error: true,
      };
  }
}

// ── Stable handlers (unchanged from Phase 1) ──────────────────────────────────

async function handleStatus(): Promise<RouteResult> {
  try {
    const status = await activeRuntime.getStatus();
    const lines = [
      `Runtime: ${status.name}`,
      `Status: ${status.online ? 'online' : 'offline'}`,
    ];
    if (status.version)     lines.push(`Version: ${status.version}`);
    if (status.projectPath) lines.push(`Project: ${status.projectPath}`);
    if (status.error)       lines.push(`Error: ${status.error}`);
    return { messages: [lines.join('\n')] };
  } catch (error) {
    return {
      messages: [`Failed to get status: ${error instanceof Error ? error.message : String(error)}`],
      error: true,
    };
  }
}

async function handleAsk(question: string): Promise<RouteResult> {
  if (!question.trim()) {
    return {
      messages: ['Usage: /op ask <your question>\nExample: /op ask What does this project do?'],
      error: true,
    };
  }

  const request = await requestStore.create('op', question);
  try {
    await requestStore.markRunning(request.requestId);
    console.log(`[Router] Asking OpenCode: ${question}`);
    const response = await activeRuntime.ask(question);
    await requestStore.markCompleted(request.requestId, response);
    const chunks = chunkText(response);
    return { messages: formatChunks(chunks) };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await requestStore.markFailed(request.requestId, errMsg);
    return {
      messages: [`Ask failed: ${errMsg}`],
      error: true,
    };
  }
}

async function handleRead(filePath: string): Promise<RouteResult> {
  if (!filePath.trim()) {
    return {
      messages: ['Usage: /op read <relative-path>\nExample: /op read src/index.ts'],
      error: true,
    };
  }
  try {
    console.log(`[Router] Reading file: ${filePath}`);
    const content = await activeRuntime.readFile(filePath.trim());
    if (!content) return { messages: ['[File is empty]'] };
    const header = `File: ${filePath}\n${'─'.repeat(40)}\n`;
    const chunks = chunkText(header + content);
    return { messages: formatChunks(chunks) };
  } catch (error) {
    return {
      messages: [`Read failed: ${error instanceof Error ? error.message : String(error)}`],
      error: true,
    };
  }
}

// ── Task handlers ─────────────────────────────────────────────────────────────

async function handleRun(
  taskPrompt: string,
  chatId: number,
  fromUserId: number,
): Promise<RouteResult> {
  if (!taskPrompt.trim()) {
    return {
      messages: ['Usage: /op run <task>\nExample: /op run list all TypeScript errors'],
      error: true,
    };
  }

  const risk = isHighRisk(taskPrompt);
  if (risk.blocked) {
    return {
      messages: [
        `Blocked: high-risk pattern detected.\nReason: ${risk.reason}\n` +
          `Use /op edit for operations that require explicit approval.`,
      ],
      error: true,
    };
  }

  const task = taskManager.create('run', taskPrompt.trim(), chatId, fromUserId);
  console.log(`[Router] Dispatching run task #${task.id} for user ${fromUserId}`);

  void executeRun(task.id);

  return { messages: [`Task #${task.id} queued (run)\nRunning via OpenCode...`] };
}

async function handleEdit(
  taskPrompt: string,
  chatId: number,
  fromUserId: number,
): Promise<RouteResult> {
  if (!taskPrompt.trim()) {
    return {
      messages: ['Usage: /op edit <task>\nExample: /op edit add error handling to src/index.ts'],
      error: true,
    };
  }

  const risk = isHighRisk(taskPrompt);
  if (risk.blocked) {
    return {
      messages: [`Blocked: high-risk pattern detected.\nReason: ${risk.reason}`],
      error: true,
    };
  }

  const task = taskManager.create('edit', taskPrompt.trim(), chatId, fromUserId);
  console.log(`[Router] Dispatching edit-plan task #${task.id} for user ${fromUserId}`);

  void executeEditPlan(task.id);

  return {
    messages: [`Task #${task.id} queued (edit)\nGenerating modification plan...`],
  };
}
