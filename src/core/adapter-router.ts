/**
 * Generic status + ask router for lightweight adapters (/cc, /cx).
 * Keeps cc-router and cx-router thin and identical in structure.
 */
import type { RuntimeAdapter } from '../runtimes/base.js';
import { requestStore } from '../state/request-store.js';
import type { EngineId } from '../state/types.js';
import { chunkText, formatChunks } from '../utils/chunk.js';

export interface RouteResult {
  messages: string[];
  error?: boolean;
}

export async function routeAdapterCommand(
  adapter: RuntimeAdapter,
  prefix: string,
  args: string,
): Promise<RouteResult> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? '';
  const subArgs = parts.slice(1).join(' ');

  switch (sub) {
    case 'status':
      return handleStatus(adapter);

    case 'ask':
      return handleAsk(adapter, subArgs, prefix === 'cc' || prefix === 'cx' ? prefix : undefined);

    case '':
    case 'help':
      return {
        messages: [
          [
            `${adapter.name} commands:`,
            `/${prefix} status     — Check ${adapter.name}`,
            `/${prefix} ask <q>    — Ask ${adapter.name} a question`,
          ].join('\n'),
        ],
      };

    default:
      return {
        messages: [`Unknown subcommand: ${sub}\nUse /${prefix} help for available commands.`],
        error: true,
      };
  }
}

async function handleStatus(adapter: RuntimeAdapter): Promise<RouteResult> {
  try {
    const s = await adapter.getStatus();
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

async function handleAsk(
  adapter: RuntimeAdapter,
  question: string,
  engine?: EngineId,
): Promise<RouteResult> {
  if (!question.trim()) {
    return {
      messages: [`Usage: ask <your question>\nExample: ask what files are in this project?`],
      error: true,
    };
  }

  const request = engine ? await requestStore.create(engine, question) : undefined;
  try {
    if (request) {
      await requestStore.markRunning(request.requestId);
    }
    console.log(`[${adapter.name}] ask: ${question}`);
    const response = await adapter.ask(question);
    if (request) {
      await requestStore.markCompleted(request.requestId, response);
    }
    return { messages: formatChunks(chunkText(response)) };
  } catch (err) {
    if (request) {
      await requestStore.markFailed(
        request.requestId,
        err instanceof Error ? err.message : String(err),
      );
    }
    return {
      messages: [`Ask failed: ${err instanceof Error ? err.message : String(err)}`],
      error: true,
    };
  }
}
