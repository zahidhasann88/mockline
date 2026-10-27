import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, makeServer } from './helpers.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mockline-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

const json = { 'content-type': 'application/json' };

describe('stateful collections', () => {
  it('keeps nested collections separate per parent and detects other id names', async () => {
    const server = await makeServer({
      spec: fixture('nested.yaml'),
      config: { validate: 'off', stateful: { enabled: true, seedItems: 2 } },
    });
    try {
      const users = (await (await fetch(`${server.url}/users`)).json()) as Array<{ uuid: string }>;
      expect(users).toHaveLength(2);
      const alice = users[0]?.uuid ?? '';
      const bob = users[1]?.uuid ?? '';
      const user = await fetch(`${server.url}/users/${alice}`);
      expect(user.status).toBe(200);

      const created = await fetch(`${server.url}/users/${alice}/posts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'Hello', status: 'draft' }),
      });
      expect(created.status).toBe(201);
      const post = (await created.json()) as { postId: number; userId: string };
      expect(post.userId).toBe(alice);
      expect((await fetch(`${server.url}/users/${alice}/posts/${post.postId}`)).status).toBe(200);

      const alicePosts = (await (
        await fetch(`${server.url}/users/${alice}/posts`)
      ).json()) as unknown[];
      const bobPosts = (await (
        await fetch(`${server.url}/users/${bob}/posts`)
      ).json()) as unknown[];
      expect(alicePosts).toHaveLength(3);
      expect(bobPosts).toHaveLength(2);
      expect(bobPosts).not.toContainEqual(expect.objectContaining({ title: 'Hello' }));

      const drafts = (await (
        await fetch(`${server.url}/users/${alice}/posts?status=draft`)
      ).json()) as Array<{ status: string }>;
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.every((item) => item.status === 'draft')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects children of missing parents and deletes children with their parent', async () => {
    const server = await makeServer({
      spec: fixture('nested.yaml'),
      config: { validate: 'off', stateful: { enabled: true, seedItems: 1 } },
    });
    try {
      const missing = await fetch(`${server.url}/users/nobody/posts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'Orphan', status: 'draft' }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        detail: 'No resource with uuid nobody exists.',
      });
      expect((await fetch(`${server.url}/users/nobody/posts`)).status).toBe(404);
      expect((await fetch(`${server.url}/users/nobody/posts/1`)).status).toBe(404);

      const created = (await (
        await fetch(`${server.url}/users`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ name: 'Ada' }),
        })
      ).json()) as { uuid: string };
      await fetch(`${server.url}/users/${created.uuid}/posts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'Mine', status: 'published' }),
      });
      expect(
        await (await fetch(`${server.url}/users/${created.uuid}/posts`)).json(),
      ).toContainEqual(expect.objectContaining({ title: 'Mine' }));

      expect(
        (await fetch(`${server.url}/users/${created.uuid}`, { method: 'DELETE' })).status,
      ).toBe(204);
      expect((await fetch(`${server.url}/users/${created.uuid}/posts`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('allows any parent when relations are off', async () => {
    const server = await makeServer({
      spec: fixture('nested.yaml'),
      config: { validate: 'off', stateful: { enabled: true, seedItems: 1, relations: false } },
    });
    try {
      const created = await fetch(`${server.url}/users/anyone/posts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'Free', status: 'draft' }),
      });
      expect(created.status).toBe(201);
    } finally {
      await server.close();
    }
  });

  it('starts from a seed file and restores it on reset', async () => {
    const directory = await temporaryDirectory();
    const seed = join(directory, 'seed.json');
    await writeFile(
      seed,
      JSON.stringify({
        listPets: [{ id: 7, name: 'Seeded', email: 'a@b.test', createdAt: '2020-01-01T00:00:00Z' }],
        '/nowhere': [],
      }),
    );
    const server = await makeServer({
      config: { validate: 'off', stateful: { enabled: true, seed } },
    });
    try {
      expect(await (await fetch(`${server.url}/v1/pets`)).json()).toEqual([
        expect.objectContaining({ id: 7, name: 'Seeded' }),
      ]);
      await fetch(`${server.url}/v1/pets`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'New' }),
      });
      expect(await (await fetch(`${server.url}/v1/pets`)).json()).toHaveLength(2);
      await server.reset();
      expect(await (await fetch(`${server.url}/v1/pets`)).json()).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('saves changes to the state file and loads them on the next start', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'state.json');
    const config = { validate: 'off' as const, stateful: { enabled: true, seedItems: 1, file } };

    const first = await makeServer({ config });
    try {
      await fetch(`${first.url}/v1/pets`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Persisted' }),
      });
    } finally {
      await first.close();
    }
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown[]>;
    expect(saved['/v1/pets']).toHaveLength(2);

    const second = await makeServer({ config });
    try {
      const pets = (await (await fetch(`${second.url}/v1/pets`)).json()) as Array<{
        id: number;
        name: string;
      }>;
      expect(pets).toContainEqual(expect.objectContaining({ name: 'Persisted' }));
      const next = (await (
        await fetch(`${second.url}/v1/pets`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ name: 'After restart' }),
        })
      ).json()) as { id: number };
      expect(pets.map((pet) => pet.id)).not.toContain(next.id);
    } finally {
      await second.close();
    }
  });

  it('logs one line per request when logRequests is on', async () => {
    const lines: string[] = [];
    const server = await makeServer({
      logRequests: true,
      logger: { info: (line) => lines.push(line), warn() {}, error() {}, debug() {} },
    });
    try {
      await fetch(`${server.url}/v1/pets?limit=1`);
      await fetch(`${server.url}/__mockline/health`);
    } finally {
      await server.close();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/v1\/pets\?limit=1 -> 200 \(example, \d+ms\)$/);
  });

  it('rejects a malformed seed file', async () => {
    const directory = await temporaryDirectory();
    const seed = join(directory, 'seed.json');
    await writeFile(seed, JSON.stringify({ listPets: 'not an array' }));
    await expect(
      makeServer({ config: { validate: 'off', stateful: { enabled: true, seed } } }),
    ).rejects.toThrow(/must be a JSON object mapping collection paths/);
  });
});
