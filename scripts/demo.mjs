import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer } from '../dist/index.js';

const fetch = globalThis.fetch;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'demo-output');
const scratch = await mkdtemp(join(tmpdir(), 'mockline-demo-'));
const servers = [];
const transcript = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cli = (...args) => {
  const result = spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
    cwd: scratch,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
async function start(config) {
  const server = await createMockServer({
    spec: join(scratch, 'openapi.yaml'),
    port: 0,
    seed: 42,
    logger,
    config,
  });
  servers.push(server);
  return server;
}
async function show(label, response) {
  const text = await response.text();
  transcript.push(`${label}: HTTP ${response.status}\n${text || '(empty body)'}`);
  return text ? JSON.parse(text) : undefined;
}
const upstream = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ upstream: 'local demo' }));
});
try {
  await mkdir(output, { recursive: true });
  transcript.push(cli('init'));
  const routes = cli('routes', 'openapi.yaml');
  transcript.push(routes, cli('validate', 'openapi.yaml'));
  await writeFile(join(output, 'routes.txt'), `${routes}\n`);
  const example = await start({ validate: 'strict' });
  const pets = await show(
    'Example response',
    await fetch(`${example.url}/pets`, { headers: { authorization: 'Bearer demo-secret' } }),
  );
  assert.equal(pets[0].name, 'Milo');
  assert.equal(
    (await fetch(`${example.url}/pets/1`, { headers: { prefer: 'code=404' } })).status,
    404,
  );
  const delayed = Date.now();
  await fetch(`${example.url}/pets`, { headers: { 'x-mockline-delay': '40' } });
  assert.ok(Date.now() - delayed >= 30);
  await show(
    'Strict validation failure',
    await fetch(`${example.url}/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }),
  );
  const generated = await start({ prefer: 'generate' });
  const first = await show('Generated response', await fetch(`${generated.url}/pets`));
  assert.deepEqual(await (await fetch(`${generated.url}/pets`)).json(), first);
  transcript.push('Same seed, same body: passed');
  const state = await start({ stateful: { enabled: true, seedItems: 0 }, validate: 'strict' });
  const created = await show(
    'Create pet',
    await fetch(`${state.url}/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rex', tag: 'dog' }),
    }),
  );
  await show('Read pet', await fetch(`${state.url}/pets/${created.id}`));
  assert.equal((await fetch(`${state.url}/pets/${created.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${state.url}/pets/${created.id}`)).status, 404);
  transcript.push('Stateful POST / GET / DELETE: passed');
  const records = await show(
    'Inspector records',
    await fetch(`${example.url}/__mockline/requests?operationId=listPets&limit=1`),
  );
  const redacted = example.requests().find((record) => record.headers.authorization)
    ?.headers.authorization;
  assert.equal(redacted, '[REDACTED]');
  transcript.push(`Recorded Authorization: ${redacted}`);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const blocked = await start({ proxy: { url } });
  assert.equal((await fetch(`${blocked.url}/unmatched`)).status, 403);
  const allowed = await start({ proxy: { url, allowPrivate: true } });
  await show('Allowed local proxy', await fetch(`${allowed.url}/unmatched`));
  transcript.push('Private upstream refused without opt-in: passed');
  assert.ok(records.length);
  await writeFile(join(output, 'demo.txt'), `${transcript.join('\n\n')}\n`);
  assert.ok(!(await readFile(join(output, 'demo.txt'), 'utf8')).includes('demo-secret'));
  console.log(transcript.join('\n\n'));
  console.log('\nDemo passed. Reports: demo-output/');
} finally {
  await Promise.all(servers.map((server) => server.close()));
  if (upstream.listening)
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(scratch, { recursive: true, force: true });
}
