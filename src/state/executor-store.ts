import type { EngineId, ExecutorState } from './types.js';
import { readJsonFile, writeJsonFile } from './storage.js';

const EXECUTOR_STATE_FILE = 'executor-state.json';

class ExecutorStore {
  private state: ExecutorState | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;

    const loaded = await readJsonFile<ExecutorState>(EXECUTOR_STATE_FILE, {
      defaultEngine: 'cc',
      memoryEnabled: false,
      updatedAt: new Date().toISOString(),
    });
    // Migrate: old state files may lack memoryEnabled
    if (loaded.memoryEnabled === undefined) loaded.memoryEnabled = false;
    this.state = loaded;
  }

  async getState(): Promise<ExecutorState> {
    await this.ensureLoaded();
    return this.state!;
  }

  async getDefaultEngine(): Promise<EngineId> {
    const state = await this.getState();
    return state.defaultEngine;
  }

  async setDefaultEngine(engine: EngineId): Promise<ExecutorState> {
    await this.ensureLoaded();
    this.state = { ...this.state!, defaultEngine: engine, updatedAt: new Date().toISOString() };
    await writeJsonFile(EXECUTOR_STATE_FILE, this.state);
    return this.state;
  }

  async isMemoryEnabled(): Promise<boolean> {
    const state = await this.getState();
    return state.memoryEnabled;
  }

  async setMemoryEnabled(enabled: boolean): Promise<ExecutorState> {
    await this.ensureLoaded();
    this.state = { ...this.state!, memoryEnabled: enabled, updatedAt: new Date().toISOString() };
    await writeJsonFile(EXECUTOR_STATE_FILE, this.state);
    return this.state;
  }
}

export const executorStore = new ExecutorStore();
