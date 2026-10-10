import { createMockServer } from '@your-github-username/mockline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const server = await createMockServer({
  spec: resolve(exampleDirectory, 'petstore/openapi.yaml'),
  port: 0,
  seed: 42,
  config: {
    validate: 'warn',
    stateful: { enabled: true, seedItems: 2 },
  },
});

try {
  console.log(`Mock API listening at ${server.url}`);
  const response = await fetch(`${server.url}/v1/pets`);
  console.log(await response.json());
  console.log(`Recorded ${server.requests({ method: 'GET' }).length} GET request(s).`);
} finally {
  await server.close();
}
