/**
 * Claude Code adapter — wraps the `claude` CLI.
 *
 * Two execution modes:
 *   ask()       — Sync: runs `claude -p`, waits for completion with timeout (for /cc ask)
 *   spawnTask() — Async: spawns `claude -p` with NO timeout, streams to log file (for /cc task)
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAdapter, RuntimeStatus } from './base.js';
import { NotImplementedError } from './base.js';
import { config } from '../config/env.js';
import { runCli } from '../utils/shell.js';

const NAME = 'Claude Code';

/** Handle returned by spawnTask() for lifecycle management. */
export interface TaskHandle {
  /** OS process ID */
  pid: number;
  /** Path to the streaming log file */
  logPath: string;
  /** Kill the child process tree (works on Windows) */
  kill(): void;
  /** Promise that resolves when the process exits. Result is stdout text on success. */
  done: Promise<string>;
}

/**
 * Build a clean environment for Claude CLI subprocesses.
 * Strips all known Claude-related env vars to avoid the "nested sessions" guard
 * that causes the CLI to refuse to start.
 */
function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Strip all known Claude nesting-guard env vars
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === 'CLAUDE_CODE' ||
      upper === 'CLAUDECODE' ||
      upper === 'CLAUDE_CODE_ENTRYPOINT' ||
      upper === 'CLAUDE_CODE_SESSION' ||
      upper.startsWith('CLAUDE_CODE_')
    ) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Kill a process tree on Windows. Falls back to child.kill() on other platforms.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }

  if (process.platform === 'win32') {
    // taskkill /T kills the entire process tree (cmd.exe + claude.exe)
    // taskkill /F forces termination
    try {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[CC] Killed process tree PID ${pid}`);
    } catch {
      // Process may have already exited
      child.kill();
    }
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Spawn a Claude CLI task in the background with NO timeout.
 * Stdout and stderr are streamed to a log file in real time.
 * Returns a handle for monitoring and cancellation.
 */
export async function spawnTask(prompt: string, taskId: string): Promise<TaskHandle> {
  const logDir = join(tmpdir(), 'telegram-agent-daemon', 'logs');
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `cc-task-${taskId}.log`);

  const logStream = createWriteStream(logPath, { flags: 'a' });
  const startTs = new Date().toISOString();
  logStream.write(`[${startTs}] Task ${taskId} started\n[${startTs}] Prompt: ${prompt}\n---\n`);

  console.log(`[CC] spawnTask: spawning claude CLI for task #${taskId} (NO timeout)`);

  const child: ChildProcess = spawn(
    config.CLAUDECODE_BIN,
    ['-p', '--dangerously-skip-permissions', '--no-session-persistence'],
    {
      cwd: config.OPENCODE_PROJECT_PATH,
      env: getCleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Use explicit shell path to avoid EPERM when ComSpec resolution fails
      shell: process.platform === 'win32'
        ? (process.env.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe')
        : false,
      windowsHide: true,
      // NO timeout — this is the key difference from runCli()
    },
  );

  const pid = child.pid ?? 0;
  console.log(`[CC] spawnTask: child process PID=${pid}, log=${logPath}`);

  let stdoutBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdoutBuf += text;
    logStream.write(text);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    logStream.write(`[stderr] ${chunk.toString()}`);
  });

  // Write prompt to stdin then close
  if (child.stdin) {
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  }

  const done = new Promise<string>((resolve, reject) => {
    child.on('error', (err) => {
      const endTs = new Date().toISOString();
      logStream.write(`\n---\n[${endTs}] Process error: ${err.message}\n`);
      logStream.end();
      console.log(`[CC] Task #${taskId} process error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code, signal) => {
      const endTs = new Date().toISOString();
      if (signal) {
        logStream.write(`\n---\n[${endTs}] Process killed by signal: ${signal}\n`);
        logStream.end();
        console.log(`[CC] Task #${taskId} killed by ${signal}`);
        reject(new Error(`Process killed by ${signal}`));
      } else if (code === 0) {
        logStream.write(`\n---\n[${endTs}] Process exited successfully (code 0)\n`);
        logStream.end();
        console.log(`[CC] Task #${taskId} completed successfully (${stdoutBuf.length} chars)`);
        resolve(stdoutBuf.trim());
      } else {
        logStream.write(`\n---\n[${endTs}] Process exited with code ${code}\n`);
        logStream.end();
        console.log(`[CC] Task #${taskId} exited with code ${code}`);
        reject(new Error(`CLI exited with code ${code}`));
      }
    });
  });

  return {
    pid,
    logPath,
    kill: () => killProcessTree(child),
    done,
  };
}

export const claudecodeAdapter: RuntimeAdapter = {
  name: NAME,

  async getStatus(): Promise<RuntimeStatus> {
    try {
      const { stdout } = await runCli(config.CLAUDECODE_BIN, ['--version'], {
        timeoutMs: 10_000,
      });
      const version = stdout.split('\n')[0].trim();
      return {
        online: true,
        name: NAME,
        version,
        projectPath: config.OPENCODE_PROJECT_PATH,
      };
    } catch (err) {
      return {
        online: false,
        name: NAME,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async ask(prompt: string): Promise<string> {
    // Sync mode with timeout — used by /cc ask ONLY
    console.log(`[CC] ask(): sync mode, timeout=${config.CLAUDECODE_TIMEOUT_MS}ms`);
    const { stdout } = await runCli(
      config.CLAUDECODE_BIN,
      ['-p', '--dangerously-skip-permissions', '--no-session-persistence'],
      {
        cwd: config.OPENCODE_PROJECT_PATH,
        timeoutMs: config.CLAUDECODE_TIMEOUT_MS,
        stdin: prompt,
        env: getCleanEnv(),
      },
    );
    if (!stdout) throw new Error(`${NAME}: empty response`);
    return stdout;
  },

  async readFile(_relativePath: string): Promise<string> {
    throw new NotImplementedError(NAME, 'readFile');
  },

  async runTask(_task: string): Promise<string> {
    throw new NotImplementedError(NAME, 'runTask');
  },

  async planEdit(_task: string): Promise<string> {
    throw new NotImplementedError(NAME, 'planEdit');
  },

  async applyEdit(_plan: string, _task: string): Promise<string> {
    throw new NotImplementedError(NAME, 'applyEdit');
  },

  async cancelTask(_taskId: string): Promise<void> {
    // Handled by TaskHandle.kill() for background tasks
  },
};
