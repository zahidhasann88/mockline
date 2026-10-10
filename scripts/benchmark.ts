import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { createMockServer } from '../src/server.js';
import type { Logger } from '../src/logger.js';

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function numericOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function main(): Promise<void> {
  const durationSeconds = numericOption('--duration', 5);
  const concurrency = numericOption('--concurrency', 10);
  if (!Number.isInteger(concurrency)) {
    throw new Error('--concurrency must be a positive integer.');
  }
  const server = await createMockServer({
    spec: resolve('examples/petstore/openapi.yaml'),
    host: '127.0.0.1',
    port: 0,
    config: {
      validate: 'off',
      recording: { enabled: false },
      inspector: { enabled: false },
    },
    logger,
  });
  const durations: number[] = [];
  const statuses = new Map<number, number>();
  let failures = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1000;

  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (performance.now() < deadline) {
          const requestStarted = performance.now();
          try {
            const response = await fetch(`${server.url}/v1/pets`);
            await response.arrayBuffer();
            durations.push(performance.now() - requestStarted);
            statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
          } catch {
            failures += 1;
          }
        }
      }),
    );
  } finally {
    await server.close();
  }

  const elapsedMs = performance.now() - startedAt;
  durations.sort((left, right) => left - right);
  const requests = durations.length;
  const requestsPerSecond = elapsedMs > 0 ? requests / (elapsedMs / 1000) : 0;
  console.log(
    `Mockline loopback benchmark (${process.version}, ${process.platform}/${process.arch})`,
  );
  console.log(
    `Duration: ${(elapsedMs / 1000).toFixed(2)}s | Concurrency: ${concurrency} | Route: GET /v1/pets`,
  );
  console.log(
    `Requests: ${requests} | Throughput: ${requestsPerSecond.toFixed(1)} req/s | Failures: ${failures}`,
  );
  console.log(
    `Latency: p50 ${percentile(durations, 0.5).toFixed(2)}ms | p95 ${percentile(durations, 0.95).toFixed(2)}ms`,
  );
  console.log(
    `Statuses: ${
      [...statuses.entries()]
        .sort(([left], [right]) => left - right)
        .map(([status, count]) => `${status}=${count}`)
        .join(', ') || 'none'
    }`,
  );
  if (failures > 0 || (statuses.get(200) ?? 0) !== requests) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
