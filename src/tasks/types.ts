export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirm'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskType = 'run' | 'edit';

export interface Task {
  id: string;
  type: TaskType;
  prompt: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Telegram chat to send async updates to */
  chatId: number;
  /** Telegram user who created this task — used for ownership checks */
  fromUserId: number;
  /** Final result text (run or edit-apply) */
  result?: string;
  /** Generated plan text (edit, waiting_confirm stage) */
  plan?: string;
  /** Error message if failed */
  error?: string;
  /** Path to streaming log file (for CLI-based tasks) */
  logPath?: string;
}
