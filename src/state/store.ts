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
import type { StateData } from './file.js';
import type { Router } from '../router.js';

interface Scope {
  items: Record<string, unknown>[];
  nextNumericId: number;
}

interface CollectionState {
  definition: ResourceCollection;
  scopes: Map<string, Scope>;
  keyPattern: RegExp;
  parent?: CollectionState;
}

export interface ResourceStoreOptions {
  seedData?: StateData;
  initialData?: StateData;
  onChange?: (data: StateData) => void;
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

function notFound(definition: ResourceCollection, rawId: string | undefined): MockResponse {
  return {
    status: 404,
    body: problem(404, 'Not Found', `No resource with ${definition.idProperty} ${rawId} exists.`),
    headers: { 'content-type': 'application/problem+json' },
    source: 'state',
  };
}

function parseId(value: unknown): string {
  return String(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyPattern(path: string): RegExp {
  const pattern = path
    .split(/\{[^{}]+\}/)
    .map(escapeRegex)
    .join('[^/]+');
  return new RegExp(`^${pattern}$`);
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
  readonly warnings: string[] = [];
  private readonly root: OpenApiDocument;
  private seed: number;
  private config: MocklineConfig;
  private seedData: StateData;
  private readonly onChange: ((data: StateData) => void) | undefined;
  private readonly data = new Map<string, CollectionState>();
  private readonly routeIndex = new Map<
    string,
    { state: CollectionState; kind: 'list' | 'create' | 'item'; route: MatchedRoute }
  >();

  constructor(
    router: Router,
    root: OpenApiDocument,
    config: MocklineConfig,
    options: ResourceStoreOptions = {},
  ) {
    this.root = root;
    this.config = config;
    this.seed = config.seed ?? 0;
    this.seedData = options.seedData ?? {};
    this.onChange = options.onChange;
    this.collections = detectCollections(router, root, config.stateful.idProperty);
    for (const definition of this.collections) {
      const state: CollectionState = {
        definition,
        scopes: new Map(),
        keyPattern: keyPattern(definition.path),
      };
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
    this.linkParents();
    this.warnUnknownKeys(this.seedData);
    this.populate();
    if (options.initialData) {
      this.warnUnknownKeys(options.initialData);
      this.load(options.initialData);
    }
  }

  setConfig(config: MocklineConfig): void {
    this.config = config;
    this.seed = config.seed ?? 0;
  }

  setSeedData(seedData: StateData | undefined): void {
    this.seedData = seedData ?? {};
    this.warnings.length = 0;
    this.warnUnknownKeys(this.seedData);
  }

  reset(): void {
    this.populate();
    this.changed();
  }

  snapshot(): StateData {
    const output: StateData = {};
    for (const state of this.data.values()) {
      for (const [key, scope] of state.scopes)
        output[key] = scope.items.map((item) => ({ ...item }));
    }
    return output;
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
    const key = definition.path.replace(
      /\{([^{}]+)\}/g,
      (_whole, name: string) => params[name] ?? '',
    );
    const missing = this.missingParent(state, key);
    if (missing) return missing;
    const scope = this.scope(state, key, params);
    if (kind === 'list') {
      let items = scope.items.map((item) => ({ ...item }));
      for (const name of new Set(url.searchParams.keys())) {
        if (name === definition.limitParam || name === definition.offsetParam) continue;
        if (!definition.properties.includes(name)) continue;
        const wanted = url.searchParams.getAll(name);
        items = items.filter((item) => {
          const value = item[name];
          return (
            (typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean') &&
            wanted.includes(String(value))
          );
        });
      }
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
          seed: deriveSeed(this.seed, route.method, key, scope.items.length, 'post'),
          hints: this.config.generation.hints,
          locale: this.config.generation.locale,
          maxDepth: this.config.generation.maxDepth,
          minArrayItems: this.config.generation.minArrayItems,
          maxArrayItems: this.config.generation.maxArrayItems,
          mode: 'request',
        });
        item = isRecord(generated) ? { ...generated } : {};
      }
      this.applyParentParams(item, definition, params);
      const id = this.ensureId(
        item,
        definition,
        scope,
        deriveSeed(this.seed, key, scope.items.length, 'create'),
        false,
      );
      item[definition.idProperty] = id;
      const saved = cleanResponseFields(item, definition, this.root);
      scope.items.push(saved);
      this.changed();
      return asResponse(defaultSuccessStatus(route), { ...saved });
    }

    const rawId = params[definition.idParam];
    const index = scope.items.findIndex(
      (item) => parseId(item[definition.idProperty]) === String(rawId),
    );
    if (route.method === 'GET') {
      if (index < 0) return notFound(definition, rawId);
      return asResponse(defaultSuccessStatus(route), { ...scope.items[index] });
    }
    if (route.method === 'DELETE') {
      if (index >= 0) {
        scope.items.splice(index, 1);
        if (this.config.stateful.relations) this.removeChildren(`${key}/${rawId}`);
        this.changed();
      }
      return { status: 204, source: 'state' };
    }
    if (route.method === 'PUT' || route.method === 'PATCH') {
      if (index < 0) return notFound(definition, rawId);
      const current = scope.items[index] ?? {};
      const replacement = isRecord(body) ? { ...body } : {};
      const item = route.method === 'PATCH' ? { ...current, ...replacement } : replacement;
      this.applyParentParams(item, definition, params);
      item[definition.idProperty] = current[definition.idProperty] ?? rawId;
      scope.items[index] = cleanResponseFields(item, definition, this.root);
      this.changed();
      return asResponse(defaultSuccessStatus(route), { ...scope.items[index] });
    }
    return undefined;
  }

  private linkParents(): void {
    const shape = (path: string): string => path.replace(/\{[^{}]+\}/g, '{}');
    for (const state of this.data.values()) {
      const path = state.definition.path;
      const prefix = path.slice(0, path.lastIndexOf('/'));
      if (!prefix.endsWith('}')) continue;
      state.parent = [...this.data.values()].find(
        (candidate) =>
          candidate !== state && shape(`${candidate.definition.path}/{}`) === shape(prefix),
      );
    }
  }

  private missingParent(state: CollectionState, key: string): MockResponse | undefined {
    const parent = state.parent;
    if (!parent || !this.config.stateful.relations) return undefined;
    const itemPath = key.slice(0, key.lastIndexOf('/'));
    const parentKey = itemPath.slice(0, itemPath.lastIndexOf('/'));
    const parentId = itemPath.slice(itemPath.lastIndexOf('/') + 1);
    const missing = this.missingParent(parent, parentKey);
    if (missing) return missing;
    const exists = this.scope(parent, parentKey, {}).items.some(
      (item) => parseId(item[parent.definition.idProperty]) === parentId,
    );
    return exists ? undefined : notFound(parent.definition, parentId);
  }

  private removeChildren(itemPath: string): void {
    for (const state of this.data.values()) {
      for (const scopeKey of [...state.scopes.keys()]) {
        if (scopeKey.startsWith(`${itemPath}/`)) state.scopes.delete(scopeKey);
      }
    }
  }

  private changed(): void {
    this.onChange?.(this.snapshot());
  }

  private populate(): void {
    for (const state of this.data.values()) {
      state.scopes.clear();
      if (!this.config.stateful.enabled) continue;
      if (state.definition.parentParams.length === 0) this.scope(state, state.definition.path, {});
    }
  }

  private load(data: StateData): void {
    for (const [key, items] of Object.entries(data)) {
      const state = this.stateForKey(key);
      if (!state) continue;
      const scopeKey = key.startsWith('/') ? key : state.definition.path;
      const scope: Scope = { items: [], nextNumericId: 1 };
      state.scopes.set(scopeKey, scope);
      this.fillScope(state.definition, scope, items, scopeKey);
    }
  }

  private stateForKey(key: string): CollectionState | undefined {
    for (const state of this.data.values()) {
      const { definition } = state;
      if (
        key.startsWith('/') ? state.keyPattern.test(key) : definition.listRoute.operationId === key
      )
        return definition.parentParams.length === 0 || key.startsWith('/') ? state : undefined;
    }
    return undefined;
  }

  private warnUnknownKeys(data: StateData): void {
    for (const key of Object.keys(data)) {
      if (!this.stateForKey(key))
        this.warnings.push(`Data key ${key} does not match any stateful collection.`);
    }
  }

  private scope(state: CollectionState, key: string, params: Record<string, string>): Scope {
    const existing = state.scopes.get(key);
    if (existing) return existing;
    const scope: Scope = { items: [], nextNumericId: 1 };
    state.scopes.set(key, scope);
    const { definition } = state;
    const seeded =
      this.seedData[key] ??
      (definition.parentParams.length === 0
        ? this.seedData[definition.listRoute.operationId]
        : undefined);
    if (seeded) {
      this.fillScope(definition, scope, seeded, key);
      return scope;
    }
    for (let index = 0; index < this.config.stateful.seedItems; index += 1) {
      const seed = deriveSeed(this.seed, key, index, 'initial');
      const generated = generateValue(definition.itemSchema, {
        root: this.root,
        seed,
        hints: this.config.generation.hints,
        locale: this.config.generation.locale,
        maxDepth: this.config.generation.maxDepth,
        minArrayItems: this.config.generation.minArrayItems,
        maxArrayItems: this.config.generation.maxArrayItems,
        mode: 'response',
      });
      const item = isRecord(generated) ? { ...generated } : {};
      this.applyParentParams(item, definition, params);
      item[definition.idProperty] = this.ensureId(item, definition, scope, seed, true);
      scope.items.push(cleanResponseFields(item, definition, this.root));
    }
    this.updateNextId(definition, scope);
    return scope;
  }

  private fillScope(
    definition: ResourceCollection,
    scope: Scope,
    items: Record<string, unknown>[],
    key: string,
  ): void {
    for (const [index, source] of items.entries()) {
      const item = { ...source };
      item[definition.idProperty] = this.ensureId(
        item,
        definition,
        scope,
        deriveSeed(this.seed, key, index, 'initial'),
        true,
      );
      scope.items.push(item);
    }
    this.updateNextId(definition, scope);
  }

  private updateNextId(definition: ResourceCollection, scope: Scope): void {
    const numericIds = scope.items
      .map((item) => item[definition.idProperty])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (numericIds.length > 0) scope.nextNumericId = Math.max(...numericIds) + 1;
  }

  private applyParentParams(
    item: Record<string, unknown>,
    definition: ResourceCollection,
    params: Record<string, string>,
  ): void {
    if (definition.parentParams.length === 0) return;
    const properties = mergedProperties(definition.itemSchema, this.root);
    for (const name of definition.parentParams) {
      const schema = properties[name];
      const value = params[name];
      if (!schema || value === undefined) continue;
      const numeric = schema.type === 'integer' || schema.type === 'number';
      item[name] = numeric && Number.isFinite(Number(value)) ? Number(value) : value;
    }
  }

  private ensureId(
    item: Record<string, unknown>,
    definition: ResourceCollection,
    scope: Scope,
    seed: number,
    seedItem: boolean,
  ): unknown {
    const properties = mergedProperties(definition.itemSchema, this.root);
    const schema = properties[definition.idProperty] ?? { type: 'string' };
    const current = item[definition.idProperty];
    const duplicate =
      current !== undefined &&
      scope.items.some((existing) => parseId(existing[definition.idProperty]) === parseId(current));
    const valid = current !== undefined && validateSchema(this.root, schema, current).valid;
    if (valid && !duplicate) return current;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let candidate: unknown;
      if (schema.type === 'integer' || schema.type === 'number') {
        candidate = scope.nextNumericId++;
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
          candidate = seedItem ? candidate : `${candidate}-${scope.items.length + 1}`;
        }
      }
      const alreadyUsed = scope.items.some(
        (existing) => parseId(existing[definition.idProperty]) === parseId(candidate),
      );
      if (!alreadyUsed && validateSchema(this.root, schema, candidate).valid) return candidate;
    }
    return schema.type === 'integer' || schema.type === 'number'
      ? scope.nextNumericId++
      : `${definition.path.replace(/\W/g, '')}-${scope.items.length + 1}`;
  }
}
