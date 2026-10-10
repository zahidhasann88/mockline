import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { configSchema, type MocklineConfig, type OverrideConfig } from './config/schema.js';
import { MocklineError, problem } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { loadSpec, type LoadedSpec } from './spec/load.js';
import { createRouter, normalizePath, type Router } from './router.js';
import { selectResponse } from './select.js';
import { RequestRecorder } from './record.js';
import { checkSecurityPresence, strictValidationStatus, validateRequest, type ValidationIssue } from './validate.js';
import type { JsonValue, MatchedRoute, MockResponse, RecordedRequest, RequestFilter, ResponseSource } from './types.js';

export interface RequestAccessor {
  (filter?: RequestFilter): RecordedRequest[];
  get(id: string): RecordedRequest | undefined;
  clear(): void;
}

export interface MockServer {
  readonly url: string;
  readonly requests: RequestAccessor;
  reset(): Promise<void>;
  setOverride(key: string, override: OverrideConfig): void;
  close(): Promise<void>;
}

export interface CreateMockServerOptions {
  spec: string;
  port?: number;
  host?: string;
  seed?: number;
  config?: Partial<MocklineConfig>;
  inspector?: boolean;
  logger?: Logger;
  clock?: () => Date;
  fetch?: typeof globalThis.fetch;
}

interface ParsedBody {
  present: boolean;
  value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeded the configured size limit.');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJsonError';
  }
}

function asHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  return headers;
}

function isLoopback(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.') || isIP(value) === 0 && value.endsWith('.localhost');
}

function hostnameForUrl(host: string): string {
  const value = host.replace(/^\[|\]$/g, '');
  return value.includes(':') ? `[${value}]` : value;
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: MocklineConfig): void {
  if (!config.cors.enabled) return;
  const origin = req.headers.origin;
  const allowed = config.cors.origins;
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  const requestHeaders = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Headers', requestHeaders ?? 'Content-Type, Authorization, Prefer, X-Mockline-Status, X-Mockline-Delay, X-Mockline-Error');
  res.setHeader('Access-Control-Max-Age', '600');
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, head = false): void {
  if (res.destroyed || res.writableEnded) return;
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  res.statusCode = safeStatus;
  for (const [name, value] of Object.entries(headers)) {
    try {
      res.setHeader(name, value);
    } catch {
      // Ignore an invalid override header rather than crashing the server.
    }
  }
  if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
  if (head || safeStatus === 204 || safeStatus === 304) {
    res.end();
    return;
  }
  const contentType = String(res.getHeader('content-type') ?? '').toLowerCase();
  let serialized: string;
  if (typeof body === 'string' && !contentType.includes('json')) serialized = body;
  else if (body === undefined) serialized = '';
  else {
    try {
      serialized = JSON.stringify(body);
    } catch {
      res.statusCode = 500;
      serialized = JSON.stringify(problem(500, 'Internal Server Error', 'The selected response body could not be serialized.'));
      res.setHeader('content-type', 'application/problem+json; charset=utf-8');
    }
  }
  res.setHeader('content-length', Buffer.byteLength(serialized));
  try {
    res.end(serialized);
  } catch {
    // A client may disconnect after headers; closing that socket is expected.
    res.destroy();
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<ParsedBody> {
  const declaredLength = req.headers['content-length'];
  if (typeof declaredLength === 'string') {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) throw new InvalidJsonError('Invalid Content-Length header.');
    if (parsedLength > limit) {
      req.resume();
      throw new BodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
      size += buffer.byteLength;
      if (size > limit) {
        req.resume();
        throw new BodyTooLargeError();
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    if (req.destroyed) throw error;
    throw new InvalidJsonError('Could not read request body.');
  }
  if (size === 0) return { present: false };
  const text = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return { present: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid JSON';
      throw new InvalidJsonError(`Malformed JSON request body: ${reason}`);
    }
  }
  return { present: true, value: text };
}

function issueStrings(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

function problemResponse(status: number, title: string, detail: string, extra: Record<string, JsonValue> = {}): MockResponse {
  return {
    status,
    body: problem(status, title, detail, extra),
    headers: { 'content-type': 'application/problem+json' },
    source: 'generated',
  };
}

function createRequestAccessor(recorder: RequestRecorder): RequestAccessor {
  const accessor = ((filter: RequestFilter = {}) => recorder.list(filter)) as RequestAccessor;
  accessor.get = (id: string) => recorder.get(id);
  accessor.clear = () => recorder.clear();
  return accessor;
}

function routeUrl(req: IncomingMessage, host: string): URL {
  const headerHost = req.headers.host;
  const fallbackHost = hostnameForUrl(host);
  return new URL(req.url ?? '/', `http://${headerHost ?? fallbackHost}`);
}

function setServerRequestTimeout(server: Server, timeout: number): void {
  server.requestTimeout = timeout;
  server.headersTimeout = Math.min(timeout, 60_000);
}

export async function createMockServer(options: CreateMockServerOptions): Promise<MockServer> {
  const loaded = await loadSpec(options.spec);
  let config = configSchema.parse({
    ...(options.config ?? {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });
  const logger = options.logger ?? createLogger();
  const inspectorRequested = options.inspector ?? config.inspector.enabled;
  const inspectorEnabled = inspectorRequested === undefined ? isLoopback(config.host) : inspectorRequested;
  if (!isLoopback(config.host) && !inspectorEnabled) {
    logger.warn('The inspector API is disabled for a non-loopback bind. Use --inspector only on a trusted network.');
  }
  if (['0.0.0.0', '::'].includes(config.host)) logger.warn(`Binding to ${config.host} exposes this mock server to the network.`);

  const router: { current: Router } = { current: createRouter(loaded.document) };
  const spec: LoadedSpec = loaded;
  const recorder = new RequestRecorder(config, options.clock);
  const requestCounters = new Map<string, number>();
  const sequenceIndexes = new Map<string, number>();
  let closing = false;
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = (options.clock ?? (() => new Date()))().getTime();
    const method = (req.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = routeUrl(req, config.host);
    } catch {
      url = new URL('/', 'http://mockline.local');
      applyCors(req, res, config);
      const failure = problemResponse(400, 'Bad Request', 'The request URL is malformed.');
      writeJson(res, failure.status, failure.body, failure.headers);
      if (config.recording.enabled) recorder.record({ method, url: req.url ?? '/', headers: asHeaders(req.headers), responseStatus: failure.status, responseSource: 'error', durationMs: Math.max(0, (options.clock ?? (() => new Date()))().getTime() - started), validationErrors: ['Malformed request URL'] });
      return;
    }
    applyCors(req, res, config);
    const pathname = normalizePath(url.pathname);
    let body: unknown;
    let bodyPresent = false;
    let route: MatchedRoute | undefined;
    let response: MockResponse = problemResponse(500, 'Internal Server Error', 'Request processing did not complete.');
    let validationErrors: string[] = [];
    let source: ResponseSource | 'error' | 'inspector' = 'error';
    let responseHeaders: Record<string, string> = {};

    try {
      if (pathname.startsWith('/__mockline')) {
        response = problemResponse(404, 'Not Found', 'The inspector API is unavailable or disabled.');
        source = 'inspector';
      } else if (method === 'OPTIONS' && config.cors.enabled && req.headers['access-control-request-method']) {
        response = { status: 204, source: 'generated' };
        source = 'generated';
      } else {
        const read = await readBody(req, config.requestBodyLimit);
        body = read.value;
        bodyPresent = read.present;
        const match = router.current.match(method, pathname);
        if (!match) {
          const methods = router.current.methodsForPath(pathname);
          const nearest = router.current.nearestPath(pathname);
          if (methods.length > 0) {
            response = problemResponse(405, 'Method Not Allowed', `Method ${method} is not allowed for ${pathname}.`, nearest ? { nearestPath: nearest } : {});
            responseHeaders = { Allow: methods.join(', ') };
          } else {
            response = problemResponse(404, 'Not Found', nearest ? `No route matched. Nearest path: ${nearest}.` : `No route matched ${pathname}.`, nearest ? { nearestPath: nearest } : {});
          }
          source = 'error';
        } else {
          route = match.route;
          let authorized = true;
          if (config.enforceAuth) {
            const auth = checkSecurityPresence(spec.document, route.operation, asHeaders(req.headers), url);
            authorized = auth.authorized;
            if (!authorized) {
              response = problemResponse(401, 'Unauthorized', 'A credential declared by the OpenAPI security scheme is required.', { errors: auth.missing });
              responseHeaders = { 'www-authenticate': 'Bearer realm="Bearer"' };
              source = 'error';
            }
          }
          if (authorized) {
            const validation = config.validate === 'off'
              ? { valid: true, issues: [], bodyInvalid: false }
              : validateRequest({ root: spec.document, route, params: match.params, url, headers: asHeaders(req.headers), body, bodyPresent });
            const strictFailure = !validation.valid && config.validate === 'strict';
            if (!validation.valid) {
              validationErrors = issueStrings(validation.issues);
              if (strictFailure) {
                const status = strictValidationStatus(validation);
                response = problemResponse(status, status === 422 ? 'Unprocessable Content' : 'Bad Request', 'Request validation failed.', {
                  errors: validation.issues.map((issue) => ({ location: issue.location, message: issue.message })),
                });
                source = 'error';
              } else if (config.validate === 'warn') {
                responseHeaders['X-Mockline-Validation'] = 'failed';
                for (const error of validationErrors) logger.warn(`${route.operationId}: ${error}`);
              }
            }
            if (!strictFailure) {
              const key = `${route.method} ${route.path}`;
              const counter = requestCounters.get(key) ?? 0;
              requestCounters.set(key, counter + 1);
              const selected = selectResponse({
                root: spec.document,
                route,
                config,
                headers: asHeaders(req.headers),
                url,
                body,
                requestCounter: counter,
                sequenceIndexes,
              });
              response = selected.response;
              if (selected.sequenceKey) {
                const index = sequenceIndexes.get(selected.sequenceKey) ?? 0;
                sequenceIndexes.set(selected.sequenceKey, index + 1);
              }
              for (const warning of selected.warnings) logger.warn(`${route.operationId}: ${warning}`);
              source = response.source;
              if (responseHeaders['X-Mockline-Validation']) response = { ...response, headers: { ...response.headers, 'X-Mockline-Validation': 'failed' } };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        response = problemResponse(413, 'Content Too Large', error.message);
        validationErrors = [error.message];
      } else if (error instanceof InvalidJsonError) {
        response = problemResponse(400, 'Bad Request', error.message);
        validationErrors = [error.message];
      } else {
        logger.error(error instanceof Error ? error.message : String(error));
        response = problemResponse(500, 'Internal Server Error', 'Mockline could not process this request.');
      }
      source = 'error';
    }

    const headers = { ...response.headers, ...responseHeaders };
    response = { ...response, headers };
    try {
      if (response.delay && response.delay > 0) await sleep(response.delay);
      writeJson(res, response.status, response.body, headers, method === 'HEAD');
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        const failure = problem(500, 'Internal Server Error', error instanceof Error ? error.message : 'Response failed.');
        writeJson(res, 500, failure, { 'content-type': 'application/problem+json' });
        source = 'error';
      }
    } finally {
      const ended = (options.clock ?? (() => new Date()))().getTime();
      if (config.recording.enabled) {
        recorder.record({
          method,
          url: `${url.pathname}${url.search}`,
          ...(route ? { operationId: route.operationId, matchedPath: route.path } : {}),
          headers: asHeaders(req.headers),
          ...(body !== undefined ? { body } : {}),
          responseStatus: res.statusCode || response.status,
          responseSource: source,
          durationMs: Math.max(0, ended - started),
          validationErrors,
        });
      }
    }
  };

  const httpServer: Server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      if (!res.destroyed && !res.headersSent) {
        const detail = error instanceof Error ? error.message : 'Unexpected request failure.';
        writeJson(res, 500, problem(500, 'Internal Server Error', detail), { 'content-type': 'application/problem+json' });
      }
    });
  });
  setServerRequestTimeout(httpServer, config.requestTimeoutMs);
  httpServer.on('clientError', (_error, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.port, config.host);
    });
  } catch (error) {
    const code = isRecord(error) && error.code === 'EADDRINUSE' ? 'Port is already in use' : 'Could not start server';
    throw new MocklineError(`${code} (${config.host}:${config.port}): ${error instanceof Error ? error.message : String(error)}`, 3, error);
  }
  const address = httpServer.address();
  const actualPort = address && typeof address !== 'string' ? address.port : config.port;
  const url = `http://${hostnameForUrl(config.host)}:${actualPort}`;
  const requests = createRequestAccessor(recorder);

  return {
    url,
    requests,
    async reset() {
      requestCounters.clear();
      sequenceIndexes.clear();
    },
    setOverride(key, override) {
      const parsed = configSchema.parse({ overrides: { [key]: override } }).overrides[key];
      if (!parsed) throw new MocklineError(`Invalid override for ${key}`, 1);
      config = { ...config, overrides: { ...config.overrides, [key]: parsed } };
    },
    async close() {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      await recorder.flush();
    },
  };
}
