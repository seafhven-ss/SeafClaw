import { config } from '../config/env.js';

export function isUserAllowed(userId: number): boolean {
  return userId === config.TELEGRAM_ALLOWED_USER_ID;
}
