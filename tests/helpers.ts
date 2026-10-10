import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createMockServer, type CreateMockServerOptions, type MockServer } from '../src/server.js';
import type { Logger } from '../src/logger.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): string => resolve(testDirectory, 'fixtures', name);
export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export async function makeServer(
  overrides: Partial<CreateMockServerOptions> = {},
): Promise<MockServer> {
  return createMockServer({
    spec: fixture('petstore-30.yaml'),
    port: 0,
    logger: silentLogger,
    config: { validate: 'off' },
    ...overrides,
  });
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms.`);
}
