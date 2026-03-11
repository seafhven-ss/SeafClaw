import { createOpencodeClient, type OpencodeClient, type TextPart } from '@opencode-ai/sdk/client';
import type { RuntimeAdapter, RuntimeStatus } from './base.js';
import { NotImplementedError } from './base.js';
import { config } from '../config/env.js';
import { validateRelativePath } from '../security/path.js';

let client: OpencodeClient | null = null;
let currentSessionId: string | null = null;

/**
 * Extract text from a message object, trying multiple possible structures
 */
function extractTextFromMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;

  const obj = msg as Record<string, unknown>;
  const texts: string[] = [];

  // Try: msg.parts[] with type='text'
  if (Array.isArray(obj.parts)) {
    for (const part of obj.parts) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        // Standard TextPart: { type: 'text', text: '...' }
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
          texts.push(p.text);
        }
        // Alternative: { content: '...' }
        if (typeof p.content === 'string' && p.content.trim()) {
          texts.push(p.content);
        }
        // Alternative: { message: '...' }
        if (typeof p.message === 'string' && p.message.trim()) {
          texts.push(p.message);
        }
      }
    }
  }

  // Try: msg.content (direct string)
  if (typeof obj.content === 'string' && obj.content.trim()) {
    texts.push(obj.content);
  }

  // Try: msg.text (direct string)
  if (typeof obj.text === 'string' && obj.text.trim()) {
    texts.push(obj.text);
  }

  // Try: msg.message (direct string)
  if (typeof obj.message === 'string' && obj.message.trim()) {
    texts.push(obj.message);
  }

  // Try: msg.info.content or msg.info.text
  if (obj.info && typeof obj.info === 'object') {
    const info = obj.info as Record<string, unknown>;
    if (typeof info.content === 'string' && info.content.trim()) {
      texts.push(info.content);
    }
    if (typeof info.text === 'string' && info.text.trim()) {
      texts.push(info.text);
    }
  }

  if (texts.length === 0) return null;

  // Deduplicate and join
  const unique = [...new Set(texts)];
  return unique.join('\n');
}

function getClient(): OpencodeClient {
  if (!client) {
    client = createOpencodeClient({
      baseUrl: config.OPENCODE_BASE_URL,
      directory: config.OPENCODE_PROJECT_PATH,
    });
  }
  return client;
}

async function ensureSession(): Promise<string> {
  if (currentSessionId) {
    return currentSessionId;
  }

  const c = getClient();
  const result = await c.session.create();

  if (result.error) {
    throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
  }

  currentSessionId = result.data?.id ?? null;
  if (!currentSessionId) {
    throw new Error('Session created but no ID returned');
  }

  console.log(`[OpenCode] Session created: ${currentSessionId}`);
  return currentSessionId;
}

export const opencodeAdapter: RuntimeAdapter = {
  name: 'OpenCode',

  async getStatus(): Promise<RuntimeStatus> {
    try {
      const c = getClient();
      const projectResult = await c.project.current();

      if (projectResult.error) {
        return {
          online: false,
          name: 'OpenCode',
          error: `Project error: ${JSON.stringify(projectResult.error)}`,
        };
      }

      return {
        online: true,
        name: 'OpenCode',
        projectPath: config.OPENCODE_PROJECT_PATH,
      };
    } catch (error) {
      return {
        online: false,
        name: 'OpenCode',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async ask(prompt: string): Promise<string> {
    const c = getClient();
    const sessionId = await ensureSession();

    // Step 1: Send prompt
    console.log(`[OpenCode] Sending prompt to session ${sessionId}...`);
    const promptResult = await c.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    });

    if (promptResult.error) {
      throw new Error(`Prompt failed: ${JSON.stringify(promptResult.error)}`);
    }

    console.log('[OpenCode] Prompt sent, fetching messages...');

    // Step 2: Fetch all messages from session
    const messagesResult = await c.session.messages({
      path: { id: sessionId },
    });

    if (messagesResult.error) {
      throw new Error(`Failed to fetch messages: ${JSON.stringify(messagesResult.error)}`);
    }

    const messages = messagesResult.data ?? [];
    console.log(`[OpenCode] Total messages in session: ${messages.length}`);

    // Step 3: Find assistant messages (newest first)
    const assistantMessages = messages
      .filter((m) => m.info.role === 'assistant')
      .reverse();
    console.log(`[OpenCode] Assistant messages: ${assistantMessages.length}`);

    if (assistantMessages.length === 0) {
      throw new Error('No assistant response found in session');
    }

    // Step 4: Try to extract text from each assistant message (newest first)
    for (const msg of assistantMessages) {
      const extracted = extractTextFromMessage(msg);
      if (extracted) {
        return extracted;
      }
    }

    // No text found - print debug info for the latest assistant message
    console.log('[OpenCode] DEBUG: Latest assistant message structure:');
    console.log(JSON.stringify(assistantMessages[0], null, 2));
    throw new Error('Assistant message exists but no readable text found');
  },

  async readFile(relativePath: string): Promise<string> {
    // Security: validate path
    const validation = validateRelativePath(relativePath, config.OPENCODE_PROJECT_PATH);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const c = getClient();
    const result = await c.file.read({
      query: {
        directory: config.OPENCODE_PROJECT_PATH,
        path: relativePath,
      },
    });

    if (result.error) {
      throw new Error(`Failed to read file: ${JSON.stringify(result.error)}`);
    }

    return result.data?.content ?? '';
  },

  /**
   * runTask / planEdit / applyEdit delegate to ask().
   * The runner (runner.ts) injects the appropriate prompt prefixes and calls
   * this adapter's ask() directly — these methods exist to satisfy the
   * unified interface and for callers that want to invoke the adapter directly.
   */
  async runTask(task: string): Promise<string> {
    return opencodeAdapter.ask(task);
  },

  async planEdit(task: string): Promise<string> {
    return opencodeAdapter.ask(task);
  },

  async applyEdit(plan: string, task: string): Promise<string> {
    return opencodeAdapter.ask(`${plan}\n\nOriginal task: ${task}`);
  },

  async cancelTask(_taskId: string): Promise<void> {
    // Cancellation is handled externally via AbortController in runner.ts.
  },
};
