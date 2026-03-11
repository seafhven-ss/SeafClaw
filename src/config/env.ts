import 'dotenv/config';

export interface EnvConfig {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USER_ID: number;
  DAEMON_NAME: string;
  POLL_TIMEOUT_SECONDS: number;
  // OpenCode
  OPENCODE_BASE_URL: string;
  OPENCODE_PROJECT_PATH: string;
  OPENCODE_TIMEOUT_MS: number;
  // Claude Code CLI
  CLAUDECODE_BIN: string;
  CLAUDECODE_TIMEOUT_MS: number;
  // Codex CLI
  CODEX_BIN: string;
  CODEX_TIMEOUT_MS: number;
  // Fallback text → /ask
  TELEGRAM_FALLBACK_TEXT_ENABLED: boolean;
  TELEGRAM_FALLBACK_PRIVATE_ONLY: boolean;
  // Search
  TAVILY_API_KEY: string;
  // X/Twitter (bird)
  BIRD_AUTH_TOKEN: string;
  BIRD_CT0: string;
  // STT
  GROQ_API_KEY: string;
  GROQ_STT_MODEL: string;
  WHISPER_BIN: string;
  WHISPER_MODEL_PATH: string;
  WHISPER_LANGUAGE: string;
  WHISPER_TIMEOUT_MS: number;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvVarAsNumber(key: string, defaultValue?: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
  }
  return num;
}

export const config: EnvConfig = {
  TELEGRAM_BOT_TOKEN: getEnvVar('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_ALLOWED_USER_ID: getEnvVarAsNumber('TELEGRAM_ALLOWED_USER_ID'),
  DAEMON_NAME: getEnvVar('DAEMON_NAME', 'telegram-agent-daemon'),
  POLL_TIMEOUT_SECONDS: getEnvVarAsNumber('POLL_TIMEOUT_SECONDS', 25),
  // OpenCode
  OPENCODE_BASE_URL: getEnvVar('OPENCODE_BASE_URL', 'http://localhost:9639'),
  OPENCODE_PROJECT_PATH: getEnvVar('OPENCODE_PROJECT_PATH', process.cwd()),
  OPENCODE_TIMEOUT_MS: getEnvVarAsNumber('OPENCODE_TIMEOUT_MS', 600_000),
  // Claude Code CLI  (defaults work if `claude` is on PATH)
  CLAUDECODE_BIN: getEnvVar('CLAUDECODE_BIN', 'claude'),
  CLAUDECODE_TIMEOUT_MS: getEnvVarAsNumber('CLAUDECODE_TIMEOUT_MS', 600_000),
  // Codex CLI  (defaults work if `codex` is on PATH)
  CODEX_BIN: getEnvVar('CODEX_BIN', 'codex'),
  CODEX_TIMEOUT_MS: getEnvVarAsNumber('CODEX_TIMEOUT_MS', 600_000),
  // Fallback text → /ask
  TELEGRAM_FALLBACK_TEXT_ENABLED: getEnvVar('TELEGRAM_FALLBACK_TEXT_ENABLED', 'true') === 'true',
  TELEGRAM_FALLBACK_PRIVATE_ONLY: getEnvVar('TELEGRAM_FALLBACK_PRIVATE_ONLY', 'true') === 'true',
  // Search
  TAVILY_API_KEY: getEnvVar('TAVILY_API_KEY', ''),
  // X/Twitter (bird)
  BIRD_AUTH_TOKEN: getEnvVar('BIRD_AUTH_TOKEN', ''),
  BIRD_CT0: getEnvVar('BIRD_CT0', ''),
  // STT
  GROQ_API_KEY: getEnvVar('GROQ_API_KEY', ''),
  GROQ_STT_MODEL: getEnvVar('GROQ_STT_MODEL', 'whisper-large-v3'),
  WHISPER_BIN: getEnvVar('WHISPER_BIN', 'C:\\telegram-agent-daemon\\bin\\Release\\whisper-cli.exe'),
  WHISPER_MODEL_PATH: getEnvVar('WHISPER_MODEL_PATH', 'C:\\telegram-agent-daemon\\models\\ggml-tiny.bin'),
  WHISPER_LANGUAGE: getEnvVar('WHISPER_LANGUAGE', 'zh'),
  WHISPER_TIMEOUT_MS: getEnvVarAsNumber('WHISPER_TIMEOUT_MS', 120_000),
};
