import type { ApiOperation, ApiParameter, ApiPathItem, MatchedRoute, OpenApiDocument, UnknownRecord } from './types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface CompiledRoute extends MatchedRoute {
  regex: RegExp;
  parameterNames: string[];
  staticSegments: number;
}

export interface RouteMatch {
  route: MatchedRoute;
  params: Record<string, string>;
}

export interface Router {
  routes: MatchedRoute[];
  match(method: string, pathname: string): RouteMatch | undefined;
  methodsForPath(pathname: string): string[];
  nearestPath(pathname: string): string | undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePath(value: string): string {
  if (value === '' || value === '/') return '/';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, '');
  return trimmed || '/';
}

function replaceServerVariables(url: string, variables: Record<string, { default?: string }> | undefined): string {
  return url.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(variables?.[name]?.default ?? ''));
}

function serverPath(url: string, variables?: Record<string, { default?: string }>): string {
  const replaced = replaceServerVariables(url, variables);
  try {
    return normalizePath(new URL(replaced, 'http://mockline.local').pathname);
  } catch {
    return '/';
  }
}

function routeForPath(base: string, pathTemplate: string): string {
  const cleanBase = base === '/' ? '' : normalizePath(base);
  const cleanPath = normalizePath(pathTemplate);
  return normalizePath(`${cleanBase}${cleanPath === '/' ? '' : cleanPath}`);
}

function compilePath(template: string): { regex: RegExp; parameterNames: string[]; staticSegments: number; score: number } {
  const normalized = normalizePath(template);
  const parts = normalized.split('/').filter(Boolean);
  const names: string[] = [];
  let staticSegments = 0;
  const pattern = parts.map((part) => {
    const match = /^\{([^{}]+)\}$/.exec(part);
    if (match) {
      names.push(match[1] ?? '');
      return '([^/]+)';
    }
    staticSegments += 1;
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const regex = new RegExp(`^/${pattern}${parts.length === 0 ? '' : ''}/?$`);
  return { regex, parameterNames: names, staticSegments, score: staticSegments * 100 + parts.length };
}

function operationId(operation: ApiOperation, method: string, path: string): string {
  return typeof operation.operationId === 'string' && operation.operationId.length > 0
    ? operation.operationId
    : `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`;
}

function combineParameters(pathItem: ApiPathItem, operation: ApiOperation): ApiParameter[] {
  const merged = new Map<string, ApiParameter>();
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    if (parameter && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
      merged.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
    }
  }
  return [...merged.values()];
}

export function createRouter(document: OpenApiDocument): Router {
  const routes: CompiledRoute[] = [];
  const paths = document.paths ?? {};
  for (const [pathTemplate, pathItemUnknown] of Object.entries(paths)) {
    if (!isRecord(pathItemUnknown)) continue;
    const pathItem = pathItemUnknown as ApiPathItem;
    for (const method of HTTP_METHODS) {
      const operationUnknown = pathItemUnknown[method];
      if (!isRecord(operationUnknown)) continue;
      const operation = operationUnknown as ApiOperation;
      const operationServers = Array.isArray(operation.servers) ? operation.servers as Array<{ url: string; variables?: Record<string, { default?: string }> }> : undefined;
      const pathServers = Array.isArray(pathItem.servers) ? pathItem.servers as Array<{ url: string; variables?: Record<string, { default?: string }> }> : undefined;
      const servers = operationServers ?? pathServers ?? document.servers ?? [];
      const bases = servers.length > 0 ? servers.map((server) => serverPath(server.url, server.variables)) : ['/'];
      for (const base of bases) {
        const routePath = routeForPath(base, pathTemplate);
        const compiled = compilePath(routePath);
        routes.push({
          method: method.toUpperCase(),
          path: routePath,
          routePath,
          operationId: operationId(operation, method, routePath),
          operation,
          pathItem,
          parameters: combineParameters(pathItem, operation),
          score: compiled.score,
          regex: compiled.regex,
          parameterNames: compiled.parameterNames,
          staticSegments: compiled.staticSegments,
        });
      }
    }
  }
  routes.sort((a, b) => b.staticSegments - a.staticSegments || b.score - a.score || a.path.localeCompare(b.path));
  const publicRoutes = routes.map(({ regex: _regex, parameterNames: _parameterNames, staticSegments: _staticSegments, ...route }) => route);

  const matchesPath = (route: CompiledRoute, pathname: string): Record<string, string> | undefined => {
    const normalized = normalizePath(pathname);
    const match = route.regex.exec(normalized);
    if (!match) return undefined;
    const values: Record<string, string> = {};
    for (const [index, name] of route.parameterNames.entries()) {
      const encoded = match[index + 1];
      if (encoded === undefined) continue;
      try {
        values[name] = decodeURIComponent(encoded);
      } catch {
        return undefined;
      }
    }
    return values;
  };

  return {
    routes: publicRoutes,
    match(method, pathname) {
      const upper = method.toUpperCase();
      for (const route of routes) {
        if (route.method !== upper) continue;
        const params = matchesPath(route, pathname);
        if (params) {
          const { regex: _regex, parameterNames: _parameterNames, staticSegments: _staticSegments, ...publicRoute } = route;
          return { route: publicRoute, params };
        }
      }
      return undefined;
    },
    methodsForPath(pathname) {
      const methods = new Set<string>();
      for (const route of routes) if (matchesPath(route, pathname)) methods.add(route.method);
      return [...methods].sort();
    },
    nearestPath(pathname) {
      const normalized = normalizePath(pathname);
      let best: { route: CompiledRoute; distance: number } | undefined;
      for (const route of routes) {
        const routeParts = route.path.split('/').filter(Boolean);
        const actualParts = normalized.split('/').filter(Boolean);
        let common = 0;
        for (let i = 0; i < Math.min(routeParts.length, actualParts.length); i += 1) {
          if (routeParts[i] === actualParts[i] || /^\{[^{}]+\}$/.test(routeParts[i] ?? '')) common += 1;
          else break;
        }
        const distance = common * 10 - Math.abs(routeParts.length - actualParts.length);
        if (!best || distance > best.distance) best = { route, distance };
      }
      return best?.route.path;
    },
  };
}
