import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isMap, isScalar, parseDocument, YAMLMap, type Document, type Pair } from 'yaml';
import { MocklineError } from '../errors.js';

const MAX_RECORDED = 10;

export interface RecordedExampleInput {
  specPath: string;
  method: string;
  status: number;
  contentType?: string;
  body: Buffer;
  label: string;
}

export type RecordResult = { recorded: true; name: string } | { recorded: false; reason: string };

function keyText(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return (map.items as Pair[]).find((pair) => keyText(pair) === key);
}

function childMap(map: YAMLMap, key: string): YAMLMap | undefined {
  const value = findPair(map, key)?.value;
  return isMap(value) ? value : undefined;
}

function ensureMap(document: Document, map: YAMLMap, key: string): YAMLMap {
  const existing = childMap(map, key);
  if (existing) return existing;
  const created = document.createNode({}) as YAMLMap;
  map.set(key, created);
  return created;
}

export function decodeBody(
  body: Buffer,
  contentType: string | undefined,
): { mediaType: string; value: unknown } | undefined {
  if (body.byteLength === 0) return undefined;
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
  const text = body.toString('utf8');
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    try {
      return { mediaType, value: JSON.parse(text) as unknown };
    } catch {
      return undefined;
    }
  }
  if (mediaType.startsWith('text/') || mediaType.endsWith('xml')) return { mediaType, value: text };
  return undefined;
}

export class SpecExampleWriter {
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly document: Document,
    private readonly outFile: string,
  ) {}

  static async open(specFile: string, outFile: string): Promise<SpecExampleWriter> {
    const text = await readFile(resolve(specFile), 'utf8');
    const document = parseDocument(text);
    if (document.errors.length > 0 || !isMap(document.contents))
      throw new MocklineError(
        `Cannot record into ${specFile}: it is not a YAML or JSON object.`,
        1,
      );
    return new SpecExampleWriter(document, resolve(outFile));
  }

  add(input: RecordedExampleInput): RecordResult {
    const root = this.document.contents as YAMLMap;
    const operation = childMap(
      childMap(childMap(root, 'paths') ?? new YAMLMap(), input.specPath) ?? new YAMLMap(),
      input.method.toLowerCase(),
    );
    if (!operation) return { recorded: false, reason: 'operation not found in the spec' };
    const responses = ensureMap(this.document, operation, 'responses');
    const statusKey = String(input.status);
    const isNew = !childMap(responses, statusKey);
    const response = ensureMap(this.document, responses, statusKey);
    if (findPair(response, '$ref')) return { recorded: false, reason: 'response uses $ref' };
    if (isNew) response.set('description', 'Recorded response');
    const decoded = decodeBody(input.body, input.contentType);
    if (!decoded) {
      if (isNew) this.schedule();
      return { recorded: false, reason: 'body is empty or not JSON or text' };
    }
    const media = ensureMap(
      this.document,
      ensureMap(this.document, response, 'content'),
      decoded.mediaType,
    );
    if (findPair(media, '$ref')) return { recorded: false, reason: 'media type uses $ref' };
    const examples = ensureMap(this.document, media, 'examples');
    const single = findPair(media, 'example');
    if (single) {
      media.delete('example');
      const wrapper = new YAMLMap();
      wrapper.set('value', single.value);
      examples.set('original', wrapper);
    }
    const serialized = JSON.stringify(decoded.value);
    const pairs = examples.items as Pair[];
    const recorded = pairs.filter((pair) => keyText(pair).startsWith('recorded'));
    if (
      pairs.some((pair) => {
        const value = isMap(pair.value) ? pair.value.get('value', true) : undefined;
        const plain =
          value && typeof value === 'object' && 'toJSON' in value ? value.toJSON() : value;
        return JSON.stringify(plain) === serialized;
      })
    )
      return { recorded: false, reason: 'same response already recorded' };
    if (recorded.length >= MAX_RECORDED)
      return { recorded: false, reason: `already has ${MAX_RECORDED} recorded examples` };
    let name = 'recorded';
    for (let index = 2; findPair(examples, name); index += 1) name = `recorded-${index}`;
    examples.set(name, this.document.createNode({ summary: input.label, value: decoded.value }));
    const added = examples.items.pop();
    if (added) examples.items.unshift(added);
    this.schedule();
    return { recorded: true, name };
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.write();
    }
    await this.queue;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, 200);
  }

  private write(): void {
    const text = /\.json$/i.test(this.outFile)
      ? `${JSON.stringify(this.document.toJS(), null, 2)}\n`
      : this.document.toString();
    const destination = this.outFile;
    this.queue = this.queue
      .then(async () => {
        const temporary = `${destination}.tmp`;
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, destination);
      })
      .catch((error: unknown) => {
        console.error(
          `mockline: could not save recorded examples: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
