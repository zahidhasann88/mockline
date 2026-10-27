import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateExpression, expandTemplate, type ExpressionContext } from '../src/events.js';
import { fixture, makeServer } from './helpers.js';

interface Received {
  method: string;
  url: string;
  body: unknown;
}

const receivers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    receivers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function receiver(status = 200): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: JSON.parse(text || 'null'),
      });
      res.statusCode = status;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  receivers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

const json = { 'content-type': 'application/json' };

describe('runtime expressions', () => {
  const context: ExpressionContext = {
    url: new URL('http://mock.test/items/7?mode=fast'),
    method: 'POST',
    headers: { 'X-Trace': 'abc' },
    params: { itemId: '7' },
    body: { hook: { url: 'http://hook.test' }, list: ['a', 'b'] },
    statusCode: 201,
    responseHeaders: { location: '/items/7' },
    responseBody: { id: 'r-1' },
  };

  it('evaluates request, response and built-in expressions', () => {
    expect(evaluateExpression('$url', context)).toBe('http://mock.test/items/7?mode=fast');
    expect(evaluateExpression('$method', context)).toBe('POST');
    expect(evaluateExpression('$statusCode', context)).toBe(201);
    expect(evaluateExpression('$request.header.x-trace', context)).toBe('abc');
    expect(evaluateExpression('$request.query.mode', context)).toBe('fast');
    expect(evaluateExpression('$request.path.itemId', context)).toBe('7');
    expect(evaluateExpression('$request.body#/list/1', context)).toBe('b');
    expect(evaluateExpression('$response.header.Location', context)).toBe('/items/7');
    expect(evaluateExpression('$response.body#/id', context)).toBe('r-1');
    expect(evaluateExpression('$request.cookie.x', context)).toBeUndefined();
  });

  it('expands templates and fails when a value is missing', () => {
    expect(
      expandTemplate('{$request.body#/hook/url}/events?id={$response.body#/id}', context),
    ).toBe('http://hook.test/events?id=r-1');
    expect(expandTemplate('$request.body#/hook/url', context)).toBe('http://hook.test');
    expect(expandTemplate('{$request.body#/missing}/x', context)).toBeUndefined();
  });
});

describe('callbacks', () => {
  it('sends callbacks after successful responses only', async () => {
    const target = await receiver();
    const server = await makeServer({ spec: fixture('events.yaml') });
    try {
      const response = await fetch(`${server.url}/subscriptions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ callbackUrl: `${target.url}/hook` }),
      });
      expect(response.status).toBe(201);
      await server.events.wait();
      expect(target.received).toEqual([
        { method: 'POST', url: '/hook?subscription=sub-1', body: { event: 'created' } },
      ]);
      expect(server.events()).toEqual([
        expect.objectContaining({ kind: 'callback', name: 'onEvent', status: 200 }),
      ]);

      await fetch(`${server.url}/subscriptions`, {
        method: 'POST',
        headers: { ...json, prefer: 'code=400' },
        body: JSON.stringify({ callbackUrl: `${target.url}/hook` }),
      });
      await server.events.wait();
      expect(target.received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('can be turned off and blocks private addresses other than localhost', async () => {
    const target = await receiver();
    const off = await makeServer({
      spec: fixture('events.yaml'),
      config: { validate: 'off', events: { callbacks: false } },
    });
    const guarded = await makeServer({ spec: fixture('events.yaml') });
    try {
      await fetch(`${off.url}/subscriptions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ callbackUrl: target.url }),
      });
      await off.events.wait();
      expect(off.events()).toHaveLength(0);

      await fetch(`${guarded.url}/subscriptions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ callbackUrl: 'http://10.0.0.1/hook' }),
      });
      await guarded.events.wait();
      expect(guarded.events()[0]?.error).toMatch(/Private network addresses are blocked/);
    } finally {
      await Promise.all([off.close(), guarded.close()]);
    }
  });
});

describe('webhooks', () => {
  it('sends webhooks from code and from the inspector', async () => {
    const target = await receiver();
    const server = await makeServer({
      spec: fixture('events.yaml'),
      config: { validate: 'off', events: { webhooks: { newPet: `${target.url}/pets` } } },
    });
    try {
      const sent = await server.sendWebhook('newPet');
      expect(sent).toMatchObject({ kind: 'webhook', name: 'newPet', method: 'POST', status: 200 });
      expect(target.received[0]?.body).toMatchObject({
        id: expect.any(Number),
        name: expect.any(String),
      });

      const listed = await fetch(`${server.url}/__mockline/webhooks`);
      expect(await listed.json()).toEqual([{ name: 'newPet', url: `${target.url}/pets` }]);

      const triggered = await fetch(`${server.url}/__mockline/webhooks/newPet`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: 9, name: 'Custom' }),
      });
      expect(triggered.status).toBe(200);
      expect(target.received[1]?.body).toEqual({ id: 9, name: 'Custom' });

      const events = (await (await fetch(`${server.url}/__mockline/events`)).json()) as unknown[];
      expect(events).toHaveLength(2);
      await fetch(`${server.url}/__mockline/events`, { method: 'DELETE' });
      expect(server.events()).toHaveLength(0);

      expect(
        (await fetch(`${server.url}/__mockline/webhooks/missing`, { method: 'POST' })).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('explains a missing webhook URL', async () => {
    const server = await makeServer({ spec: fixture('events.yaml') });
    try {
      await expect(server.sendWebhook('newPet')).rejects.toThrow(/No URL for webhook newPet/);
      const response = await fetch(`${server.url}/__mockline/webhooks/newPet`, { method: 'POST' });
      expect(response.status).toBe(400);
      await expect(server.sendWebhook('missing', { url: 'http://localhost:1' })).rejects.toThrow(
        /no webhook named missing/,
      );
    } finally {
      await server.close();
    }
  });
});
