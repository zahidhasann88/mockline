import { describe, expect, it } from 'vitest';
import {
  generateFromSchema,
  generateValue,
  deriveSeed,
  SeededRandom,
} from '../src/generate/index.js';
import { validateSchema } from '../src/ajv.js';
import { loadSpec } from '../src/spec/load.js';
import type { ApiOperation, JsonSchema, OpenApiDocument } from '../src/types.js';
import { fixture } from './helpers.js';

describe('seeded schema generation', () => {
  it('validates responses across a broad corpus of OpenAPI and JSON Schema rules', async () => {
    const loaded = await loadSpec(fixture('schema-only.yaml'));
    const root = loaded.document;
    const user = root.components?.schemas?.User;
    expect(user).toBeDefined();
    for (let seed = 1; seed <= 25; seed += 1) {
      const result = generateFromSchema(user as JsonSchema, { root, seed, hints: true });
      expect(validateSchema(root, user as JsonSchema, result.value).valid, `seed ${seed}`).toBe(
        true,
      );
      const value = result.value as { email: string; status: string; labels: string[] };
      expect(value.email).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
      expect(['active', 'pending', 'disabled']).toContain(value.status);
      expect(value.labels.length).toBeGreaterThanOrEqual(2);
      expect(new Set(value.labels).size).toBe(value.labels.length);
      expect(value.labels.every((label) => /^[A-Z]{3}$/.test(label))).toBe(true);
    }
  });

  it('honors primitive constraints, examples, formats, and hints only when unconstrained', () => {
    const root: OpenApiDocument = { openapi: '3.1.0' };
    const constrained: JsonSchema[] = [
      { type: 'string', enum: ['small', 'large'] },
      { type: 'string', const: 'fixed' },
      { type: 'string', default: 'default-value' },
      { type: 'string', format: 'uuid' },
      { type: 'string', format: 'date' },
      { type: 'string', format: 'date-time' },
      { type: 'string', format: 'uri' },
      { type: 'string', format: 'hostname' },
      { type: 'string', format: 'ipv4' },
      { type: 'string', format: 'ipv6' },
      { type: 'string', minLength: 4, maxLength: 7 },
      { type: 'string', pattern: '^[A-Z]{3}$' },
      { type: 'integer', minimum: 5, maximum: 20, multipleOf: 5 },
      { type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 8, exclusiveMaximum: true },
      { type: 'number', minimum: 1.25, maximum: 2.5, multipleOf: 0.25 },
      { type: 'boolean' },
      { type: 'null' },
      { type: ['string', 'null'] },
      { type: 'string', nullable: true },
    ];
    for (const [index, schema] of constrained.entries()) {
      const generated = generateFromSchema(schema, { root, seed: index + 10 });
      expect(validateSchema(root, schema, generated.value).valid, JSON.stringify(schema)).toBe(
        true,
      );
    }
    expect(generateValue({ type: 'string', enum: ['small'] }, { root, seed: 4 })).toBe('small');
    expect(generateValue({ type: 'string', const: 'constant' }, { root })).toBe('constant');
    expect(generateValue({ type: 'string', default: 'defaults' }, { root })).toBe('defaults');
    const email = generateValue({ type: 'string', format: 'email' }, { root, seed: 9 });
    expect(email).toMatch(/@/);
    const hinted = generateValue(
      { type: 'string' },
      { root, seed: 1, hints: true, mode: 'response' },
    );
    expect(typeof hinted).toBe('string');
  });

  it('supports allOf merge, anyOf and oneOf selection with discriminators', async () => {
    const root = (await loadSpec(fixture('recursive-polymorphic.yaml'))).document;
    const combined: JsonSchema = {
      allOf: [
        {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 2 } },
        },
        {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'integer', minimum: 2, maximum: 5 } },
        },
      ],
    };
    const allOf = generateFromSchema(combined, { root, seed: 3 }).value as Record<string, unknown>;
    expect(allOf).toHaveProperty('name');
    expect(allOf.count).toBeGreaterThanOrEqual(2);
    expect(validateSchema(root, combined, allOf).valid).toBe(true);

    const oneOf: JsonSchema = {
      oneOf: [
        { type: 'string', enum: ['a'] },
        { type: 'integer', minimum: 1 },
      ],
    };
    for (let seed = 0; seed < 8; seed += 1) {
      const result = generateFromSchema(oneOf, { root, seed }).value;
      expect(validateSchema(root, oneOf, result).valid).toBe(true);
    }
    const operation = root.paths?.['/animals']?.get as ApiOperation | undefined;
    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema;
    expect(schema).toBeDefined();
    for (let seed = 0; seed < 10; seed += 1) {
      const animal = generateFromSchema(schema as JsonSchema, { root, seed }).value as Record<
        string,
        unknown
      >;
      expect(['cat', 'dog']).toContain(animal.kind);
      expect(validateSchema(root, schema as JsonSchema, animal).valid).toBe(true);
    }
  });

  it('terminates recursive references within the configured depth and validates the result', async () => {
    const root = (await loadSpec(fixture('recursive-polymorphic.yaml'))).document;
    const schema: JsonSchema = { $ref: '#/components/schemas/Node' };
    for (let seed = 0; seed < 10; seed += 1) {
      const result = generateFromSchema(schema, {
        root,
        seed,
        maxDepth: 2,
        minArrayItems: 0,
        maxArrayItems: 2,
      });
      expect(validateSchema(root, schema, result.value).valid).toBe(true);
      const depth = (value: unknown): number => {
        if (!value || typeof value !== 'object') return 0;
        if (Array.isArray(value)) return Math.max(0, ...value.map(depth));
        const object = value as Record<string, unknown>;
        return 1 + Math.max(depth(object.next), depth(object.children));
      };
      expect(depth(result.value)).toBeLessThanOrEqual(4);
    }
  });

  it('excludes writeOnly fields in responses and readOnly fields in request generation', () => {
    const root: OpenApiDocument = {
      openapi: '3.0.3',
      components: {
        schemas: {
          Account: {
            type: 'object',
            required: ['id', 'password', 'name'],
            properties: {
              id: { type: 'integer', minimum: 1, readOnly: true },
              password: { type: 'string', minLength: 1, writeOnly: true },
              name: { type: 'string' },
            },
          },
        },
      },
    };
    const schema = root.components?.schemas?.Account as JsonSchema;
    const response = generateFromSchema(schema, { root, seed: 1, mode: 'response' })
      .value as Record<string, unknown>;
    expect(response).toHaveProperty('id');
    expect(response).not.toHaveProperty('password');
    const request = generateFromSchema(schema, { root, seed: 1, mode: 'request' }).value as Record<
      string,
      unknown
    >;
    expect(request).not.toHaveProperty('id');
    expect(request).toHaveProperty('password');
  });

  it('respects additionalProperties and configurable property hints', () => {
    const root: OpenApiDocument = { openapi: '3.1.0' };
    const closed = generateFromSchema(
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      { root, seed: 5 },
    );
    expect(Object.keys(closed.value as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['name']),
    );
    expect(
      Object.keys(closed.value as Record<string, unknown>).every((key) => key === 'name'),
    ).toBe(true);
    const open = generateFromSchema(
      {
        type: 'object',
        properties: { age: { type: 'integer' } },
        additionalProperties: { type: 'boolean' },
      },
      { root, seed: 7 },
    );
    expect((open.value as Record<string, unknown>).extension).toBeTypeOf('boolean');
    const hinted = generateValue(
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      { root, seed: 1, hints: { name: 'Ada' } },
    ) as { name: string };
    expect(hinted.name).toBe('Ada');
  });

  it('uses deterministic per-request seeds and deterministic RNG primitives', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name', 'score'],
      properties: { name: { type: 'string' }, score: { type: 'integer' } },
    };
    const first = generateFromSchema(schema, { seed: 123 });
    const second = generateFromSchema(schema, { seed: 123 });
    const other = generateFromSchema(schema, { seed: 124 });
    expect(first.value).toEqual(second.value);
    expect(first.value).not.toEqual(other.value);
    expect(deriveSeed(1, 'GET', '/users')).toBe(deriveSeed(1, 'GET', '/users'));
    const randomA = new SeededRandom(42);
    const randomB = new SeededRandom(42);
    expect([randomA.next(), randomA.int(1, 10), randomA.bool()]).toEqual([
      randomB.next(),
      randomB.int(1, 10),
      randomB.bool(),
    ]);
  });
});
