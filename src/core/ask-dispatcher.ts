/**
 * Unified /ask dispatcher.
 *
 * Assembles the full prompt: SOUL + USER + [MEMORY] + [conversation history] + current message.
 * Dispatches to cc / cx / op based on the current default engine.
 * Returns an immediate receipt, then sends the result asynchronously.
 */
import { executorStore } from '../state/executor-store.js';
import { requestStore } from '../state/request-store.js';
import { conversationStore } from '../state/conversation.js';
import { memoryStore } from '../state/memory.js';
import { getSoulPrompt, getUserPrompt } from '../state/bootstrap.js';
import type { EngineId } from '../state/types.js';
import { claudecodeAdapter } from '../runtimes/claudecode.js';
import { codexAdapter } from '../runtimes/codex.js';
import { opencodeAdapter } from '../runtimes/opencode.js';
import type { RuntimeAdapter } from '../runtimes/base.js';
import { sendMessage } from '../telegram/bot.js';
import { chunkText, formatChunks } from '../utils/chunk.js';
import { cleanMarkdown } from '../utils/format.js';
import { detectSearchType, tavilySearch, birdSearch } from '../utils/search.js';

const ENGINE_LABELS: Record<EngineId, string> = {
  cc: 'Claude Code',
  cx: 'Codex',
  op: 'OpenCode（基础兜底模式）',
};

function getAdapter(engine: EngineId): RuntimeAdapter {
  switch (engine) {
    case 'cc': return claudecodeAdapter;
    case 'cx': return codexAdapter;
    case 'op': return opencodeAdapter;
  }
}

export interface AskReceipt {
  messages: string[];
}

/**
 * Build the full prompt to send to the executor.
 */
async function buildPrompt(content: string, chatId: number, memoryEnabled: boolean): Promise<string> {
  const parts: string[] = [];

  // 1. Personality (always injected)
  const soul = getSoulPrompt();
  if (soul) parts.push(`[System]\n${soul}`);

  const user = getUserPrompt();
  if (user) parts.push(`[User Profile]\n${user}`);

  // 2. Long-term memory (only when /mem on)
  if (memoryEnabled) {
    const memCtx = await memoryStore.getContextString();
    if (memCtx) parts.push(`[Long-term Memory]\n${memCtx}`);
  }

  // 3. Short-term conversation history (always — needed for multi-turn coherence)
  const historyCtx = conversationStore.getContextString(chatId);
  if (historyCtx) parts.push(`[Conversation History]\n${historyCtx}`);

  // 4. Search results (if triggered by keywords)
  const searchType = detectSearchType(content);
  if (searchType !== 'none') {
    try {
      console.log(`[AskDispatcher] Search triggered (${searchType}): "${content.slice(0, 60)}"`);
      if (searchType === 'x') {
        const xResults = await birdSearch(content);
        if (xResults) parts.push(`[X/Twitter Search Results]\n${xResults}`);
      } else {
        const webResults = await tavilySearch(content);
        if (webResults) parts.push(`[Web Search Results]\n${webResults}`);
      }
    } catch (err) {
      console.error(`[AskDispatcher] Search failed: ${err}`);
    }
  }

  // 5. Current message
  parts.push(`[Current Message]\n${content}`);

  return parts.join('\n\n');
}

/**
 * Dispatch an /ask request.
 */
export async function dispatchAsk(
  content: string,
  chatId: number,
): Promise<AskReceipt> {
  const engine = await executorStore.getDefaultEngine();
  const memoryEnabled = await executorStore.isMemoryEnabled();
  const request = await requestStore.create(engine, content);

  // Record user message in conversation history
  conversationStore.addUser(chatId, content);

  // Fire-and-forget async execution
  void executeAsk(request.requestId, engine, content, chatId, memoryEnabled);

  // No receipt message — response will arrive directly
  return { messages: [] };
}

async function executeAsk(
  requestId: string,
  engine: EngineId,
  content: string,
  chatId: number,
  memoryEnabled: boolean,
): Promise<void> {
  const adapter = getAdapter(engine);

  try {
    await requestStore.markRunning(requestId);

    const fullPrompt = await buildPrompt(content, chatId, memoryEnabled);
    console.log(`[AskDispatcher] ${engine} ask (prompt ${fullPrompt.length} chars, mem=${memoryEnabled})`);

    // Send a "thinking" hint if the request takes longer than 120s
    const thinkingTimer = setTimeout(() => {
      sendMessage(chatId, '💭 思考中…').catch(() => {});
    }, 120_000);

    let response: string;
    try {
      response = await adapter.ask(fullPrompt);
    } finally {
      clearTimeout(thinkingTimer);
    }

    await requestStore.markCompleted(requestId, response);

    // Record assistant response in conversation history
    conversationStore.addAssistant(chatId, response.length > 500 ? response.slice(0, 497) + '...' : response);

    // Send response directly — no header, like a real conversation
    const fullText = cleanMarkdown(response);
    const chunks = chunkText(fullText);
    const parts = formatChunks(chunks);
    for (const part of parts) {
      await sendMessage(chatId, part);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await requestStore.markFailed(requestId, errMsg);

    const truncatedErr = errMsg.length > 500 ? errMsg.slice(0, 497) + '...' : errMsg;
    const failureMsg = `⚠️ ${truncatedErr}`;

    try {
      await sendMessage(chatId, failureMsg);
    } catch (sendErr) {
      console.error(`[AskDispatcher] Failed to send error feedback: ${sendErr}`);
    }
  }
}
