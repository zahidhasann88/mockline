import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSpec, inspectSpec } from '../src/spec/load.js';
import { defaultStatus, summarizeSpec } from '../src/spec/summary.js';
import { loadConfig, parseConfigText } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import type { OpenApiDocument } from '../src/types.js';
import { fixture } from './helpers.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('spec loading and summaries', () => {
  it('loads OpenAPI 3.0 and 3.1 files and dereferences the document', async () => {
    const v30 = await loadSpec(fixture('petstore-30.yaml'));
    const v31 = await loadSpec(fixture('openapi-31.yaml'));
    expect(v30.document.openapi).toBe('3.0.3');
    expect(v30.dereferenced.paths?.['/pets']).toBeDefined();
    expect(v31.document.openapi).toBe('3.1.0');
    expect(summarizeSpec(v30)).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/v1/pets',
        source: 'example',
      }),
    );
  });

  it('provides a clear Swagger 2.0 conversion limitation', async () => {
    await expect(loadSpec(fixture('swagger2.yaml'))).rejects.toMatchObject({
      name: 'MocklineError',
      message: expect.stringContaining('Convert the document to OpenAPI 3.x'),
      exitCode: 1,
    });
  });

  it('reports unresolved references and invalid YAML as spec errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-spec-'));
    temporaryDirectories.push(directory);
    const invalidRef = join(directory, 'broken.yaml');
    await writeFile(
      invalidRef,
      `openapi: 3.0.3\ninfo: { title: Broken, version: 1 }\npaths:\n  /x:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Missing' }\n`,
    );
    await expect(loadSpec(invalidRef)).rejects.toThrow(/Invalid OpenAPI spec/);
    const invalidYaml = join(directory, 'bad.yaml');
    await writeFile(invalidYaml, 'openapi: [not valid');
    await expect(loadSpec(invalidYaml)).rejects.toThrow(/Cannot parse OpenAPI spec/);
  });

  it('reports mocking warnings for operations without examples or schemas and unsupported features', () => {
    const document: OpenApiDocument = {
      openapi: '3.0.3',
      webhooks: { callback: {} },
      paths: {
        '/empty': {
          get: {
            operationId: 'empty',
            callbacks: { event: {} },
            links: { next: {} },
            responses: { '200': { description: 'empty' } },
          },
        },
      },
    };
    const warnings = inspectSpec(document);
    expect(warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No response schema or example'),
        expect.stringContaining('Callbacks are not supported'),
        expect.stringContaining('Response links are ignored'),
        expect.stringContaining('Webhooks are not served'),
      ]),
    );
  });

  it('chooses the lowest successful response before default and falls back as specified', () => {
    expect(
      defaultStatus({
        '201': { description: 'created' },
        '200': { description: 'ok' },
        '404': { description: 'missing' },
      }),
    ).toBe('200');
    expect(
      defaultStatus({
        default: { description: 'fallback' },
        '404': { description: 'missing' },
      }),
    ).toBe('default');
    expect(defaultStatus({ '404': { description: 'missing' } })).toBe('200');
    expect(defaultStatus(undefined)).toBe('200');
  });
});

describe('configuration', () => {
  it('parses YAML and JSON and fills defaults', async () => {
    const yaml = await parseConfigText('port: 0\nhost: 127.0.0.1\ngeneration:\n  hints: false\n');
    const json = await parseConfigText('{"port": 4050, "prefer": "generate"}', 'mockline.json');
    expect(yaml.port).toBe(0);
    expect(yaml.recording.maxRequests).toBe(500);
    expect(yaml.generation.hints).toBe(false);
    expect(json.port).toBe(4050);
    expect(json.prefer).toBe('generate');
    expect(configSchema.parse({}).cors.enabled).toBe(true);
  });

  it('returns field paths for invalid values and validates proxy protocols', async () => {
    await expect(parseConfigText('errors:\n  rate: 2')).rejects.toMatchObject({
      name: 'MocklineError',
      message: expect.stringContaining('errors.rate'),
    });
    await expect(parseConfigText('proxy:\n  url: ftp://example.test')).rejects.toThrow(/proxy.url/);
    await expect(parseConfigText('proxy:\n  all: true')).rejects.toThrow(/proxy.url/);
    await expect(parseConfigText('latency:\n  min: 80\n  max: 10')).rejects.toThrow(/latency.min/);
    await expect(
      parseConfigText('generation:\n  minArrayItems: 4\n  maxArrayItems: 2'),
    ).rejects.toThrow(/generation.minArrayItems/);
  });

  it('loads an explicit config file and reports missing files with the path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'mockline.json');
    await writeFile(path, JSON.stringify({ port: 0, seed: 17 }));
    const result = await loadConfig(path);
    expect(result.config.seed).toBe(17);
    expect(result.path).toBe(path);
    await expect(loadConfig(join(directory, 'missing.yaml'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('publishes the generated config schema with editor metadata', async () => {
    const schema = JSON.parse(await readFile('docs/config.schema.json', 'utf8')) as {
      title?: string;
      definitions?: {
        MocklineConfig?: { properties?: Record<string, unknown> };
      };
    };
    expect(schema.title).toBe('Mockline configuration');
    expect(schema.definitions?.MocklineConfig?.properties).toHaveProperty('generation');
    expect(schema.definitions?.MocklineConfig?.properties).toHaveProperty('recording');
  });
});
