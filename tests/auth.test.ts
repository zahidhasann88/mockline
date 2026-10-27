import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixture, makeServer } from './helpers.js';

const secret = 'test-secret';

function jwt(claims: Record<string, unknown>, key = secret, alg = 'HS256'): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg, typ: 'JWT' })}.${encode(claims)}`;
  const hash = alg === 'HS512' ? 'sha512' : 'sha256';
  return `${body}.${createHmac(hash, key).update(body).digest('base64url')}`;
}

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('token checking', () => {
  it('checks API keys, basic credentials, bearer tokens, JWTs and scopes', async () => {
    const server = await makeServer({
      spec: fixture('auth.yaml'),
      config: {
        validate: 'off',
        auth: {
          apiKeys: ['key-1'],
          basic: [{ username: 'ada', password: 'pw' }],
          bearerTokens: ['static-token'],
          jwtSecret: secret,
        },
      },
    });
    const status = async (path: string, headers: Record<string, string> = {}): Promise<number> =>
      (await fetch(`${server.url}${path}`, { headers })).status;
    const now = Math.floor(Date.now() / 1000);
    try {
      expect(await status('/public')).toBe(200);

      expect(await status('/key')).toBe(401);
      expect(await status('/key', { 'x-api-key': 'wrong' })).toBe(401);
      expect(await status('/key', { 'x-api-key': 'key-1' })).toBe(200);

      expect(await status('/basic', { authorization: basic('ada', 'nope') })).toBe(401);
      expect(await status('/basic', { authorization: basic('ada', 'pw') })).toBe(200);

      expect(await status('/bearer', { authorization: 'Bearer static-token' })).toBe(200);
      expect(await status('/bearer', { authorization: `Bearer ${jwt({ sub: '1' })}` })).toBe(200);
      expect(
        await status('/bearer', { authorization: `Bearer ${jwt({ sub: '1' }, 'other-secret')}` }),
      ).toBe(401);
      expect(await status('/bearer', { authorization: `Bearer ${jwt({ exp: now - 10 })}` })).toBe(
        401,
      );
      expect(await status('/bearer', { authorization: `Bearer ${jwt({ nbf: now + 600 })}` })).toBe(
        401,
      );
      expect(await status('/bearer', { authorization: `Bearer ${jwt({}, secret, 'HS512')}` })).toBe(
        200,
      );

      const denied = await fetch(`${server.url}/admin`, {
        headers: { authorization: `Bearer ${jwt({ scope: 'pets:read' })}` },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        title: 'Forbidden',
        errors: [expect.stringContaining('missing scope pets:write')],
      });
      expect(
        await status('/admin', { authorization: `Bearer ${jwt({ scp: ['pets:write'] })}` }),
      ).toBe(200);

      const unauthorized = await fetch(`${server.url}/bearer`, {
        headers: { authorization: 'Bearer junk' },
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');

      const config = (await (await fetch(`${server.url}/__mockline/config`)).json()) as {
        auth: Record<string, unknown>;
      };
      expect(JSON.stringify(config.auth)).not.toMatch(/key-1|static-token|test-secret|"pw"/);
    } finally {
      await server.close();
    }
  });

  it('only checks presence when enforceAuth is on without configured values', async () => {
    const server = await makeServer({
      spec: fixture('auth.yaml'),
      config: { validate: 'off', enforceAuth: true },
    });
    try {
      expect((await fetch(`${server.url}/bearer`)).status).toBe(401);
      const anyToken = await fetch(`${server.url}/bearer`, {
        headers: { authorization: 'anything' },
      });
      expect(anyToken.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
