# Telegram Agent Daemon

[English](./README.md) | 中文

一个 TypeScript 守护进程，将 Telegram 变为多 AI 代码引擎的统一控制台。通过文字或语音消息与机器人交互，自动路由至 **Claude Code**、**Codex** 或 **OpenCode** 执行，支持对话历史、长期记忆和人格系统。

## 架构

```
Telegram Bot API
       │
       ▼
┌──────────────┐
│  长轮询       │  src/index.ts
│  + PID 锁    │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌─────────────┐
│  命令路由     │────▶│  统一调度器   │  src/core/ask-dispatcher.ts
│  src/telegram│     │             │
│  /commands.ts│     │ Prompt 组装：│
│              │     │ SOUL + USER  │
│              │     │ + 记忆 + 历史│
│              │     │ + 当前消息   │
└──────────────┘     └──────┬──────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Claude   │ │  Codex   │ │ OpenCode │
        │ Code CLI │ │  CLI     │ │ HTTP API │
        │ (cc)     │ │ (cx)     │ │ (op)     │
        └──────────┘ └──────────┘ └──────────┘
```

## 功能特性

- **多引擎路由** — 通过 `/e` 在 Claude Code (`cc`)、Codex (`cx`)、OpenCode (`op`) 之间切换
- **语音输入** — 发送语音消息，通过 Groq Whisper API（主）或本地 whisper.cpp（备）转文字
- **短期记忆** — 每个聊天独立的对话历史（10 轮，30 分钟超时自动清空）
- **长期记忆** — 持久化 `/mem` 系统，带 token 统计，以 Markdown 文件存储
- **人格系统** — `SOUL.md` 定义机器人行为风格，`USER.md` 定义用户画像
- **任务管理** — 计划-审批-执行的代码修改工作流
- **安全控制** — 基于 Telegram 用户 ID 的白名单机制
- **PID 锁** — 防止多个守护进程实例同时运行

## 快速开始

### 前置条件

- Node.js 20+
- 至少安装一个 AI 引擎：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 命令）
  - [Codex CLI](https://github.com/openai/codex)（`codex` 命令）
  - [OpenCode](https://github.com/opencode-ai/opencode)（HTTP 服务）

### 安装

```bash
git clone <repo-url>
cd telegram-agent-daemon
npm install

# 复制并填写环境变量
cp .env.example .env
```

编辑 `.env`：

```env
# 必填
TELEGRAM_BOT_TOKEN=你的Bot Token
TELEGRAM_ALLOWED_USER_ID=你的Telegram用户ID

# AI 引擎（至少配置一个）
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_PROJECT_PATH=/path/to/your/project
CLAUDECODE_BIN=claude
CODEX_BIN=codex

# 语音识别（可选）
GROQ_API_KEY=你的Groq API Key

# 守护进程
DAEMON_NAME=telegram-agent-daemon
POLL_TIMEOUT_SECONDS=25
```

### 人格文件（可选）

创建 `data/SOUL.md` 定义机器人人格：

```markdown
You are a precise, efficient AI assistant accessed via Telegram.
Be concise. Lead with the answer, not the reasoning.
```

创建 `data/USER.md` 定义用户画像：

```markdown
User is a developer who manages projects via this Telegram daemon.
Preferred language: Chinese for conversation, English for code.
```

### 运行

```bash
# 开发模式
npm run dev

# 生产模式（先编译）
npx tsc && npm start
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `/ask <内容>` | 向当前引擎发送提示词 |
| `/e [cc\|cx\|op]` | 查看或切换默认执行器 |
| `/status [请求ID]` | 查看执行器状态和最近请求 |
| `/mem` | 记忆管理（详见下方） |
| `/new` | 清空当前聊天的对话历史 |
| `/op <参数>` | 直接调用 OpenCode |
| `/cc <参数>` | 直接调用 Claude Code |
| `/cx <参数>` | 直接调用 Codex |
| `/tasks` | 查看最近任务 |
| `/approve <ID>` | 审批通过待确认任务 |
| `/deny <ID>` | 拒绝待确认任务 |
| `/cancel <ID>` | 取消任务 |
| `/ping` | 健康检查 |
| `/help` | 显示命令列表 |

**纯文本** 在私聊中自动当作 `/ask <文本>` 处理（可配置关闭）。

**语音消息** 转文字后走与文本相同的处理管道。

## 记忆系统

### 短期记忆（自动）

每个聊天独立维护对话历史，最多 10 轮。空闲 30 分钟后自动清空。始终开启，用于保持多轮对话连贯性。

### 长期记忆（`/mem`）

持久化存储于 `data/MEMORY.md`，可随时开关。开启后，记忆条目会注入到每次请求的提示词中。

```
/mem            — 查看状态和用法
/mem on|off     — 开启/关闭记忆注入
/mem show       — 列出所有条目及 token 统计
/mem add <标题>:<内容> — 添加记忆条目
/mem del <编号>  — 删除指定条目
/mem clear      — 清空全部记忆
/mem file       — 显示文件路径（可手动编辑）
```

每条记忆附带 token 估算（中文约 0.5 token/字，英文约 0.25 token/字）。

### Prompt 组装顺序

每次 `/ask` 请求的提示词按以下顺序拼装：

```
[System]           ← SOUL.md（人格定义）
[User Profile]     ← USER.md（用户画像）
[Long-term Memory] ← data/MEMORY.md（仅 /mem on 时注入）
[Conversation]     ← 最近对话轮次（自动）
[Current Message]  ← 用户当前输入
```

## 语音输入

语音消息采用双层转写策略：

1. **Groq Whisper API**（主通道）— 云端快速转写（约 1-2 秒），需配置 `GROQ_API_KEY`
2. **本地 whisper.cpp**（备用）— 离线转写，需安装 `whisper-cli` 和模型文件

Telegram 语音消息（OGG/Opus 格式）直接发送至 Groq；本地 whisper 则通过 `ffmpeg` 转为 WAV 后处理。

## 项目结构

```
src/
├── index.ts                 # 入口，轮询循环，PID 锁
├── config/env.ts            # 环境变量加载
├── telegram/
│   ├── bot.ts               # Telegram Bot API 客户端
│   └── commands.ts          # 命令路由
├── core/
│   ├── ask-dispatcher.ts    # 统一 /ask 调度 + Prompt 组装
│   ├── router.ts            # /op 命令路由
│   ├── cc-router.ts         # /cc 命令路由
│   ├── cx-router.ts         # /cx 命令路由
│   └── adapter-router.ts    # 通用适配器路由
├── runtimes/
│   ├── base.ts              # RuntimeAdapter 接口定义
│   ├── claudecode.ts        # Claude Code CLI 适配器
│   ├── codex.ts             # Codex CLI 适配器
│   └── opencode.ts          # OpenCode HTTP 适配器
├── state/
│   ├── bootstrap.ts         # SOUL.md / USER.md 加载器
│   ├── conversation.ts      # 短期对话历史
│   ├── memory.ts            # 长期持久记忆
│   ├── executor-store.ts    # 引擎选择 + 记忆开关
│   ├── request-store.ts     # 请求历史追踪
│   ├── storage.ts           # JSON 文件读写工具
│   └── types.ts             # 共享类型定义
├── tasks/
│   ├── manager.ts           # 任务 CRUD + AbortController
│   ├── runner.ts            # 任务执行（计划/应用）
│   ├── safety.ts            # 路径安全检查
│   └── types.ts             # 任务类型定义
├── security/
│   ├── allowlist.ts         # 用户 ID 白名单
│   └── path.ts              # 路径遍历防护
└── utils/
    ├── chunk.ts             # 消息分块（适配 Telegram 长度限制）
    ├── shell.ts             # CLI 进程启动（兼容 Windows）
    └── stt.ts               # 语音转文字（Groq + whisper.cpp）

data/
├── SOUL.md                  # 机器人人格定义
├── USER.md                  # 用户画像
└── MEMORY.md                # 长期记忆（自动管理）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TELEGRAM_BOT_TOKEN` | *（必填）* | Telegram Bot API Token |
| `TELEGRAM_ALLOWED_USER_ID` | *（必填）* | 授权的 Telegram 用户 ID |
| `DAEMON_NAME` | `telegram-agent-daemon` | 进程名称（用于日志） |
| `POLL_TIMEOUT_SECONDS` | `25` | 长轮询超时秒数 |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode API 地址 |
| `OPENCODE_PROJECT_PATH` | 当前目录 | OpenCode 项目路径 |
| `OPENCODE_TIMEOUT_MS` | `120000` | OpenCode 请求超时 |
| `CLAUDECODE_BIN` | `claude` | Claude Code CLI 路径 |
| `CLAUDECODE_TIMEOUT_MS` | `300000` | Claude Code 超时 |
| `CODEX_BIN` | `codex` | Codex CLI 路径 |
| `CODEX_TIMEOUT_MS` | `300000` | Codex 超时 |
| `TELEGRAM_FALLBACK_TEXT_ENABLED` | `true` | 纯文本自动路由到 /ask |
| `TELEGRAM_FALLBACK_PRIVATE_ONLY` | `true` | 仅私聊启用文本自动路由 |
| `GROQ_API_KEY` | *（可选）* | Groq API Key（云端语音转写） |
| `GROQ_STT_MODEL` | `whisper-large-v3` | Groq Whisper 模型 |
| `WHISPER_BIN` | `whisper-cli` | 本地 whisper 二进制路径 |
| `WHISPER_MODEL_PATH` | `models/ggml-tiny.bin` | 本地 whisper 模型路径 |
| `WHISPER_LANGUAGE` | `zh` | Whisper 语言代码 |
| `WHISPER_TIMEOUT_MS` | `120000` | 本地 whisper 超时 |

## 许可证

MIT
