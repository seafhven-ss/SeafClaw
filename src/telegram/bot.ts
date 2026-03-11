import { config } from '../config/env.js';

const BASE_URL = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callApi<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const url = `${BASE_URL}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = (await response.json()) as TelegramResponse<T>;

  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? 'Unknown error'}`);
  }

  return data.result as T;
}

export async function getMe(): Promise<TelegramUser> {
  return callApi<TelegramUser>('getMe');
}

export async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>('getUpdates', {
    offset,
    timeout: config.POLL_TIMEOUT_SECONDS,
    allowed_updates: ['message'],
  });
}

export async function sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
  return callApi<TelegramMessage>('sendMessage', {
    chat_id: chatId,
    text,
  });
}

/** Get the download URL for a file on Telegram servers. */
export async function getFileUrl(fileId: string): Promise<string> {
  const file = await callApi<{ file_id: string; file_path?: string }>('getFile', {
    file_id: fileId,
  });
  if (!file.file_path) {
    throw new Error('Telegram did not return a file_path');
  }
  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

/** Download a file from Telegram servers as a Buffer. */
export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
