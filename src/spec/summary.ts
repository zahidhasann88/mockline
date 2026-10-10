import type { LoadedSpec } from './load.js';
import { createRouter } from '../router.js';
import type { ApiResponse, SummaryOperation } from '../types.js';

export function defaultStatus(responses: Record<string, ApiResponse> | undefined): string {
  if (!responses || Object.keys(responses).length === 0) return '200';
  const success = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort((a, b) => Number(a) - Number(b));
  if (success[0]) return success[0];
  if (responses.default) return 'default';
  return '200';
}

function hasExample(response: ApiResponse | undefined): boolean {
  if (!response?.content) return false;
  return Object.values(response.content).some(
    (media) =>
      'example' in media ||
      Boolean(media.examples && Object.keys(media.examples).length > 0) ||
      Boolean(
        media.schema &&
        ('example' in media.schema ||
          (Array.isArray(media.schema.examples) && media.schema.examples.length > 0)),
      ),
  );
}

export function summarizeSpec(spec: LoadedSpec, overrideKeys: string[] = []): SummaryOperation[] {
  const router = createRouter(spec.document);
  return router.routes.map((route) => {
    const responses = route.operation.responses;
    const status = defaultStatus(responses);
    const response = responses?.[status] ?? responses?.default;
    const override = overrideKeys.some(
      (key) =>
        key === route.operationId ||
        key.toUpperCase() === `${route.method} ${route.path}`.toUpperCase(),
    );
    const source: SummaryOperation['source'] = override
      ? 'override'
      : hasExample(response)
        ? 'example'
        : 'schema generation';
    return {
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      defaultStatus: status,
      source,
    };
  });
}
