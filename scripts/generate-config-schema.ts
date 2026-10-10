import { writeFile, mkdir } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from '../src/config/schema.js';

const schema = zodToJsonSchema(configSchema, {
  name: 'MocklineConfig',
  $refStrategy: 'none',
  target: 'jsonSchema7',
});
schema.$schema = 'http://json-schema.org/draft-07/schema#';
schema.title = 'Mockline configuration';
schema.description = 'Configuration accepted by Mockline CLI and library.';
await mkdir('docs', { recursive: true });
await writeFile('docs/config.schema.json', `${JSON.stringify(schema, null, 2)}\n`);
