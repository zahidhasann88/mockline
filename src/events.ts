import { randomUUID } from 'node:crypto';
import type { MocklineConfig } from './config/schema.js';
import { generateValue } from './generate/schema.js';
import { resolvesPrivate } from './proxy.js';
import { findExample } from './select.js';
import type { ApiOperation, JsonSchema, OpenApiDocument, UnknownRecord } from './types.js';

export type EventKind = 'callback' | 'webhook';

export interface SentEvent {
  id: string;
  kind: EventKind;
  name: string;
  method: string;
  url: string;
  body?: unknown;
  status?: number;
  error?: string;
  timestamp: string;
  durationMs: number;
}

export interface EventRequest {
  kind: EventKind;
  name: string;
  method: string;
  url: string;
  body?: unknown;
  contentType?: string;
}

export interface ExpressionContext {
  url: URL;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  body: unknown;
  statusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

const HTTP_METHODS = ['post', 'put', 'patch', 'get', 'delete', 'head', 'options', 'trace'];
const MAX_EVENTS = 100;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerLookup(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value.join(', ') : value;
  }
  return undefined;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return pointer === '' ? value : undefined;
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((current, key) => {
      if (Array.isArray(current)) return current[Number(key)];
      return isRecord(current) ? current[key] : undefined;
    }, value);
}

export function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  if (expression === '$url') return context.url.href;
  if (expression === '$method') return context.method;
  if (expression === '$statusCode') return context.statusCode;
  const match = /^\$(request|response)\.(header|query|path|body)(?:\.([^#]+))?(?:#(.*))?$/.exec(
    expression,
  );
  if (!match) return undefined;
  const [, source, part, name, pointer] = match;
  if (part === 'body') {
    const body = source === 'request' ? context.body : context.responseBody;
    return jsonPointer(body, pointer ?? '');
  }
  if (!name) return undefined;
  if (source === 'response')
    return part === 'header' ? headerLookup(context.responseHeaders, name) : undefined;
  if (part === 'header') return headerLookup(context.headers, name);
  if (part === 'query') return context.url.searchParams.get(name) ?? undefined;
  return context.params[name];
}

export function expandTemplate(template: string, context: ExpressionContext): string | undefined {
  if (template.startsWith('$')) {
    const value = evaluateExpression(template, context);
    return value === undefined || value === null ? undefined : String(value);
  }
  let missing = false;
  const expanded = template.replace(/\{(\$[^{}]+)\}/g, (_whole, expression: string) => {
    const value = evaluateExpression(expression, context);
    if (value === undefined || value === null) {
      missing = true;
      return '';
    }
    return String(value);
  });
  return missing ? undefined : expanded;
}

export function pathItemOperations(
  pathItem: unknown,
): Array<{ method: string; operation: ApiOperation }> {
  if (!isRecord(pathItem)) return [];
  return HTTP_METHODS.filter((method) => isRecord(pathItem[method])).map((method) => ({
    method: method.toUpperCase(),
    operation: pathItem[method] as ApiOperation,
  }));
}

export function eventPayload(
  operation: ApiOperation,
  root: OpenApiDocument,
  config: MocklineConfig,
  seed: number,
): { body?: unknown; contentType?: string } {
  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const content = isRecord(requestBody?.content) ? requestBody.content : {};
  const entries = Object.entries(content).filter(([, media]) => isRecord(media));
  const selected =
    entries.find(([type]) => type === 'application/json' || type.endsWith('+json')) ?? entries[0];
  if (!selected) return {};
  const [contentType, mediaUnknown] = selected;
  const media = mediaUnknown as UnknownRecord;
  const example = findExample(media);
  if (example.found) return { body: example.value, contentType };
  if (!isRecord(media.schema) || !contentType.includes('json')) return { contentType };
  const body = generateValue(media.schema as JsonSchema, {
    root,
    seed,
    hints: config.generation.hints,
    maxDepth: config.generation.maxDepth,
    minArrayItems: config.generation.minArrayItems,
    maxArrayItems: config.generation.maxArrayItems,
    mode: 'request',
  });
  return { body, contentType };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
  );
}

async function blockedReason(
  url: URL,
  config: MocklineConfig['events'],
): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'Event URLs must use http or https.';
  if (isLoopbackHost(url.hostname) || config.allowPrivate) return undefined;
  if (await resolvesPrivate(url.hostname, config.timeoutMs))
    return 'Private network addresses are blocked. Set events.allowPrivate to allow them.';
  return undefined;
}

function serializeBody(body: unknown, contentType: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string' && !contentType?.includes('json')) return body;
  return JSON.stringify(body);
}

export class EventSender {
  private readonly sent: SentEvent[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly pending = new Set<Promise<SentEvent>>();

  constructor(
    private readonly config: () => MocklineConfig['events'],
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly clock: () => Date = () => new Date(),
    private readonly onSent?: (event: SentEvent) => void,
  ) {}

  schedule(request: EventRequest): void {
    const delay = this.config().delay;
    if (delay <= 0) {
      void this.track(this.send(request));
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.track(this.send(request));
    }, delay);
    this.timers.add(timer);
  }

  async send(request: EventRequest): Promise<SentEvent> {
    const config = this.config();
    const started = this.clock();
    const base = {
      id: randomUUID(),
      kind: request.kind,
      name: request.name,
      method: request.method,
      url: request.url,
      ...(request.body !== undefined ? { body: request.body } : {}),
      timestamp: started.toISOString(),
    };
    const finish = (result: { status?: number; error?: string }): SentEvent => {
      const event: SentEvent = {
        ...base,
        ...result,
        durationMs: Math.max(0, this.clock().getTime() - started.getTime()),
      };
      this.sent.push(event);
      if (this.sent.length > MAX_EVENTS) this.sent.splice(0, this.sent.length - MAX_EVENTS);
      this.onSent?.(event);
      return event;
    };
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return finish({ error: `Invalid event URL: ${request.url}` });
    }
    try {
      const blocked = await blockedReason(url, config);
      if (blocked) return finish({ error: blocked });
      const body = serializeBody(request.body, request.contentType);
      const response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          'user-agent': 'mockline',
          ...(body !== undefined
            ? { 'content-type': request.contentType ?? 'application/json' }
            : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      await response.arrayBuffer().catch(() => undefined);
      return finish({ status: response.status });
    } catch (error) {
      return finish({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  list(): SentEvent[] {
    return this.sent.map((event) => ({ ...event }));
  }

  clear(): void {
    this.sent.length = 0;
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.pending]);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0 || this.timers.size > 0) {
      if (this.pending.size > 0) await Promise.all([...this.pending]);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private track(promise: Promise<SentEvent>): Promise<SentEvent> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
    return promise;
  }
}
