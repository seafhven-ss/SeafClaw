import { routeOpCommand } from '../core/router.js';
import { routeCcCommand } from '../core/cc-router.js';
import { routeCxCommand } from '../core/cx-router.js';
import { dispatchAsk } from '../core/ask-dispatcher.js';
import { executorStore } from '../state/executor-store.js';
import { requestStore } from '../state/request-store.js';
import { conversationStore } from '../state/conversation.js';
import { memoryStore } from '../state/memory.js';
import type { EngineId, RequestRecord } from '../state/types.js';
import { taskManager, formatTaskLine, statusEmoji } from '../tasks/manager.js';
import { executeEditApply } from '../tasks/runner.js';

export interface CommandResult {
  messages: string[];
}

type SyncCommandHandler = () => CommandResult;

const syncCommands: Record<string, SyncCommandHandler> = {
  '/ping': () => ({ messages: ['pong'] }),

  '/help': () => ({
    messages: [
      [
        '主命令：',
        '/e                  - 查看/切换默认执行器 (cc|cx|op)',
        '/ask <内容>         - 统一请求入口（走当前执行器）',
        '/status             - 查看执行器和最近请求',
        '/mem                - 记忆管理 (on|off|show|add|del|clear|file)',
        '/new                - 清空当前对话历史',
        '',
        '提示：直接发送纯文本 = /ask <文本>',
        '',
        '旧命令（兼容保留）：',
        '/op /cc /cx /tasks /approve /deny /cancel /ping',
      ].join('\n'),
    ],
  }),
};

export async function handleCommand(
  text: string,
  chatId: number,
  fromUserId: number,
): Promise<CommandResult | null> {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();

  const syncHandler = syncCommands[command];
  if (syncHandler) return syncHandler();

  if (command === '/e') {
    return handleExecutorCommand(parts[1]?.toLowerCase());
  }

  if (command === '/status') {
    return handleUnifiedStatus(parts[1]);
  }

  if (command === '/ask') {
    const askContent = trimmed.slice(4).trim();
    return handleAskCommand(askContent, chatId);
  }

  if (command === '/mem') {
    const memArgs = trimmed.slice(4).trim();
    return handleMemCommand(memArgs);
  }

  if (command === '/new') {
    conversationStore.clear(chatId);
    return { messages: ['对话历史已清空，开始新会话。'] };
  }

  if (command === '/op') {
    const args = trimmed.slice(3).trim();
    const result = await routeOpCommand(args, chatId, fromUserId);
    return { messages: result.messages };
  }

  if (command === '/cc') {
    const args = trimmed.slice(3).trim();
    const result = await routeCcCommand(args, chatId, fromUserId);
    return { messages: result.messages };
  }

  if (command === '/cx') {
    const args = trimmed.slice(3).trim();
    const result = await routeCxCommand(args);
    return { messages: result.messages };
  }

  if (command === '/tasks') return handleTasks();
  if (command === '/approve') return handleApprove(parts[1], fromUserId);
  if (command === '/deny') return handleDeny(parts[1], fromUserId);
  if (command === '/cancel') return handleCancel(parts[1], fromUserId);

  return null;
}

export function getCommandList(): string[] {
  return [...Object.keys(syncCommands), '/e', '/status', '/ask', '/mem', '/new', '/op', '/cc', '/cx', '/tasks', '/approve', '/deny', '/cancel'];
}

const VALID_ENGINES: EngineId[] = ['cc', 'cx', 'op'];

const ENGINE_DESCRIPTIONS: Record<EngineId, string> = {
  cc: 'Claude Code — 主开发执行器',
  cx: 'Codex — 替补/补丁执行器',
  op: 'OpenCode — 基础终端兜底执行器',
};

async function handleExecutorCommand(rawEngine: string | undefined): Promise<CommandResult> {
  if (!rawEngine) {
    const current = await executorStore.getDefaultEngine();
    const lines = [
      `当前默认执行器：${current}`,
      `可选执行器：${VALID_ENGINES.join(', ')}`,
      '',
      ...VALID_ENGINES.map((e) => `  ${e} = ${ENGINE_DESCRIPTIONS[e]}`),
    ];
    return { messages: [lines.join('\n')] };
  }

  if (!VALID_ENGINES.includes(rawEngine as EngineId)) {
    return { messages: [`Usage: /e [${VALID_ENGINES.join('|')}]\nExample: /e cc`] };
  }

  await executorStore.setDefaultEngine(rawEngine as EngineId);
  return { messages: [`已切换默认执行器为：${rawEngine}`] };
}

async function handleUnifiedStatus(rawRequestId: string | undefined): Promise<CommandResult> {
  const currentEngine = await executorStore.getDefaultEngine();
  const requestId = rawRequestId?.trim();

  if (requestId) {
    const record = await requestStore.get(requestId);
    if (!record) {
      return { messages: [`当前默认执行器：${currentEngine}\n未找到请求 ${requestId}`] };
    }
    return { messages: [formatRequestDetail(currentEngine, record)] };
  }

  const recent = await requestStore.recent(5);
  const lines = [`当前默认执行器：${currentEngine}`, '最近请求：'];

  if (recent.length === 0) {
    lines.push('暂无记录');
  } else {
    for (const record of recent) {
      lines.push(formatRequestBrief(record));
    }
  }

  return { messages: [lines.join('\n')] };
}

function formatRequestBrief(record: RequestRecord): string {
  return [
    record.requestId,
    record.engine,
    record.status,
    formatTimestamp(record.updatedAt),
  ].join(' | ');
}

function formatRequestDetail(currentEngine: EngineId, record: RequestRecord): string {
  const lines = [
    `当前默认执行器：${currentEngine}`,
    `requestId: ${record.requestId}`,
    `engine: ${record.engine}`,
    `status: ${record.status}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    `input: ${record.inputSummary}`,
  ];

  if (record.resultSummary) lines.push(`result: ${record.resultSummary}`);
  if (record.errorSummary) lines.push(`error: ${record.errorSummary}`);

  return lines.join('\n');
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

function normalizeTaskId(rawId: string): string {
  return rawId
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .replace(/^#+/, '');
}

function handleTasks(): CommandResult {
  const tasks = taskManager.recent(10);
  if (tasks.length === 0) {
    return { messages: ['No tasks yet.'] };
  }
  const lines = tasks.map((task) => `${statusEmoji(task.status)} ${formatTaskLine(task)}`);
  return { messages: [`Recent tasks (newest first):\n\n${lines.join('\n')}`] };
}

function handleApprove(rawId: string | undefined, fromUserId: number): CommandResult {
  if (!rawId) {
    return { messages: ['Usage: /approve <taskId>\nExample: /approve a3f2c1'] };
  }

  const id = normalizeTaskId(rawId);
  const task = taskManager.get(id);

  if (!task) {
    return { messages: [`Task #${id} not found.`] };
  }

  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} was not created by you.`] };
  }

  if (task.status !== 'waiting_confirm') {
    return {
      messages: [
        `Task #${id} cannot be approved - current status: ${task.status}\nOnly tasks in waiting_confirm can be approved.`,
      ],
    };
  }

  if (!task.plan) {
    return { messages: [`Task #${id} has no plan to execute.`] };
  }

  taskManager.update(id, { status: 'running' });
  console.log(`[Commands] Approved task #${id} by user ${fromUserId}, dispatching edit-apply`);
  void executeEditApply(id);

  return { messages: [`Task #${id} approved. Applying changes via OpenCode...`] };
}

function handleDeny(rawId: string | undefined, fromUserId: number): CommandResult {
  if (!rawId) {
    return { messages: ['Usage: /deny <taskId>\nExample: /deny a3f2c1'] };
  }

  const id = normalizeTaskId(rawId);
  const task = taskManager.get(id);

  if (!task) {
    return { messages: [`Task #${id} not found.`] };
  }

  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} was not created by you.`] };
  }

  if (task.status !== 'waiting_confirm') {
    return {
      messages: [
        `Task #${id} cannot be denied - current status: ${task.status}\nOnly tasks in waiting_confirm can be denied.`,
      ],
    };
  }

  taskManager.update(id, { status: 'cancelled' });
  return { messages: [`Task #${id} denied and cancelled.`] };
}

async function handleMemCommand(args: string): Promise<CommandResult> {
  const parts = args.split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? '';

  switch (sub) {
    case '': {
      // /mem — show status
      const enabled = await executorStore.isMemoryEnabled();
      const entries = await memoryStore.getAll();
      const total = entries.reduce((s, e) => s + e.tokens, 0);
      const lines = [
        `记忆模式：${enabled ? '开启' : '关闭'}`,
        `记忆条目：${entries.length} 条`,
        `总 token 估算：~${total}`,
        `文件：${memoryStore.getFilePath()}`,
        '',
        '用法：',
        '/mem on|off    - 开关记忆',
        '/mem show      - 显示所有记忆（含 token 数）',
        '/mem add <内容> - 添加记忆',
        '/mem del <编号> - 删除指定记忆',
        '/mem clear     - 清空全部记忆',
        '/mem file      - 显示文件路径（可手动编辑）',
      ];
      return { messages: [lines.join('\n')] };
    }

    case 'on': {
      await executorStore.setMemoryEnabled(true);
      return { messages: ['记忆模式已开启。后续 /ask 将注入长期记忆。'] };
    }

    case 'off': {
      await executorStore.setMemoryEnabled(false);
      return { messages: ['记忆模式已关闭。后续 /ask 不注入长期记忆。'] };
    }

    case 'show': {
      const entries = await memoryStore.getAll();
      if (entries.length === 0) {
        return { messages: ['暂无记忆条目。使用 /mem add <内容> 添加。'] };
      }
      const lines = entries.map(
        (e) => `#${e.id} ${e.title} [~${e.tokens} tokens]\n${e.content}`,
      );
      const total = entries.reduce((s, e) => s + e.tokens, 0);
      lines.push(`\n总计：${entries.length} 条，~${total} tokens`);
      return { messages: [lines.join('\n\n')] };
    }

    case 'add': {
      const content = parts.slice(1).join(' ').trim();
      if (!content) {
        return { messages: ['Usage: /mem add <标题>: <内容>\nExample: /mem add 偏好: 我习惯用 pnpm'] };
      }
      // Split title:content by first colon or use full text as both
      const colonIdx = content.indexOf(':');
      let title: string;
      let body: string;
      if (colonIdx > 0 && colonIdx < 30) {
        title = content.slice(0, colonIdx).trim();
        body = content.slice(colonIdx + 1).trim() || title;
      } else {
        title = content.slice(0, 20).trim();
        body = content;
      }
      const entry = await memoryStore.add(title, body);
      return { messages: [`已添加记忆 #${entry.id}「${entry.title}」(~${entry.tokens} tokens)`] };
    }

    case 'del': {
      const id = parseInt(parts[1], 10);
      if (isNaN(id)) {
        return { messages: ['Usage: /mem del <编号>\nExample: /mem del 2'] };
      }
      const ok = await memoryStore.remove(id);
      return { messages: [ok ? `已删除记忆 #${id}` : `未找到记忆 #${id}`] };
    }

    case 'clear': {
      const count = await memoryStore.clear();
      return { messages: [`已清空全部记忆（${count} 条）`] };
    }

    case 'file': {
      return { messages: [`记忆文件路径：\n${memoryStore.getFilePath()}\n\n可直接用编辑器打开修改。修改后立即生效（下次 /ask 时重新读取）。`] };
    }

    default:
      return { messages: ['未知子命令。使用 /mem 查看帮助。'] };
  }
}

async function handleAskCommand(content: string, chatId: number): Promise<CommandResult> {
  if (!content) {
    return { messages: ['Usage: /ask <内容>\nExample: /ask 这个项目的结构是什么？'] };
  }

  const receipt = await dispatchAsk(content, chatId);
  return { messages: receipt.messages };
}

function handleCancel(rawId: string | undefined, fromUserId: number): CommandResult {
  if (!rawId) {
    return { messages: ['Usage: /cancel <taskId>\nExample: /cancel a3f2c1'] };
  }

  const id = normalizeTaskId(rawId);
  const task = taskManager.get(id);

  if (!task) {
    return { messages: [`Task #${id} not found.`] };
  }

  if (task.fromUserId !== fromUserId) {
    return { messages: [`Task #${id} was not created by you.`] };
  }

  const cancellable = ['queued', 'running', 'waiting_confirm'];
  if (!cancellable.includes(task.status)) {
    return { messages: [`Task #${id} cannot be cancelled - current status: ${task.status}`] };
  }

  taskManager.cancel(id);

  return {
    messages: [
      `Task #${id} cancelled.\nThe in-flight OpenCode request has been signalled to stop.\nResults will not be delivered even if the network call completes.`,
    ],
  };
}
