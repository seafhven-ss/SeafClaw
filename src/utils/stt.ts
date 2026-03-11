/**
 * Speech-to-Text: Groq Whisper API (fast, online) → local whisper.cpp (fallback).
 *
 * Telegram voice = OGG/Opus.
 * - Groq API accepts OGG directly.
 * - Local whisper.cpp needs ffmpeg OGG/Opus → WAV conversion.
 */
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from '../config/env.js';
import { runCli } from './shell.js';

const TMP_DIR = join(tmpdir(), 'telegram-agent-daemon', 'voice');

/**
 * Transcribe audio buffer to text.
 * Tries Groq API first; on any failure falls back to local whisper.cpp.
 */
export async function transcribe(audioBuffer: Buffer): Promise<string> {
  // Try Groq first if API key is configured
  if (config.GROQ_API_KEY) {
    try {
      const text = await transcribeGroq(audioBuffer);
      if (text) return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[STT] Groq failed, falling back to local whisper: ${msg}`);
    }
  }

  // Fallback: local whisper.cpp
  return transcribeLocal(audioBuffer);
}

// ── Groq Whisper API ─────────────────────────────────────────────────────────

async function transcribeGroq(audioBuffer: Buffer): Promise<string> {
  console.log(`[STT] Groq API: sending ${audioBuffer.length} bytes...`);

  // Groq uses OpenAI-compatible multipart form
  const blob = new Blob([audioBuffer as unknown as BlobPart], { type: 'audio/ogg' });

  const form = new FormData();
  form.append('file', blob, 'voice.ogg');
  form.append('model', config.GROQ_STT_MODEL);
  form.append('language', config.WHISPER_LANGUAGE);
  form.append('response_format', 'text');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq API ${response.status}: ${body.slice(0, 200)}`);
  }

  const text = (await response.text()).trim();
  if (!text) throw new Error('Groq returned empty transcription');

  console.log(`[STT] Groq result: "${text.slice(0, 100)}"`);
  return text;
}

// ── Local whisper.cpp ────────────────────────────────────────────────────────

async function transcribeLocal(audioBuffer: Buffer): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });

  const id = randomBytes(4).toString('hex');
  const oggPath = join(TMP_DIR, `voice-${id}.ogg`);
  const wavPath = join(TMP_DIR, `voice-${id}.wav`);
  const txtPath = join(TMP_DIR, `voice-${id}.txt`);

  try {
    // 1. Write OGG/Opus to temp file
    await writeFile(oggPath, audioBuffer);
    console.log(`[STT] Local: converting OGG/Opus → WAV (${audioBuffer.length} bytes)...`);

    // 2. Convert to 16kHz mono WAV
    await runCli('ffmpeg', [
      '-i', oggPath,
      '-ar', '16000',
      '-ac', '1',
      '-y',
      wavPath,
    ], { timeoutMs: 30_000 });

    console.log(`[STT] Local: transcribing with whisper-cli...`);

    // 3. Run whisper-cli
    const { stdout } = await runCli(
      config.WHISPER_BIN,
      [
        '--model', config.WHISPER_MODEL_PATH,
        '--language', config.WHISPER_LANGUAGE,
        '--no-timestamps',
        '--no-prints',
        '--output-txt',
        '--output-file', join(TMP_DIR, `voice-${id}`),
        wavPath,
      ],
      { timeoutMs: config.WHISPER_TIMEOUT_MS },
    );

    // 4. Read result
    let text: string;
    try {
      text = (await readFile(txtPath, 'utf8')).trim();
    } catch {
      text = parseWhisperOutput(stdout);
    }

    if (!text) throw new Error('Local whisper returned empty transcription');

    console.log(`[STT] Local result: "${text.slice(0, 100)}"`);
    return text;
  } finally {
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}

function parseWhisperOutput(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}
