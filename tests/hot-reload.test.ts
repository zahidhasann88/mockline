import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMockServer } from '../src/server.js';
import { loadConfig } from '../src/config/load.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

describe('hot reload', () => {
  it('reloads valid spec changes and keeps serving the last good version after an invalid edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-watch-spec-'));
    const specPath = join(directory, 'openapi.yaml');
    const original = await readFile(fixture('petstore-30.yaml'), 'utf8');
    await writeFile(specPath, original);
    const server = await createMockServer({
      spec: specPath,
      port: 0,
      watch: true,
      logger: silentLogger,
      config: { validate: 'off' },
    });
    try {
      expect((await fetch(`${server.url}/v1/reloaded`)).status).toBe(404);
      const changed = original.replace(
        '\ncomponents:',
        `\n  /reloaded:\n    get:\n      operationId: reloaded\n      responses:\n        '200':\n          description: hot reload\n          content:\n            application/json:\n              example: { ready: true }\n\ncomponents:`,
      );
      await writeFile(specPath, changed);
      await waitFor(async () => (await fetch(`${server.url}/v1/reloaded`)).status === 200);
      const response = await fetch(`${server.url}/v1/reloaded`);
      expect(await response.json()).toEqual({ ready: true });

      await writeFile(specPath, 'openapi: invalid\n');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
      const kept = await fetch(`${server.url}/v1/reloaded`);
      expect(kept.status).toBe(200);
      expect(await kept.json()).toEqual({ ready: true });
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reloads config atomically and retains the last good configuration on invalid edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-watch-config-'));
    const configPath = join(directory, 'mockline.yaml');
    await writeFile(configPath, 'prefer: example\nvalidate: off\nport: 4010\n');
    const initial = await loadConfig(configPath);
    const server = await createMockServer({
      spec: fixture('petstore-30.yaml'),
      port: 0,
      config: initial.config,
      configFile: configPath,
      watch: true,
      reloadConfig: async () => (await loadConfig(configPath)).config,
      logger: silentLogger,
    });
    try {
      expect(server.requests()).toHaveLength(0);
      const example = await fetch(`${server.url}/v1/pets`);
      expect((await example.json())[0].id).toBe(17);
      await writeFile(configPath, 'prefer: generate\nvalidate: off\nport: 4010\n');
      await waitFor(async () => {
        await fetch(`${server.url}/v1/pets`);
        return server.requests().at(-1)?.responseSource === 'generated';
      });
      const generated = await fetch(`${server.url}/v1/pets`);
      expect((await generated.json()).length).toBeGreaterThan(0);
      expect(server.requests().at(-1)?.responseSource).toBe('generated');

      await writeFile(configPath, 'prefer: invalid\nport: no-number\n');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
      const stillGenerated = await fetch(`${server.url}/v1/pets`);
      expect((await stillGenerated.json()).length).toBeGreaterThan(0);
      expect(server.requests().at(-1)?.responseSource).toBe('generated');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
