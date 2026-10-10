import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';
import { configSchema, type MocklineConfig } from './schema.js';
import { MocklineError } from '../errors.js';

export function formatConfigErrors(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

export async function parseConfigText(
  text: string,
  fileName = 'mockline.yaml',
): Promise<MocklineConfig> {
  let raw: unknown;
  try {
    raw =
      extname(fileName).toLowerCase() === '.json' ? (JSON.parse(text) as unknown) : parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Invalid config ${fileName}: ${reason}`, 1);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MocklineError(
      `Invalid config ${fileName}:\n${formatConfigErrors(parsed.error)}`,
      1,
      parsed.error,
    );
  }
  return parsed.data;
}

export async function loadConfig(
  file?: string,
): Promise<{ config: MocklineConfig; path?: string }> {
  const candidates = file
    ? [resolve(file)]
    : [resolve('mockline.yaml'), resolve('mockline.yml'), resolve('mockline.json')];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    if (file) throw new MocklineError(`Config file not found: ${file}`, 1);
    return { config: configSchema.parse({}) };
  }
  let text: string;
  try {
    text = await readFile(selected, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Cannot read config ${selected}: ${reason}`, 1);
  }
  return { config: await parseConfigText(text, selected), path: selected };
}
