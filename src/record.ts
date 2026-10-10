import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { MocklineConfig } from './config/schema.js';
import type { RecordedRequest, RequestFilter } from './types.js';

export interface RecordInput extends Omit<RecordedRequest, 'id' | 'timestamp' | 'headers'> {
  headers: Record<string, string | string[] | undefined>;
}

function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraRedacted: string[],
): Record<string, string | string[]> {
  const redacted = new Set([
    'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'api-key',
    'x-auth-token', 'x-access-token', ...extraRedacted.map((name) => name.toLowerCase()),
  ]);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = redacted.has(name.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}

function cloneRecord(record: RecordedRequest): RecordedRequest {
  return structuredClone(record);
}

export class RequestRecorder {
  private readonly buffer: RecordedRequest[] = [];
  private maxRequests: number;
  private file?: string;
  private redact: string[];
  private readonly clock: () => Date;
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: MocklineConfig, clock: () => Date = () => new Date()) {
    this.maxRequests = config.recording.maxRequests;
    this.file = config.recording.file ? resolve(config.recording.file) : undefined;
    this.redact = config.recording.redactHeaders;
    this.clock = clock;
  }

  record(input: RecordInput): RecordedRequest {
    const entry: RecordedRequest = {
      id: String(this.nextId++),
      timestamp: this.clock().toISOString(),
      method: input.method,
      url: input.url,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.matchedPath ? { matchedPath: input.matchedPath } : {}),
      headers: redactHeaders(input.headers, this.redact),
      ...(input.body !== undefined ? { body: input.body } : {}),
      responseStatus: input.responseStatus,
      responseSource: input.responseSource,
      durationMs: input.durationMs,
      validationErrors: [...input.validationErrors],
    };
    if (this.buffer.length >= this.maxRequests) this.buffer.shift();
    this.buffer.push(entry);
    if (this.file) {
      this.writeQueue = this.writeQueue.then(async () => {
        await mkdir(dirname(this.file as string), { recursive: true });
        await appendFile(this.file as string, `${JSON.stringify(entry)}\n`, 'utf8');
      }).catch((error: unknown) => {
        console.error(`mockline: could not append request record: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return cloneRecord(entry);
  }

  setConfig(config: MocklineConfig): void {
    this.maxRequests = config.recording.maxRequests;
    this.file = config.recording.file ? resolve(config.recording.file) : undefined;
    this.redact = config.recording.redactHeaders;
    while (this.buffer.length > this.maxRequests) this.buffer.shift();
  }

  list(filter: RequestFilter = {}): RecordedRequest[] {
    const since = filter.since ? new Date(filter.since).getTime() : undefined;
    let entries = this.buffer.filter((entry) => {
      if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
      if (filter.path && !entry.url.includes(filter.path)) return false;
      if (filter.status !== undefined && entry.responseStatus !== filter.status) return false;
      if (filter.operationId && entry.operationId !== filter.operationId) return false;
      if (since !== undefined && Number.isFinite(since) && new Date(entry.timestamp).getTime() < since) return false;
      return true;
    });
    if (filter.limit !== undefined) entries = filter.limit <= 0 ? [] : entries.slice(-filter.limit);
    return entries.map(cloneRecord);
  }

  get(id: string): RecordedRequest | undefined {
    const entry = this.buffer.find((request) => request.id === id);
    return entry ? cloneRecord(entry) : undefined;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
