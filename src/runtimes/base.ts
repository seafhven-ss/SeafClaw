/**
 * Unified interface for all runtime adapters.
 * Adapters that don't support a method should throw NotImplementedError.
 *
 * Status per Phase:
 *   Phase 2: getStatus, ask, readFile   — OpenCode: real
 *   Phase 3: runTask, planEdit, applyEdit, cancelTask — OpenCode: delegates to ask()
 *                                                       ClaudeCode / Codex: stub
 */
export interface RuntimeAdapter {
  readonly name: string;

  /** Check if the runtime is available and return its status. */
  getStatus(): Promise<RuntimeStatus>;

  /** Send a freeform prompt and return the text response. */
  ask(prompt: string): Promise<string>;

  /**
   * Read a file from the project directory.
   * @param relativePath — relative to project root, no ../ allowed
   */
  readFile(relativePath: string): Promise<string>;

  /**
   * Execute a read-only / low-risk task and return the result.
   * The adapter is responsible for constraining the task to read-only operations.
   */
  runTask(task: string): Promise<string>;

  /**
   * Generate a modification plan for the given task WITHOUT writing any files.
   * Returns the plan as text; the caller decides whether to apply it.
   */
  planEdit(task: string): Promise<string>;

  /**
   * Apply a previously generated plan.
   * @param plan — the plan returned by planEdit()
   * @param task — the original task description for context
   */
  applyEdit(plan: string, task: string): Promise<string>;

  /**
   * Signal that a running task should be cancelled.
   * Adapters that cannot interrupt in-flight work may no-op.
   */
  cancelTask(taskId: string): Promise<void>;
}

export interface RuntimeStatus {
  online: boolean;
  name: string;
  version?: string;
  projectPath?: string;
  error?: string;
}

/** Throw this from adapter methods that are not yet implemented. */
export class NotImplementedError extends Error {
  constructor(adapterName: string, method: string) {
    super(`${adapterName}: ${method}() is not implemented in this adapter`);
    this.name = 'NotImplementedError';
  }
}
