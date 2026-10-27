import { z } from 'zod';

const nonNegative = z.number().finite().min(0);
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'must use http or https' });
const responseShape = z.object({
  status: z.number().int().min(100).max(599).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional(),
  delay: nonNegative.optional(),
});

const conditionSchema = z.object({
  location: z.enum(['query', 'header', 'body']),
  name: z.string().min(1),
  op: z.enum(['eq', 'contains', 'regex']).default('eq'),
  value: z.unknown(),
});

const overrideSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional(),
  delay: nonNegative.optional(),
  sequence: z.array(responseShape).min(1).optional(),
  loop: z.boolean().default(false),
  when: conditionSchema.optional(),
  response: responseShape.optional(),
  rules: z.array(z.object({ when: conditionSchema, response: responseShape })).optional(),
});

const latencySchema = z.union([
  nonNegative,
  z.tuple([nonNegative, nonNegative]).refine(([min, max]) => min <= max, {
    message: 'range minimum must not exceed maximum',
  }),
  z
    .object({
      fixed: nonNegative.optional(),
      min: nonNegative.optional(),
      max: nonNegative.optional(),
      distribution: z.enum(['uniform', 'normal']).default('uniform'),
    })
    .refine(
      (value) => value.fixed !== undefined || (value.min !== undefined && value.max !== undefined),
      {
        message: 'provide fixed or both min and max',
      },
    )
    .refine(
      (value) => value.min === undefined || value.max === undefined || value.min <= value.max,
      {
        message: 'range minimum must not exceed maximum',
        path: ['min'],
      },
    ),
]);

export const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(4010),
  host: z.string().min(1).default('127.0.0.1'),
  seed: z.number().int().optional(),
  prefer: z.enum(['example', 'generate']).default('example'),
  latency: latencySchema.default(0),
  errors: z
    .object({
      rate: z.number().min(0).max(1).default(0),
      statuses: z.array(z.number().int().min(400).max(599)).min(1).default([500, 503]),
      perOperationRates: z.record(z.number().min(0).max(1)).default({}),
    })
    .default({}),
  validate: z.enum(['off', 'warn', 'strict']).default('warn'),
  stateful: z
    .object({
      enabled: z.boolean().default(false),
      seedItems: z.number().int().min(0).default(3),
      idProperty: z.string().min(1).default('id'),
      seed: z.string().min(1).optional(),
      file: z.string().min(1).optional(),
    })
    .default({}),
  overrides: z.record(overrideSchema).default({}),
  proxy: z
    .object({
      url: z
        .string()
        .url()
        .refine((value) => /^https?:\/\//i.test(value), {
          message: 'must use http or https',
        })
        .optional(),
      all: z.boolean().default(false),
      allowPrivate: z.boolean().default(false),
      timeoutMs: z.number().int().positive().default(5000),
      recordFile: z.string().optional(),
    })
    .refine((value) => !value.all || Boolean(value.url), {
      message: 'proxy.url is required when proxy.all is true',
      path: ['url'],
    })
    .default({}),
  cors: z
    .object({
      enabled: z.boolean().default(true),
      origins: z.array(z.string()).default(['*']),
    })
    .default({}),
  recording: z
    .object({
      enabled: z.boolean().default(true),
      file: z.string().optional(),
      maxRequests: z.number().int().positive().default(500),
      redactHeaders: z
        .array(z.string())
        .default(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-auth-token']),
    })
    .default({}),
  generation: z
    .object({
      hints: z
        .union([
          z.boolean(),
          z.record(
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.null(),
              z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
            ]),
          ),
        ])
        .default(true),
      counter: z.boolean().default(false),
      maxDepth: z.number().int().min(0).max(20).default(3),
      minArrayItems: z.number().int().min(0).default(1),
      maxArrayItems: z.number().int().min(0).default(3),
    })
    .refine((value) => value.minArrayItems <= value.maxArrayItems, {
      message: 'minArrayItems must not exceed maxArrayItems',
      path: ['minArrayItems'],
    })
    .default({}),
  events: z
    .object({
      callbacks: z.boolean().default(true),
      delay: nonNegative.default(0),
      timeoutMs: z.number().int().positive().default(5000),
      allowPrivate: z.boolean().default(false),
      webhookUrl: httpUrl.optional(),
      webhooks: z.record(httpUrl).default({}),
    })
    .default({}),
  auth: z
    .object({
      apiKeys: z.array(z.string().min(1)).default([]),
      bearerTokens: z.array(z.string().min(1)).default([]),
      basic: z.array(z.object({ username: z.string(), password: z.string() })).default([]),
      jwtSecret: z.string().min(1).optional(),
    })
    .default({}),
  controlHeaders: z.object({ allow: z.boolean().default(true) }).default({}),
  inspector: z.object({ enabled: z.boolean().optional() }).default({}),
  enforceAuth: z.boolean().default(false),
  requestBodyLimit: z.number().int().positive().default(1_048_576),
  requestTimeoutMs: z.number().int().positive().default(30_000),
});

export type MocklineConfig = z.infer<typeof configSchema>;
export type OverrideConfig = z.input<typeof overrideSchema>;
export type NormalizedOverrideConfig = MocklineConfig['overrides'][string];
export type OverrideResponseConfig = z.infer<typeof responseShape>;
export type ConditionConfig = z.infer<typeof conditionSchema>;
export type ConditionInput = z.input<typeof conditionSchema>;

export const defaultConfig: MocklineConfig = configSchema.parse({});
