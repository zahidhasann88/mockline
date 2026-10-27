# Configuration

Mockline reads `--config <file>`, or `mockline.yaml` / `.yml` / `.json` from the
current folder. CLI options override the file. For editor autocomplete, use
[`config.schema.json`](config.schema.json).

## All settings

Every setting is optional. Values shown are the defaults.

```yaml
port: 4010 # 0 picks a free port
host: 127.0.0.1 # other addresses expose the mock to your network
seed: 0 # same seed = same generated data
prefer: example # or: generate
validate: warn # off, warn or strict
latency: 0 # ms: 25, [10, 80] or { min, max, distribution: normal }
enforceAuth: false # require the credentials declared in the spec
requestBodyLimit: 1048576 # bytes
requestTimeoutMs: 30000

errors:
  rate: 0 # 0 to 1, chance of an injected error
  statuses: [500, 503]
  perOperationRates: {} # e.g. { createPet: 0.2 }

stateful:
  enabled: false
  seedItems: 3 # generated items per collection
  idProperty: id # also tries the path parameter name, uuid and _id
  relations: true # nested items need an existing parent and are deleted with it
  seed: ./seed.json # start from these items (not set by default)
  file: ./state.json # load on start, save after each change (not set by default)

generation:
  hints: true # realistic values from property names; or a map of name -> value
  counter: false # true varies output per request
  maxDepth: 3 # recursion limit, 0-20
  minArrayItems: 1
  maxArrayItems: 3

proxy:
  url: https://api.example.test # not set by default
  all: false # true forwards every request, not just unmatched ones
  allowPrivate: false # allow loopback/private upstreams
  timeoutMs: 5000
  recordFile: ./proxy-examples.json # save upstream responses (not set by default)

cors:
  enabled: true
  origins: ['*']

recording:
  enabled: true
  file: ./requests.jsonl # also append requests here (not set by default)
  maxRequests: 500
  redactHeaders: [authorization, cookie, set-cookie, x-api-key, api-key, x-auth-token]

events:
  callbacks: true # send callbacks declared in the spec
  delay: 0 # ms before sending
  timeoutMs: 5000
  allowPrivate: false # localhost is always allowed; this allows other private addresses
  webhookUrl: http://localhost:3000/hooks # default webhook target (not set by default)
  webhooks: {} # per-webhook targets, e.g. { newPet: http://localhost:3000/pets }

auth: # setting any value turns on checks, like enforceAuth
  apiKeys: [] # accepted API keys
  bearerTokens: [] # accepted bearer tokens
  basic: [] # e.g. [{ username: ada, password: secret }]
  jwtSecret: my-secret # verify HS256/384/512 JWTs (not set by default)

controlHeaders:
  allow: true # false ignores Prefer and X-Mockline-* headers

inspector:
  enabled: true # default: on for loopback hosts, off otherwise
```

## Overrides

Fix a response by `operationId` or `METHOD /path`:

```yaml
overrides:
  listPets:
    status: 200
    body: [{ id: 1, name: Fixed }]

  getPet: # returns each in turn, then stays on the last (loop: true repeats)
    sequence:
      - { status: 200, body: { id: 1, name: First } }
      - { status: 404 }

  searchPets: # first matching rule wins
    rules:
      - when: { location: query, name: q, value: empty }
        response: { status: 200, body: [] }
```

`location` is `query`, `header` or `body` (paths like `user.id` work). `op` is
`eq` (default), `contains` or `regex`. Any override can also set `headers` and
`delay`.

### Templates

Override bodies and headers can use values from the request:

```yaml
overrides:
  getPet:
    body: { id: '{{request.path.petId}}', name: 'Pet {{request.path.petId}}' }
  createPet:
    status: 201
    body: { id: '{{uuid}}', name: '{{request.body.name}}', createdAt: '{{now}}' }
```

Available: `request.method`, `request.url`, `request.path`, `request.path.<param>`,
`request.query.<name>`, `request.header.<name>`, `request.body` and
`request.body.<field>` (e.g. `request.body.items.0.id`), plus `now` and `uuid`.

A value that is only a placeholder keeps its type, so `'{{request.body.age}}'`
stays a number. Missing values become `null`, or empty text inside a longer
string.

## Seed and state files

`stateful.seed` and `stateful.file` use the same JSON format. Keys are list
paths (or the list `operationId`):

```json
{
  "/pets": [{ "id": 1, "name": "Milo" }],
  "/users/1/posts": [{ "postId": 1, "title": "Hello" }]
}
```

To go back to the seed data, delete the state file or call reset.

## Webhooks

Webhooks come from the spec's `webhooks` section (OpenAPI 3.1). Send one with:

```sh
curl -X POST http://127.0.0.1:4010/__mockline/webhooks/newPet
```

The payload comes from the spec. Post a JSON body to send your own, or add
`?url=` to change the target. In code, use `server.sendWebhook('newPet')`.

## Testing

```ts
import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import { useMockline, mocklineMatchers } from '@zahid15/mockline/testing';

expect.extend(mocklineMatchers);

const api = useMockline({
  spec: './openapi.yaml',
  hooks: { beforeAll, afterAll, beforeEach }, // not needed with Jest or Vitest globals
});

test('creates a pet', async () => {
  await fetch(`${api.url}/pets`, { method: 'POST', body: '{}' });
  expect(api).toHaveReceived('POST /pets', 1);
});
```

The server starts before the tests and stops after. Data and recorded requests
reset before each test. Match requests by `"METHOD /path"`, `"/path"` or
`operationId`.

For `toHaveReceived` types in Vitest, add once:

```ts
import type { MocklineMatchers } from '@zahid15/mockline/testing';

declare module 'vitest' {
  interface Assertion<T> extends MocklineMatchers<T> {}
}
```
