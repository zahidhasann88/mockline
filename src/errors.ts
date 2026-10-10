import type { JsonValue } from './types.js';

export type ErrorExitCode = 1 | 2 | 3;

export class MocklineError extends Error {
  readonly exitCode: ErrorExitCode;
  readonly details?: unknown;

  constructor(message: string, exitCode: ErrorExitCode = 3, details?: unknown) {
    super(message);
    this.name = 'MocklineError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: string[];
  [key: string]: JsonValue | undefined;
}

export function problem(
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, JsonValue> = {},
): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}
