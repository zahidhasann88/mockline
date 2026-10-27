import { createMockServer, type CreateMockServerOptions, type MockServer } from './server.js';
import type { RecordedRequest } from './types.js';

type Hook = (fn: () => unknown) => void;

export interface TestHooks {
  beforeAll: Hook;
  afterAll: Hook;
  beforeEach?: Hook;
}

export interface UseMocklineOptions extends CreateMockServerOptions {
  resetBetweenTests?: boolean;
  hooks?: TestHooks;
}

export interface MocklineTestServer extends MockServer {
  received(target: string): RecordedRequest[];
}

export function receivedRequests(server: MockServer, target: string): RecordedRequest[] {
  const match = /^([A-Za-z]+)\s+(\/.*)$/.exec(target.trim());
  const method = match?.[1]?.toUpperCase();
  const path = match ? match[2] : target.trim();
  return server.requests().filter((request) => {
    if (method && request.method !== method) return false;
    if (!path?.startsWith('/')) return request.operationId === path;
    const pathname = request.url.split('?')[0];
    return pathname === path || request.matchedPath === path;
  });
}

function globalHooks(): TestHooks | undefined {
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.beforeAll !== 'function' || typeof scope.afterAll !== 'function')
    return undefined;
  return {
    beforeAll: scope.beforeAll as Hook,
    afterAll: scope.afterAll as Hook,
    ...(typeof scope.beforeEach === 'function' ? { beforeEach: scope.beforeEach as Hook } : {}),
  };
}

export function useMockline(options: UseMocklineOptions): MocklineTestServer {
  const { resetBetweenTests = true, hooks: givenHooks, ...serverOptions } = options;
  const hooks = givenHooks ?? globalHooks();
  if (!hooks)
    throw new Error(
      'useMockline needs test hooks. Enable globals in your test runner, or pass { hooks: { beforeAll, afterAll, beforeEach } }.',
    );
  let server: MockServer | undefined;
  const current = (): MockServer => {
    if (!server) throw new Error('The Mockline server is not running. Use it inside a test.');
    return server;
  };

  hooks.beforeAll(async () => {
    server = await createMockServer({ port: 0, ...serverOptions });
  });
  hooks.afterAll(async () => {
    await server?.close();
    server = undefined;
  });
  if (resetBetweenTests && hooks.beforeEach)
    hooks.beforeEach(async () => {
      await server?.reset();
      server?.requests.clear();
      server?.events.clear();
    });

  return {
    get url() {
      return current().url;
    },
    get requests() {
      return current().requests;
    },
    get events() {
      return current().events;
    },
    sendWebhook: (name, options) => current().sendWebhook(name, options),
    reset: () => current().reset(),
    setOverride: (key, override) => current().setOverride(key, override),
    close: () => current().close(),
    received: (target) => receivedRequests(current(), target),
  };
}

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

export interface MocklineMatchers<R = unknown, T = MockServer> {
  toHaveReceived: T extends MockServer ? (target: string, times?: number) => R : never;
}

export const mocklineMatchers = {
  toHaveReceived(server: MockServer, target: string, times?: number): MatcherResult {
    const count = receivedRequests(server, target).length;
    const pass = times === undefined ? count > 0 : count === times;
    const expected = times === undefined ? 'at least one request' : `${times} request(s)`;
    return {
      pass,
      message: () =>
        pass
          ? `Expected no ${expected} matching ${target}, but received ${count}.`
          : `Expected ${expected} matching ${target}, but received ${count}.`,
    };
  },
};
