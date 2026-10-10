#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import cac from 'cac';
import pc from 'picocolors';
import { configSchema, type MocklineConfig } from './config/schema.js';
import { loadConfig } from './config/load.js';
import { MocklineError } from './errors.js';
import { createLogger } from './logger.js';
import { loadSpec } from './spec/load.js';
import { summarizeSpec } from './spec/summary.js';
import { createMockServer } from './server.js';

const VERSION = '0.1.0';
const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Mockline starter Petstore
  version: 1.0.0
servers:
  - url: http://127.0.0.1:4010
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: A list of pets
          content:
            application/json:
              examples:
                cats:
                  value:
                    - id: 1
                      name: Milo
                      tag: cat
              schema:
                type: array
                items: { $ref: '#/components/schemas/Pet' }
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PetInput' }
      responses:
        '201':
          description: Created pet
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        schema: { type: integer }
    get:
      operationId: getPet
      responses:
        '200':
          description: A pet
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
        '404':
          description: Not found
          content:
            application/problem+json:
              example: { title: Not Found, status: 404 }
    put:
      operationId: replacePet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PetInput' }
      responses:
        '200':
          description: Updated pet
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
    patch:
      operationId: updatePet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PetInput' }
      responses:
        '200':
          description: Updated pet
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
    delete:
      operationId: deletePet
      responses:
        '204':
          description: Deleted pet
components:
  schemas:
    PetInput:
      type: object
      required: [name]
      properties:
        name: { type: string, minLength: 2 }
        tag: { type: string }
    Pet:
      allOf:
        - $ref: '#/components/schemas/PetInput'
        - type: object
          required: [id]
          properties:
            id: { type: integer, minimum: 1 }
`;
const SAMPLE_CONFIG = `# Mockline configuration. CLI flags override these values.
port: 4010
host: 127.0.0.1
prefer: example
validate: warn
latency: 0
errors:
  rate: 0
  statuses: [500, 503]
stateful:
  enabled: false
  seedItems: 3
recording:
  enabled: true
  maxRequests: 500
  redactHeaders: [authorization, cookie, set-cookie, x-api-key, api-key, x-auth-token]
generation:
  hints: true
  counter: false
  maxDepth: 3
  minArrayItems: 1
  maxArrayItems: 3
controlHeaders:
  allow: true
`;

interface CliOptions extends Record<string, unknown> {
  config?: string;
  port?: string | number;
  host?: string;
  seed?: string | number;
  prefer?: string;
  delay?: string;
  errorRate?: string | number;
  errorStatuses?: string;
  validate?: string;
  stateful?: boolean;
  proxy?: string;
  proxyAll?: boolean;
  proxyRecord?: string;
  proxyAllowPrivate?: boolean;
  cors?: boolean;
  inspector?: boolean;
  watch?: boolean;
  recordFile?: string;
  enforceAuth?: boolean;
  seedCounter?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  force?: boolean;
}

function optionString(options: CliOptions, key: keyof CliOptions): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function parseInteger(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new MocklineError(`--${name} must be an integer.`, 2);
  return parsed;
}

function parseDelay(value: string | undefined): MocklineConfig['latency'] | undefined {
  if (value === undefined) return undefined;
  const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(value);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (max < min) throw new MocklineError('--delay range must be min-max with min no greater than max.', 2);
    return [min, max];
  }
  const fixed = Number(value);
  if (!Number.isFinite(fixed) || fixed < 0) throw new MocklineError('--delay must be a non-negative number or min-max range.', 2);
  return fixed;
}

function parseStatuses(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const statuses = value.split(',').map((item) => Number(item.trim()));
  if (statuses.length === 0 || statuses.some((status) => !Number.isInteger(status) || status < 400 || status > 599)) {
    throw new MocklineError('--error-statuses must be a comma-separated list of HTTP error status codes.', 2);
  }
  return statuses;
}

function makeConfig(base: MocklineConfig, options: CliOptions): MocklineConfig {
  const port = parseInteger(options.port, 'port');
  const seed = parseInteger(options.seed, 'seed');
  const errorRate = options.errorRate === undefined ? undefined : Number(options.errorRate);
  if (errorRate !== undefined && (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1)) {
    throw new MocklineError('--error-rate must be a number from 0 to 1.', 2);
  }
  const prefer = optionString(options, 'prefer');
  if (prefer && prefer !== 'example' && prefer !== 'generate') throw new MocklineError('--prefer must be example or generate.', 2);
  const validate = optionString(options, 'validate');
  if (validate && !['off', 'warn', 'strict'].includes(validate)) throw new MocklineError('--validate must be off, warn, or strict.', 2);
  const statuses = parseStatuses(options.errorStatuses);
  const delay = parseDelay(options.delay);
  return configSchema.parse({
    ...base,
    ...(port !== undefined ? { port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(prefer ? { prefer } : {}),
    ...(delay !== undefined ? { latency: delay } : {}),
    ...(validate ? { validate } : {}),
    errors: {
      ...base.errors,
      ...(errorRate !== undefined ? { rate: errorRate } : {}),
      ...(statuses ? { statuses } : {}),
    },
    stateful: { ...base.stateful, ...(options.stateful ? { enabled: true } : {}) },
    proxy: {
      ...base.proxy,
      ...(options.proxy ? { url: options.proxy } : {}),
      ...(options.proxyAll ? { all: true } : {}),
      ...(options.proxyAllowPrivate ? { allowPrivate: true } : {}),
      ...(options.proxyRecord ? { recordFile: options.proxyRecord } : {}),
    },
    cors: { ...base.cors, ...(options.cors !== undefined ? { enabled: options.cors } : {}) },
    recording: { ...base.recording, ...(options.recordFile ? { file: options.recordFile } : {}) },
    inspector: { ...base.inspector, ...(options.inspector ? { enabled: true } : {}) },
    enforceAuth: Boolean(options.enforceAuth) || base.enforceAuth,
    generation: { ...base.generation, ...(options.seedCounter ? { counter: true } : {}) },
  });
}

function table(spec: Awaited<ReturnType<typeof loadSpec>>, configKeys: string[] = []): string {
  const rows = summarizeSpec(spec, configKeys);
  if (rows.length === 0) return 'No operations found.';
  const widths = [
    Math.max(6, ...rows.map((row) => row.method.length)),
    Math.max(4, ...rows.map((row) => row.path.length)),
    Math.max(11, ...rows.map((row) => row.operationId.length)),
    Math.max(6, ...rows.map((row) => row.defaultStatus.length)),
    Math.max(6, ...rows.map((row) => row.source.length)),
  ];
  const headers = ['METHOD', 'PATH', 'OPERATION ID', 'STATUS', 'SOURCE'];
  const line = (values: string[]): string => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ');
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map((row) => line([row.method, row.path, row.operationId, row.defaultStatus, row.source]))].join('\n');
}

async function initProject(options: CliOptions, logger: ReturnType<typeof createLogger>): Promise<void> {
  const configFile = resolve('mockline.yaml');
  const specFile = resolve('openapi.yaml');
  if (!options.force && (existsSync(configFile) || existsSync(specFile))) {
    throw new MocklineError('mockline.yaml or openapi.yaml already exists. Use --force to overwrite them.', 1);
  }
  await writeFile(configFile, SAMPLE_CONFIG, 'utf8');
  await writeFile(specFile, SAMPLE_SPEC, 'utf8');
  logger.info('Created mockline.yaml and openapi.yaml. Start with: mockline serve openapi.yaml');
}

async function startServing(specPath: string, options: CliOptions): Promise<void> {
  const loadedConfig = await loadConfig(options.config);
  const config = makeConfig(loadedConfig.config, options);
  const logger = createLogger({ quiet: options.quiet, verbose: options.verbose, color: options.color });
  const server = await createMockServer({
    spec: specPath,
    config,
    inspector: options.inspector,
    logger,
    watch: options.watch === true,
    configFile: loadedConfig.path ?? options.config,
    reloadConfig: async () => {
      const freshConfig = await loadConfig(options.config);
      return makeConfig(freshConfig.config, options);
    },
  });
  logger.info(`Mock API listening at ${server.url}`);
  if (options.quiet !== true) logger.info(`Inspector: ${server.url}/__mockline/health`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => {
      process.exitCode = 0;
    }).catch((error: unknown) => {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 3;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const cli = cac('mockline');
  cli.version(VERSION);
  cli.help();
  let action = Promise.resolve();
  let failureCode = 0;
  const logger = createLogger();
  const register = (handler: (...args: unknown[]) => Promise<void>): ((...args: unknown[]) => void) => (...args) => {
    action = handler(...args).catch((error: unknown) => {
      const code = error instanceof MocklineError ? error.exitCode : 3;
      failureCode = code;
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red('error'), message);
    });
  };

  cli.command('init', 'Create a commented config and a starter OpenAPI spec')
    .option('--force', 'Overwrite existing starter files')
    .action(register(async (...args) => {
      const options = (args[0] ?? {}) as CliOptions;
      await initProject(options, logger);
    }));

  cli.command('serve <spec>', 'Start a mock API server')
    .option('--port <port>', 'Port to listen on; use 0 to select a free port')
    .option('--host <host>', 'Bind address (default 127.0.0.1)')
    .option('--config <file>', 'YAML or JSON config file')
    .option('--seed <n>', 'Deterministic generation seed')
    .option('--prefer <mode>', 'Prefer examples or schema generation')
    .option('--delay <ms|min-max>', 'Global response latency')
    .option('--error-rate <rate>', 'Probability of injected failures from 0 to 1')
    .option('--error-statuses <codes>', 'Failure statuses, comma-separated')
    .option('--validate <mode>', 'Request validation: off, warn, or strict')
    .option('--stateful', 'Enable in-memory resource collections')
    .option('--proxy <url>', 'Forward unmatched requests to an upstream')
    .option('--proxy-all', 'Forward all non-inspector requests to the upstream')
    .option('--proxy-record <file>', 'Save upstream responses as JSON examples')
    .option('--proxy-allow-private', 'Permit upstreams resolving to private addresses')
    .option('--cors', 'Enable CORS (default)')
    .option('--no-cors', 'Disable CORS')
    .option('--inspector', 'Enable the inspector on a non-loopback bind')
    .option('--watch', 'Reload valid spec and config changes')
    .option('--record-file <path>', 'Append redacted request records as JSONL')
    .option('--enforce-auth', 'Require declared security credentials to be present')
    .option('--seed-counter', 'Vary repeat requests with an operation-local counter')
    .option('--quiet', 'Suppress normal logs')
    .option('--verbose', 'Enable diagnostic logs')
    .option('--no-color', 'Disable color output')
    .action(register(async (spec: unknown, optionsUnknown: unknown) => {
      const specPath = String(spec);
      const options = (optionsUnknown ?? {}) as CliOptions;
      await startServing(specPath, options);
    }));

  cli.command('routes <spec>', 'List operations and their default response source')
    .action(register(async (spec: unknown) => {
      const loaded = await loadSpec(String(spec));
      console.log(table(loaded));
    }));

  cli.command('validate <spec>', 'Validate an OpenAPI document and report mocking limitations')
    .action(register(async (spec: unknown) => {
      const loaded = await loadSpec(String(spec));
      const operationCount = summarizeSpec(loaded).length;
      const version = loaded.document.openapi ?? 'OpenAPI';
      console.log(`${pc.green('Valid')} ${version}: ${operationCount} operation(s), ${loaded.warnings.length} warning(s).`);
      for (const warning of loaded.warnings) {
        const location = warning.operationId ? ` (${warning.operationId}${warning.path ? ` ${warning.path}` : ''})` : '';
        console.warn(`${pc.yellow('warning')}${location}: ${warning.message}`);
      }
    }));

  cli.on('command:*', () => {
    console.error(`Unknown command: ${argv[0] ?? ''}`);
    cli.outputHelp();
    failureCode = 2;
  });

  try {
    cli.parse(['node', 'mockline', ...argv], { run: true });
    await action;
    return failureCode;
  } catch (error) {
    const code = error instanceof MocklineError ? error.exitCode : 2;
    console.error(pc.red('error'), error instanceof Error ? error.message : String(error));
    return code;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('/mockline')) {
  // Package manager bin shims generally invoke the file by its `mockline` name.
  void runCli().then((code) => {
    process.exitCode = code;
  });
} else if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
