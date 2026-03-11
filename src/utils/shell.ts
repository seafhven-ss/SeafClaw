import { spawn } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
}

/**
 * Build a clean environment for child processes.
 * Always strips Claude Code nesting-guard env vars so spawned CLIs
 * (especially `claude` itself) never see them.
 */
function buildCleanEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(base ?? process.env) };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === 'CLAUDECODE' ||
      upper === 'CLAUDE_CODE' ||
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
 * Resolve the Windows shell path for spawn().
 * Uses ComSpec env var with fallback to well-known cmd.exe path.
 */
function getWindowsShell(): string | true {
  return process.env.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe';
}

/**
 * Run an external CLI and return its stdout/stderr.
 *
 * Design notes:
 * - Uses spawn (not exec) so the prompt never goes through shell string parsing.
 * - On Windows, shell is required because npm-installed CLIs are .cmd files.
 * - Prompt/input is written to stdin so no quoting issues regardless of content.
 * - A hard timeout kills the child process if it takes too long.
 * - CLAUDECODE env vars are always stripped to prevent nested session detection.
 */
export function runCli(
  bin: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    /** Content to write to the child's stdin then close it. */
    stdin?: string;
    /**
     * Override the environment passed to the child process.
     * CLAUDECODE env vars are always stripped regardless.
     */
    env?: NodeJS.ProcessEnv;
  },
): Promise<ShellResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const cleanEnv = buildCleanEnv(options?.env);

  return new Promise<ShellResult>((resolve, reject) => {
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };

    const child = spawn(bin, args, {
      cwd: options?.cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows npm-installed CLIs are .cmd files — shell is required to resolve them.
      // Use explicit shell path to avoid EPERM when ComSpec resolution fails.
      // On Unix this stays false to avoid shell injection.
      shell: process.platform === 'win32' ? getWindowsShell() : false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(new Error(`CLI '${bin}' timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    child.on('error', (err) => settle(() => reject(err)));

    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() });
        } else {
          const detail = stderrBuf.trim() || stdoutBuf.trim() || '(no output)';
          reject(new Error(
            `CLI '${bin}' exited with code ${code ?? '?'}: ${detail}`,
          ));
        }
      });
    });

    // Write optional stdin content then signal EOF
    if (options?.stdin !== undefined) {
      child.stdin?.write(options.stdin, 'utf8');
    }
    child.stdin?.end();
  });
}
