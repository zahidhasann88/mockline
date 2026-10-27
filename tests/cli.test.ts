import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { fixture } from './helpers.js';

const cliFile = resolve('dist/cli.js');

async function waitUntilReady(child: ChildProcess, timeoutMs = 8000): Promise<string> {
  let output = '';
  let errors = '';
  return new Promise<string>((resolveUrl, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`CLI server did not start. stdout=${output} stderr=${errors}`)),
      timeoutMs,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening at (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8');
      if (errors.includes('error')) {
        clearTimeout(timeout);
        reject(new Error(errors));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`CLI server exited before ready (code ${String(code)}). ${output} ${errors}`),
      );
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, 3000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGKILL');
}

describe('CLI', () => {
  it('handles help/version, invalid usage codes, and spec errors', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runCli([])).toBe(0);
      expect(await runCli(['--version'])).toBe(0);
      expect(String(output.mock.calls.at(-1)?.[0])).toMatch(/^mockline\/\d+\.\d+\.\d+/);
      expect(await runCli(['unknown-command'])).toBe(2);
      expect(errors.mock.calls.some((call) => String(call[0]).includes('Unknown command'))).toBe(
        true,
      );
      expect(await runCli(['serve', fixture('petstore-30.yaml'), '--port', 'invalid'])).toBe(2);
      expect(
        await runCli(['serve', fixture('petstore-30.yaml'), '--proxy', 'ftp://example.test']),
      ).toBe(2);
      expect(await runCli(['routes', fixture('does-not-exist.yaml')])).toBe(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  it('initializes a starter project without overwriting existing files unless forced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-init-'));
    const previous = process.cwd();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.chdir(directory);
      expect(await runCli(['routes'])).toBe(2);
      expect(String(errors.mock.calls.at(-1)?.[1])).toContain('No spec file given');
      expect(await runCli(['init'])).toBe(0);
      expect(await runCli(['routes'])).toBe(0);
      expect(output.mock.calls.some((call) => String(call[0]).includes('listPets'))).toBe(true);
      expect((await readFile(join(directory, 'mockline.yaml'), 'utf8')).startsWith('#')).toBe(true);
      expect(
        (await readFile(join(directory, 'openapi.yaml'), 'utf8')).includes('openapi: 3.0.3'),
      ).toBe(true);
      expect(await runCli(['init'])).toBe(1);
      expect(await runCli(['init', '--force'])).toBe(0);
    } finally {
      process.chdir(previous);
      output.mockRestore();
      errors.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the built CLI against petstore, recursive, and schema-only fixtures', () => {
    const routes = execFileSync(
      process.execPath,
      [cliFile, 'routes', fixture('petstore-30.yaml')],
      { encoding: 'utf8' },
    );
    expect(routes).toContain('listPets');
    expect(routes).toContain('example');
    const validation = execFileSync(
      process.execPath,
      [cliFile, 'validate', fixture('recursive-polymorphic.yaml')],
      { encoding: 'utf8' },
    );
    expect(stripVTControlCharacters(validation)).toContain('Valid 3.0.3');
    const schemaRoutes = execFileSync(
      process.execPath,
      [cliFile, 'routes', fixture('schema-only.yaml')],
      { encoding: 'utf8' },
    );
    expect(schemaRoutes).toContain('schema generation');
  }, 60_000);

  it('serves the checked-in Petstore example with its config and conditional override', async () => {
    const child = spawn(
      process.execPath,
      [
        cliFile,
        'serve',
        resolve('examples/petstore/openapi.yaml'),
        '--config',
        resolve('examples/petstore/mockline.yaml'),
        '--port',
        '0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const baseUrl = await waitUntilReady(child);
      const empty = await fetch(`${baseUrl}/v1/pets?demo=empty`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual([]);
      const seeded = await fetch(`${baseUrl}/v1/pets`);
      expect(await seeded.json()).toHaveLength(3);
    } finally {
      await stopChild(child);
    }
  });

  it('serves a built CLI child process with seed generation, controls, latency, validation, state, and inspector', async () => {
    const generatedChild = spawn(
      process.execPath,
      [
        cliFile,
        'serve',
        fixture('schema-only.yaml'),
        '--port',
        '0',
        '--seed',
        '7',
        '--validate',
        'strict',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const baseUrl = await waitUntilReady(generatedChild);
      const generated = await fetch(`${baseUrl}/users`);
      expect(generated.status).toBe(200);
      expect(Array.isArray(await generated.json())).toBe(true);
      const forced = await fetch(`${baseUrl}/users`, { headers: { prefer: 'code=404' } });
      expect(forced.status).toBe(404);
      const delayedStarted = Date.now();
      await fetch(`${baseUrl}/users`, { headers: { 'x-mockline-delay': '35' } });
      expect(Date.now() - delayedStarted).toBeGreaterThanOrEqual(25);
      const invalid = await fetch(`${baseUrl}/users/not-a-number`);
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get('content-type')).toContain('problem+json');
      const records = (await (
        await fetch(`${baseUrl}/__mockline/requests?limit=10`)
      ).json()) as Array<{ headers: Record<string, string> }>;
      expect(records.length).toBeGreaterThanOrEqual(4);
    } finally {
      await stopChild(generatedChild);
    }

    const statefulChild = spawn(
      process.execPath,
      [
        cliFile,
        'serve',
        fixture('petstore-30.yaml'),
        '--port',
        '0',
        '--stateful',
        '--seed',
        '3',
        '--validate',
        'strict',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const baseUrl = await waitUntilReady(statefulChild);
      const list = (await (await fetch(`${baseUrl}/v1/pets`)).json()) as Array<{ id: number }>;
      expect(list.length).toBe(3);
      const createdResponse = await fetch(`${baseUrl}/v1/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer cli-secret' },
        body: JSON.stringify({ name: 'CLI pet', tag: 'cat' }),
      });
      const created = (await createdResponse.json()) as { id: number; name: string };
      expect(createdResponse.status).toBe(201);
      expect(
        ((await (await fetch(`${baseUrl}/v1/pets/${created.id}`)).json()) as { name: string }).name,
      ).toBe('CLI pet');
      expect((await fetch(`${baseUrl}/v1/pets/${created.id}`, { method: 'DELETE' })).status).toBe(
        204,
      );
      expect((await fetch(`${baseUrl}/v1/pets/${created.id}`)).status).toBe(404);
      const recorded = (await (
        await fetch(`${baseUrl}/__mockline/requests?operationId=createPet`)
      ).json()) as Array<{ headers: Record<string, string> }>;
      expect(recorded[0]?.headers.authorization).toBe('[REDACTED]');
    } finally {
      await stopChild(statefulChild);
    }
  });
});
