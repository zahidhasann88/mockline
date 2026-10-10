import { describe, expect, it, vi } from 'vitest';
import { generateFromSchema } from '../src/generate/schema.js';
import { validateSchema } from '../src/ajv.js';
import { createRouter } from '../src/router.js';
import { validateRequest } from '../src/validate.js';
import type { JsonSchema, OpenApiDocument } from '../src/types.js';

describe('generation and validation regressions', () => {
  it('rejects impossible schemas even without a root document', () => {
    expect(() => generateFromSchema({ type: 'string', minLength: 5, maxLength: 2 })).toThrow(
      /satisfying/,
    );
  });
  it('keeps generated dates stable when wall-clock time changes', () => {
    vi.useFakeTimers();
    try {
      const schema: JsonSchema = {
        type: 'object',
        required: ['createdAt', 'date'],
        properties: {
          createdAt: { type: 'string' },
          date: { type: 'string', format: 'date-time' },
        },
      };
      vi.setSystemTime(new Date('2024-01-01'));
      const first = generateFromSchema(schema, { seed: 1 }).value;
      vi.setSystemTime(new Date('2030-01-01'));
      expect(generateFromSchema(schema, { seed: 1 }).value).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds required recursive schemas that cannot have finite values', () => {
    const root: OpenApiDocument = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['next'],
            properties: { next: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    };
    expect(() =>
      generateFromSchema({ $ref: '#/components/schemas/Node' }, { root, maxDepth: 2 }),
    ).toThrow(/finite value/);
  });
  it('uses sensible numeric bounds when only one bound is declared', () => {
    for (const schema of [
      { type: 'integer', minimum: 1000 },
      { type: 'integer', maximum: -1000 },
    ]) {
      const value = generateFromSchema(schema, { seed: 5 }).value;
      expect(validateSchema({}, schema, value).valid).toBe(true);
    }
  });
  it('validates OpenAPI 3.1 unevaluatedProperties with the 2020 schema dialect', () => {
    const root: OpenApiDocument = { openapi: '3.1.0' };
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      unevaluatedProperties: false,
    };
    expect(validateSchema(root, schema, { name: 'Ada' }).valid).toBe(true);
    expect(validateSchema(root, schema, { name: 'Ada', extra: true }).valid).toBe(false);
  });
  it('keeps query parameter names case-sensitive', () => {
    const router = createRouter({
      paths: {
        '/items': {
          parameters: [{ name: 'ID', in: 'query', required: true, schema: { type: 'integer' } }],
          get: {
            parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'integer' } }],
          },
        },
      },
    });
    expect(router.routes[0]?.parameters.map((p) => p.name)).toEqual(['ID', 'id']);
  });
  it('does not require inline readOnly body properties', () => {
    const bodySchema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } },
    };
    const root: OpenApiDocument = {
      paths: {
        '/items': {
          post: {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: bodySchema } },
            },
          },
        },
      },
    };
    const route = createRouter(root).routes[0];
    if (!route) throw new Error('missing route');
    expect(
      validateRequest({
        root,
        route,
        params: {},
        url: new URL('http://localhost/items'),
        headers: { 'content-type': 'application/json' },
        body: { name: 'Ada' },
        bodyPresent: true,
      }).valid,
    ).toBe(true);
  });
});
