import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { handleInspector } from '../src/inspector.js';
import { RequestRecorder } from '../src/record.js';
import { loadSpec } from '../src/spec/load.js';
import type { InspectorContext } from '../src/inspector.js';
import { fixture } from './helpers.js';

const startedAt = new Date('2025-01-01T00:00:00.000Z');
const timestamp = new Date('2025-01-02T03:04:05.000Z');

function inspectorUrl(path: string): URL {
  return new URL(path, 'http://127.0.0.1');
}

async function makeContext(enabled = true): Promise<InspectorContext> {
  const spec = await loadSpec(fixture('petstore-30.yaml'));
  const config = configSchema.parse({
    proxy: {
      url: 'https://user:secret@example.test/api',
      recordFile: '/private/proxy-examples.json',
    },
    recording: { file: '/private/requests.jsonl' },
  });
  const recorderConfig = configSchema.parse({
    ...config,
    recording: { ...config.recording, file: undefined },
  });
  const recorder = new RequestRecorder(recorderConfig, () => timestamp);
  recorder.record({
    method: 'GET',
    url: '/v1/pets?limit=5',
    operationId: 'listPets',
    matchedPath: '/v1/pets',
    headers: { authorization: 'Bearer secret', 'x-trace': 'public-value' },
    responseStatus: 200,
    responseSource: 'example',
    durationMs: 8,
    validationErrors: [],
  });
  return {
    enabled,
    recorder,
    config,
    spec,
    startedAt,
    reset: vi.fn(async () => undefined),
  };
}

describe('inspector API', () => {
  it('ignores unrelated paths and reports disabled inspectors as not found', async () => {
    const context = await makeContext(false);
    expect(await handleInspector('GET', inspectorUrl('/pets'), context)).toBeUndefined();
    const disabled = await handleInspector('GET', inspectorUrl('/__mockline/health'), context);
    expect(disabled).toMatchObject({ status: 404 });
  });

  it('exposes health, spec metadata, and a redacted configuration view', async () => {
    const context = await makeContext();
    const health = await handleInspector('GET', inspectorUrl('/__mockline/health'), context);
    expect(health?.status).toBe(200);
    expect(health?.body).toMatchObject({
      status: 'ok',
      openapi: '3.0.3',
      operationCount: 10,
    });

    const spec = await handleInspector('GET', inspectorUrl('/__mockline/spec'), context);
    expect(spec?.body).toMatchObject({
      title: 'Mockline Petstore Fixture',
      version: '1.0.0',
    });

    const configResult = await handleInspector('GET', inspectorUrl('/__mockline/config'), context);
    const config = configResult?.body as {
      proxy: { url?: string; recordFile?: string };
      recording: { file?: string };
    };
    expect(config.proxy.url).toBe('[REDACTED UPSTREAM URL]');
    expect(config.proxy.recordFile).toBe('[PATH REDACTED]');
    expect(config.recording.file).toBe('[PATH REDACTED]');
  });

  it('filters recorded requests and rejects malformed filters and request IDs', async () => {
    const context = await makeContext();
    const filtered = await handleInspector(
      'GET',
      inspectorUrl(
        '/__mockline/requests?method=get&path=pets&status=200&operationId=listPets&since=2025-01-02T03%3A04%3A00Z&limit=1',
      ),
      context,
    );
    expect(filtered?.body).toHaveLength(1);

    for (const query of ['limit=nope', 'limit=-1', 'status=99', 'since=not-a-date']) {
      const invalid = await handleInspector(
        'GET',
        inspectorUrl(`/__mockline/requests?${query}`),
        context,
      );
      expect(invalid?.status).toBe(400);
    }

    const existing = await handleInspector('GET', inspectorUrl('/__mockline/requests/1'), context);
    expect(existing?.status).toBe(200);
    const missing = await handleInspector(
      'GET',
      inspectorUrl('/__mockline/requests/missing'),
      context,
    );
    expect(missing?.status).toBe(404);
    const malformed = await handleInspector(
      'GET',
      inspectorUrl('/__mockline/requests/%E0%A4%A'),
      context,
    );
    expect(malformed?.status).toBe(400);
  });

  it('supports reset and clear, and returns accurate method and route errors', async () => {
    const context = await makeContext();
    const reset = await handleInspector('POST', inspectorUrl('/__mockline/reset'), context);
    expect(reset?.status).toBe(200);
    expect(context.reset).toHaveBeenCalledOnce();

    const methodNotAllowed = await handleInspector(
      'POST',
      inspectorUrl('/__mockline/requests/1'),
      context,
    );
    expect(methodNotAllowed).toMatchObject({
      status: 405,
      headers: { allow: 'GET' },
    });
    const knownPathMethod = await handleInspector(
      'POST',
      inspectorUrl('/__mockline/health'),
      context,
    );
    expect(knownPathMethod).toMatchObject({
      status: 405,
      headers: { allow: 'GET' },
    });
    const unknown = await handleInspector(
      'GET',
      inspectorUrl('/__mockline/no-such-endpoint'),
      context,
    );
    expect(unknown?.status).toBe(404);

    const deleted = await handleInspector('DELETE', inspectorUrl('/__mockline/requests'), context);
    expect(deleted?.status).toBe(200);
    expect(context.recorder.list()).toHaveLength(0);
    expect(
      (await handleInspector('GET', inspectorUrl('/__mockline/requests'), context))?.body,
    ).toEqual([]);
  });
});
