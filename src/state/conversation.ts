/**
 * Short-term conversation history — kept in memory, lost on restart.
 * Maintains the last N turns per chat so the LLM has context.
 */

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const MAX_TURNS = 10;
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours idle → auto-clear

class ConversationStore {
  private histories: Map<number, Turn[]> = new Map();

  /** Add a user message to the history. */
  addUser(chatId: number, content: string): void {
    this.ensureSession(chatId);
    const turns = this.histories.get(chatId)!;
    turns.push({ role: 'user', content, timestamp: Date.now() });
    this.trim(chatId);
  }

  /** Add an assistant response to the history. */
  addAssistant(chatId: number, content: string): void {
    this.ensureSession(chatId);
    const turns = this.histories.get(chatId)!;
    turns.push({ role: 'assistant', content, timestamp: Date.now() });
    this.trim(chatId);
  }

  /** Get the current history formatted for prompt injection. */
  getContextString(chatId: number): string {
    const turns = this.histories.get(chatId);
    if (!turns || turns.length === 0) return '';

    return turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
  }

  /** Get turn count for display. */
  turnCount(chatId: number): number {
    return this.histories.get(chatId)?.length ?? 0;
  }

  /** Clear history for a chat (e.g. /new). */
  clear(chatId: number): void {
    this.histories.delete(chatId);
  }

  private ensureSession(chatId: number): void {
    const turns = this.histories.get(chatId);
    if (turns && turns.length > 0) {
      const lastTs = turns[turns.length - 1].timestamp;
      if (Date.now() - lastTs > SESSION_TIMEOUT_MS) {
        // Session expired
        this.histories.set(chatId, []);
        return;
      }
    }
    if (!turns) {
      this.histories.set(chatId, []);
    }
  }

  private trim(chatId: number): void {
    const turns = this.histories.get(chatId);
    if (turns && turns.length > MAX_TURNS * 2) {
      // Keep last MAX_TURNS pairs (user + assistant)
      this.histories.set(chatId, turns.slice(-MAX_TURNS * 2));
    }
  }
}

export const conversationStore = new ConversationStore();
