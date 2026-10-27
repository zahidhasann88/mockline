import { randomUUID } from 'node:crypto';

export interface TemplateContext {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  body: unknown;
  now: Date;
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function header(headers: TemplateContext['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined)
      return Array.isArray(value) ? value.join(', ') : value;
  }
  return undefined;
}

function walk(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (Array.isArray(current)) return current[Number(key)];
    return isRecord(current) ? current[key] : undefined;
  }, value);
}

export function templateValue(expression: string, context: TemplateContext): unknown {
  if (expression === 'now') return context.now.toISOString();
  if (expression === 'uuid') return randomUUID();
  if (expression === 'request.method') return context.method;
  if (expression === 'request.url') return context.url.href;
  if (expression === 'request.path') return context.url.pathname;
  if (expression === 'request.body') return context.body;
  const match = /^request\.(path|query|header|body)\.(.+)$/.exec(expression);
  if (!match) return undefined;
  const [, part, name = ''] = match;
  if (part === 'path') return context.params[name];
  if (part === 'query') return context.url.searchParams.get(name) ?? undefined;
  if (part === 'header') return header(context.headers, name);
  return walk(context.body, name.split('.'));
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function renderTemplate(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return templateValue(whole[1] ?? '', context) ?? null;
    if (!value.includes('{{')) return value;
    return value.replace(PLACEHOLDER, (_match, expression: string) =>
      asText(templateValue(expression, context)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]),
    );
  return value;
}

export function renderHeaders(
  headers: Record<string, string>,
  context: TemplateContext,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, asText(renderTemplate(value, context))]),
  );
}
