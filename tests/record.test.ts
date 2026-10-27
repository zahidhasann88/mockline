import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMockServer } from '../src/server.js';
import { loadSpec } from '../src/spec/load.js';
import { decodeBody } from '../src/spec/examples.js';
import { silentLogger } from './helpers.js';

const SPEC = `openapi: 3.0.3
info: { title: Pets, version: 1.0.0 }
paths:
  # pets collection
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: Pets
          content:
            application/json:
              example: [{ id: 0, name: Old }]
              schema: { type: array, items: { $ref: '#/components/schemas/Pet' } }
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - { name: petId, in: path, required: true, schema: { type: integer } }
      responses:
        '200':
          $ref: '#/components/responses/PetResponse'
  /hello:
    get:
      operationId: hello
      responses:
        '200': { description: Hello }
components:
  schemas:
    Pet:
      type: object
      properties:
        id: { type: integer }
        name: { type: string }
  responses:
    PetResponse:
      description: A pet
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Pet' }
`;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function upstream(): Promise<string> {
  let pets = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === '/pets') {
      pets += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pets === 1 ? [{ id: 1, name: 'Rex' }] : [{ id: 2, name: 'Milo' }]));
    } else if (req.url === '/pets/1') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 1, name: 'Rex' }));
    } else if (req.url === '/hello') {
      res.setHeader('content-type', 'text/plain');
      res.end('hi there');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('recording examples', () => {
  it('decodes JSON and text bodies and skips others', () => {
    expect(decodeBody(Buffer.from('{"a":1}'), 'application/json; charset=utf-8')).toEqual({
      mediaType: 'application/json',
      value: { a: 1 },
    });
    expect(decodeBody(Buffer.from('hi'), 'text/plain')).toEqual({
      mediaType: 'text/plain',
      value: 'hi',
    });
    expect(decodeBody(Buffer.from('{bad'), 'application/json')).toBeUndefined();
    expect(decodeBody(Buffer.from([1, 2]), 'image/png')).toBeUndefined();
    expect(decodeBody(Buffer.alloc(0), 'application/json')).toBeUndefined();
  });

  it('saves proxied responses into a copy of the spec that can be served', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mockline-record-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const spec = join(directory, 'openapi.yaml');
    const out = join(directory, 'openapi.recorded.yaml');
    await writeFile(spec, SPEC);
    const api = await upstream();

    const warnings: string[] = [];
    const recorder = await createMockServer({
      spec,
      port: 0,
      logger: { ...silentLogger, warn: (line) => warnings.push(line) },
      config: { proxy: { url: api, all: true, allowPrivate: true, recordSpec: out } },
    });
    try {
      expect(await (await fetch(`${recorder.url}/pets`)).json()).toEqual([{ id: 1, name: 'Rex' }]);
      await fetch(`${recorder.url}/pets`);
      await fetch(`${recorder.url}/pets`);
      await fetch(`${recorder.url}/pets/1`);
      await fetch(`${recorder.url}/hello`);
      await fetch(`${recorder.url}/unknown`);
    } finally {
      await recorder.close();
    }

    expect(await readFile(spec, 'utf8')).toBe(SPEC);
    const text = await readFile(out, 'utf8');
    expect(text).toContain('# pets collection');
    expect(text).toContain("$ref: '#/components/responses/PetResponse'");
    expect(warnings).toEqual([expect.stringContaining('/unknown is not in the spec')]);

    const recorded = parse(text) as {
      paths: Record<string, { get: { responses: Record<string, Record<string, unknown>> } }>;
    };
    const pets = recorded.paths['/pets']?.get.responses['200']?.content as Record<
      string,
      { example?: unknown; examples: Record<string, { value: unknown }> }
    >;
    const media = pets['application/json'];
    expect(media?.example).toBeUndefined();
    expect(Object.keys(media?.examples ?? {})).toEqual(['recorded-2', 'recorded', 'original']);
    expect(media?.examples['recorded-2']?.value).toEqual([{ id: 2, name: 'Milo' }]);
    expect(media?.examples.original?.value).toEqual([{ id: 0, name: 'Old' }]);
    expect(recorded.paths['/hello']?.get.responses['200']?.content).toEqual({
      'text/plain': { examples: { recorded: { summary: 'GET /hello', value: 'hi there' } } },
    });

    expect((await loadSpec(out)).document.openapi).toBe('3.0.3');
    const replay = await createMockServer({ spec: out, port: 0, logger: silentLogger });
    try {
      expect(await (await fetch(`${replay.url}/pets`)).json()).toEqual([{ id: 2, name: 'Milo' }]);
      expect(await (await fetch(`${replay.url}/hello`)).text()).toBe('hi there');
    } finally {
      await replay.close();
    }
  });
});
