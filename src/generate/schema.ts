import type { Faker } from '@faker-js/faker';
import { validateSchema } from '../ajv.js';
import type { JsonSchema, OpenApiDocument, UnknownRecord } from '../types.js';
import { createFaker, hintedValue, type GenerationHints } from './hints.js';
import { deriveSeed, SeededRandom } from './rng.js';

export interface GenerationOptions {
  seed?: number;
  root?: OpenApiDocument;
  maxDepth?: number;
  minArrayItems?: number;
  maxArrayItems?: number;
  hints?: boolean | GenerationHints;
  mode?: 'response' | 'request';
}

export interface GeneratorWarning {
  message: string;
}

export interface GenerationResult {
  value: unknown;
  warnings: GeneratorWarning[];
}

interface Context {
  root: OpenApiDocument;
  rng: SeededRandom;
  faker: Faker;
  maxDepth: number;
  minArrayItems: number;
  maxArrayItems: number;
  hints: boolean | GenerationHints;
  mode: 'response' | 'request';
  warnings: GeneratorWarning[];
  refTrail: Set<string>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  return pointer
    .slice(2)
    .split('/')
    .reduce<unknown>((current, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(current)) return current[Number(key)];
      if (isRecord(current)) return current[key];
      return undefined;
    }, root);
}

function resolveSchema(schema: JsonSchema, context: Context): JsonSchema {
  if (typeof schema.$ref !== 'string') return schema;
  const target = getPointer(context.root, schema.$ref);
  if (!isRecord(target)) {
    context.warnings.push({
      message: `Could not resolve schema reference ${schema.$ref}; using an empty value.`,
    });
    return {};
  }
  return target as JsonSchema;
}

function mergeSchema(left: JsonSchema, right: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...left, ...right };
  const leftProperties = isRecord(left.properties)
    ? (left.properties as Record<string, JsonSchema>)
    : {};
  const rightProperties = isRecord(right.properties)
    ? (right.properties as Record<string, JsonSchema>)
    : {};
  if (Object.keys(leftProperties).length > 0 || Object.keys(rightProperties).length > 0) {
    merged.properties = { ...leftProperties, ...rightProperties };
  }
  const required = [
    ...new Set([
      ...(Array.isArray(left.required) ? left.required : []),
      ...(Array.isArray(right.required) ? right.required : []),
    ]),
  ];
  if (required.length > 0) merged.required = required;
  for (const key of ['minimum', 'exclusiveMinimum']) {
    const a = left[key];
    const b = right[key];
    if (typeof a === 'number' && typeof b === 'number') merged[key] = Math.max(a, b);
  }
  for (const key of ['maximum', 'exclusiveMaximum']) {
    const a = left[key];
    const b = right[key];
    if (typeof a === 'number' && typeof b === 'number') merged[key] = Math.min(a, b);
  }
  if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
    merged.enum = left.enum.filter((value) =>
      right.enum?.some((other) => JSON.stringify(other) === JSON.stringify(value)),
    );
  }
  return merged;
}

function schemaType(schema: JsonSchema, rng: SeededRandom): string {
  const type = schema.type;
  if (Array.isArray(type)) {
    const alternatives = type.filter(
      (candidate): candidate is string => typeof candidate === 'string',
    );
    return rng.pick(alternatives) ?? 'object';
  }
  if (typeof type === 'string') return type;
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  return 'string';
}

function isUnconstrained(schema: JsonSchema): boolean {
  return ![
    'enum',
    'const',
    'default',
    'format',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
  ].some((key) => key in schema);
}

function expandCharacterClass(value: string): string[] | undefined {
  let index = 0;
  const chars: string[] = [];
  while (index < value.length) {
    const first = value[index] ?? '';
    if (first === '\\') {
      const escaped = value[index + 1];
      if (escaped === 'd') chars.push(...'0123456789');
      else if (escaped === 'w')
        chars.push(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_');
      else if (escaped === 's') chars.push(' ');
      else if (escaped) chars.push(escaped);
      index += 2;
      continue;
    }
    const rangeEnd = value[index + 1] === '-' ? value[index + 2] : undefined;
    if (rangeEnd !== undefined) {
      const from = first.codePointAt(0) ?? 0;
      const to = rangeEnd.codePointAt(0) ?? 0;
      if (to < from || to - from > 200) return undefined;
      for (let code = from; code <= to; code += 1) chars.push(String.fromCodePoint(code));
      index += 3;
      continue;
    }
    chars.push(first);
    index += 1;
  }
  return chars.length > 0 ? chars : undefined;
}

function generateSimplePattern(pattern: string, rng: SeededRandom): string | undefined {
  const source = pattern.replace(/^\^/, '').replace(/\$$/, '');
  if (source.includes('|') || source.includes('(?') || source.includes(')')) return undefined;
  let output = '';
  for (let index = 0; index < source.length;) {
    let choices: string[];
    let atom = '';
    const char = source[index] ?? '';
    if (char === '[') {
      const end = source.indexOf(']', index + 1);
      if (end < 0 || source[index + 1] === '^') return undefined;
      choices = expandCharacterClass(source.slice(index + 1, end)) ?? [];
      if (choices.length === 0) return undefined;
      atom = source.slice(index, end + 1);
      index = end + 1;
    } else if (char === '\\') {
      const next = source[index + 1];
      if (next === 'd') choices = [...'0123456789'];
      else if (next === 'w')
        choices = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'];
      else if (next === 's') choices = [' '];
      else if (next) choices = [next];
      else return undefined;
      atom = `\\${next ?? ''}`;
      index += 2;
    } else if (char === '.') {
      choices = ['a', 'b', 'x', '7'];
      atom = '.';
      index += 1;
    } else if ('*+?{}[]()'.includes(char)) {
      return undefined;
    } else {
      choices = [char];
      atom = char;
      index += 1;
    }

    let minimum = 1;
    let maximum = 1;
    if (source[index] === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index));
      if (!match) return undefined;
      minimum = Number(match[1]);
      maximum = match[2] === undefined ? minimum : match[2] === '' ? minimum + 3 : Number(match[2]);
      if (maximum < minimum || maximum > 100) return undefined;
      index += match[0].length;
    } else if (source[index] === '+') {
      minimum = 1;
      maximum = 3;
      index += 1;
    } else if (source[index] === '*') {
      minimum = 0;
      maximum = 3;
      index += 1;
    } else if (source[index] === '?') {
      minimum = 0;
      maximum = 1;
      index += 1;
    }
    void atom;
    const count = rng.int(minimum, maximum);
    for (let repeat = 0; repeat < count; repeat += 1) output += rng.pick(choices) ?? 'x';
  }
  try {
    return new RegExp(pattern).test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

function formatString(format: string, faker: Faker): string | undefined {
  if (format === 'email') return faker.internet.email().toLowerCase();
  if (format === 'uuid') return faker.string.uuid();
  if (format === 'date') return faker.date.anytime().toISOString().slice(0, 10);
  if (format === 'date-time') return faker.date.anytime().toISOString();
  if (format === 'uri' || format === 'url') return faker.internet.url();
  if (format === 'hostname') return faker.internet.domainName();
  if (format === 'ipv4') return faker.internet.ipv4();
  if (format === 'ipv6') return faker.internet.ipv6();
  return undefined;
}

function fallbackPatternValue(pattern: string, context: Context): string | undefined {
  try {
    const expression = new RegExp(pattern);
    const candidates = [
      'a',
      'x',
      '0',
      'test',
      'foo',
      'abc',
      'ab',
      'cd',
      'abc123',
      '2020-01-01',
      context.faker.lorem.word(),
    ];
    return candidates.find((candidate) => expression.test(candidate));
  } catch {
    return undefined;
  }
}

function constrainedString(schema: JsonSchema, context: Context, propertyName: string): string {
  const pattern = stringValue(schema.pattern);
  if (pattern) {
    const matching = generateSimplePattern(pattern, context.rng);
    if (matching !== undefined) return matching;
    context.warnings.push({
      message: `Pattern ${JSON.stringify(pattern)} is too complex for the built-in generator; a fallback value was used.`,
    });
    const fallback = fallbackPatternValue(pattern, context);
    if (fallback !== undefined) return fallback;
  }
  const format = stringValue(schema.format);
  let candidate = formatString(format, context.faker);
  const isUnconstrainedSchema = isUnconstrained(schema);
  const hintOption = context.hints;
  if (candidate === undefined && isUnconstrainedSchema && hintOption !== false) {
    if (isRecord(hintOption)) {
      const custom = hintOption[propertyName];
      if (Array.isArray(custom)) candidate = String(context.rng.pick(custom) ?? '');
      else if (custom !== undefined) candidate = String(custom);
    }
    candidate ??= hintedValue(propertyName, 'string', context.faker, context.rng) as
      string | undefined;
  }
  candidate ??= context.faker.lorem.word();
  const minimum = Math.max(0, Math.floor(numberValue(schema.minLength, 0)));
  const maximum = Math.max(
    minimum,
    Math.floor(numberValue(schema.maxLength, Math.max(80, candidate.length))),
  );
  if (candidate.length < minimum) candidate = candidate.padEnd(minimum, 'x');
  if (candidate.length > maximum) candidate = candidate.slice(0, maximum);
  return candidate;
}

function generateNumber(
  schema: JsonSchema,
  context: Context,
  type: 'integer' | 'number',
  propertyName: string,
): number {
  if (context.hints !== false && isUnconstrained(schema)) {
    const hintOption = context.hints;
    const custom = isRecord(hintOption) ? hintOption[propertyName] : undefined;
    const hinted =
      custom !== undefined
        ? Number(Array.isArray(custom) ? context.rng.pick(custom) : custom)
        : hintedValue(propertyName, type, context.faker, context.rng);
    if (typeof hinted === 'number' && Number.isFinite(hinted))
      return type === 'integer' ? Math.round(hinted) : hinted;
  }
  const minimumValue = schema.minimum;
  const maximumValue = schema.maximum;
  let minimum = typeof minimumValue === 'number' ? minimumValue : -100;
  let maximum = typeof maximumValue === 'number' ? maximumValue : 100;
  if (schema.exclusiveMinimum === true && typeof minimumValue === 'number')
    minimum += type === 'integer' ? 1 : 0.000001;
  else if (typeof schema.exclusiveMinimum === 'number')
    minimum = Math.max(
      minimum,
      schema.exclusiveMinimum + (type === 'integer' ? 1 : Number.EPSILON),
    );
  if (schema.exclusiveMaximum === true && typeof maximumValue === 'number')
    maximum -= type === 'integer' ? 1 : 0.000001;
  else if (typeof schema.exclusiveMaximum === 'number')
    maximum = Math.min(
      maximum,
      schema.exclusiveMaximum - (type === 'integer' ? 1 : Number.EPSILON),
    );
  if (minimum > maximum) minimum = maximum;
  const multipleOf = numberValue(schema.multipleOf, 0);
  if (type === 'integer') {
    const low = Math.ceil(minimum);
    const high = Math.floor(maximum);
    if (multipleOf > 0) {
      const first = Math.ceil(low / multipleOf) * multipleOf;
      const last = Math.floor(high / multipleOf) * multipleOf;
      if (first <= last)
        return Math.round(context.rng.int(first / multipleOf, last / multipleOf) * multipleOf);
      return Math.round(first);
    }
    return context.rng.int(low, high);
  }
  let number = context.rng.float(minimum, maximum);
  if (multipleOf > 0) number = Math.round(number / multipleOf) * multipleOf;
  number = Math.min(maximum, Math.max(minimum, number));
  return Number(number.toPrecision(8));
}

function generateArray(
  schema: JsonSchema,
  context: Context,
  depth: number,
  propertyName: string,
): unknown[] {
  const minimum = Math.max(0, Math.floor(numberValue(schema.minItems, context.minArrayItems)));
  const maximum = Math.max(
    minimum,
    Math.floor(numberValue(schema.maxItems, context.maxArrayItems)),
  );
  const count = context.rng.int(minimum, maximum);
  const itemSchema = isRecord(schema.items) ? (schema.items as JsonSchema) : {};
  const values: unknown[] = [];
  const unique = schema.uniqueItems === true;
  let attempts = 0;
  while (values.length < count && attempts < Math.max(count * 10, 10)) {
    attempts += 1;
    const value = generateNode(itemSchema, context, depth + 1, `${propertyName}Item`);
    if (!unique || !values.some((existing) => JSON.stringify(existing) === JSON.stringify(value)))
      values.push(value);
  }
  return values;
}

function generateObject(
  schema: JsonSchema,
  context: Context,
  depth: number,
): Record<string, unknown> {
  const properties = isRecord(schema.properties)
    ? (schema.properties as Record<string, JsonSchema>)
    : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((v): v is string => typeof v === 'string')
      : [],
  );
  const result: Record<string, unknown> = {};
  for (const [name, childSchema] of Object.entries(properties)) {
    if (context.mode === 'response' && childSchema.writeOnly === true) continue;
    if (context.mode === 'request' && childSchema.readOnly === true) continue;
    const isRequired = required.has(name);
    if (!isRequired && depth >= context.maxDepth) continue;
    if (!isRequired && !context.rng.bool(0.72)) continue;
    result[name] = generateNode(childSchema, context, depth + 1, name);
  }
  if (schema.additionalProperties && isRecord(schema.additionalProperties)) {
    // One generated extension property demonstrates the declared additionalProperties schema without making responses noisy.
    const extensionName = properties.extension ? 'extra' : 'extension';
    result[extensionName] = generateNode(
      schema.additionalProperties as JsonSchema,
      context,
      depth + 1,
      extensionName,
    );
  }
  return result;
}

function discriminatorValue(
  schema: JsonSchema,
  branch: JsonSchema,
  context: Context,
): { name: string; value: unknown } | undefined {
  const discriminator = isRecord(schema.discriminator) ? schema.discriminator : undefined;
  const propertyName =
    typeof discriminator?.propertyName === 'string' ? discriminator.propertyName : undefined;
  if (!propertyName) return undefined;
  const mapping = isRecord(discriminator?.mapping) ? discriminator.mapping : undefined;
  if (mapping) {
    const match = Object.entries(mapping).find(
      ([, ref]) => typeof ref === 'string' && ref === branch.$ref,
    );
    if (match) return { name: propertyName, value: match[0] };
  }
  const resolved = resolveSchema(branch, context);
  const properties = isRecord(resolved.properties) ? resolved.properties : {};
  const propertySchema = isRecord(properties[propertyName]) ? properties[propertyName] : undefined;
  if (propertySchema && 'const' in propertySchema)
    return { name: propertyName, value: propertySchema.const };
  if (Array.isArray(propertySchema?.enum))
    return { name: propertyName, value: propertySchema.enum[0] };
  if (typeof branch.$ref === 'string')
    return { name: propertyName, value: branch.$ref.split('/').pop() ?? 'variant' };
  return undefined;
}

function chooseCompositionBranch(schema: JsonSchema, context: Context): JsonSchema | undefined {
  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!branches || branches.length === 0) return undefined;
  const usable = branches.filter(isRecord) as JsonSchema[];
  if (usable.length === 0) return undefined;
  const discriminator = isRecord(schema.discriminator) ? schema.discriminator : undefined;
  if (typeof discriminator?.propertyName === 'string' && isRecord(discriminator.mapping)) {
    const mappedRefs = Object.values(discriminator.mapping).filter(
      (value): value is string => typeof value === 'string',
    );
    const selectedRef = context.rng.pick(mappedRefs);
    const found = usable.find((branch) => branch.$ref === selectedRef);
    if (found) return found;
  }
  return context.rng.pick(usable);
}

function generateNode(
  rawSchema: JsonSchema,
  context: Context,
  depth: number,
  propertyName: string,
): unknown {
  let schema = resolveSchema(rawSchema, context);
  if (rawSchema.$ref && context.refTrail.has(rawSchema.$ref)) {
    if (depth >= context.maxDepth) {
      const resolved = resolveSchema(rawSchema, context);
      if (
        resolved.nullable === true ||
        (Array.isArray(resolved.type) && resolved.type.includes('null'))
      )
        return null;
      if (resolved.default !== undefined) return resolved.default;
      if (resolved.const !== undefined) return resolved.const;
      const type = schemaType(resolved, context.rng);
      if (type === 'array')
        return numberValue(resolved.minItems, 0) === 0
          ? []
          : generateArray(resolved, context, context.maxDepth, propertyName);
      if (type === 'object') return generateObject(resolved, context, context.maxDepth);
      if (type === 'integer' || type === 'number')
        return generateNumber(resolved, context, type, propertyName);
      if (type === 'boolean') return context.rng.bool();
      if (type === 'string') return constrainedString(resolved, context, propertyName);
      return null;
    }
  }
  if (rawSchema.$ref) context.refTrail.add(rawSchema.$ref);
  try {
    if ('const' in schema) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return context.rng.pick(schema.enum);
    if (schema.nullable === true && context.rng.bool(0.12)) return null;

    const allOf = Array.isArray(schema.allOf)
      ? (schema.allOf.filter(isRecord) as JsonSchema[])
      : [];
    if (allOf.length > 0) {
      let merged: JsonSchema = { ...schema };
      delete merged.allOf;
      for (const item of allOf) merged = mergeSchema(merged, resolveSchema(item, context));
      schema = merged;
    }

    const branch = chooseCompositionBranch(schema, context);
    if (branch) {
      const generated = generateNode(branch, context, depth + 1, propertyName);
      const disc = discriminatorValue(schema, branch, context);
      const base: JsonSchema = { ...schema };
      delete base.oneOf;
      delete base.anyOf;
      delete base.discriminator;
      const generatedBase = generateNode(base, context, depth, propertyName);
      if (isRecord(generated)) {
        const combined = { ...(isRecord(generatedBase) ? generatedBase : {}), ...generated };
        if (disc) combined[disc.name] = disc.value;
        return combined;
      }
      return generated;
    }

    const type = schemaType(schema, context.rng);
    if (type === 'null') return null;
    if (type === 'object') return generateObject(schema, context, depth);
    if (type === 'array') return generateArray(schema, context, depth, propertyName);
    if (type === 'integer' || type === 'number')
      return generateNumber(schema, context, type, propertyName);
    if (type === 'boolean') return context.rng.bool();
    if (type === 'string') {
      const typeArray = Array.isArray(schema.type) ? schema.type : [];
      if (typeArray.includes('null') && context.rng.bool(0.08)) return null;
      return constrainedString(schema, context, propertyName);
    }
    return null;
  } finally {
    if (rawSchema.$ref) context.refTrail.delete(rawSchema.$ref);
  }
}

function createContext(options: GenerationOptions, seed: number): Context {
  return {
    root: options.root ?? {},
    rng: new SeededRandom(seed),
    faker: createFaker(seed),
    maxDepth: options.maxDepth ?? 3,
    minArrayItems: options.minArrayItems ?? 1,
    maxArrayItems: options.maxArrayItems ?? 3,
    hints: options.hints ?? true,
    mode: options.mode ?? 'response',
    warnings: [],
    refTrail: new Set(),
  };
}

function stripModeOnlyFields(
  value: unknown,
  field: 'readOnly' | 'writeOnly',
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => stripModeOnlyFields(item, field, seen));
  if (!isRecord(value)) return value;
  const known = seen.get(value);
  if (known) return known;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties' && isRecord(child)) {
      const properties: Record<string, unknown> = {};
      for (const [name, schemaValue] of Object.entries(child)) {
        if (isRecord(schemaValue) && schemaValue[field] === true) continue;
        properties[name] = stripModeOnlyFields(schemaValue, field, seen);
      }
      output[key] = properties;
    } else if (key === 'required' && Array.isArray(child)) {
      const properties = isRecord(value.properties) ? value.properties : {};
      output[key] = child.filter(
        (name) =>
          typeof name !== 'string' ||
          !isRecord(properties[name]) ||
          properties[name]?.[field] !== true,
      );
    } else {
      output[key] = stripModeOnlyFields(child, field, seen);
    }
  }
  return output;
}

export function generateFromSchema(
  schema: JsonSchema,
  options: GenerationOptions = {},
): GenerationResult {
  const baseSeed = options.seed ?? 0;
  const mode = options.mode ?? 'response';
  const field = mode === 'response' ? 'writeOnly' : 'readOnly';
  const validationRoot = stripModeOnlyFields(options.root ?? {}, field) as OpenApiDocument;
  const validationSchema = stripModeOnlyFields(schema, field) as JsonSchema;
  let last: unknown;
  const warnings: GeneratorWarning[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seed = deriveSeed(baseSeed, 'generate', attempt);
    const context = createContext(options, seed);
    last = generateNode(schema, context, 0, '');
    warnings.push(...context.warnings);
    const validation = validateSchema(validationRoot, validationSchema, last);
    if (validation.valid || (Object.keys(validationRoot).length === 0 && !schema.$ref)) {
      return { value: last, warnings: dedupeWarnings(warnings) };
    }
  }
  const reason = warnings.map((warning) => warning.message).join('; ');
  throw new Error(
    `Mockline could not generate a value satisfying its schema.${reason ? ` ${reason}` : ''}`,
  );
}

export function generateValue(schema: JsonSchema, options: GenerationOptions = {}): unknown {
  return generateFromSchema(schema, options).value;
}

function dedupeWarnings(warnings: GeneratorWarning[]): GeneratorWarning[] {
  const unique = new Map(warnings.map((warning) => [warning.message, warning]));
  return [...unique.values()];
}
