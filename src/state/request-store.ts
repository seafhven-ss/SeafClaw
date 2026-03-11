import { randomBytes } from 'node:crypto';
import type { EngineId, RequestRecord, UnifiedRequestStatus } from './types.js';
import { readJsonFile, writeJsonFile } from './storage.js';

const REQUESTS_STATE_FILE = 'request-history.json';
const MAX_REQUESTS = 50;
const SUMMARY_LIMIT = 160;

function summarize(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= SUMMARY_LIMIT) return normalized;
  return `${normalized.slice(0, SUMMARY_LIMIT - 3)}...`;
}

class RequestStore {
  private requests: RequestRecord[] | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.requests) return;

    const loaded = await readJsonFile<RequestRecord[]>(REQUESTS_STATE_FILE, []);
    this.requests = Array.isArray(loaded) ? loaded : [];
  }

  private async persist(): Promise<void> {
    await writeJsonFile(REQUESTS_STATE_FILE, this.requests ?? []);
  }

  private generateRequestId(): string {
    return randomBytes(4).toString('hex');
  }

  async create(engine: EngineId, input: string): Promise<RequestRecord> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const record: RequestRecord = {
      requestId: this.generateRequestId(),
      engine,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      inputSummary: summarize(input) ?? '',
    };

    this.requests!.push(record);
    if (this.requests!.length > MAX_REQUESTS) {
      this.requests = this.requests!.slice(-MAX_REQUESTS);
    }

    await this.persist();
    return record;
  }

  async get(requestId: string): Promise<RequestRecord | undefined> {
    await this.ensureLoaded();
    return this.requests!.find((item) => item.requestId === requestId);
  }

  async recent(limit: number = 5): Promise<RequestRecord[]> {
    await this.ensureLoaded();
    return [...this.requests!].slice(-limit).reverse();
  }

  async update(
    requestId: string,
    patch: Partial<Pick<RequestRecord, 'status' | 'resultSummary' | 'errorSummary'>>,
  ): Promise<RequestRecord | undefined> {
    await this.ensureLoaded();

    const index = this.requests!.findIndex((item) => item.requestId === requestId);
    if (index === -1) return undefined;

    const current = this.requests![index];
    const nextStatus = patch.status ?? current.status;
    const next: RequestRecord = {
      ...current,
      status: nextStatus as UnifiedRequestStatus,
      updatedAt: new Date().toISOString(),
      resultSummary:
        patch.resultSummary !== undefined ? summarize(patch.resultSummary) : current.resultSummary,
      errorSummary:
        patch.errorSummary !== undefined ? summarize(patch.errorSummary) : current.errorSummary,
    };

    this.requests![index] = next;
    await this.persist();
    return next;
  }

  async markRunning(requestId: string): Promise<RequestRecord | undefined> {
    return this.update(requestId, { status: 'running' });
  }

  async markCompleted(requestId: string, result: string): Promise<RequestRecord | undefined> {
    return this.update(requestId, {
      status: 'completed',
      resultSummary: result,
      errorSummary: '',
    });
  }

  async markFailed(requestId: string, error: string): Promise<RequestRecord | undefined> {
    return this.update(requestId, {
      status: 'failed',
      errorSummary: error,
      resultSummary: '',
    });
  }
}

export const requestStore = new RequestStore();
