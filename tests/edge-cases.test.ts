import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config/schema.js';
import { EventSender } from '../src/events.js';
import { SpecExampleWriter } from '../src/spec/examples.js';
import { readStateFile } from '../src/state/file.js';
import { checkSecurity, type AuthSettings } from '../src/validate.js';
import type { ApiOperation, OpenApiDocument } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'mockline-edge-'));
  directories.push(created);
  return created;
}

const root: OpenApiDocument = {
  openapi: '3.0.3',
  components: {
    securitySchemes: {
      QueryKey: { type: 'apiKey', in: 'query', name: 'key' },
      CookieKey: { type: 'apiKey', in: 'cookie', name: 'session' },
      Basic: { type: 'http', scheme: 'basic' },
      Bearer: { type: 'http', scheme: 'bearer' },
      Digest: { type: 'http', scheme: 'digest' },
      Odd: { type: 'unknown' },
    },
  },
};

const auth: AuthSettings = {
  apiKeys: ['k1'],
  bearerTokens: [],
  basic: [{ username: 'ada', password: 'pw' }],
  jwtSecret: 'secret',
};

function check(
  scheme: string,
  headers: Record<string, string> = {},
  url = 'http://mock.test/x',
  settings: AuthSettings = auth,
): { authorized: boolean; status: number; missing: string[] } {
  const operation: ApiOperation = { security: [{ [scheme]: [] }], responses: {} };
  return checkSecurity(root, operation, headers, new URL(url), settings);
}

function token(header: Record<string, unknown>, payload: string): string {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = `${head}.${payload}`;
  return `${body}.${createHmac('sha256', 'secret').update(body).digest('base64url')}`;
}

describe('auth edge cases', () => {
  it('reads API keys from the query and cookies', () => {
    expect(check('QueryKey', {}, 'http://mock.test/x?key=k1').authorized).toBe(true);
    expect(check('QueryKey', {}, 'http://mock.test/x?key=bad').missing[0]).toContain(
      'invalid API key',
    );
    expect(check('CookieKey', { cookie: 'session=k1' }).authorized).toBe(true);
    expect(check('CookieKey').missing[0]).toContain('cookie session');
  });

  it('rejects malformed basic credentials and bearer tokens', () => {
    expect(check('Basic', { authorization: 'Bearer x' }).missing[0]).toContain('Basic credentials');
    expect(check('Basic', { authorization: 'Basic bm9jb2xvbg==' }).missing[0]).toContain(
      'invalid username or password',
    );
    expect(check('Bearer').missing[0]).toContain('Bearer token');
    expect(check('Bearer', { authorization: 'Bearer a.b' }).missing[0]).toContain('not a JWT');
    expect(
      check('Bearer', { authorization: `Bearer ${token({ alg: 'none' }, 'e30')}` }).missing[0],
    ).toContain('HS256, HS384 or HS512');
    expect(
      check('Bearer', { authorization: `Bearer ${token({ alg: 'HS256' }, 'bm90LWpzb24')}` })
        .missing[0],
    ).toContain('payload is invalid');
    const noSecret = { ...auth, jwtSecret: undefined, bearerTokens: ['known'] };
    expect(
      check('Bearer', { authorization: 'Bearer other' }, undefined, noSecret).missing[0],
    ).toContain('unknown bearer token');
  });

  it('only checks presence for other schemes', () => {
    expect(check('Digest').authorized).toBe(false);
    expect(check('Digest', { authorization: 'Digest abc' }).authorized).toBe(true);
    expect(check('Odd').missing).toEqual(['Odd']);
    expect(check('Missing').missing).toEqual(['Missing']);
  });
});

describe('event sender edge cases', () => {
  const config = () => defaultConfig.events;

  it('reports invalid and non-http URLs without sending', async () => {
    const sender = new EventSender(config);
    expect(
      (await sender.send({ kind: 'webhook', name: 'a', method: 'POST', url: 'nope' })).error,
    ).toMatch(/Invalid event URL/);
    expect(
      (await sender.send({ kind: 'webhook', name: 'a', method: 'POST', url: 'ftp://localhost/x' }))
        .error,
    ).toMatch(/must use http or https/);
    expect(sender.list()).toHaveLength(2);
    sender.clear();
    expect(sender.list()).toHaveLength(0);
  });

  it('sends text bodies, records fetch errors and waits for delayed events', async () => {
    const calls: Array<{ body: unknown; type: unknown }> = [];
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ body: init?.body, type: headers['content-type'] });
      if (init?.body === 'boom') throw new Error('network down');
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const sender = new EventSender(() => ({ ...defaultConfig.events, delay: 5 }), fetchImpl);
    sender.schedule({
      kind: 'callback',
      name: 'text',
      method: 'POST',
      url: 'http://localhost/hook',
      body: 'hello',
      contentType: 'text/plain',
    });
    await sender.idle();
    expect(calls[0]).toEqual({ body: 'hello', type: 'text/plain' });
    expect(sender.list()[0]?.status).toBe(202);
    const failed = await sender.send({
      kind: 'callback',
      name: 'fail',
      method: 'POST',
      url: 'http://localhost/hook',
      body: 'boom',
      contentType: 'text/plain',
    });
    expect(failed.error).toBe('network down');
    sender.schedule({ kind: 'callback', name: 'late', method: 'POST', url: 'http://localhost/x' });
    await sender.close();
  });
});

describe('recording edge cases', () => {
  it('rejects specs that are not objects and skips unknown operations and $ref media', async () => {
    const folder = await directory();
    const bad = join(folder, 'bad.yaml');
    await writeFile(bad, '- just\n- a list\n');
    await expect(SpecExampleWriter.open(bad, join(folder, 'out.yaml'))).rejects.toThrow(
      /not a YAML or JSON object/,
    );

    const spec = join(folder, 'spec.json');
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'x', version: '1' },
        paths: {
          '/a': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { $ref: '#/components/x' } },
                },
              },
            },
          },
        },
      }),
    );
    const out = join(folder, 'out.json');
    const writer = await SpecExampleWriter.open(spec, out);
    const body = Buffer.from('{"a":1}');
    expect(
      writer.add({ specPath: '/missing', method: 'GET', status: 200, body, label: 'x' }),
    ).toEqual({ recorded: false, reason: 'operation not found in the spec' });
    expect(
      writer.add({
        specPath: '/a',
        method: 'GET',
        status: 200,
        contentType: 'application/json',
        body,
        label: 'x',
      }),
    ).toEqual({ recorded: false, reason: 'media type uses $ref' });
    expect(
      writer.add({ specPath: '/a', method: 'GET', status: 204, body: Buffer.alloc(0), label: 'x' }),
    ).toEqual({ recorded: false, reason: 'body is empty or not JSON or text' });
    for (let index = 0; index < 11; index += 1) {
      writer.add({
        specPath: '/a',
        method: 'GET',
        status: 201,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ index })),
        label: `x${index}`,
      });
    }
    expect(
      writer.add({
        specPath: '/a',
        method: 'GET',
        status: 201,
        contentType: 'application/json',
        body: Buffer.from('{"index":99}'),
        label: 'x',
      }),
    ).toEqual({ recorded: false, reason: 'already has 10 recorded examples' });
    await writer.flush();
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8')) as {
      paths: { '/a': { get: { responses: Record<string, unknown> } } };
    };
    expect(Object.keys(saved.paths['/a'].get.responses)).toEqual(['200', '201', '204']);
  });
});

describe('state file edge cases', () => {
  it('returns nothing for a missing optional file and explains other read errors', async () => {
    const folder = await directory();
    expect(await readStateFile(join(folder, 'missing.json'), true)).toBeUndefined();
    await expect(readStateFile(join(folder, 'missing.json'))).rejects.toThrow(
      /Cannot read data file/,
    );
    const broken = join(folder, 'broken.json');
    await writeFile(broken, '{not json');
    await expect(readStateFile(broken)).rejects.toThrow(/Cannot parse data file/);
  });
});
