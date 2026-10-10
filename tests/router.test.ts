import { describe, expect, it } from 'vitest';
import { createRouter, normalizePath } from '../src/router.js';
import { loadSpec } from '../src/spec/load.js';
import { fixture } from './helpers.js';
import type { OpenApiDocument } from '../src/types.js';

describe('OpenAPI router', () => {
  it('orders static paths ahead of parameters and includes server base paths', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const router = createRouter(loaded.document);
    const staticMatch = router.match('get', '/v1/pets/mine');
    expect(staticMatch?.route.operationId).toBe('getMyPets');
    expect(router.match('get', '/v1/pets/12')?.route.operationId).toBe('getPet');
    expect(router.routes.some((route) => route.path === '/v1/pets')).toBe(true);
  });

  it('decodes encoded path values and accepts trailing slashes', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const router = createRouter(loaded.document);
    expect(router.match('get', '/v1/pets/123/')?.params).toEqual({ petId: '123' });
    expect(router.match('get', '/v1/pets/a%2Fb')?.params).toEqual({ petId: 'a/b' });
    expect(router.match('get', '/v1/pets/%ZZ')).toBeUndefined();
    expect(router.match('get', '/v1/pets/')?.route.operationId).toBe('listPets');
  });

  it('returns methods for a matching path and a nearest path for misses', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const router = createRouter(loaded.document);
    expect(router.methodsForPath('/v1/pets/4')).toEqual(['DELETE', 'GET', 'PATCH', 'PUT']);
    expect(router.nearestPath('/v1/pets/4/unknown')).toBe('/v1/pets/{petId}');
    expect(router.nearestPath('/missing')).toBeDefined();
    expect(router.methodsForPath('/no-such-path')).toEqual([]);
  });

  it('supports variable server prefixes, root paths, and normalized slashes', () => {
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      servers: [{ url: '/api/{version}', variables: { version: { default: 'v2' } } }],
      paths: {
        '/items/{itemId}': {
          get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } },
        },
        '/': { get: { responses: { '200': { description: 'root' } } } },
      },
    };
    const router = createRouter(document);
    expect(router.match('GET', '/api/v2/items/abc')?.params).toEqual({ itemId: 'abc' });
    expect(router.match('GET', '/api/v2/items/abc/')?.route.operationId).toBe('getItem');
    expect(router.match('GET', '/api/v2')).toBeDefined();
    expect(normalizePath('items///')).toBe('/items');
    expect(normalizePath('/')).toBe('/');
  });
});
