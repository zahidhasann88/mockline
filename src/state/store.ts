import { deriveSeed } from '../generate/rng.js';
import { generateValue } from '../generate/schema.js';
import { validateSchema } from '../ajv.js';
import { defaultStatus } from '../spec/summary.js';
import { problem } from '../errors.js';
import type { MocklineConfig } from '../config/schema.js';
import type {
  MatchedRoute,
  MockResponse,
  JsonSchema,
  OpenApiDocument,
  UnknownRecord,
} from '../types.js';
import { detectCollections, type ResourceCollection } from './collections.js';
import type { Router } from '../router.js';

interface CollectionState {
  definition: ResourceCollection;
  items: Record<string, unknown>[];
  nextNumericId: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveSchema(
  schema: JsonSchema | undefined,
  root: OpenApiDocument,
): JsonSchema | undefined {
  if (!schema || typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return schema;
  const resolved = schema.$ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      return isRecord(current) ? current[key] : undefined;
    }, root);
  return isRecord(resolved) ? (resolved as JsonSchema) : schema;
}

function mergedProperties(
  schema: JsonSchema,
  root: OpenApiDocument,
  seen = new Set<JsonSchema>(),
): Record<string, JsonSchema> {
  if (seen.has(schema)) return {};
  seen.add(schema);
  const resolved = resolveSchema(schema, root) ?? schema;
  const properties = isRecord(resolved.properties)
    ? (resolved.properties as Record<string, JsonSchema>)
    : {};
  const merged: Record<string, JsonSchema> = { ...properties };
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      if (isRecord(branch))
        Object.assign(merged, mergedProperties(branch as JsonSchema, root, seen));
    }
  }
  return merged;
}

function defaultSuccessStatus(route: MatchedRoute): number {
  const value = defaultStatus(route.operation.responses);
  const status = Number(value);
  return Number.isInteger(status) ? status : 200;
}

function asResponse(
  status: number,
  body: unknown,
  contentType = 'application/json; charset=utf-8',
): MockResponse {
  return { status, body, headers: { 'content-type': contentType }, source: 'state' };
}

function parseId(value: unknown): string {
  return String(value);
}

function cleanResponseFields(
  item: Record<string, unknown>,
  definition: ResourceCollection,
  root: OpenApiDocument,
): Record<string, unknown> {
  const properties = mergedProperties(definition.itemSchema, root);
  const output: Record<string, unknown> = { ...item };
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.writeOnly === true) delete output[name];
  }
  return output;
}

export class ResourceStore {
  readonly collections: ResourceCollection[];
  private readonly root: OpenApiDocument;
  private seed: number;
  private config: MocklineConfig;
  private readonly data = new Map<string, CollectionState>();
  private readonly routeIndex = new Map<
    string,
    { state: CollectionState; kind: 'list' | 'create' | 'item'; route: MatchedRoute }
  >();

  constructor(router: Router, root: OpenApiDocument, config: MocklineConfig) {
    this.root = root;
    this.config = config;
    this.seed = config.seed ?? 0;
    this.collections = detectCollections(router, root, config.stateful.idProperty);
    for (const definition of this.collections) {
      const state: CollectionState = { definition, items: [], nextNumericId: 1 };
      this.data.set(definition.path, state);
      this.routeIndex.set(`${definition.listRoute.method} ${definition.listRoute.path}`, {
        state,
        kind: 'list',
        route: definition.listRoute,
      });
      this.routeIndex.set(`${definition.createRoute.method} ${definition.createRoute.path}`, {
        state,
        kind: 'create',
        route: definition.createRoute,
      });
      for (const [method, route] of definition.itemRoutes) {
        this.routeIndex.set(`${method} ${route.path}`, { state, kind: 'item', route });
      }
    }
    this.reset();
  }

  setConfig(config: MocklineConfig): void {
    this.config = config;
    this.seed = config.seed ?? 0;
  }

  reset(): void {
    for (const state of this.data.values()) {
      state.items = [];
      if (!this.config.stateful.enabled) continue;
      state.nextNumericId = 1;
      for (let index = 0; index < this.config.stateful.seedItems; index += 1) {
        const seed = deriveSeed(this.seed, state.definition.path, index, 'initial');
        const generated = generateValue(state.definition.itemSchema, {
          root: this.root,
          seed,
          hints: this.config.generation.hints,
          maxDepth: this.config.generation.maxDepth,
          minArrayItems: this.config.generation.minArrayItems,
          maxArrayItems: this.config.generation.maxArrayItems,
          mode: 'response',
        });
        const item = isRecord(generated) ? { ...generated } : {};
        const assignedId = this.ensureId(item, state, seed, true);
        item[state.definition.idProperty] = assignedId;
        state.items.push(cleanResponseFields(item, state.definition, this.root));
      }
      const numericIds = state.items
        .map((item) => item[state.definition.idProperty])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (numericIds.length > 0) state.nextNumericId = Math.max(...numericIds) + 1;
    }
  }

  handle(
    route: MatchedRoute,
    params: Record<string, string>,
    url: URL,
    body: unknown,
  ): MockResponse | undefined {
    const match = this.routeIndex.get(`${route.method} ${route.path}`);
    if (!match) return undefined;
    const { state, kind } = match;
    const definition = state.definition;
    if (kind === 'list') {
      let items = state.items.map((item) => ({ ...item }));
      const offset = definition.offsetParam
        ? Math.max(0, Number(url.searchParams.get(definition.offsetParam) ?? 0) || 0)
        : 0;
      const limitRaw = definition.limitParam ? url.searchParams.get(definition.limitParam) : null;
      const limit = limitRaw === null ? undefined : Math.max(0, Number(limitRaw) || 0);
      items = items.slice(offset, limit === undefined ? undefined : offset + limit);
      return asResponse(defaultSuccessStatus(route), items);
    }
    if (kind === 'create') {
      let item: Record<string, unknown>;
      if (isRecord(body)) item = { ...body };
      else {
        const schema = definition.createSchema ?? definition.itemSchema;
        const generated = generateValue(schema, {
          root: this.root,
          seed: deriveSeed(this.seed, route.method, route.path, state.items.length, 'post'),
          hints: this.config.generation.hints,
          maxDepth: this.config.generation.maxDepth,
          minArrayItems: this.config.generation.minArrayItems,
          maxArrayItems: this.config.generation.maxArrayItems,
          mode: 'request',
        });
        item = isRecord(generated) ? { ...generated } : {};
      }
      const id = this.ensureId(
        item,
        state,
        deriveSeed(this.seed, route.path, state.items.length, 'create'),
        false,
      );
      item[definition.idProperty] = id;
      const saved = cleanResponseFields(item, definition, this.root);
      state.items.push(saved);
      return asResponse(defaultSuccessStatus(route), { ...saved });
    }

    const rawId = params[definition.idParam];
    const index = state.items.findIndex(
      (item) => parseId(item[definition.idProperty]) === String(rawId),
    );
    if (route.method === 'GET') {
      if (index < 0)
        return {
          status: 404,
          body: problem(
            404,
            'Not Found',
            `No resource with ${definition.idProperty} ${rawId} exists.`,
          ),
          headers: { 'content-type': 'application/problem+json' },
          source: 'state',
        };
      return asResponse(defaultSuccessStatus(route), { ...state.items[index] });
    }
    if (route.method === 'DELETE') {
      if (index < 0) return { status: 204, source: 'state' };
      state.items.splice(index, 1);
      return { status: 204, source: 'state' };
    }
    if (route.method === 'PUT' || route.method === 'PATCH') {
      if (index < 0)
        return {
          status: 404,
          body: problem(
            404,
            'Not Found',
            `No resource with ${definition.idProperty} ${rawId} exists.`,
          ),
          headers: { 'content-type': 'application/problem+json' },
          source: 'state',
        };
      const current = state.items[index] ?? {};
      const replacement = isRecord(body) ? { ...body } : {};
      const item = route.method === 'PATCH' ? { ...current, ...replacement } : replacement;
      item[definition.idProperty] = current[definition.idProperty] ?? rawId;
      state.items[index] = cleanResponseFields(item, definition, this.root);
      return asResponse(defaultSuccessStatus(route), { ...state.items[index] });
    }
    return undefined;
  }

  private ensureId(
    item: Record<string, unknown>,
    state: CollectionState,
    seed: number,
    seedItem: boolean,
  ): unknown {
    const definition = state.definition;
    const properties = mergedProperties(definition.itemSchema, this.root);
    const schema = properties[definition.idProperty] ?? { type: 'string' };
    const current = item[definition.idProperty];
    const duplicate =
      current !== undefined &&
      state.items.some((existing) => parseId(existing[definition.idProperty]) === parseId(current));
    const valid = current !== undefined && validateSchema(this.root, schema, current).valid;
    if (valid && !duplicate) return current;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let candidate: unknown;
      if (schema.type === 'integer' || schema.type === 'number') {
        candidate = state.nextNumericId++;
      } else {
        candidate = generateValue(schema, {
          root: this.root,
          seed: deriveSeed(seed, 'id', attempt),
          hints: false,
          maxDepth: 1,
          minArrayItems: 0,
          maxArrayItems: 0,
        });
        if (
          typeof candidate === 'string' &&
          !('format' in schema) &&
          !('pattern' in schema) &&
          !('enum' in schema) &&
          !('const' in schema)
        ) {
          candidate = seedItem ? candidate : `${candidate}-${state.items.length + 1}`;
        }
      }
      const alreadyUsed = state.items.some(
        (existing) => parseId(existing[definition.idProperty]) === parseId(candidate),
      );
      if (!alreadyUsed && validateSchema(this.root, schema, candidate).valid) return candidate;
    }
    return schema.type === 'integer' || schema.type === 'number'
      ? state.nextNumericId++
      : `${definition.path.replace(/\W/g, '')}-${state.items.length + 1}`;
  }
}
