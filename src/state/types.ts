export type EngineId = 'cc' | 'cx' | 'op';

export type UnifiedRequestStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExecutorState {
  defaultEngine: EngineId;
  memoryEnabled: boolean;
  updatedAt: string;
}

export interface RequestRecord {
  requestId: string;
  engine: EngineId;
  status: UnifiedRequestStatus;
  createdAt: string;
  updatedAt: string;
  inputSummary: string;
  resultSummary?: string;
  errorSummary?: string;
}
