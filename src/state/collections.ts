import { defaultStatus } from '../spec/summary.js';
import type { ApiOperation, ApiResponse, JsonSchema, MatchedRoute, OpenApiDocument, UnknownRecord } from '../types.js';
import type { Router } from '../router.js';

export interface ResourceCollection {
  path: string;
  idParam: string;
  idProperty: string;
  listRoute: MatchedRoute;
  createRoute: MatchedRoute;
  itemRoutes: Map<string, MatchedRoute>;
  itemSchema: JsonSchema;
  createSchema?: JsonSchema;
  limitParam?: string;
  offsetParam?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseSchema(operation: ApiOperation): JsonSchema | undefined {
  const responses = operation.responses;
  if (!responses) return undefined;
  const status = defaultStatus(responses);
  const response: ApiResponse | undefined = responses[status] ?? responses.default;
  const content = response?.content;
  if (!content) return undefined;
  const media = content['application/json'] ?? Object.entries(content).find(([type]) => type.endsWith('+json'))?.[1];
  return media?.schema;
}

function resolveSchema(schema: JsonSchema | undefined, root: OpenApiDocument): JsonSchema | undefined {
  if (!schema || typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return schema;
  const resolved = schema.$ref.slice(2).split('/').reduce<unknown>((current, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return isRecord(current) ? current[key] : undefined;
  }, root);
  return isRecord(resolved) ? resolved as JsonSchema : schema;
}

function schemaProperties(schema: JsonSchema | undefined, root: OpenApiDocument, seen = new Set<JsonSchema>()): Record<string, JsonSchema> {
  if (!schema || seen.has(schema)) return {};
  seen.add(schema);
  const resolved = resolveSchema(schema, root) ?? schema;
  const output: Record<string, JsonSchema> = isRecord(resolved.properties) ? { ...(resolved.properties as Record<string, JsonSchema>) } : {};
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      if (isRecord(branch)) Object.assign(output, schemaProperties(branch as JsonSchema, root, seen));
    }
  }
  return output;
}

function schemaFingerprint(schema: JsonSchema | undefined, root: OpenApiDocument): string | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return `ref:${schema.$ref}`;
  return JSON.stringify(resolveSchema(schema, root));
}

function listItemSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.type === 'array' && isRecord(schema.items)) return schema.items as JsonSchema;
  if (Array.isArray(schema.type) && schema.type.includes('array') && isRecord(schema.items)) return schema.items as JsonSchema;
  return undefined;
}

function requestBodySchema(operation: ApiOperation): JsonSchema | undefined {
  const body = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const content = isRecord(body?.content) ? body.content : {};
  const media = isRecord(content['application/json'])
    ? content['application/json']
    : Object.entries(content).find(([type]) => type.endsWith('+json'))?.[1];
  return isRecord(media) && isRecord(media.schema) ? media.schema as JsonSchema : undefined;
}

function pathId(path: string, collectionPath: string): string | undefined {
  if (!path.startsWith(`${collectionPath}/`)) return undefined;
  const tail = path.slice(collectionPath.length + 1);
  const match = /^\{([^{}]+)\}$/.exec(tail);
  return match?.[1];
}

function declaredQueryName(route: MatchedRoute, name: string): string | undefined {
  return route.parameters.some((parameter) => parameter.in === 'query' && parameter.name === name) ? name : undefined;
}

export function detectCollections(router: Router, root: OpenApiDocument, idProperty = 'id'): ResourceCollection[] {
  const collections: ResourceCollection[] = [];
  const listRoutes = router.routes.filter((route) => route.method === 'GET' && !route.path.includes('{'));
  for (const listRoute of listRoutes) {
    const createRoute = router.routes.find((route) => route.method === 'POST' && route.path === listRoute.path);
    if (!createRoute) continue;
    const listItem = listItemSchema(responseSchema(listRoute.operation));
    if (!listItem) continue;
    const itemCandidates = router.routes.filter((route) => pathId(route.path, listRoute.path) !== undefined);
    const getItem = itemCandidates.find((route) => route.method === 'GET');
    if (!getItem) continue;
    const getSchema = responseSchema(getItem.operation);
    if (!getSchema || schemaFingerprint(listItem, root) !== schemaFingerprint(getSchema, root)) continue;
    const properties = schemaProperties(listItem, root);
    const idSchema = isRecord(properties[idProperty]) ? properties[idProperty] as JsonSchema : undefined;
    if (!idSchema) continue;
    const itemRoutes = new Map<string, MatchedRoute>();
    for (const route of itemCandidates) {
      const routeIdParam = pathId(route.path, listRoute.path);
      if (routeIdParam && routeIdParam === pathId(getItem.path, listRoute.path)) itemRoutes.set(route.method, route);
    }
    collections.push({
      path: listRoute.path,
      idParam: pathId(getItem.path, listRoute.path) ?? idProperty,
      idProperty,
      listRoute,
      createRoute,
      itemRoutes,
      itemSchema: listItem,
      ...(requestBodySchema(createRoute.operation) ? { createSchema: requestBodySchema(createRoute.operation) } : {}),
      ...(declaredQueryName(listRoute, 'limit') ? { limitParam: 'limit' } : {}),
      ...(declaredQueryName(listRoute, 'offset') ? { offsetParam: 'offset' } : {}),
    });
  }
  return collections;
}
