import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'mockline-pack-check-'));
const packDirectory = join(scratch, 'pack');
const installDirectory = join(scratch, 'install');

function run(label, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${String(result.status)}):\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

try {
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory)]);
  run('npm pack', 'npm', ['pack', '--pack-destination', packDirectory], root);
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith('.tgz'));
  if (!tarballName) throw new Error('npm pack did not create a tarball.');
  const tarball = join(packDirectory, tarballName);
  run('npm init', 'npm', ['init', '-y'], installDirectory);
  run(
    'clean tarball install',
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', tarball],
    installDirectory,
  );

  const importCheck = `
    const pkg = await import(${JSON.stringify(metadata.name)});
    if (typeof pkg.createMockServer !== 'function' || pkg.defaultConfig.host !== '127.0.0.1') {
      throw new Error('The installed package is missing its programmatic API or loopback default.');
    }
    console.log('Clean ESM import passed.');
  `;
  run(
    'clean ESM import',
    process.execPath,
    ['--input-type=module', '-e', importCheck],
    installDirectory,
  );

  const packagePath = join(installDirectory, 'node_modules', ...metadata.name.split('/'));
  const cliPath = join(packagePath, 'dist', 'cli.js');
  run('installed CLI version', process.execPath, [cliPath, '--version'], installDirectory);
  const binName = process.platform === 'win32' ? 'mockline.cmd' : 'mockline';
  run(
    'installed mockline binary',
    join(installDirectory, 'node_modules', '.bin', binName),
    ['--version'],
    installDirectory,
  );
  const routeOutput = run(
    'installed CLI routes',
    process.execPath,
    [cliPath, 'routes', join(root, 'examples', 'petstore', 'openapi.yaml')],
    installDirectory,
  );
  if (!routeOutput.includes('listPets'))
    throw new Error('The installed CLI could not load the example OpenAPI document.');
  process.stdout.write(`Tarball check passed: ${metadata.name}@${metadata.version}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
