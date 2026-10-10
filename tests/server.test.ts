import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, request as requestHttp } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createMockServer } from '../src/server.js';
import { fixture, makeServer, silentLogger } from './helpers.js';

function postChunked(url: URL, body: string): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const request = requestHttp(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolvePromise(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    const splitAt = Math.floor(body.length / 2);
    request.write(body.slice(0, splitAt));
    request.end(body.slice(splitAt));
  });
}

describe('programmatic mock server', () => {
  it('runs independent servers in parallel and keeps seeded output deterministic', async () => {
    const spec = fixture('schema-only.yaml');
    const [first, second] = await Promise.all([
      createMockServer({
        spec,
        port: 0,
        seed: 111,
        config: { validate: 'off' },
        logger: silentLogger,
      }),
      createMockServer({
        spec,
        port: 0,
        seed: 111,
        config: { validate: 'off' },
        logger: silentLogger,
      }),
    ]);
    try {
      const [a, b] = await Promise.all([fetch(`${first.url}/users`), fetch(`${second.url}/users`)]);
      const bodyA = await a.json();
      const bodyB = await b.json();
      expect(bodyA).toEqual(bodyB);
      expect(first.url).not.toBe(second.url);
      expect(first.requests({ method: 'GET', path: '/users' })).toHaveLength(1);
      expect(second.requests().length).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('records and redacts requests, filters inspector results, and exposes spec/config summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-records-'));
    const file = join(directory, 'nested', 'records.jsonl');
    const server = await makeServer({
      config: { validate: 'off', recording: { file, maxRequests: 2 } },
    });
    try {
      await fetch(`${server.url}/v1/pets`, {
        headers: {
          authorization: 'Bearer very-secret',
          cookie: 'sid=cookie-secret',
          'x-api-key': 'key-secret',
        },
      });
      await fetch(`${server.url}/v1/private`, { headers: { authorization: 'should-redact' } });
      const list = await fetch(
        `${server.url}/__mockline/requests?method=GET&path=%2Fv1%2Fprivate&limit=1`,
      );
      expect(list.status).toBe(200);
      const entries = (await list.json()) as Array<{
        headers: Record<string, string>;
        operationId?: string;
      }>;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.operationId).toBe('readPrivate');
      expect(entries[0]?.headers.authorization).toBe('[REDACTED]');

      const config = (await (await fetch(`${server.url}/__mockline/config`)).json()) as {
        proxy: { url?: string };
      };
      expect(config.proxy.url).toBeUndefined();
      const spec = (await (await fetch(`${server.url}/__mockline/spec`)).json()) as {
        operations: Array<{ operationId: string }>;
      };
      expect(spec.operations.some((operation) => operation.operationId === 'listPets')).toBe(true);
      const health = (await (await fetch(`${server.url}/__mockline/health`)).json()) as {
        status: string;
      };
      expect(health.status).toBe('ok');
      const records = server.requests();
      expect(records.length).toBeLessThanOrEqual(2);
      expect(records.at(-1)?.headers.authorization).toBeUndefined();
      const detailId = entries[0]
        ? server.requests().find((request) => request.operationId === 'readPrivate')?.id
        : undefined;
      if (detailId)
        expect((await fetch(`${server.url}/__mockline/requests/${detailId}`)).status).toBe(200);
      expect((await fetch(`${server.url}/__mockline/requests/nope`)).status).toBe(404);
      await fetch(`${server.url}/__mockline/requests`, { method: 'DELETE' });
      expect(server.requests()).toHaveLength(1); // the DELETE itself is recorded after the ring was cleared
    } finally {
      await server.close();
    }
    const recordsFile = await readFile(file, 'utf8');
    expect(recordsFile).toContain('[REDACTED]');
    expect(recordsFile).not.toContain('very-secret');
    await rm(directory, { recursive: true, force: true });
  });

  it('honors stateful CRUD, pagination, reset, and operation overrides', async () => {
    const server = await makeServer({
      config: { validate: 'strict', stateful: { enabled: true, seedItems: 2 } },
    });
    try {
      const listResponse = await fetch(`${server.url}/v1/pets`);
      const seeded = (await listResponse.json()) as Array<{ id: number }>;
      expect(seeded).toHaveLength(2);
      const limited = await fetch(`${server.url}/v1/pets?limit=1&offset=1`);
      expect(await limited.json()).toHaveLength(1);

      const createdResponse = await fetch(`${server.url}/v1/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex', tag: 'dog' }),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: number; name: string };
      expect(created.id).toBeTypeOf('number');
      expect(created.name).toBe('Rex');
      const fetched = await fetch(`${server.url}/v1/pets/${created.id}`);
      expect(await fetched.json()).toMatchObject({ id: created.id, name: 'Rex' });

      const replaced = await fetch(`${server.url}/v1/pets/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex II' }),
      });
      expect(await replaced.json()).toMatchObject({ id: created.id, name: 'Rex II' });
      const patched = await fetch(`${server.url}/v1/pets/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex III' }),
      });
      expect(await patched.json()).toMatchObject({ id: created.id, name: 'Rex III' });

      const deleted = await fetch(`${server.url}/v1/pets/${created.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(204);
      expect((await fetch(`${server.url}/v1/pets/${created.id}`)).status).toBe(404);
      await fetch(`${server.url}/__mockline/reset`, { method: 'POST' });
      expect(await (await fetch(`${server.url}/v1/pets`)).json()).toHaveLength(2);

      server.setOverride('listPets', { status: 202, body: { overridden: true } });
      const overridden = await fetch(`${server.url}/v1/pets`);
      expect(overridden.status).toBe(202);
      expect(await overridden.json()).toEqual({ overridden: true });
    } finally {
      await server.close();
    }
  });

  it('returns RFC 9457 404/405 errors, applies CORS and protects malformed or oversized bodies', async () => {
    const server = await makeServer({ config: { validate: 'off', requestBodyLimit: 24 } });
    const noCors = await makeServer({ config: { validate: 'off', cors: { enabled: false } } });
    try {
      const unknown = await fetch(`${server.url}/v1/does-not-exist`);
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('content-type')).toContain('problem+json');
      expect(await unknown.json()).toMatchObject({
        type: 'about:blank',
        status: 404,
        nearestPath: expect.any(String),
      });
      const wrongMethod = await fetch(`${server.url}/v1/pets/5`, { method: 'POST' });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('allow')).toContain('GET');
      expect(
        (
          await fetch(`${server.url}/v1/pets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{broken',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${server.url}/v1/pets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'this body is way too long' }),
          })
        ).status,
      ).toBe(413);
      expect(
        await postChunked(
          new URL(`${server.url}/v1/pets`),
          JSON.stringify({ name: 'this chunked body exceeds the limit' }),
        ),
      ).toBe(413);
      const preflight = await fetch(`${server.url}/v1/pets`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
        },
      });
      expect(preflight.status).toBe(204);
      expect(
        (
          await fetch(`${server.url}/v1/pets`, { headers: { origin: 'https://app.example' } })
        ).headers.get('access-control-allow-origin'),
      ).toBe('*');
      expect(
        (
          await fetch(`${noCors.url}/v1/pets`, { headers: { origin: 'https://app.example' } })
        ).headers.get('access-control-allow-origin'),
      ).toBeNull();
    } finally {
      await Promise.all([server.close(), noCors.close()]);
    }
  });

  it('restricts the inspector API on non-loopback binds unless explicitly enabled', async () => {
    const server = await createMockServer({
      spec: fixture('petstore-30.yaml'),
      host: '0.0.0.0',
      port: 0,
      inspector: false,
      logger: silentLogger,
      config: { validate: 'off' },
    });
    try {
      const port = new URL(server.url).port;
      const result = await fetch(`http://127.0.0.1:${port}/__mockline/health`);
      expect(result.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('fails clearly when the requested port is already in use', async () => {
    const busy = createHttpServer();
    await new Promise<void>((resolvePromise) => busy.listen(0, '127.0.0.1', resolvePromise));
    const address = busy.address();
    if (!address || typeof address === 'string') throw new Error('Could not bind test server');
    try {
      await expect(
        createMockServer({
          spec: fixture('petstore-30.yaml'),
          host: '127.0.0.1',
          port: address.port,
          logger: silentLogger,
        }),
      ).rejects.toMatchObject({
        name: 'MocklineError',
        exitCode: 3,
        message: expect.stringContaining('Port is already in use'),
      });
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        busy.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });
});
