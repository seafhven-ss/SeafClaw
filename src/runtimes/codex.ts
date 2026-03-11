/**
 * Codex (OpenAI) adapter — wraps the `codex` CLI.
 *
 * Phase 3 status:
 *   getStatus()  — REAL  (runs `codex --version`)
 *   ask()        — REAL  (runs `codex exec -s read-only --ephemeral`, prompt via stdin)
 *   readFile()   — STUB  (throws NotImplementedError)
 *   runTask()    — STUB
 *   planEdit()   — STUB
 *   applyEdit()  — STUB
 *   cancelTask() — no-op
 *
 * Configuration (.env):
 *   CODEX_BIN           path or name of the codex binary (default: "codex")
 *   CODEX_TIMEOUT_MS    per-call timeout in ms       (default: 120000)
 *
 * Installation:
 *   npm install -g @openai/codex
 *   # then: codex --version   should work
 *
 * Non-interactive usage: `codex exec --full-auto -s read-only --json [OPTIONS] -`
 *   `--full-auto`  auto-approves all commands (no interactive prompts).
 *   `-s read-only` overrides sandbox to read-only filesystem (safe for ask).
 *   `--full-auto` sets sandbox=workspace-write by default; `-s read-only`
 *                 explicitly overrides it back to read-only.
 *   `--json`      JSONL output — parsed via parseCodexJson().
 *   `-`           read prompt from stdin (handles any content safely).
 */
import type { RuntimeAdapter, RuntimeStatus } from './base.js';
import { NotImplementedError } from './base.js';
import { config } from '../config/env.js';
import { runCli } from '../utils/shell.js';

const NAME = 'Codex';

/**
 * Parse JSONL output from `codex exec --json`.
 * Collects all `item.completed` events where item.type === "agent_message"
 * and joins their text fields.
 *
 * Example relevant line:
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"2"}}
 */
function parseCodexJson(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        event['type'] === 'item.completed' &&
        event['item'] !== null &&
        typeof event['item'] === 'object'
      ) {
        const item = event['item'] as Record<string, unknown>;
        if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
          parts.push(item['text'] as string);
        }
      }
    } catch {
      // Non-JSON lines (shouldn't appear with --json, but guard anyway)
    }
  }
  return parts.join('\n').trim();
}

export const codexAdapter: RuntimeAdapter = {
  name: NAME,

  async getStatus(): Promise<RuntimeStatus> {
    try {
      const { stdout } = await runCli(config.CODEX_BIN, ['--version'], {
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
    // `codex exec` is the non-interactive subcommand.
    // `-` as the prompt argument tells codex to read from stdin — safe for
    // any prompt content including special characters.
    // `-s read-only` constrains the sandbox to read-only filesystem access.
    // `--ephemeral` skips writing session files to disk.
    // `--skip-git-repo-check` allows running outside a git repository.
    // `-C <dir>` sets the working root for the agent.
    const { stdout } = await runCli(
      config.CODEX_BIN,
      [
        'exec',
        '--json',              // JSONL output — parseable, no decoration
        '--full-auto',        // auto-approve commands (no interactive prompts)
        '-s', 'read-only',    // override sandbox: filesystem stays read-only
        '--ephemeral',        // no session files written to disk
        '--skip-git-repo-check',
        '-C', config.OPENCODE_PROJECT_PATH,
        '-',                  // read prompt from stdin
      ],
      {
        timeoutMs: config.CODEX_TIMEOUT_MS,
        stdin: prompt,
      },
    );
    const answer = parseCodexJson(stdout);
    if (!answer) throw new Error(`${NAME}: no agent_message found in output`);
    return answer;
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
    // Phase 3: no-op.
  },
};
