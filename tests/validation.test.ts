import { describe, expect, it } from 'vitest';
import { createRouter } from '../src/router.js';
import { loadSpec } from '../src/spec/load.js';
import { checkSecurityPresence, strictValidationStatus, validateRequest } from '../src/validate.js';
import { fixture, makeServer } from './helpers.js';
import type { OpenApiDocument } from '../src/types.js';

describe('OpenAPI request validation', () => {
  it('coerces query strings and validates path, header, cookie, and query parameters', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const router = createRouter(loaded.document);
    const list = router.match('GET', '/v1/pets');
    if (!list) throw new Error('missing list operation');
    const valid = validateRequest({
      root: loaded.document,
      route: list.route,
      params: {},
      url: new URL('http://localhost/v1/pets?limit=5&filter%5Bactive%5D=true'),
      headers: { 'x-trace': 'test' },
      body: undefined,
      bodyPresent: false,
    });
    expect(valid.valid).toBe(true);
    const invalid = validateRequest({
      root: loaded.document,
      route: list.route,
      params: {},
      url: new URL('http://localhost/v1/pets?limit=1000'),
      headers: {},
      body: undefined,
      bodyPresent: false,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.location.startsWith('query.limit'))).toBe(true);

    const item = router.match('GET', '/v1/pets/10');
    if (!item) throw new Error('missing item operation');
    const missingPath = validateRequest({
      root: loaded.document,
      route: item.route,
      params: {},
      url: new URL('http://localhost/v1/pets/10'),
      headers: {},
      body: undefined,
      bodyPresent: false,
    });
    expect(missingPath.issues.some((issue) => issue.location === 'path.petId')).toBe(true);
  });

  it('validates JSON body content and ignores readOnly fields on input', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const route = createRouter(loaded.document).match('POST', '/v1/pets');
    if (!route) throw new Error('missing create operation');
    const valid = validateRequest({
      root: loaded.document,
      route: route.route,
      params: {},
      url: new URL('http://localhost/v1/pets'),
      headers: { 'content-type': 'application/json' },
      body: { name: 'Rex', id: 15 },
      bodyPresent: true,
    });
    expect(valid.valid).toBe(true);
    const tooShort = validateRequest({
      root: loaded.document,
      route: route.route,
      params: {},
      url: new URL('http://localhost/v1/pets'),
      headers: { 'content-type': 'application/json' },
      body: { name: 'x' },
      bodyPresent: true,
    });
    expect(tooShort.bodyInvalid).toBe(true);
    expect(tooShort.issues.some((issue) => issue.location === '/body/name')).toBe(true);
    expect(strictValidationStatus(tooShort)).toBe(422);

    const missingContentType = validateRequest({
      root: loaded.document,
      route: route.route,
      params: {},
      url: new URL('http://localhost/v1/pets'),
      headers: {},
      body: { name: 'Rex' },
      bodyPresent: true,
    });
    expect(
      missingContentType.issues.some((issue) => issue.location === 'header.content-type'),
    ).toBe(true);
    const missingBody = validateRequest({
      root: loaded.document,
      route: route.route,
      params: {},
      url: new URL('http://localhost/v1/pets'),
      headers: {},
      body: undefined,
      bodyPresent: false,
    });
    expect(missingBody.bodyInvalid).toBe(true);
  });

  it('supports header, cookie, and object parameter coercion', () => {
    const root: OpenApiDocument = {
      openapi: '3.0.3',
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
              { name: 'flag', in: 'cookie', required: true, schema: { type: 'boolean' } },
              { name: 'X-Count', in: 'header', schema: { type: 'integer', minimum: 2 } },
              {
                name: 'filter',
                in: 'query',
                style: 'deepObject',
                explode: true,
                schema: { type: 'object', properties: { limit: { type: 'integer' } } },
              },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const match = createRouter(root).match('GET', '/things/5');
    if (!match) throw new Error('missing operation');
    const result = validateRequest({
      root,
      route: match.route,
      params: match.params,
      url: new URL('http://localhost/things/5?filter%5Blimit%5D=4'),
      headers: { cookie: 'flag=true', 'x-count': '3' },
      body: undefined,
      bodyPresent: false,
    });
    expect(result.valid).toBe(true);
  });

  it('checks credential presence for API keys and HTTP auth without verifying values', async () => {
    const loaded = await loadSpec(fixture('petstore-30.yaml'));
    const route = createRouter(loaded.document).match('GET', '/v1/private');
    if (!route) throw new Error('missing private operation');
    const url = new URL('http://localhost/v1/private');
    expect(checkSecurityPresence(loaded.document, route.route.operation, {}, url).authorized).toBe(
      false,
    );
    expect(
      checkSecurityPresence(
        loaded.document,
        route.route.operation,
        { 'x-api-key': 'anything' },
        url,
      ).authorized,
    ).toBe(true);
    expect(
      checkSecurityPresence({ ...loaded.document, security: [] }, route.route.operation, {}, url)
        .authorized,
    ).toBe(false);
    expect(
      checkSecurityPresence(
        { ...loaded.document, security: [] },
        { ...route.route.operation, security: [] },
        {},
        url,
      ).authorized,
    ).toBe(true);
  });
});

describe('validation modes in the server', () => {
  it('warn mode serves responses with a failure header; strict mode returns problem+json', async () => {
    const warn = await makeServer({ config: { validate: 'warn' } });
    const strict = await makeServer({ config: { validate: 'strict' } });
    try {
      const warned = await fetch(`${warn.url}/v1/pets?limit=500`);
      expect(warned.status).toBe(200);
      expect(warned.headers.get('x-mockline-validation')).toBe('failed');
      expect(warn.requests()[0]?.validationErrors.length).toBeGreaterThan(0);

      const rejected = await fetch(`${strict.url}/v1/pets?limit=500`);
      expect(rejected.status).toBe(400);
      expect(rejected.headers.get('content-type')).toContain('problem+json');
      const problem = (await rejected.json()) as { errors: Array<{ location: string }> };
      expect(problem.errors.some((error) => error.location === 'query.limit')).toBe(true);
      const invalidBody = await fetch(`${strict.url}/v1/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      expect(invalidBody.status).toBe(422);
    } finally {
      await Promise.all([warn.close(), strict.close()]);
    }
  });

  it('off mode skips request validation and enforce-auth checks only credential presence', async () => {
    const off = await makeServer({ config: { validate: 'off', enforceAuth: true } });
    try {
      const rejected = await fetch(`${off.url}/v1/private`);
      expect(rejected.status).toBe(401);
      const accepted = await fetch(`${off.url}/v1/private`, {
        headers: { 'x-api-key': 'not-verified' },
      });
      expect(accepted.status).toBe(200);
      const invalidQuery = await fetch(`${off.url}/v1/pets?limit=bad`);
      expect(invalidQuery.status).toBe(200);
      expect(invalidQuery.headers.get('x-mockline-validation')).toBeNull();
    } finally {
      await off.close();
    }
  });
});
