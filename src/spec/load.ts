import { readFile } from 'node:fs/promises';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import swagger2openapi from 'swagger2openapi';
import { parse as parseYaml } from 'yaml';
import { MocklineError } from '../errors.js';
import type { OpenApiDocument, UnknownRecord } from '../types.js';

export interface SpecWarning {
  message: string;
  operationId?: string;
  path?: string;
}

export interface LoadedSpec {
  file: string;
  document: OpenApiDocument;
  dereferenced: OpenApiDocument;
  warnings: SpecWarning[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationEntries(
  document: OpenApiDocument,
): Array<{ path: string; method: string; operation: UnknownRecord }> {
  const entries: Array<{ path: string; method: string; operation: UnknownRecord }> = [];
  const paths = document.paths ?? {};
  const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  for (const [routePath, pathItemUnknown] of Object.entries(paths)) {
    if (!isRecord(pathItemUnknown)) continue;
    for (const [method, operation] of Object.entries(pathItemUnknown)) {
      if (methods.has(method.toLowerCase()) && isRecord(operation)) {
        entries.push({ path: routePath, method: method.toUpperCase(), operation });
      }
    }
  }
  return entries;
}

function getResponseDetails(operation: UnknownRecord): { hasExample: boolean; hasSchema: boolean } {
  const responses = isRecord(operation.responses) ? operation.responses : {};
  let hasExample = false;
  let hasSchema = false;
  for (const responseUnknown of Object.values(responses)) {
    if (!isRecord(responseUnknown) || !isRecord(responseUnknown.content)) continue;
    for (const mediaUnknown of Object.values(responseUnknown.content)) {
      if (!isRecord(mediaUnknown)) continue;
      if (
        'example' in mediaUnknown ||
        (isRecord(mediaUnknown.examples) && Object.keys(mediaUnknown.examples).length > 0)
      ) {
        hasExample = true;
      }
      if (isRecord(mediaUnknown.schema)) hasSchema = true;
    }
  }
  return { hasExample, hasSchema };
}

export function inspectSpec(document: OpenApiDocument): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  for (const entry of operationEntries(document)) {
    const { hasExample, hasSchema } = getResponseDetails(entry.operation);
    const responses = isRecord(entry.operation.responses) ? entry.operation.responses : {};
    for (const response of Object.values(responses)) {
      if (!isRecord(response) || !isRecord(response.content)) continue;
      for (const [mediaType, media] of Object.entries(response.content)) {
        if (!isRecord(media)) continue;
        const json = mediaType.toLowerCase().includes('json');
        const schema = isRecord(media.schema) ? media.schema : undefined;
        const hasMediaExample =
          'example' in media ||
          (isRecord(media.examples) && Object.keys(media.examples).length > 0) ||
          Boolean(
            schema &&
            ('example' in schema || (Array.isArray(schema.examples) && schema.examples.length > 0)),
          );
        if (!json && !hasMediaExample)
          warnings.push({
            message: `Mockline cannot generate ${mediaType} responses; add an example.`,
            path: entry.path,
          });
      }
    }
    if (!hasExample && !hasSchema) {
      warnings.push({
        message: 'No response schema or example; Mockline can only return an empty/default body.',
        operationId:
          typeof entry.operation.operationId === 'string' ? entry.operation.operationId : undefined,
        path: entry.path,
      });
    }
    if (entry.operation.links)
      warnings.push({
        message: 'Response links are ignored by the mock server.',
        path: entry.path,
      });
  }
  return warnings;
}

export async function loadSpec(file: string): Promise<LoadedSpec> {
  const absoluteFile = path.resolve(file);
  let text: string;
  try {
    text = await readFile(absoluteFile, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Cannot read OpenAPI spec ${file}: ${reason}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = /\.json$/i.test(absoluteFile) ? (JSON.parse(text) as unknown) : parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Cannot parse OpenAPI spec ${file}: ${reason}`, 1);
  }
  if (!isRecord(parsed))
    throw new MocklineError('OpenAPI document must be a YAML or JSON object.', 1);
  const converted = 'swagger' in parsed;
  if (converted) {
    if (parsed.swagger !== '2.0')
      throw new MocklineError('Only Swagger 2.0 and OpenAPI 3.x documents are supported.', 1);
    try {
      parsed = (await swagger2openapi.convertObj(parsed, { patch: true, warnOnly: true })).openapi;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MocklineError(`Cannot convert Swagger 2.0 spec ${file}: ${reason}`, 1, error);
    }
  }
  if (!isRecord(parsed) || typeof parsed.openapi !== 'string' || !parsed.openapi.startsWith('3.')) {
    throw new MocklineError('Only OpenAPI 3.0 and 3.1 documents are supported.', 1);
  }

  let dereferenced: OpenApiDocument;
  try {
    const parser = new SwaggerParser();
    dereferenced = (await parser.validate(absoluteFile, parsed as never, {
      dereference: { circular: 'ignore' },
    })) as unknown as OpenApiDocument;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Invalid OpenAPI spec ${file}: ${reason}`, 1, error);
  }
  const document = dereferenced;
  const warnings = inspectSpec(document);
  if (converted) warnings.unshift({ message: 'Converted from Swagger 2.0 to OpenAPI 3.0.' });
  return { file: absoluteFile, document, dereferenced, warnings };
}
