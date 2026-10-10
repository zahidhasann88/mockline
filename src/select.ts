import { deriveSeed, SeededRandom } from './generate/rng.js';
import { generateFromSchema } from './generate/schema.js';
import { defaultStatus } from './spec/summary.js';
import { problem } from './errors.js';
import type {
  MocklineConfig,
  OverrideConfig,
  OverrideResponseConfig,
  ConditionInput,
} from './config/schema.js';
import type {
  ApiResponse,
  JsonSchema,
  MatchedRoute,
  MockResponse,
  OpenApiDocument,
  UnknownRecord,
} from './types.js';

export interface SelectionInput {
  root: OpenApiDocument;
  route: MatchedRoute;
  config: MocklineConfig;
  headers: Record<string, string | string[] | undefined>;
  url: URL;
  body: unknown;
  requestCounter?: number;
  sequenceIndexes?: ReadonlyMap<string, number>;
  stateResponse?: MockResponse;
}

export interface SelectionResult {
  response: MockResponse;
  warnings: string[];
  sequenceKey?: string;
}

interface ControlValues {
  status?: number;
  example?: string;
  delay?: number;
  forceError: boolean;
  active: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(headers: SelectionInput['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function parseControls(input: SelectionInput): ControlValues {
  const allow = input.config.controlHeaders.allow;
  if (!allow) return { forceError: false, active: false };
  const prefer = headerValue(input.headers, 'prefer') ?? '';
  const statusMatch = /(?:^|[,;]\s*)code\s*=\s*(\d{3})/i.exec(prefer);
  const exampleMatch = /(?:^|[,;]\s*)example\s*=\s*"?([^,;"\s]+)"?/i.exec(prefer);
  const headerStatus = Number(headerValue(input.headers, 'x-mockline-status'));
  const status =
    Number.isInteger(headerStatus) && headerStatus >= 100 && headerStatus <= 599
      ? headerStatus
      : statusMatch?.[1]
        ? Number(statusMatch[1])
        : undefined;
  const delayValue = Number(headerValue(input.headers, 'x-mockline-delay'));
  const delay = Number.isFinite(delayValue) && delayValue >= 0 ? delayValue : undefined;
  const forceError = /^(true|1|yes)$/i.test(headerValue(input.headers, 'x-mockline-error') ?? '');
  const example = exampleMatch?.[1];
  return {
    status,
    example,
    delay,
    forceError,
    active: status !== undefined || example !== undefined || forceError,
  };
}

function responseForStatus(
  responses: Record<string, ApiResponse> | undefined,
  requestedStatus?: number,
): { status: number; response?: ApiResponse } {
  const standardStatus = defaultStatus(responses);
  const status = requestedStatus ?? (standardStatus === 'default' ? 200 : Number(standardStatus));
  return {
    status,
    response:
      responses?.[String(status)] ??
      responses?.default ??
      (requestedStatus === undefined ? responses?.[standardStatus] : undefined),
  };
}

function jsonMediaType(media: string): boolean {
  const normalized = media.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/problem+json'
  );
}

function parseAccept(
  header: string | undefined,
): Array<{ value: string; q: number; index: number }> {
  if (!header || header.trim() === '') return [{ value: '*/*', q: 1, index: 0 }];
  return header
    .split(',')
    .map((part, index) => {
      const [value = '*/*', ...parameters] = part.trim().split(';');
      const qValue = parameters
        .find((parameter) => parameter.trim().startsWith('q='))
        ?.trim()
        .slice(2);
      const parsedQ = qValue === undefined ? 1 : Number(qValue);
      return {
        value: value.trim().toLowerCase(),
        q: Number.isFinite(parsedQ) ? parsedQ : 0,
        index,
      };
    })
    .filter((item) => item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
}

function mediaMatches(accept: string, media: string): boolean {
  const accepted = accept.split(';')[0]?.trim().toLowerCase() ?? '';
  const offered = media.split(';')[0]?.trim().toLowerCase() ?? '';
  if (accepted === '*/*' || accepted === offered) return true;
  const [acceptedType, acceptedSubtype] = accepted.split('/');
  const [offeredType, offeredSubtype] = offered.split('/');
  if (acceptedType === offeredType && acceptedSubtype === '*') return true;
  if (acceptedType === '*' && Boolean(acceptedSubtype)) return false;
  if (acceptedSubtype?.startsWith('*+'))
    return offeredSubtype?.endsWith(acceptedSubtype.slice(1)) ?? false;
  return false;
}

function negotiateMedia(
  content: Record<string, unknown>,
  accept: string | undefined,
): string | undefined {
  const available = Object.keys(content);
  if (available.length === 0) return undefined;
  const preferences = parseAccept(accept);
  for (const preference of preferences) {
    const compatible = available.filter((media) => mediaMatches(preference.value, media));
    if (compatible.length > 0) {
      return compatible.find(jsonMediaType) ?? compatible[0];
    }
  }
  return undefined;
}

function exampleValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) return value.value;
  return value;
}

function findExample(
  media: UnknownRecord,
  preferredName?: string,
): { found: boolean; value?: unknown } {
  const examples = isRecord(media.examples) ? media.examples : undefined;
  if (examples) {
    if (preferredName && preferredName in examples)
      return { found: true, value: exampleValue(examples[preferredName]) };
    const first = Object.values(examples)[0];
    if (first !== undefined) return { found: true, value: exampleValue(first) };
  }
  if ('example' in media) return { found: true, value: media.example };
  const schema = isRecord(media.schema) ? media.schema : undefined;
  if (schema) {
    if ('example' in schema) return { found: true, value: schema.example };
    if (Array.isArray(schema.examples) && schema.examples.length > 0)
      return { found: true, value: schema.examples[0] };
  }
  return { found: false };
}

function matchesCondition(condition: ConditionInput, input: SelectionInput): boolean {
  let actual: unknown;
  if (condition.location === 'query')
    actual = input.url.searchParams.get(condition.name) ?? undefined;
  else if (condition.location === 'header')
    actual = headerValue(input.headers, condition.name.toLowerCase());
  else {
    const path = condition.name.startsWith('/')
      ? condition.name.slice(1).split('/')
      : condition.name.split('.');
    actual = path.reduce<unknown>((current, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      return isRecord(current) ? current[key] : undefined;
    }, input.body);
  }
  const operation = condition.op ?? 'eq';
  if (operation === 'eq') return String(actual) === String(condition.value);
  if (operation === 'contains') {
    if (Array.isArray(actual))
      return actual.some((item) => String(item).includes(String(condition.value)));
    return typeof actual === 'string' && actual.includes(String(condition.value));
  }
  try {
    return typeof actual === 'string' && new RegExp(String(condition.value)).test(actual);
  } catch {
    return false;
  }
}

function overrideKey(input: SelectionInput): string | undefined {
  const entries = Object.entries(input.config.overrides);
  return (
    entries.find(([key]) => key === input.route.operationId)?.[0] ??
    entries.find(
      ([key]) => key.toUpperCase() === `${input.route.method} ${input.route.path}`.toUpperCase(),
    )?.[0]
  );
}

function selectOverride(
  override: OverrideConfig,
  key: string,
  input: SelectionInput,
): { value: OverrideResponseConfig; sequenceKey?: string } | undefined {
  if (override.rules?.length) {
    const matching = override.rules.find((rule) => matchesCondition(rule.when, input));
    if (matching) return { value: matching.response };
  }
  if (override.when && override.response && matchesCondition(override.when, input))
    return { value: override.response };
  if (override.sequence?.length) {
    const index = input.sequenceIndexes?.get(key) ?? 0;
    const selectedIndex = override.loop
      ? index % override.sequence.length
      : Math.min(index, override.sequence.length - 1);
    const selected = override.sequence[selectedIndex];
    if (selected) return { value: selected, sequenceKey: key };
  }
  if (!override.when && !override.rules?.length) {
    const fixed: OverrideResponseConfig = {};
    if (override.status !== undefined) fixed.status = override.status;
    if ('body' in override) fixed.body = override.body;
    if (override.headers) fixed.headers = override.headers;
    if (override.delay !== undefined) fixed.delay = override.delay;
    return { value: fixed };
  }
  return undefined;
}

function calculateDelay(
  config: MocklineConfig,
  overrideDelay: number | undefined,
  controlDelay: number | undefined,
  seed: number,
  requestCounter: number,
): number | undefined {
  if (controlDelay !== undefined) return controlDelay;
  if (overrideDelay !== undefined) return overrideDelay;
  const latency = config.latency;
  const rng = new SeededRandom(deriveSeed(seed, 'latency', requestCounter));
  if (typeof latency === 'number') return latency > 0 ? latency : undefined;
  if (Array.isArray(latency)) return rng.int(latency[0], latency[1]);
  if ('fixed' in latency && latency.fixed !== undefined)
    return latency.fixed > 0 ? latency.fixed : undefined;
  if ('min' in latency && latency.min !== undefined && latency.max !== undefined) {
    if (latency.distribution === 'normal') {
      const u1 = Math.max(rng.next(), Number.EPSILON);
      const u2 = rng.next();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const midpoint = (latency.min + latency.max) / 2;
      const spread = (latency.max - latency.min) / 6;
      return Math.max(latency.min, Math.min(latency.max, Math.round(midpoint + normal * spread)));
    }
    return rng.int(latency.min, latency.max);
  }
  return undefined;
}

function injectedFailure(
  status: number,
  seed: number,
  input: SelectionInput,
  force: boolean,
): MockResponse | undefined {
  const rate =
    input.config.errors.perOperationRates[input.route.operationId] ?? input.config.errors.rate;
  const rng = new SeededRandom(deriveSeed(seed, 'failure', input.requestCounter ?? 0));
  if (!force && rng.next() >= rate) return undefined;
  const failureStatus = force
    ? (input.config.errors.statuses[0] ?? 500)
    : (rng.pick(input.config.errors.statuses) ?? 500);
  return {
    status: failureStatus,
    body: problem(
      failureStatus,
      failureStatus >= 500 ? 'Mock upstream failure' : 'Mock error',
      'A failure was injected by Mockline.',
      { originalStatus: status },
    ),
    headers: { 'content-type': 'application/problem+json' },
    source: 'generated',
  };
}

function responseWithStatusAndMedia(
  input: SelectionInput,
  requestedStatus: number | undefined,
  exampleName: string | undefined,
  forceSelection: boolean,
  seed: number,
): { response: MockResponse; warnings: string[] } {
  const warnings: string[] = [];
  const responses = input.route.operation.responses;
  const selected = responseForStatus(responses, requestedStatus);
  const status = selected.status;
  const responseDefinition = selected.response;
  const content = responseDefinition?.content ?? {};
  const mediaType = negotiateMedia(content, headerValue(input.headers, 'accept'));
  if (Object.keys(content).length > 0 && mediaType === undefined) {
    return {
      response: {
        status: 406,
        body: problem(
          406,
          'Not Acceptable',
          'The requested Accept header does not match any response media type declared by this operation.',
        ),
        headers: { 'content-type': 'application/problem+json' },
        source: 'generated',
      },
      warnings,
    };
  }
  const media =
    mediaType && isRecord(content[mediaType]) ? (content[mediaType] as UnknownRecord) : undefined;
  const preferredExample = exampleName;
  const found = media ? findExample(media, preferredExample) : { found: false };
  const allowExample = input.config.prefer === 'example' || forceSelection || Boolean(exampleName);
  if (found.found && allowExample) {
    const exampleHeaders = mediaType ? { 'content-type': mediaType } : undefined;
    return {
      response: { status, body: found.value, headers: exampleHeaders, source: 'example' },
      warnings,
    };
  }
  if (!media) return { response: { status, source: 'generated' }, warnings };
  if (mediaType && !jsonMediaType(mediaType)) {
    if (found.found)
      return {
        response: {
          status,
          body: found.value,
          headers: { 'content-type': mediaType },
          source: 'example',
        },
        warnings,
      };
    const body = problem(
      501,
      'Not Implemented',
      `Mockline cannot synthesize ${mediaType} responses. Add an example to the OpenAPI document.`,
    );
    return {
      response: {
        status: 501,
        body,
        headers: { 'content-type': 'application/problem+json' },
        source: 'generated',
      },
      warnings,
    };
  }
  const schema = isRecord(media.schema) ? (media.schema as JsonSchema) : undefined;
  if (!schema)
    return {
      response: {
        status,
        headers: mediaType ? { 'content-type': mediaType } : undefined,
        source: 'generated',
      },
      warnings,
    };
  const generated = generateFromSchema(schema, {
    seed,
    root: input.root,
    hints: input.config.generation.hints,
    maxDepth: input.config.generation.maxDepth,
    minArrayItems: input.config.generation.minArrayItems,
    maxArrayItems: input.config.generation.maxArrayItems,
    mode: 'response',
  });
  warnings.push(...generated.warnings.map((warning) => warning.message));
  return {
    response: {
      status,
      body: generated.value,
      headers: mediaType ? { 'content-type': mediaType } : undefined,
      source: 'generated',
    },
    warnings,
  };
}

function applyAcceptNegotiation(input: SelectionInput, response: MockResponse): MockResponse {
  const responses = input.route.operation.responses;
  const definition = responses?.[String(response.status)] ?? responses?.default;
  const content = definition?.content;
  if (!content || Object.keys(content).length === 0 || response.status === 406) return response;
  const mediaType = negotiateMedia(content, headerValue(input.headers, 'accept'));
  if (!mediaType) {
    return {
      status: 406,
      body: problem(
        406,
        'Not Acceptable',
        'The requested Accept header does not match any response media type declared by this operation.',
      ),
      headers: { 'content-type': 'application/problem+json' },
      source: 'generated',
    };
  }
  return { ...response, headers: { ...response.headers, 'content-type': mediaType } };
}

export function selectResponse(input: SelectionInput): SelectionResult {
  const controls = parseControls(input);
  const baseSeed = input.config.seed ?? 0;
  const counter = input.config.generation.counter ? (input.requestCounter ?? 0) : 0;
  const seed = deriveSeed(baseSeed, input.route.method, input.route.path, counter);
  let response: MockResponse;
  let warnings: string[] = [];
  let sequenceKey: string | undefined;
  let overrideDelay: number | undefined;
  const controlSelection =
    controls.status !== undefined || controls.example !== undefined || controls.forceError;
  if (controlSelection) {
    const selected = responseWithStatusAndMedia(
      input,
      controls.status,
      controls.example,
      true,
      seed,
    );
    response = selected.response;
    warnings = selected.warnings;
  } else {
    const key = overrideKey(input);
    const override = key ? input.config.overrides[key] : undefined;
    const chosenOverride = override && key ? selectOverride(override, key, input) : undefined;
    if (chosenOverride) {
      const value = chosenOverride.value;
      sequenceKey = chosenOverride.sequenceKey;
      overrideDelay = value.delay;
      const operationStatus = defaultStatus(input.route.operation.responses);
      const fallbackStatus = operationStatus === 'default' ? 200 : Number(operationStatus);
      response = {
        status: value.status ?? fallbackStatus,
        ...(value.body !== undefined ? { body: value.body } : {}),
        ...(value.headers ? { headers: value.headers } : {}),
        ...(value.delay !== undefined ? { delay: value.delay } : {}),
        source: 'override',
      };
    } else if (input.stateResponse) {
      response = input.stateResponse;
    } else {
      const selected = responseWithStatusAndMedia(input, undefined, undefined, false, seed);
      response = selected.response;
      warnings = selected.warnings;
    }
  }
  const failure = injectedFailure(response.status, seed, input, controls.forceError);
  if (failure) response = failure;
  response = applyAcceptNegotiation(input, response);
  const delay = calculateDelay(
    input.config,
    overrideDelay ?? response.delay,
    controls.delay,
    seed,
    input.requestCounter ?? 0,
  );
  if (delay !== undefined) response = { ...response, delay };
  return { response, warnings, ...(sequenceKey ? { sequenceKey } : {}) };
}
