import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ErrorObject } from 'ajv';
import { validateSchema } from './ajv.js';
import type {
  ApiParameter,
  ApiOperation,
  JsonSchema,
  MatchedRoute,
  OpenApiDocument,
  UnknownRecord,
} from './types.js';

export interface ValidationIssue {
  location: string;
  message: string;
  keyword?: string;
}

export interface RequestValidationInput {
  root: OpenApiDocument;
  route: MatchedRoute;
  params: Record<string, string>;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  bodyPresent: boolean;
}

export interface RequestValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  bodyInvalid: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(headers: RequestValidationInput['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function cookieValues(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name) result.set(name, decodeURIComponentSafe(value));
  }
  return result;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.type))
    return (
      schema.type.find((item): item is string => typeof item === 'string' && item !== 'null') ??
      'string'
    );
  return typeof schema.type === 'string' ? schema.type : 'string';
}

function coerceScalar(value: string, schema: JsonSchema): unknown {
  const type = schemaType(schema);
  if (type === 'integer') {
    if (!/^[+-]?\d+$/.test(value.trim())) return value;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (type === 'number') {
    if (value.trim() === '') return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === 'boolean') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  if (type === 'null' && value === 'null') return null;
  return value;
}

function coerceTyped(value: unknown, schema: JsonSchema): unknown {
  const type = schemaType(schema);
  if (type === 'array' && Array.isArray(value)) {
    const items = isRecord(schema.items) ? (schema.items as JsonSchema) : {};
    return value.map((item) => coerceTyped(item, items));
  }
  if (type === 'object' && isRecord(value)) {
    const properties = isRecord(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        properties[name] ? coerceTyped(item, properties[name]) : item,
      ]),
    );
  }
  return typeof value === 'string' ? coerceScalar(value, schema) : value;
}

function coerceValue(
  raw: string | string[] | undefined,
  schema: JsonSchema,
  parameter?: ApiParameter,
): unknown {
  if (raw === undefined) return undefined;
  const type = schemaType(schema);
  if (type === 'array') {
    const items = isRecord(schema.items) ? (schema.items as JsonSchema) : {};
    const style = parameter?.style ?? (parameter?.in === 'query' ? 'form' : 'simple');
    const explode = parameter?.explode ?? style === 'form';
    const separator = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    const values = Array.isArray(raw)
      ? raw
      : raw.includes(separator) && !explode
        ? raw.split(separator)
        : [raw];
    return values.map((item) => coerceTyped(item, items));
  }
  if (type === 'object') {
    let value: Record<string, unknown>;
    if (Array.isArray(raw)) return raw;
    if (raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        value = isRecord(parsed) ? parsed : {};
      } catch {
        value = {};
      }
    } else {
      value = {};
      const separator = parameter?.style === 'simple' ? ',' : '&';
      for (const pair of raw.split(separator)) {
        const [name, ...rest] = pair.split('=');
        if (name) value[name] = rest.join('=');
      }
    }
    return coerceTyped(value, schema);
  }
  return typeof raw === 'string'
    ? coerceScalar(raw, schema)
    : raw.map((item) => coerceScalar(item, schema));
}

function parameterRawValue(
  parameter: ApiParameter,
  input: RequestValidationInput,
): string | string[] | undefined {
  if (parameter.in === 'path') return input.params[parameter.name];
  if (parameter.in === 'query') {
    const values = input.url.searchParams.getAll(parameter.name);
    if (values.length > 1) return values;
    if (values.length === 1) return values[0];
    if (parameter.style === 'deepObject') {
      const object: Record<string, string> = {};
      for (const [key, value] of input.url.searchParams.entries()) {
        const match = new RegExp(`^${escapeRegExp(parameter.name)}\\[([^\\]]+)\\]$`).exec(key);
        if (match?.[1]) object[match[1]] = value;
      }
      if (Object.keys(object).length > 0) return JSON.stringify(object);
    }
    if (schemaType(parameter.schema ?? {}) === 'object' && parameter.explode !== false) {
      const properties = isRecord(parameter.schema?.properties) ? parameter.schema.properties : {};
      const object: Record<string, string> = {};
      for (const name of Object.keys(properties)) {
        const value = input.url.searchParams.get(name);
        if (value !== null) object[name] = value;
      }
      if (Object.keys(object).length > 0) return JSON.stringify(object);
    }
    return undefined;
  }
  if (parameter.in === 'header') return headerValue(input.headers, parameter.name);
  return cookieValues(headerValue(input.headers, 'cookie')).get(parameter.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatAjvIssue(issue: ErrorObject, location: string): ValidationIssue {
  const pointer = issue.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('/');
  const at = pointer ? `${location}/${pointer}` : location;
  const suffix = issue.message ? `: ${issue.message}` : '';
  return { location: at, message: `${at}${suffix}`, keyword: issue.keyword };
}

function stripReadOnly(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (Array.isArray(value)) return value.map((item) => stripReadOnly(item, seen));
  if (!isRecord(value)) return value;
  const known = seen.get(value);
  if (known) return known;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties' && isRecord(child)) {
      const properties: Record<string, unknown> = {};
      for (const [property, propertySchema] of Object.entries(child)) {
        if (isRecord(propertySchema) && propertySchema.readOnly === true) continue;
        properties[property] = stripReadOnly(propertySchema, seen);
      }
      copy[key] = properties;
    } else if (key === 'required' && Array.isArray(child)) {
      const parentProperties = isRecord(value.properties) ? value.properties : {};
      copy[key] = child.filter(
        (property) =>
          typeof property !== 'string' ||
          !isRecord(parentProperties[property]) ||
          parentProperties[property]?.readOnly !== true,
      );
    } else {
      copy[key] = stripReadOnly(child, seen);
    }
  }
  return copy;
}

function requestRootWithoutReadOnly(root: OpenApiDocument): OpenApiDocument {
  return stripReadOnly(root) as OpenApiDocument;
}

function contentTypeMatches(declared: string, actual: string): boolean {
  const expected = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  const received = actual.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    expected === received ||
    (expected === 'application/*' && received.startsWith('application/')) ||
    (expected === 'application/json' && received.endsWith('+json'))
  );
}

function validateParameters(input: RequestValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const parameter of input.route.parameters) {
    if (!parameter.schema) continue;
    const location = `${parameter.in}.${parameter.name}`;
    const raw = parameterRawValue(parameter, input);
    if (raw === undefined) {
      if (parameter.required)
        issues.push({
          location,
          message: `${location}: required parameter is missing`,
          keyword: 'required',
        });
      continue;
    }
    const value = coerceValue(raw, parameter.schema, parameter);
    const validation = validateSchema(input.root, parameter.schema, value);
    issues.push(...validation.errors.map((error) => formatAjvIssue(error, location)));
  }
  return issues;
}

function requestBodyContent(operation: ApiOperation): {
  content: Record<string, unknown>;
  contentTypes: string[];
  required: boolean;
} {
  const body = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const content = isRecord(body?.content) ? body.content : {};
  return { content, contentTypes: Object.keys(content), required: body?.required === true };
}

function validateBody(input: RequestValidationInput): {
  issues: ValidationIssue[];
  bodyInvalid: boolean;
} {
  const issues: ValidationIssue[] = [];
  const details = requestBodyContent(input.route.operation);
  if (details.contentTypes.length === 0) return { issues, bodyInvalid: false };
  const contentType = headerValue(input.headers, 'content-type');
  if (input.bodyPresent && !contentType) {
    issues.push({
      location: 'header.content-type',
      message: 'header.content-type: Content-Type is required for this operation',
      keyword: 'contentType',
    });
  }
  const selectedType =
    contentType &&
    details.contentTypes.find((declared) => contentTypeMatches(declared, contentType));
  if (input.bodyPresent && contentType && !selectedType) {
    issues.push({
      location: 'header.content-type',
      message: `header.content-type: expected ${details.contentTypes.join(' or ')}`,
      keyword: 'contentType',
    });
  }
  if (!input.bodyPresent) {
    if (details.required)
      issues.push({
        location: 'body',
        message: 'body: required request body is missing',
        keyword: 'required',
      });
    return { issues, bodyInvalid: issues.length > 0 };
  }
  const mediaObject =
    selectedType && isRecord(details.content[selectedType])
      ? details.content[selectedType]
      : undefined;
  const bodySchema = isRecord(mediaObject?.schema) ? (mediaObject.schema as JsonSchema) : undefined;
  if (!selectedType || !bodySchema) return { issues, bodyInvalid: issues.length > 0 };
  const root = requestRootWithoutReadOnly(input.root);
  const validation = validateSchema(root, stripReadOnly(bodySchema) as JsonSchema, input.body);
  issues.push(...validation.errors.map((error) => formatAjvIssue(error, '/body')));
  return { issues, bodyInvalid: !validation.valid || issues.length > 0 };
}

export function validateRequest(input: RequestValidationInput): RequestValidationResult {
  const parameterIssues = validateParameters(input);
  const bodyResult = validateBody(input);
  return {
    valid: parameterIssues.length === 0 && bodyResult.issues.length === 0,
    issues: [...parameterIssues, ...bodyResult.issues],
    bodyInvalid: bodyResult.bodyInvalid,
  };
}

export interface AuthSettings {
  apiKeys: string[];
  bearerTokens: string[];
  basic: Array<{ username: string; password: string }>;
  jwtSecret?: string;
}

export interface SecurityResult {
  authorized: boolean;
  status: 401 | 403;
  missing: string[];
}

const NO_AUTH: AuthSettings = { apiKeys: [], bearerTokens: [], basic: [] };
const JWT_ALGORITHMS: Record<string, string> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeJsonPart(part: string): UnknownRecord | undefined {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function verifyJwt(
  token: string,
  secret: string,
  now: number,
): { claims?: UnknownRecord; error?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'token is not a JWT' };
  const [headerPart = '', payloadPart = '', signature = ''] = parts;
  const header = decodeJsonPart(headerPart);
  const algorithm = JWT_ALGORITHMS[String(header?.alg)];
  if (!algorithm) return { error: 'JWT must be signed with HS256, HS384 or HS512' };
  const expected = createHmac(algorithm, secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return { error: 'JWT signature is invalid' };
  const claims = decodeJsonPart(payloadPart);
  if (!claims) return { error: 'JWT payload is invalid' };
  const seconds = now / 1000;
  if (typeof claims.exp === 'number' && claims.exp <= seconds) return { error: 'JWT has expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > seconds)
    return { error: 'JWT is not valid yet' };
  return { claims };
}

function tokenScopes(claims: UnknownRecord): string[] {
  for (const key of ['scope', 'scp', 'scopes']) {
    const value = claims[key];
    if (typeof value === 'string') return value.split(' ').filter(Boolean);
    if (Array.isArray(value)) return value.map(String);
  }
  return [];
}

function bearerToken(headers: RequestValidationInput['headers']): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(headerValue(headers, 'authorization') ?? '');
  return match?.[1]?.trim();
}

function checkBearer(
  name: string,
  headers: RequestValidationInput['headers'],
  auth: AuthSettings,
  scopes: string[],
  now: number,
): { problem?: string; forbidden?: boolean } {
  if (auth.bearerTokens.length === 0 && !auth.jwtSecret)
    return headerValue(headers, 'authorization') === undefined
      ? { problem: `${name} (Authorization)` }
      : {};
  const token = bearerToken(headers);
  if (!token) return { problem: `${name} (Authorization: Bearer token)` };
  if (auth.bearerTokens.some((known) => safeEqual(known, token))) return {};
  if (!auth.jwtSecret) return { problem: `${name} (unknown bearer token)` };
  const result = verifyJwt(token, auth.jwtSecret, now);
  if (!result.claims) return { problem: `${name} (${result.error})` };
  const granted = tokenScopes(result.claims);
  const missingScopes = scopes.filter((scope) => !granted.includes(scope));
  if (missingScopes.length > 0)
    return { problem: `${name} (missing scope ${missingScopes.join(', ')})`, forbidden: true };
  return {};
}

function checkBasic(
  name: string,
  headers: RequestValidationInput['headers'],
  auth: AuthSettings,
): string | undefined {
  const header = headerValue(headers, 'authorization');
  if (auth.basic.length === 0) return header === undefined ? `${name} (Authorization)` : undefined;
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return `${name} (Authorization: Basic credentials)`;
  const decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const valid =
    separator >= 0 &&
    auth.basic.some(
      (entry) => safeEqual(entry.username, username) && safeEqual(entry.password, password),
    );
  return valid ? undefined : `${name} (invalid username or password)`;
}

export function checkSecurity(
  root: OpenApiDocument,
  operation: ApiOperation,
  headers: RequestValidationInput['headers'],
  url: URL,
  auth: AuthSettings = NO_AUTH,
  now: number = Date.now(),
): SecurityResult {
  const requirements = operation.security ?? root.security ?? [];
  if (requirements.length === 0) return { authorized: true, status: 401, missing: [] };
  const schemes = root.components?.securitySchemes ?? {};
  const missingAll: string[] = [];
  let forbidden = false;
  for (const requirement of requirements) {
    const missing: string[] = [];
    let requirementForbidden = false;
    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = schemes[name];
      if (!isRecord(scheme)) {
        missing.push(name);
        continue;
      }
      const type = String(scheme.type ?? '');
      if (type === 'apiKey') {
        const location = String(scheme.in ?? '');
        const credentialName = String(scheme.name ?? '');
        const value =
          location === 'header'
            ? headerValue(headers, credentialName)
            : location === 'query'
              ? (url.searchParams.get(credentialName) ?? undefined)
              : location === 'cookie'
                ? cookieValues(headerValue(headers, 'cookie')).get(credentialName)
                : undefined;
        if (value === undefined) missing.push(`${name} (${location} ${credentialName})`);
        else if (auth.apiKeys.length > 0 && !auth.apiKeys.some((known) => safeEqual(known, value)))
          missing.push(`${name} (invalid API key)`);
      } else if (type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'basic') {
        const problem = checkBasic(name, headers, auth);
        if (problem) missing.push(problem);
      } else if (
        (type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'bearer') ||
        type === 'oauth2' ||
        type === 'openIdConnect'
      ) {
        const result = checkBearer(name, headers, auth, Array.isArray(scopes) ? scopes : [], now);
        if (result.problem) missing.push(result.problem);
        if (result.forbidden) requirementForbidden = true;
      } else if (type === 'http' || type === 'mutualTLS') {
        if (headerValue(headers, 'authorization') === undefined)
          missing.push(`${name} (Authorization)`);
      } else {
        missing.push(name);
      }
    }
    if (missing.length === 0) return { authorized: true, status: 401, missing: [] };
    if (requirementForbidden && missing.every((entry) => entry.includes('missing scope')))
      forbidden = true;
    missingAll.push(...missing);
  }
  return { authorized: false, status: forbidden ? 403 : 401, missing: [...new Set(missingAll)] };
}

export function checkSecurityPresence(
  root: OpenApiDocument,
  operation: ApiOperation,
  headers: RequestValidationInput['headers'],
  url: URL,
): { authorized: boolean; missing: string[] } {
  const { authorized, missing } = checkSecurity(root, operation, headers, url);
  return { authorized, missing };
}

export function strictValidationStatus(result: RequestValidationResult): number {
  return result.bodyInvalid ? 422 : 400;
}
