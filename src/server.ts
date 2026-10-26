import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { watch as watchFiles, type FSWatcher } from 'chokidar';
import { loadConfig } from './config/load.js';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { configSchema, type MocklineConfig, type OverrideConfig } from './config/schema.js';
import { MocklineError, problem } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { loadSpec, type LoadedSpec } from './spec/load.js';
import { createRouter, normalizePath, type Router } from './router.js';
import { selectResponse } from './select.js';
import { RequestRecorder } from './record.js';
import { handleInspector } from './inspector.js';
import { ResourceStore } from './state/store.js';
import { readStateFile, StateFileWriter } from './state/file.js';
import { forwardRequest, ProxyExampleRecorder } from './proxy.js';
import {
  checkSecurityPresence,
  strictValidationStatus,
  validateRequest,
  type ValidationIssue,
} from './validate.js';
import type {
  JsonValue,
  MatchedRoute,
  MockResponse,
  RecordedRequest,
  RequestFilter,
  ResponseSource,
} from './types.js';

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

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface CreateMockServerOptions {
  spec: string;
  port?: number;
  host?: string;
  seed?: number;
  config?: DeepPartial<MocklineConfig>;
  inspector?: boolean;
  logger?: Logger;
  logRequests?: boolean;
  clock?: () => Date;
  fetch?: typeof globalThis.fetch;
  watch?: boolean;
  configFile?: string;
  reloadConfig?: () => Promise<MocklineConfig>;
}

interface ParsedBody {
  present: boolean;
  value?: unknown;
  raw: Buffer;
  parseError?: string;
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

function asHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string | string[] | undefined> {
  return headers;
}

function isLoopback(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    value === 'localhost' ||
    value === '::1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.') ||
    (isIP(value) === 0 && value.endsWith('.localhost'))
  );
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
  res.setHeader(
    'Access-Control-Allow-Headers',
    requestHeaders ??
      'Content-Type, Authorization, Prefer, X-Mockline-Status, X-Mockline-Delay, X-Mockline-Error',
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  head = false,
): void {
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
  if (!res.hasHeader('content-type'))
    res.setHeader('content-type', 'application/json; charset=utf-8');
  if (head || safeStatus === 204 || safeStatus === 304) {
    res.end();
    return;
  }
  const contentType = String(res.getHeader('content-type') ?? '').toLowerCase();
  let serialized: string | Buffer;
  if (Buffer.isBuffer(body)) serialized = body;
  else if (typeof body === 'string' && !contentType.includes('json')) serialized = body;
  else if (body === undefined) serialized = '';
  else {
    try {
      serialized = JSON.stringify(body);
    } catch {
      res.statusCode = 500;
      serialized = JSON.stringify(
        problem(
          500,
          'Internal Server Error',
          'The selected response body could not be serialized.',
        ),
      );
      res.setHeader('content-type', 'application/problem+json; charset=utf-8');
    }
  }
  res.setHeader(
    'content-length',
    Buffer.isBuffer(serialized) ? serialized.byteLength : Buffer.byteLength(serialized),
  );
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
    if (!Number.isFinite(parsedLength) || parsedLength < 0)
      throw new InvalidJsonError('Invalid Content-Length header.');
    if (parsedLength > limit) {
      req.resume();
      throw new BodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk));
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
  if (size === 0) return { present: false, raw: Buffer.alloc(0) };
  const raw = Buffer.concat(chunks);
  const text = raw.toString('utf8');
  const contentType =
    String(req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase() ?? '';
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return { present: true, value: JSON.parse(text) as unknown, raw };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid JSON';
      return { present: true, raw, parseError: `Malformed JSON request body: ${reason}` };
    }
  }
  return { present: true, value: text, raw };
}

function issueStrings(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  extra: Record<string, JsonValue> = {},
): MockResponse {
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
  const inspectorEnabled =
    inspectorRequested === undefined ? isLoopback(config.host) : inspectorRequested;
  if (!isLoopback(config.host)) {
    if (inspectorEnabled)
      logger.warn(
        'The inspector API is enabled on a non-loopback bind; use it only on a trusted network.',
      );
    else
      logger.warn(
        'The inspector API is disabled for a non-loopback bind. Use --inspector only on a trusted network.',
      );
  }
  if (['0.0.0.0', '::'].includes(config.host))
    logger.warn(`Binding to ${config.host} exposes this mock server to the network.`);

  const stateWriter = new StateFileWriter();
  const buildStore = async (
    router: Router,
    spec: LoadedSpec,
    storeConfig: MocklineConfig,
  ): Promise<ResourceStore> => {
    const { enabled, seed, file } = storeConfig.stateful;
    await stateWriter.flush();
    const seedData = enabled && seed ? await readStateFile(seed) : undefined;
    const initialData = enabled && file ? await readStateFile(file, true) : undefined;
    const store = new ResourceStore(router, spec.document, storeConfig, {
      seedData,
      initialData,
      onChange: (data) => stateWriter.save(data),
    });
    for (const warning of store.warnings) logger.warn(warning);
    stateWriter.setFile(enabled ? file : undefined);
    return store;
  };

  const routerState: { current: Router } = { current: createRouter(loaded.document) };
  const specState: { current: LoadedSpec } = { current: loaded };
  const stateStoreState = {
    current: await buildStore(routerState.current, loaded, config),
  };
  const recorder = new RequestRecorder(config, options.clock);
  const proxyExamples = new ProxyExampleRecorder(config.proxy.recordFile);
  const requestCounters = new Map<string, number>();
  const sequenceIndexes = new Map<string, number>();
  const startedAt = options.clock?.() ?? new Date();
  const boundPort = config.port;
  const boundHost = config.host;
  const resetRuntime = async (): Promise<void> => {
    requestCounters.clear();
    sequenceIndexes.clear();
    stateStoreState.current.reset();
  };
  let closing = false;
  let watcher: FSWatcher | undefined;
  let specReloadTimer: NodeJS.Timeout | undefined;
  let configReloadTimer: NodeJS.Timeout | undefined;
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
      if (config.recording.enabled)
        recorder.record({
          method,
          url: req.url ?? '/',
          headers: asHeaders(req.headers),
          responseStatus: failure.status,
          responseSource: 'error',
          durationMs: Math.max(0, (options.clock ?? (() => new Date()))().getTime() - started),
          validationErrors: ['Malformed request URL'],
        });
      return;
    }
    applyCors(req, res, config);
    const pathname = normalizePath(url.pathname);
    let body: unknown;
    let bodyPresent: boolean;
    let rawBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let route: MatchedRoute | undefined;
    let response: MockResponse = problemResponse(
      500,
      'Internal Server Error',
      'Request processing did not complete.',
    );
    let validationErrors: string[] = [];
    let source: ResponseSource | 'error' | 'inspector' = 'error';
    let responseHeaders: Record<string, string> = {};
    const forward = async (matchedRoute?: MatchedRoute): Promise<MockResponse> => {
      if (!config.proxy.url)
        return problemResponse(502, 'Bad Gateway', 'No proxy upstream is configured.');
      const proxied = await forwardRequest({
        upstream: config.proxy.url,
        method,
        requestUrl: url,
        headers: asHeaders(req.headers),
        body: rawBody,
        config: config.proxy,
        fetchImpl: options.fetch,
      });
      if (!proxied.blocked && config.proxy.recordFile) {
        proxyExamples.record({
          method,
          path: `${url.pathname}${url.search}`,
          ...(matchedRoute ? { operationId: matchedRoute.operationId } : {}),
          status: proxied.status,
          headers: proxied.headers,
          body: proxied.body,
        });
      }
      return {
        status: proxied.status,
        body: proxied.body,
        headers: proxied.headers,
        source: 'proxy',
      };
    };

    try {
      if (pathname === '/__mockline' || pathname.startsWith('/__mockline/')) {
        const inspectorResponse = await handleInspector(method, url, {
          enabled: inspectorEnabled,
          recorder,
          config,
          spec: specState.current,
          startedAt,
          reset: resetRuntime,
        });
        response = inspectorResponse
          ? {
              status: inspectorResponse.status,
              ...(inspectorResponse.body !== undefined ? { body: inspectorResponse.body } : {}),
              ...(inspectorResponse.headers ? { headers: inspectorResponse.headers } : {}),
              source: 'generated',
            }
          : problemResponse(404, 'Not Found', 'The inspector endpoint does not exist.');
        source = 'inspector';
      } else if (
        method === 'OPTIONS' &&
        config.cors.enabled &&
        req.headers['access-control-request-method']
      ) {
        response = { status: 204, source: 'generated' };
        source = 'generated';
      } else {
        const read = await readBody(req, config.requestBodyLimit);
        body = read.value;
        bodyPresent = read.present;
        rawBody = read.raw;
        if (config.proxy.all && config.proxy.url) {
          response = await forward();
          source = 'proxy';
        } else {
          const match = routerState.current.match(method, pathname);
          if (!match) {
            if (read.parseError && !config.proxy.url) throw new InvalidJsonError(read.parseError);
            if (config.proxy.url) {
              response = await forward();
              source = 'proxy';
            } else {
              const methods = routerState.current.methodsForPath(pathname);
              const nearest = routerState.current.nearestPath(pathname);
              if (methods.length > 0) {
                response = problemResponse(
                  405,
                  'Method Not Allowed',
                  `Method ${method} is not allowed for ${pathname}.`,
                  nearest ? { nearestPath: nearest } : {},
                );
                responseHeaders = { Allow: methods.join(', ') };
              } else {
                response = problemResponse(
                  404,
                  'Not Found',
                  nearest
                    ? `No route matched. Nearest path: ${nearest}.`
                    : `No route matched ${pathname}.`,
                  nearest ? { nearestPath: nearest } : {},
                );
              }
              source = 'error';
            }
          } else {
            if (read.parseError) throw new InvalidJsonError(read.parseError);
            route = match.route;
            let authorized = true;
            if (config.enforceAuth) {
              const auth = checkSecurityPresence(
                specState.current.document,
                route.operation,
                asHeaders(req.headers),
                url,
              );
              authorized = auth.authorized;
              if (!authorized) {
                response = problemResponse(
                  401,
                  'Unauthorized',
                  'A credential declared by the OpenAPI security scheme is required.',
                  { errors: auth.missing },
                );
                responseHeaders = { 'www-authenticate': 'Bearer realm="Bearer"' };
                source = 'error';
              }
            }
            if (authorized) {
              const validation =
                config.validate === 'off'
                  ? { valid: true, issues: [], bodyInvalid: false }
                  : validateRequest({
                      root: specState.current.document,
                      route,
                      params: match.params,
                      url,
                      headers: asHeaders(req.headers),
                      body,
                      bodyPresent,
                    });
              const strictFailure = !validation.valid && config.validate === 'strict';
              if (!validation.valid) {
                validationErrors = issueStrings(validation.issues);
                if (strictFailure) {
                  const status = strictValidationStatus(validation);
                  response = problemResponse(
                    status,
                    status === 422 ? 'Unprocessable Content' : 'Bad Request',
                    'Request validation failed.',
                    {
                      errors: validation.issues.map((issue) => ({
                        location: issue.location,
                        message: issue.message,
                      })),
                    },
                  );
                  source = 'error';
                } else if (config.validate === 'warn') {
                  responseHeaders['X-Mockline-Validation'] = 'failed';
                  for (const error of validationErrors)
                    logger.warn(`${route.operationId}: ${error}`);
                }
              }
              if (!strictFailure) {
                const key = `${route.method} ${route.path}`;
                const counter = requestCounters.get(key) ?? 0;
                requestCounters.set(key, counter + 1);
                const stateResponse = config.stateful.enabled
                  ? () => stateStoreState.current.handle(match.route, match.params, url, body)
                  : undefined;
                const selected = selectResponse({
                  root: specState.current.document,
                  route,
                  config,
                  headers: asHeaders(req.headers),
                  url,
                  body,
                  requestCounter: counter,
                  sequenceIndexes,
                  stateResponse,
                });
                response = selected.response;
                if (selected.sequenceKey) {
                  const index = sequenceIndexes.get(selected.sequenceKey) ?? 0;
                  sequenceIndexes.set(selected.sequenceKey, index + 1);
                }
                for (const warning of selected.warnings)
                  logger.warn(`${route.operationId}: ${warning}`);
                source = response.source;
                if (responseHeaders['X-Mockline-Validation'])
                  response = {
                    ...response,
                    headers: { ...response.headers, 'X-Mockline-Validation': 'failed' },
                  };
              }
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
        response = problemResponse(
          500,
          'Internal Server Error',
          'Mockline could not process this request.',
        );
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
        const failure = problem(
          500,
          'Internal Server Error',
          error instanceof Error ? error.message : 'Response failed.',
        );
        writeJson(res, 500, failure, { 'content-type': 'application/problem+json' });
        source = 'error';
      }
    } finally {
      const ended = (options.clock ?? (() => new Date()))().getTime();
      if (options.logRequests && source !== 'inspector')
        logger.info(
          `${method} ${url.pathname}${url.search} -> ${res.statusCode || response.status} (${source}, ${Math.max(0, ended - started)}ms)`,
        );
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
        writeJson(res, 500, problem(500, 'Internal Server Error', detail), {
          'content-type': 'application/problem+json',
        });
      }
    });
  });
  setServerRequestTimeout(httpServer, config.requestTimeoutMs);
  httpServer.on('clientError', (_error, socket) => {
    if (socket.writable && !socket.destroyed)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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
    const code =
      isRecord(error) && error.code === 'EADDRINUSE'
        ? 'Port is already in use'
        : 'Could not start server';
    throw new MocklineError(
      `${code} (${config.host}:${config.port}): ${error instanceof Error ? error.message : String(error)}`,
      3,
      error,
    );
  }
  const address = httpServer.address();
  const actualPort = address && typeof address !== 'string' ? address.port : config.port;
  const url = `http://${hostnameForUrl(config.host)}:${actualPort}`;
  const requests = createRequestAccessor(recorder);

  if (options.watch) {
    const specPath = resolve(options.spec);
    const configPaths = options.configFile
      ? [resolve(options.configFile)]
      : [resolve('mockline.yaml'), resolve('mockline.yml'), resolve('mockline.json')];
    const watchedPaths = [...new Set([specPath, ...configPaths])];
    const reloadSpec = async (): Promise<void> => {
      try {
        const nextSpec = await loadSpec(options.spec);
        const nextRouter = createRouter(nextSpec.document);
        const nextStore = await buildStore(nextRouter, nextSpec, config);
        specState.current = nextSpec;
        routerState.current = nextRouter;
        stateStoreState.current = nextStore;
        requestCounters.clear();
        sequenceIndexes.clear();
        logger.info(`Reloaded OpenAPI spec ${options.spec}`);
      } catch (error) {
        logger.error(
          `Invalid OpenAPI change; keeping the last good spec: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const reloadConfiguration = async (): Promise<void> => {
      try {
        const loadedConfig = options.reloadConfig
          ? await options.reloadConfig()
          : (await loadConfig(options.configFile)).config;
        if (loadedConfig.port !== boundPort || loadedConfig.host !== boundHost) {
          logger.warn(
            'Hot reload cannot change the bound host or port; keeping the original listener address.',
          );
        }
        const nextConfig = configSchema.parse({
          ...loadedConfig,
          port: boundPort,
          host: boundHost,
        });
        const stateChanged =
          config.seed !== nextConfig.seed ||
          JSON.stringify(config.stateful) !== JSON.stringify(nextConfig.stateful) ||
          JSON.stringify(config.generation) !== JSON.stringify(nextConfig.generation);
        const nextStore = stateChanged
          ? await buildStore(routerState.current, specState.current, nextConfig)
          : undefined;
        config = nextConfig;
        recorder.setConfig(config);
        proxyExamples.setFile(config.proxy.recordFile);
        if (nextStore) stateStoreState.current = nextStore;
        else stateStoreState.current.setConfig(config);
        setServerRequestTimeout(httpServer, config.requestTimeoutMs);
        logger.info('Reloaded Mockline configuration');
      } catch (error) {
        logger.error(
          `Invalid config change; keeping the last good config: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const schedule = (kind: 'spec' | 'config'): void => {
      if (closing) return;
      const previous = kind === 'spec' ? specReloadTimer : configReloadTimer;
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        if (kind === 'spec') void reloadSpec();
        else void reloadConfiguration();
      }, 120);
      timer.unref();
      if (kind === 'spec') specReloadTimer = timer;
      else configReloadTimer = timer;
    };
    watcher = watchFiles(watchedPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    watcher.on('all', (event, changedPath) => {
      if (!['add', 'change', 'unlink'].includes(event)) return;
      const absolutePath = resolve(changedPath);
      if (absolutePath === specPath) schedule('spec');
      if (configPaths.includes(absolutePath)) schedule('config');
    });
    watcher.on('error', (error: unknown) => {
      logger.error(`Watch error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    url,
    requests,
    async reset() {
      await resetRuntime();
    },
    setOverride(key, override) {
      const parsed = configSchema.parse({ overrides: { [key]: override } }).overrides[key];
      if (!parsed) throw new MocklineError(`Invalid override for ${key}`, 1);
      config = { ...config, overrides: { ...config.overrides, [key]: parsed } };
      stateStoreState.current.setConfig(config);
    },
    async close() {
      if (closing) return;
      closing = true;
      if (specReloadTimer) clearTimeout(specReloadTimer);
      if (configReloadTimer) clearTimeout(configReloadTimer);
      await watcher?.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await recorder.flush();
      await proxyExamples.flush();
      await stateWriter.flush();
    },
  };
}
