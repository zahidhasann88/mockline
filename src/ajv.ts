import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema, OpenApiDocument } from './types.js';

const ROOT_ID = 'https://mockline.local/openapi.json';

function cloneSchema(
  value: unknown,
  rootId: string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneSchema(item, rootId, seen));
  if (typeof value !== 'object' || value === null) return value;
  const prior = seen.get(value);
  if (prior) return prior;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
      output[key] = `${rootId}${child}`;
    } else if (key === 'exclusiveMinimum' && child === true) {
      // OpenAPI 3.0 encodes exclusivity as a boolean beside minimum.
      const parent = value as Record<string, unknown>;
      if (typeof parent.minimum === 'number') output.minimum = undefined;
      output[key] = typeof parent.minimum === 'number' ? parent.minimum : child;
    } else if (key === 'exclusiveMaximum' && child === true) {
      const parent = value as Record<string, unknown>;
      if (typeof parent.maximum === 'number') output.maximum = undefined;
      output[key] = typeof parent.maximum === 'number' ? parent.maximum : child;
    } else {
      output[key] = cloneSchema(child, rootId, seen);
    }
  }
  if (output.minimum === undefined) delete output.minimum;
  if (output.maximum === undefined) delete output.maximum;
  return output;
}

export interface SchemaValidation {
  valid: boolean;
  errors: ErrorObject[];
}

export function createValidator(root: OpenApiDocument, schema: JsonSchema): ValidateFunction {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  try {
    ajv.addSchema(root, ROOT_ID);
  } catch {
    // The root may have already been registered under a conflicting schema key in a caller-owned instance.
  }
  const normalized = cloneSchema(schema, ROOT_ID) as JsonSchema;
  return ajv.compile(normalized);
}

export function validateSchema(
  root: OpenApiDocument,
  schema: JsonSchema,
  value: unknown,
): SchemaValidation {
  try {
    const validator = createValidator(root, schema);
    const valid = validator(value) === true;
    return { valid, errors: validator.errors ?? [] };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          keyword: 'schema',
          instancePath: '',
          schemaPath: '',
          params: {},
          message: error instanceof Error ? error.message : 'Unable to compile schema',
        },
      ],
    };
  }
}
