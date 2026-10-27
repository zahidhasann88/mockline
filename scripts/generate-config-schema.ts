import { writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../src/config/schema.js';

function closeObjects(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(closeObjects);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.properties && record.additionalProperties === undefined)
    record.additionalProperties = false;
  Object.values(record).forEach(closeObjects);
}

const generated = z.toJSONSchema(configSchema, {
  io: 'input',
  target: 'draft-7',
  unrepresentable: 'any',
});
closeObjects(generated);
const schema = {
  ...generated,
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Mockline configuration',
  description: 'Configuration accepted by Mockline CLI and library.',
};
await mkdir('docs', { recursive: true });
await writeFile('docs/config.schema.json', `${JSON.stringify(schema, null, 2)}\n`);
