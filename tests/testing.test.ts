import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mocklineMatchers, useMockline, type MocklineMatchers } from '../src/testing.js';
import { fixture, silentLogger } from './helpers.js';

declare module 'vitest' {
  interface Assertion<T> extends MocklineMatchers<T> {}
}

expect.extend(mocklineMatchers);

describe('useMockline', () => {
  const api = useMockline({
    spec: fixture('petstore-30.yaml'),
    logger: silentLogger,
    config: { validate: 'off', stateful: { enabled: true, seedItems: 1 } },
    hooks: { beforeAll, afterAll, beforeEach },
  });

  it('starts a server and matches requests by method and path or operationId', async () => {
    await fetch(`${api.url}/v1/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rex' }),
    });
    await fetch(`${api.url}/v1/pets?limit=1`);
    expect(api.received('POST /v1/pets')).toHaveLength(1);
    expect(api.received('listPets')).toHaveLength(1);
    expect(api.received('GET /v1/pets/{petId}')).toHaveLength(0);
    expect(api).toHaveReceived('createPet', 1);
    expect(api).not.toHaveReceived('DELETE /v1/pets/1');
  });

  it('resets state and recorded requests between tests', async () => {
    expect(api.requests()).toHaveLength(0);
    expect(await (await fetch(`${api.url}/v1/pets`)).json()).toHaveLength(1);
  });
});

describe('useMockline without hooks', () => {
  it('explains how to pass hooks', () => {
    expect(() => useMockline({ spec: fixture('petstore-30.yaml') })).toThrow(/needs test hooks/);
  });
});
