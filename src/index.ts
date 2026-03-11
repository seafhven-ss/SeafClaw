import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config/env.js';
import { getMe, getUpdates, sendMessage, getFileUrl, downloadFile, type TelegramMessage, type TelegramChat } from './telegram/bot.js';
import { isUserAllowed } from './security/allowlist.js';
import { handleCommand } from './telegram/commands.js';
import { dispatchAsk } from './core/ask-dispatcher.js';
import { transcribe } from './utils/stt.js';
import { loadBootstrapFiles } from './state/bootstrap.js';

// ── PID lock: prevent multiple daemon instances ──────────────────────────────
const PID_FILE = join(import.meta.dirname ?? '.', '..', 'daemon.pid');

function acquireLock(): void {
  if (existsSync(PID_FILE)) {
    const oldPid = readFileSync(PID_FILE, 'utf8').trim();
    // Check if old process is still alive
    try {
      process.kill(Number(oldPid), 0); // signal 0 = existence check
      console.error(`[Fatal] Another daemon is already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Old process is dead — stale PID file, safe to overwrite
      console.log(`[Daemon] Removing stale PID file (old PID ${oldPid})`);
    }
  }
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
  console.log(`[Daemon] PID lock acquired: ${process.pid}`);
}

function releaseLock(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

const UNAUTHORIZED_MESSAGE = '未授权用户，已拒绝访问。';

async function processMessage(message: TelegramMessage): Promise<void> {
  const { from, chat, text } = message;

  // Log all incoming messages
  console.log(`[Message] from.id=${from?.id ?? 'unknown'} chat.id=${chat.id} text="${text ?? ''}" voice=${!!message.voice}`);

  if (!from) return;

  // Check authorization
  if (!isUserAllowed(from.id)) {
    console.log(`[Security] Unauthorized user: ${from.id}`);
    await sendMessage(chat.id, UNAUTHORIZED_MESSAGE);
    return;
  }

  // Voice message → STT → treat as text
  if (message.voice && !text) {
    try {
      await handleVoiceMessage(message.voice.file_id, message.voice.duration, chat, from.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Error] Voice processing failed: ${errMsg}`);
      await sendMessage(chat.id, `语音识别失败：${errMsg}`);
    }
    return;
  }

  if (!text) return;

  try {
    // Handle commands
    const result = await handleCommand(text, chat.id, from.id);
    if (result) {
      // Send all message parts
      for (const msg of result.messages) {
        await sendMessage(chat.id, msg);
      }
    } else if (!text.startsWith('/')) {
      // Plain text fallback → /ask
      await handleTextFallback(text, chat, from.id);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Error] processMessage failed for "${text}": ${errMsg}`);
    // Try once more to notify the user
    try {
      await sendMessage(chat.id, `处理命令失败：${errMsg}`);
    } catch {
      console.error('[Error] Failed to send error notification to user');
    }
  }
}

async function handleVoiceMessage(
  fileId: string,
  duration: number,
  chat: TelegramChat,
  fromUserId: number,
): Promise<void> {
  console.log(`[Daemon] Voice message received (${duration}s), downloading...`);

  // 1. Download audio
  const fileUrl = await getFileUrl(fileId);
  const audioBuffer = await downloadFile(fileUrl);

  // 2. Transcribe
  const text = await transcribe(audioBuffer);

  // 3. Echo transcription to user
  await sendMessage(chat.id, `语音识别：${text}`);

  // 4. Feed into the same pipeline as text input
  const result = await handleCommand(text, chat.id, fromUserId);
  if (result) {
    for (const msg of result.messages) {
      await sendMessage(chat.id, msg);
    }
  } else if (!text.startsWith('/')) {
    await handleTextFallback(text, chat, fromUserId);
  }
}

async function handleTextFallback(
  text: string,
  chat: TelegramChat,
  _fromUserId: number,
): Promise<void> {
  // Check if fallback is enabled
  if (!config.TELEGRAM_FALLBACK_TEXT_ENABLED) return;

  // Check private-only constraint
  if (config.TELEGRAM_FALLBACK_PRIVATE_ONLY && chat.type !== 'private') return;

  const content = text.trim();
  if (!content) return;

  console.log(`[Daemon] Text fallback → /ask: "${content.slice(0, 80)}"`);

  const receipt = await dispatchAsk(content, chat.id);
  for (const msg of receipt.messages) {
    await sendMessage(chat.id, msg);
  }
}

async function startPolling(): Promise<void> {
  let offset: number | undefined;

  console.log(`[Daemon] Starting long polling (timeout=${config.POLL_TIMEOUT_SECONDS}s)...`);

  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message) {
          await processMessage(update.message);
        }
      }
    } catch (error) {
      console.error('[Error] Polling failed:', error);
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function main(): Promise<void> {
  acquireLock();
  console.log(`[Daemon] ${config.DAEMON_NAME} starting...`);
  console.log(`[Daemon] Stage 3: Async Task Engine (build ${new Date().toISOString()})`);

  // Verify bot token
  try {
    const me = await getMe();
    console.log(`[Telegram] Bot connected: @${me.username ?? me.first_name} (id=${me.id})`);
  } catch (error) {
    console.error('[Fatal] Failed to connect to Telegram:', error);
    process.exit(1);
  }

  console.log(`[Security] Allowed user ID: ${config.TELEGRAM_ALLOWED_USER_ID}`);
  console.log(`[OpenCode] Base URL: ${config.OPENCODE_BASE_URL}`);
  console.log(`[OpenCode] Project Path: ${config.OPENCODE_PROJECT_PATH}`);

  // Load personality & user profile files
  await loadBootstrapFiles();

  // Start polling
  await startPolling();
}

main().catch((error) => {
  console.error('[Fatal] Unhandled error:', error);
  process.exit(1);
});
