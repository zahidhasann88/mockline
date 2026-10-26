import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MocklineError } from '../errors.js';

export type StateData = Record<string, Record<string, unknown>[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readStateFile(
  file: string,
  optional = false,
): Promise<StateData | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(file), 'utf8');
  } catch (error) {
    if (optional && isRecord(error) && error.code === 'ENOENT') return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Cannot read data file ${file}: ${reason}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MocklineError(`Cannot parse data file ${file}: ${reason}`, 1);
  }
  const valid =
    isRecord(parsed) &&
    Object.values(parsed).every((items) => Array.isArray(items) && items.every(isRecord));
  if (!valid)
    throw new MocklineError(
      `Data file ${file} must be a JSON object mapping collection paths to arrays of objects.`,
      1,
    );
  return parsed as StateData;
}

export class StateFileWriter {
  private file?: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.setFile(file);
  }

  setFile(file?: string): void {
    this.file = file ? resolve(file) : undefined;
  }

  save(data: StateData): void {
    if (!this.file) return;
    const destination = this.file;
    const text = `${JSON.stringify(data, null, 2)}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.tmp`;
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, destination);
      })
      .catch((error: unknown) => {
        console.error(
          `mockline: could not save state file: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
