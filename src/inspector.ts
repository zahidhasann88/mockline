import { problem } from './errors.js';
import type { MocklineConfig } from './config/schema.js';
import { summarizeSpec } from './spec/summary.js';
import type { LoadedSpec } from './spec/load.js';
import type { RequestRecorder } from './record.js';
import type { RecordedRequest, RequestFilter } from './types.js';

export interface InspectorContext {
  enabled: boolean;
  recorder: RequestRecorder;
  config: MocklineConfig;
  spec: LoadedSpec;
  startedAt: Date;
  reset: () => Promise<void>;
}

export interface InspectorResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function json(status: number, body: unknown): InspectorResult {
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8' } };
}

function problemResult(status: number, title: string, detail: string): InspectorResult {
  return {
    status,
    body: problem(status, title, detail),
    headers: { 'content-type': 'application/problem+json; charset=utf-8' },
  };
}

function redactConfig(config: MocklineConfig): Record<string, unknown> {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  const proxy = copy.proxy;
  if (typeof proxy === 'object' && proxy !== null && !Array.isArray(proxy)) {
    (proxy as Record<string, unknown>).url = (proxy as Record<string, unknown>).url
      ? '[REDACTED UPSTREAM URL]'
      : undefined;
    (proxy as Record<string, unknown>).recordFile = (proxy as Record<string, unknown>).recordFile
      ? '[PATH REDACTED]'
      : undefined;
  }
  const recording = copy.recording;
  if (
    typeof recording === 'object' &&
    recording !== null &&
    !Array.isArray(recording) &&
    (recording as Record<string, unknown>).file
  ) {
    (recording as Record<string, unknown>).file = '[PATH REDACTED]';
  }
  return copy;
}

function parseInteger(searchParams: URLSearchParams, key: string): number | undefined | null {
  const value = searchParams.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function requestFilter(url: URL): RequestFilter | undefined | null {
  const status = parseInteger(url.searchParams, 'status');
  const limit = parseInteger(url.searchParams, 'limit');
  if (status === null || limit === null || (status !== undefined && (status < 100 || status > 599)))
    return null;
  const since = url.searchParams.get('since') ?? undefined;
  if (since && !Number.isFinite(new Date(since).getTime())) return null;
  return {
    ...(url.searchParams.get('method')
      ? { method: url.searchParams.get('method') ?? undefined }
      : {}),
    ...(url.searchParams.get('path') ? { path: url.searchParams.get('path') ?? undefined } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(url.searchParams.get('operationId')
      ? { operationId: url.searchParams.get('operationId') ?? undefined }
      : {}),
    ...(since ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function specSummary(context: InspectorContext): Record<string, unknown> {
  const resolvedSpec: LoadedSpec = { ...context.spec, document: context.spec.dereferenced };
  const operations = summarizeSpec(resolvedSpec);
  const schemas = Object.keys(context.spec.document.components?.schemas ?? {});
  const info = context.spec.document.info ?? {};
  return {
    openapi: context.spec.document.openapi,
    title: typeof info.title === 'string' ? info.title : undefined,
    version: typeof info.version === 'string' ? info.version : undefined,
    operations,
    schemas,
    warnings: context.spec.warnings,
  };
}

function outputRequest(record: RecordedRequest | undefined): RecordedRequest | undefined {
  return record;
}

export async function handleInspector(
  method: string,
  url: URL,
  context: InspectorContext,
): Promise<InspectorResult | undefined> {
  if (url.pathname !== '/__mockline' && !url.pathname.startsWith('/__mockline/')) return undefined;
  if (!context.enabled)
    return problemResult(404, 'Not Found', 'The inspector API is disabled for this bind address.');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/__mockline/health' && method === 'GET') {
    return json(200, {
      status: 'ok',
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      openapi: context.spec.document.openapi,
      operationCount: summarizeSpec(context.spec).length,
      startedAt: context.startedAt.toISOString(),
    });
  }
  if (pathname === '/__mockline/spec' && method === 'GET') return json(200, specSummary(context));
  if (pathname === '/__mockline/config' && method === 'GET')
    return json(200, redactConfig(context.config));
  if (pathname === '/__mockline/requests' && method === 'GET') {
    const filter = requestFilter(url);
    if (filter === null)
      return problemResult(
        400,
        'Bad Request',
        'Invalid request filter. limit must be a non-negative integer, status must be an HTTP status code, and since must be a date.',
      );
    return json(200, context.recorder.list(filter ?? {}));
  }
  if (pathname === '/__mockline/requests' && method === 'DELETE') {
    context.recorder.clear();
    return json(200, { deleted: true });
  }
  const requestMatch = /^\/__mockline\/requests\/([^/]+)$/.exec(pathname);
  if (requestMatch && method === 'GET') {
    let id = requestMatch[1] ?? '';
    try {
      id = decodeURIComponent(id);
    } catch {
      return problemResult(400, 'Bad Request', 'Request ID contains invalid percent encoding.');
    }
    const request = outputRequest(context.recorder.get(id));
    return request
      ? json(200, request)
      : problemResult(404, 'Not Found', `No recorded request has ID ${id}.`);
  }
  if (requestMatch)
    return {
      ...problemResult(
        405,
        'Method Not Allowed',
        `Method ${method} is not allowed for ${pathname}.`,
      ),
      headers: { 'content-type': 'application/problem+json', allow: 'GET' },
    };
  if (pathname === '/__mockline/reset' && method === 'POST') {
    await context.reset();
    return json(200, { reset: true });
  }
  const allowByPath: Record<string, string[]> = {
    '/__mockline/health': ['GET'],
    '/__mockline/spec': ['GET'],
    '/__mockline/config': ['GET'],
    '/__mockline/requests': ['GET', 'DELETE'],
    '/__mockline/reset': ['POST'],
  };
  const allowed = allowByPath[pathname];
  if (allowed)
    return {
      ...problemResult(
        405,
        'Method Not Allowed',
        `Method ${method} is not allowed for ${pathname}.`,
      ),
      headers: { 'content-type': 'application/problem+json', allow: allowed.join(', ') },
    };
  return problemResult(404, 'Not Found', `No inspector endpoint matched ${pathname}.`);
}
