import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { loadSpec } from '../src/spec/load.js';
import { createRouter } from '../src/router.js';
import { selectResponse, type SelectionInput } from '../src/select.js';
import type { MocklineConfig } from '../src/config/schema.js';
import type { DeepPartial } from '../src/server.js';
import { fixture } from './helpers.js';

async function context(
  routePath = '/v1/pets',
  method = 'GET',
  configOverride: DeepPartial<MocklineConfig> = {},
  headers: Record<string, string> = {},
): Promise<SelectionInput> {
  const spec = await loadSpec(fixture('petstore-30.yaml'));
  const router = createRouter(spec.document);
  const match = router.match(method, routePath);
  if (!match) throw new Error(`No route for ${method} ${routePath}`);
  return {
    root: spec.document,
    route: match.route,
    config: configSchema.parse({ seed: 15, ...configOverride }),
    headers: { accept: 'application/json', ...headers },
    url: new URL(`http://localhost${routePath}`),
    body: undefined,
    requestCounter: 0,
    sequenceIndexes: new Map(),
  };
}

describe('response selection', () => {
  it('prefers named examples by default and generates when requested', async () => {
    const exampleInput = await context();
    const example = selectResponse(exampleInput);
    expect(example.response.source).toBe('example');
    expect(example.response.body).toEqual([
      { id: 17, name: 'Miso', tag: 'cat', createdAt: '2025-01-02T03:04:05Z' },
    ]);

    const generatedInput = await context('/v1/pets', 'GET', { prefer: 'generate' });
    const generated = selectResponse(generatedInput);
    expect(generated.response.source).toBe('generated');
    expect(Array.isArray(generated.response.body)).toBe(true);
  });

  it('supports Prefer code, Prefer example, and X-Mockline status/delay/error controls', async () => {
    const codeInput = await context('/v1/pets/2', 'GET', {}, { accept: '*/*', prefer: 'code=404' });
    const code = selectResponse(codeInput).response;
    expect(code.status).toBe(404);
    expect(code.source).toBe('example');
    expect((code.body as { title: string }).title).toBe('Not Found');

    const exampleInput = await context('/v1/pets', 'GET', {}, { prefer: 'example=kitten' });
    expect((selectResponse(exampleInput).response.body as Array<{ id: number }>)[0]?.id).toBe(17);

    const status = selectResponse(
      await context('/v1/pets/2', 'GET', {}, { accept: '*/*', 'x-mockline-status': '404' }),
    ).response;
    expect(status.status).toBe(404);
    const delay = selectResponse(
      await context('/v1/pets', 'GET', {}, { 'x-mockline-delay': '37' }),
    ).response;
    expect(delay.delay).toBe(37);
    const failure = selectResponse(
      await context('/v1/pets', 'GET', {}, { 'x-mockline-error': 'true' }),
    ).response;
    expect([500, 503]).toContain(failure.status);
    expect(failure.source).toBe('generated');
    expect(failure.headers?.['content-type']).toContain('problem+json');
  });

  it('can disable control headers and applies per-operation overrides after controls', async () => {
    const disabled = selectResponse(
      await context(
        '/v1/pets/2',
        'GET',
        { controlHeaders: { allow: false } },
        { prefer: 'code=404' },
      ),
    ).response;
    expect(disabled.status).toBe(200);

    const withOverride = await context(
      '/v1/pets',
      'GET',
      {
        overrides: { listPets: { status: 202, body: { source: 'fixed' } } },
      },
      { 'x-mockline-status': '404' },
    );
    expect(selectResponse(withOverride).response.status).toBe(404);

    const override = await context('/v1/pets', 'GET', {
      overrides: { 'GET /v1/pets': { status: 202, body: { source: 'override' } } },
    });
    expect(selectResponse(override).response).toMatchObject({
      status: 202,
      body: { source: 'override' },
      source: 'override',
    });
  });

  it('evaluates conditional override rules against query, headers, and JSON body paths', async () => {
    const query = await context('/v1/pets', 'GET', {
      overrides: {
        listPets: {
          rules: [
            {
              when: { location: 'query', name: 'view', op: 'eq', value: 'compact' },
              response: { status: 206, body: { compact: true } },
            },
          ],
        },
      },
    });
    query.url.searchParams.set('view', 'compact');
    expect(selectResponse(query).response.status).toBe(206);

    const header = await context(
      '/v1/pets',
      'GET',
      {
        overrides: {
          listPets: {
            rules: [
              {
                when: { location: 'header', name: 'x-mode', op: 'contains', value: 'preview' },
                response: { status: 207, body: 'preview' },
              },
            ],
          },
        },
      },
      { 'x-mode': 'preview-v2' },
    );
    expect(selectResponse(header).response.status).toBe(207);

    const body = await context('/v1/pets', 'GET', {
      overrides: {
        listPets: {
          when: { location: 'body', name: 'meta.region', op: 'regex', value: '^eu-' },
          response: { status: 208, body: { matched: true } },
        },
      },
    });
    body.body = { meta: { region: 'eu-west' } };
    expect(selectResponse(body).response.status).toBe(208);
  });

  it('serves sequences in order and either loops or sticks at the last response', async () => {
    const looping = await context('/v1/pets', 'GET', {
      overrides: {
        listPets: {
          sequence: [
            { status: 201, body: { n: 1 } },
            { status: 202, body: { n: 2 } },
          ],
          loop: true,
        },
      },
    });
    const indexes = new Map<string, number>();
    const first = selectResponse({ ...looping, sequenceIndexes: indexes });
    indexes.set(first.sequenceKey ?? '', 1);
    const second = selectResponse({ ...looping, sequenceIndexes: indexes });
    indexes.set(second.sequenceKey ?? '', 2);
    const third = selectResponse({ ...looping, sequenceIndexes: indexes });
    expect([first.response.status, second.response.status, third.response.status]).toEqual([
      201, 202, 201,
    ]);

    const sticking = await context('/v1/pets', 'GET', {
      overrides: { listPets: { sequence: [{ status: 201 }, { status: 202 }] } },
    });
    expect(
      selectResponse({ ...sticking, sequenceIndexes: new Map([['listPets', 99]]) }).response.status,
    ).toBe(202);
  });

  it('uses stateful handlers after overrides and before examples', async () => {
    const state = { status: 200, body: [{ id: 1 }], source: 'state' as const };
    const noOverride = await context('/v1/pets', 'GET');
    expect(selectResponse({ ...noOverride, stateResponse: state }).response.source).toBe('state');
    const withOverride = await context('/v1/pets', 'GET', {
      overrides: { listPets: { status: 202, body: [] } },
    });
    expect(selectResponse({ ...withOverride, stateResponse: state }).response.source).toBe(
      'override',
    );
  });

  it('negotiates response media types and returns 406 when none match', async () => {
    const plain = selectResponse(
      await context('/v1/accept', 'GET', {}, { accept: 'text/plain' }),
    ).response;
    expect(plain.status).toBe(200);
    expect(plain.headers?.['content-type']).toBe('text/plain');
    expect(plain.body).toBe('plain');
    const notAcceptable = selectResponse(
      await context('/v1/accept', 'GET', {}, { accept: 'application/xml' }),
    ).response;
    expect(notAcceptable.status).toBe(406);
    expect(notAcceptable.headers?.['content-type']).toContain('problem+json');
    const defaultJson = selectResponse(
      await context('/v1/accept', 'GET', {}, { accept: '*/*' }),
    ).response;
    expect(defaultJson.headers?.['content-type']).toBe('application/json');
  });

  it('injects configured failures and fixed, ranged, or distributed latency', async () => {
    const failing = selectResponse(
      await context('/v1/pets', 'GET', {
        errors: { rate: 1, statuses: [502], perOperationRates: {} },
      }),
    ).response;
    expect(failing.status).toBe(502);
    expect(failing.body).toMatchObject({ status: 502 });
    const fixed = selectResponse(await context('/v1/pets', 'GET', { latency: 11 })).response;
    expect(fixed.delay).toBe(11);
    const range = selectResponse(await context('/v1/pets', 'GET', { latency: [20, 30] })).response;
    expect(range.delay).toBeGreaterThanOrEqual(20);
    expect(range.delay).toBeLessThanOrEqual(30);
    const normal = selectResponse(
      await context('/v1/pets', 'GET', { latency: { min: 4, max: 8, distribution: 'normal' } }),
    ).response;
    expect(normal.delay).toBeGreaterThanOrEqual(4);
    expect(normal.delay).toBeLessThanOrEqual(8);
  });
});
