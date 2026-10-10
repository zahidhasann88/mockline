import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forwardRequest, isPrivateAddress } from '../src/proxy.js';
import { configSchema } from '../src/config/schema.js';
import { makeServer } from './helpers.js';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolvePromise())),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to obtain upstream address');
  return address.port;
}

async function collect(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('safe HTTP proxy', () => {
  it('blocks private addresses by default and forwards only when explicitly allowed', async () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.20.30.40')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);

    const ipv6Config = configSchema.parse({ proxy: { url: 'http://[::1]:8080' } }).proxy;
    const ipv6Blocked = await forwardRequest({
      upstream: 'http://[::1]:8080',
      method: 'GET',
      requestUrl: new URL('http://mockline.local/test'),
      headers: {},
      config: ipv6Config,
    });
    expect(ipv6Blocked.status).toBe(403);
    expect(ipv6Blocked.blocked).toBe(true);

    const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(upstream);
    const base = `http://127.0.0.1:${port}`;
    const denied = await makeServer({ config: { proxy: { url: base } } });
    const allowed = await makeServer({ config: { proxy: { url: base, allowPrivate: true } } });
    try {
      const refused = await fetch(`${denied.url}/no-match`);
      expect(refused.status).toBe(403);
      expect((await refused.json()).title).toBe('Forbidden');
      const forwarded = await fetch(`${allowed.url}/no-match`);
      expect(forwarded.status).toBe(200);
      expect(await forwarded.json()).toEqual({ ok: true });
      expect(allowed.requests()[0]?.responseSource).toBe('proxy');
    } finally {
      await Promise.all([denied.close(), allowed.close()]);
      await new Promise<void>((resolvePromise, reject) =>
        upstream.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it('strips request hop-by-hop headers, including headers named by Connection', async () => {
    const proxyConfig = configSchema.parse({
      proxy: { url: 'http://127.0.0.1:1', allowPrivate: true },
    }).proxy;
    const fakeFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has('connection')).toBe(false);
      expect(headers.has('x-remove')).toBe(false);
      return new Response('ok', { status: 200 });
    };
    const result = await forwardRequest({
      upstream: 'http://127.0.0.1:1',
      method: 'GET',
      requestUrl: new URL('http://localhost/test'),
      headers: { connection: 'x-remove', 'x-remove': 'secret' },
      config: proxyConfig,
      fetchImpl: fakeFetch,
    });
    expect(result.status).toBe(200);
  });

  it('passes redirect responses through, strips hop-by-hop headers, records examples, and times out', async () => {
    const upstream = createServer(async (req, res) => {
      const body = await collect(req);
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', '/destination');
        res.end('redirect body');
        return;
      }
      if (req.url === '/slow') {
        setTimeout(() => {
          if (!res.destroyed) res.end('late');
        }, 220);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'x-secret-hop');
      res.setHeader('x-secret-hop', 'must-not-pass');
      res.end(
        JSON.stringify({
          path: req.url,
          body: body.toString('utf8'),
          removed: req.headers['x-remove'] ?? null,
        }),
      );
    });
    const port = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'mockline-proxy-'));
    const examplesFile = join(directory, 'upstream-examples.json');
    const server = await makeServer({
      config: {
        proxy: {
          url: `http://127.0.0.1:${port}`,
          all: true,
          allowPrivate: true,
          timeoutMs: 60,
          recordFile: examplesFile,
        },
      },
      fetch: globalThis.fetch,
    });
    try {
      const response = await fetch(`${server.url}/echo?q=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-secret-hop')).toBeNull();
      expect(await response.json()).toEqual({
        path: '/echo?q=1',
        body: '{"hello":"world"}',
        removed: null,
      });

      const redirect = await fetch(`${server.url}/redirect`, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/destination');
      expect(await redirect.text()).toBe('redirect body');

      const timedOut = await fetch(`${server.url}/slow`);
      expect(timedOut.status).toBe(504);
      expect(timedOut.headers.get('content-type')).toContain('problem+json');
    } finally {
      await server.close();
      await new Promise<void>((resolvePromise, reject) =>
        upstream.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
    const saved = JSON.parse(await readFile(examplesFile, 'utf8')) as {
      format: string;
      examples: Array<{ path: string; example?: unknown }>;
    };
    expect(saved.format).toBe('mockline-proxy-examples-v1');
    expect(
      saved.examples.some(
        (example) => example.path === '/echo?q=1' && example.example !== undefined,
      ),
    ).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });
});
