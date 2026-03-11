# telegram-agent-daemon 架构说明文档

> 存储路径：`C:\telegram-agent-daemon\ARCHITECTURE.md`
> 版本：Phase 3（OpenCode + Claude Code + Codex 插件化）

---

## 一、项目定位

一个运行在本地 Windows 机器上的 Telegram bot daemon，通过 long polling 接收你发出的命令，将任务分发给三个独立的 AI 执行引擎（OpenCode、Claude Code、Codex），并把结果返回到 Telegram。

**三个引擎完全独立，互不中转。**

---

## 二、消息路由全链路

```
你（Telegram）
    │
    │  发送消息
    ▼
Telegram 服务器
    │
    │  long polling（每 25 秒轮询）
    ▼
src/index.ts
    │
    ├─ 安全拦截：src/security/allowlist.ts
    │    如果 from.id 不在白名单 → 拒绝，返回"未授权"
    │
    ▼
src/telegram/commands.ts  ← handleCommand(text, chatId, fromUserId)
    │
    ├─ /ping /status /help   → 同步返回，无 AI 调用
    │
    ├─ /tasks               → 查询内存任务表，返回最近 10 条
    │
    ├─ /approve /deny /cancel → 任务状态管理（见第四节）
    │
    ├─ /op <subcommand>
    │    └──▶ src/core/router.ts
    │              └──▶ src/runtimes/opencode.ts
    │                        └──▶ OpenCode HTTP API (localhost:9639)
    │
    ├─ /cc <subcommand>
    │    └──▶ src/core/cc-router.ts
    │              └──▶ src/runtimes/claudecode.ts
    │                        └──▶ 子进程：claude -p --dangerously-skip-permissions
    │
    └─ /cx <subcommand>
         └──▶ src/core/cx-router.ts
                   └──▶ src/runtimes/codex.ts
                             └──▶ 子进程：codex exec --json --full-auto -s read-only
```

**结论：`/op` `/cc` `/cx` 各自直连自己的引擎，OpenCode 不会中转 cc 或 cx 的请求。**

---

## 三、全部 Telegram 命令

### 3.1 系统命令

| 命令 | 说明 | 是否异步 |
|------|------|----------|
| `/ping` | 存活检测，返回 pong | 否 |
| `/status` | 显示 daemon 状态、阶段、配置路径 | 否 |
| `/help` | 所有命令列表 | 否 |

### 3.2 OpenCode 命令（`/op`）

> 引擎：OpenCode HTTP API，地址由 `OPENCODE_BASE_URL` 配置

| 命令 | 说明 | 是否异步 |
|------|------|----------|
| `/op status` | 检查 OpenCode 连接状态 | 否 |
| `/op ask <问题>` | 向 OpenCode 提问，同步等待返回 | 否 |
| `/op read <相对路径>` | 读取项目文件内容 | 否 |
| `/op run <任务>` | 创建只读任务，异步执行，结果推送回 Telegram | **是** |
| `/op edit <任务>` | 生成修改计划（不写文件），等待确认 | **是** |

### 3.3 Claude Code 命令（`/cc`）

> 引擎：本地 `claude` CLI，通过子进程调用

| 命令 | 说明 | 是否异步 |
|------|------|----------|
| `/cc status` | 运行 `claude --version`，检查 CLI 是否可用 | 否 |
| `/cc ask <问题>` | 运行 `claude -p`，非交互模式返回回答 | 否 |

### 3.4 Codex 命令（`/cx`）

> 引擎：本地 `codex` CLI，通过子进程调用

| 命令 | 说明 | 是否异步 |
|------|------|----------|
| `/cx status` | 运行 `codex --version`，检查 CLI 是否可用 | 否 |
| `/cx ask <问题>` | 运行 `codex exec --json --full-auto -s read-only`，解析 JSONL 返回回答 | 否 |

### 3.5 任务控制命令

> 仅对 `/op run` 和 `/op edit` 创建的任务有效

| 命令 | 说明 |
|------|------|
| `/tasks` | 列出最近 10 条任务（含 taskId、类型、状态、创建时间） |
| `/approve <taskId>` | 批准 waiting_confirm 状态的 edit 任务，触发真正写入 |
| `/deny <taskId>` | 拒绝 edit 计划，任务标记 cancelled |
| `/cancel <taskId>` | 取消 queued / running / waiting_confirm 任务，同时 abort 底层 HTTP 请求 |

**taskId 输入格式兼容：** `a3f2c1` / `#a3f2c1` / `<a3f2c1>` / `<#a3f2c1>` 均可识别。

---

## 四、任务系统（`/op run` / `/op edit`）

### 4.1 任务状态机

```
queued ──▶ running ──▶ done
                   └──▶ failed
                   └──▶ waiting_confirm ──▶ running ──▶ done
                                        └──▶ cancelled（/deny）
任意状态（queued/running/waiting_confirm）可被 /cancel 强制终止
```

### 4.2 `/op run` 完整流程

```
1. 安全拦截：高危指令检测（rm -rf / rd /s / bcdedit 等）
2. 创建 task（status: queued），立即回复 "Task #xxx queued"
3. 后台异步调用 OpenCode ask()，前缀 [READ-ONLY MODE]
4. 完成后推送结果到 Telegram
```

### 4.3 `/op edit` 完整流程

```
1. 安全拦截
2. 创建 task（status: queued），立即回复 "Task #xxx queued"
3. 后台异步调用 OpenCode ask()，前缀 [PLANNING MODE — NO FILE WRITES ALLOWED]
4. 生成计划后 status 变为 waiting_confirm，推送计划 + 操作提示
5. 用户发送 /approve → status 原子切换为 running → 调用 applyEdit
6. 用户发送 /deny → status 变为 cancelled
```

### 4.4 取消机制

`/cancel` 调用 `taskManager.cancel(id)`，该方法：
1. 查找并调用对应 `AbortController.abort()`
2. runner 内 `raceAbort()` 立即 throw AbortError
3. 状态设为 cancelled，不推送任何结果

---

## 五、目录结构

```
C:\telegram-agent-daemon\
├── .env                      # 实际配置（不提交 git）
├── .env.example              # 配置模板
├── ARCHITECTURE.md           # 本文档
├── package.json
├── tsconfig.json
└── src\
    ├── index.ts              # 入口：polling 循环 + 消息分发
    │
    ├── config\
    │   └── env.ts            # 读取 .env，导出 config 对象
    │
    ├── security\
    │   ├── allowlist.ts      # 用户白名单（单一 userId）
    │   └── path.ts           # 路径校验（防止路径穿越）
    │
    ├── telegram\
    │   ├── bot.ts            # Telegram API 封装（getUpdates / sendMessage）
    │   └── commands.ts       # 主命令分发器，所有命令入口
    │
    ├── core\
    │   ├── router.ts         # /op 子命令路由（OpenCode 专用）
    │   ├── adapter-router.ts # 通用 status/ask 路由（/cc /cx 共用）
    │   ├── cc-router.ts      # /cc → claudecodeAdapter
    │   └── cx-router.ts      # /cx → codexAdapter
    │
    ├── runtimes\
    │   ├── base.ts           # RuntimeAdapter 接口 + NotImplementedError
    │   ├── opencode.ts       # OpenCode adapter（HTTP API）
    │   ├── claudecode.ts     # Claude Code adapter（claude CLI 子进程）
    │   └── codex.ts          # Codex adapter（codex CLI 子进程）
    │
    ├── tasks\
    │   ├── types.ts          # Task / TaskStatus / TaskType 类型
    │   ├── manager.ts        # 内存任务表 + AbortController 注册表
    │   ├── runner.ts         # 异步执行引擎（executeRun / editPlan / editApply）
    │   └── safety.ts         # 高危指令正则拦截（30+ 条规则）
    │
    └── utils\
        ├── chunk.ts          # 长文本分片（≤3970字符/片，带序号头）
        └── shell.ts          # CLI 子进程执行器（spawn + stdin + timeout）
```

---

## 六、配置文件（.env）

```ini
# Telegram
TELEGRAM_BOT_TOKEN=          # BotFather 给的 token
TELEGRAM_ALLOWED_USER_ID=    # 你自己的 Telegram 数字 ID
DAEMON_NAME=telegram-agent-daemon
POLL_TIMEOUT_SECONDS=25

# OpenCode（需要 opencode 服务器在运行）
OPENCODE_BASE_URL=http://localhost:9639
OPENCODE_PROJECT_PATH=C:\path\to\your\project
OPENCODE_TIMEOUT_MS=60000

# Claude Code CLI（需要 claude 在 PATH 中）
CLAUDECODE_BIN=claude
CLAUDECODE_TIMEOUT_MS=120000

# Codex CLI（需要 codex 在 PATH 中）
CODEX_BIN=codex
CODEX_TIMEOUT_MS=120000
```

---

## 七、各引擎的前置条件

| 引擎 | 前置条件 | 检查命令 |
|------|----------|----------|
| OpenCode | opencode 服务器在运行，且监听 `OPENCODE_BASE_URL` | `/op status` |
| Claude Code | `@anthropic-ai/claude-code` 已全局安装，已登录 | `claude --version` |
| Codex | `@openai/codex` 已全局安装，OPENAI_API_KEY 已配置 | `codex --version` |

```powershell
# 安装（如未安装）
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

---

## 八、启动与运行

```powershell
# 开发模式（推荐，tsx 热重载）
cd C:\telegram-agent-daemon
npm run dev

# 生产模式
npx tsc          # 编译到 dist/
node dist/index.js
```

**重要：daemon 必须从普通终端（PowerShell / cmd.exe）启动，不要从 Claude Code 内置终端启动。**
（代码已自动剥离 `CLAUDECODE` 环境变量，但从外部终端启动是更稳妥的方式。）

---

## 九、常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| `/cc ask` 返回 "nested session" 错误 | 旧代码未剥离 CLAUDECODE 变量 | 重启 daemon，新代码已修复 |
| `/cx ask` 返回 "unexpected argument" | 旧代码用了 `-q` flag | 已修复为 `codex exec --json` |
| `/cancel` 返回 "Task not found" | taskId 输入带了 `<>` | 现已兼容，可带 `<#id>` 输入 |
| `/op run` 超时无响应 | OpenCode 服务未启动 | 先运行 opencode，再 `/op status` 确认 |
| 长回复只收到一条 | 分片正常，消息 ≤3970 字符 | 超过阈值会带 [Part N/M] 标头 |

---

## 十、Phase 3 adapter 能力矩阵

| 方法 | OpenCode | Claude Code | Codex |
|------|----------|-------------|-------|
| `getStatus()` | ✅ HTTP API | ✅ `claude --version` | ✅ `codex --version` |
| `ask()` | ✅ HTTP session | ✅ `claude -p` stdin | ✅ `codex exec --json` stdin |
| `readFile()` | ✅ HTTP API | ❌ stub | ❌ stub |
| `runTask()` | ✅ 委托 ask() | ❌ stub | ❌ stub |
| `planEdit()` | ✅ 委托 ask() | ❌ stub | ❌ stub |
| `applyEdit()` | ✅ 委托 ask() | ❌ stub | ❌ stub |
| `cancelTask()` | ✅ AbortController | no-op | no-op |
