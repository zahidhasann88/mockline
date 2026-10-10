import type { ErrorObject } from 'ajv';
import { validateSchema } from './ajv.js';
import type { ApiParameter, ApiOperation, JsonSchema, MatchedRoute, OpenApiDocument, UnknownRecord } from './types.js';

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
  if (Array.isArray(schema.type)) return schema.type.find((item): item is string => typeof item === 'string' && item !== 'null') ?? 'string';
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

function coerceValue(raw: string | string[] | undefined, schema: JsonSchema, parameter?: ApiParameter): unknown {
  if (raw === undefined) return undefined;
  const type = schemaType(schema);
  if (type === 'array') {
    const items = isRecord(schema.items) ? schema.items as JsonSchema : {};
    if (Array.isArray(raw)) return raw.map((item) => coerceScalar(item, items));
    const style = parameter?.style ?? (parameter?.in === 'query' ? 'form' : 'simple');
    const explode = parameter?.explode ?? style === 'form';
    const separator = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    const values = explode && raw.includes(separator) && style !== 'form' ? raw.split(separator) : raw.includes(separator) && !explode ? raw.split(separator) : [raw];
    return values.map((item) => coerceScalar(item, items));
  }
  if (type === 'object') {
    if (typeof raw !== 'string') return raw;
    const value: Record<string, unknown> = {};
    const separator = parameter?.style === 'simple' ? ',' : '&';
    for (const pair of raw.split(separator)) {
      const [name, ...rest] = pair.split('=');
      if (name) value[name] = rest.join('=');
    }
    return value;
  }
  return typeof raw === 'string' ? coerceScalar(raw, schema) : raw.map((item) => coerceScalar(item, schema));
}

function parameterRawValue(parameter: ApiParameter, input: RequestValidationInput): string | string[] | undefined {
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
      copy[key] = child.filter((property) => typeof property !== 'string' || !isRecord(parentProperties[property]) || parentProperties[property]?.readOnly !== true);
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
  return expected === received || expected === 'application/*' && received.startsWith('application/') || expected === 'application/json' && received.endsWith('+json');
}

function validateParameters(input: RequestValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const parameter of input.route.parameters) {
    if (!parameter.schema) continue;
    const location = `${parameter.in}.${parameter.name}`;
    const raw = parameterRawValue(parameter, input);
    if (raw === undefined) {
      if (parameter.required) issues.push({ location, message: `${location}: required parameter is missing`, keyword: 'required' });
      continue;
    }
    const value = coerceValue(raw, parameter.schema, parameter);
    const validation = validateSchema(input.root, parameter.schema, value);
    issues.push(...validation.errors.map((error) => formatAjvIssue(error, location)));
  }
  return issues;
}

function requestBodySchema(operation: ApiOperation): { schema?: JsonSchema; contentTypes: string[]; required: boolean } {
  const body = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const content = isRecord(body?.content) ? body.content : {};
  const contentTypes = Object.keys(content);
  const media = contentTypes.find((key) => key === 'application/json' || key.endsWith('+json')) ?? contentTypes[0];
  const mediaObject = media && isRecord(content[media]) ? content[media] : undefined;
  return {
    schema: isRecord(mediaObject?.schema) ? mediaObject.schema as JsonSchema : undefined,
    contentTypes,
    required: body?.required === true,
  };
}

function validateBody(input: RequestValidationInput): { issues: ValidationIssue[]; bodyInvalid: boolean } {
  const issues: ValidationIssue[] = [];
  const details = requestBodySchema(input.route.operation);
  if (details.contentTypes.length === 0) return { issues, bodyInvalid: false };
  const contentType = headerValue(input.headers, 'content-type');
  if (input.bodyPresent && !contentType) {
    issues.push({ location: 'header.content-type', message: 'header.content-type: Content-Type is required for this operation', keyword: 'contentType' });
  }
  const selectedType = contentType && details.contentTypes.find((declared) => contentTypeMatches(declared, contentType));
  if (input.bodyPresent && contentType && !selectedType) {
    issues.push({ location: 'header.content-type', message: `header.content-type: expected ${details.contentTypes.join(' or ')}`, keyword: 'contentType' });
  }
  if (!input.bodyPresent) {
    if (details.required) issues.push({ location: 'body', message: 'body: required request body is missing', keyword: 'required' });
    return { issues, bodyInvalid: issues.length > 0 };
  }
  if (!selectedType || !details.schema) return { issues, bodyInvalid: issues.length > 0 };
  const root = requestRootWithoutReadOnly(input.root);
  const validation = validateSchema(root, details.schema, input.body);
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

export function checkSecurityPresence(
  root: OpenApiDocument,
  operation: ApiOperation,
  headers: RequestValidationInput['headers'],
  url: URL,
): { authorized: boolean; missing: string[] } {
  const requirements = operation.security ?? root.security ?? [];
  if (requirements.length === 0) return { authorized: true, missing: [] };
  const schemes = root.components?.securitySchemes ?? {};
  const missingAll: string[] = [];
  for (const requirement of requirements) {
    const missing: string[] = [];
    for (const name of Object.keys(requirement)) {
      const scheme = schemes[name];
      if (!isRecord(scheme)) {
        missing.push(name);
        continue;
      }
      const type = String(scheme.type ?? '');
      if (type === 'apiKey') {
        const location = String(scheme.in ?? '');
        const credentialName = String(scheme.name ?? '');
        const present = location === 'header'
          ? Boolean(headerValue(headers, credentialName))
          : location === 'query'
            ? url.searchParams.has(credentialName)
            : location === 'cookie'
              ? cookieValues(headerValue(headers, 'cookie')).has(credentialName)
              : false;
        if (!present) missing.push(`${name} (${location} ${credentialName})`);
      } else if (type === 'http' || type === 'oauth2' || type === 'openIdConnect' || type === 'mutualTLS') {
        if (!headerValue(headers, 'authorization')) missing.push(`${name} (Authorization)`);
      } else {
        missing.push(name);
      }
    }
    if (missing.length === 0) return { authorized: true, missing: [] };
    missingAll.push(...missing);
  }
  return { authorized: false, missing: [...new Set(missingAll)] };
}

export function strictValidationStatus(result: RequestValidationResult): number {
  return result.bodyInvalid ? 422 : 400;
}
