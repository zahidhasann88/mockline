import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { problem } from './errors.js';
import type { MocklineConfig } from './config/schema.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'expect',
]);

export interface ProxyRequest {
  upstream: string;
  method: string;
  requestUrl: URL;
  headers: Record<string, string | string[] | undefined>;
  body?: Uint8Array;
  config: MocklineConfig['proxy'];
  fetchImpl?: typeof globalThis.fetch;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  blocked: boolean;
}

export interface ProxyExampleInput {
  method: string;
  path: string;
  operationId?: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface SavedProxyExample {
  method: string;
  path: string;
  operationId?: string;
  status: number;
  mediaType?: string;
  example?: unknown;
  bodyBase64?: string;
  recordedAt: string;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a === 192 && b === 0 || a === 192 && b === 0 || a === 198 && b === 51 || a === 203 && b === 0;
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const lowered = address.toLowerCase().split('%')[0] ?? '';
  if (!lowered.startsWith('::ffff:')) return undefined;
  const tail = lowered.slice('::ffff:'.length);
  if (tail.includes('.')) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const first = Number.parseInt(parts[0] ?? '0', 16);
  const second = Number.parseInt(parts[1] ?? '0', 16);
  return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isPrivateIpv4(mapped);
  return normalized === '::' || normalized === '::1'
    || /^f[cd]/.test(normalized)
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set(HOP_BY_HOP);
  const connection = headers.connection;
  if (connection) for (const header of connection.split(',')) blocked.add(header.trim().toLowerCase());
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

function requestHeaders(headers: ProxyRequest['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) output[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return stripHopByHop(output);
}

function targetUrl(upstream: URL, requestUrl: URL): URL {
  const basePath = upstream.pathname.replace(/\/+$/, '');
  const requestedPath = requestUrl.pathname.startsWith('/') ? requestUrl.pathname : `/${requestUrl.pathname}`;
  const target = new URL(upstream);
  target.pathname = `${basePath}${requestedPath}` || '/';
  target.search = requestUrl.search;
  target.hash = '';
  return target;
}

async function resolvesPrivate(hostname: string, timeoutMs: number): Promise<boolean> {
  if (isIP(hostname)) return isPrivateAddress(hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
      }),
    ]);
    return addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function proxyProblem(status: number, title: string, detail: string): ProxyResult {
  const body = Buffer.from(JSON.stringify(problem(status, title, detail)));
  return { status, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'content-length': String(body.byteLength) }, body, blocked: status === 403 };
}

export async function forwardRequest(input: ProxyRequest): Promise<ProxyResult> {
  let upstream: URL;
  try {
    upstream = new URL(input.upstream);
  } catch {
    return proxyProblem(502, 'Bad Gateway', 'The configured proxy URL is invalid.');
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    return proxyProblem(502, 'Bad Gateway', 'Mockline proxy URLs must use http or https.');
  }
  if (!input.config.allowPrivate) {
    try {
      if (await resolvesPrivate(upstream.hostname, input.config.timeoutMs)) {
        return proxyProblem(403, 'Forbidden', 'Proxying to private, loopback, or link-local addresses is disabled. Use --proxy-allow-private only for a trusted local upstream.');
      }
    } catch (error) {
      return proxyProblem(502, 'Bad Gateway', `Could not safely resolve proxy host: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const target = targetUrl(upstream, input.requestUrl);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const headers = requestHeaders(input.headers);
  try {
    const copiedBody = input.body && input.body.byteLength > 0 && input.method !== 'GET' && input.method !== 'HEAD'
      ? Uint8Array.from(input.body)
      : undefined;
    const response = await fetchImpl(target, {
      method: input.method,
      headers,
      ...(copiedBody ? { body: copiedBody.buffer } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(input.config.timeoutMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    const filtered = stripHopByHop(responseHeaders);
    delete filtered['content-length'];
    delete filtered['content-encoding'];
    return { status: response.status, headers: filtered, body, blocked: false };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return proxyProblem(timedOut ? 504 : 502, timedOut ? 'Gateway Timeout' : 'Bad Gateway', timedOut ? 'The upstream request timed out.' : `The upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeExample(input: ProxyExampleInput): SavedProxyExample {
  const mediaType = input.headers['content-type']?.split(';')[0]?.trim();
  const base: SavedProxyExample = {
    method: input.method,
    path: input.path,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    status: input.status,
    ...(mediaType ? { mediaType } : {}),
    recordedAt: new Date().toISOString(),
  };
  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    try {
      return { ...base, example: JSON.parse(input.body.toString('utf8')) as unknown };
    } catch {
      return { ...base, example: input.body.toString('utf8') };
    }
  }
  if (mediaType?.startsWith('text/')) return { ...base, example: input.body.toString('utf8') };
  return { ...base, bodyBase64: input.body.toString('base64') };
}

export class ProxyExampleRecorder {
  private file?: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file ? resolve(file) : undefined;
  }

  setFile(file?: string): void {
    this.file = file ? resolve(file) : undefined;
  }

  record(input: ProxyExampleInput): void {
    if (!this.file) return;
    const example = decodeExample(input);
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file as string), { recursive: true });
      let examples: SavedProxyExample[] = [];
      try {
        const existing = JSON.parse(await readFile(this.file as string, 'utf8')) as unknown;
        if (typeof existing === 'object' && existing !== null && !Array.isArray(existing) && Array.isArray((existing as { examples?: unknown }).examples)) {
          examples = (existing as { examples: SavedProxyExample[] }).examples;
        }
      } catch {
        // A missing file starts a new examples document; malformed files are replaced on the next successful record.
      }
      examples.push(example);
      const destination = this.file as string;
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ format: 'mockline-proxy-examples-v1', examples }, null, 2)}\n`, 'utf8');
      await rename(temporary, destination);
    }).catch((error: unknown) => {
      console.error(`mockline: could not save proxy example: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
