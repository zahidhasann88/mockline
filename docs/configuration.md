# Configuration

Mockline loads the file given with `--config`, or the first `mockline.yaml`,
`mockline.yml` or `mockline.json` in the current directory. Invalid config is an
error. CLI options override config values.

Editor schema: [`config.schema.json`](config.schema.json). Regenerate it with
`corepack pnpm schema:config` after changing `src/config/schema.ts`.

## Top-level fields

| Field              | Default     | Meaning                                          |
| ------------------ | ----------- | ------------------------------------------------ |
| `port`             | `4010`      | TCP port. `0` picks a free port.                 |
| `host`             | `127.0.0.1` | Bind address. Other addresses expose the mock.   |
| `seed`             | `0`         | Seed for generated responses.                    |
| `prefer`           | `example`   | `example` or `generate`.                         |
| `latency`          | `0`         | Delay in ms: `25`, `[10, 80]` or `{ min, max }`. |
| `validate`         | `warn`      | `off`, `warn` or `strict`.                       |
| `enforceAuth`      | `false`     | Require declared credentials (presence only).    |
| `requestBodyLimit` | `1048576`   | Max request body in bytes.                       |
| `requestTimeoutMs` | `30000`     | Request timeout in ms.                           |

`latency` can also be `{ min, max, distribution: normal }` (default `uniform`).
`--delay 25` or `--delay 10-80` overrides it.

## Errors

```yaml
errors:
  rate: 0.05 # 0 to 1
  statuses: [500, 503]
  perOperationRates:
    createPet: 0.2
```

`X-Mockline-Error: true` forces the first status in `statuses`.

## Stateful

```yaml
stateful:
  enabled: true
  seedItems: 3
  idProperty: id
```

See [stateful mode](how-it-works.md#stateful-mode) for which routes qualify.

## Generation

```yaml
generation:
  hints: true # false, or a map of property name → value
  counter: false # true varies output per request
  maxDepth: 3 # 0–20, limits recursion
  minArrayItems: 1
  maxArrayItems: 3
```

## Overrides

Key overrides by `operationId` or `METHOD /path`.

Fixed response:

```yaml
overrides:
  listPets:
    status: 200
    body:
      - id: 1
        name: Fixed response
```

Sequence (stays on the last item unless `loop: true`):

```yaml
overrides:
  getPet:
    loop: true
    sequence:
      - status: 200
        body: { id: 1, name: First }
      - status: 404
        body: { title: Not Found, status: 404 }
```

Rules (first match wins). `location` is `query`, `header` or `body`; `op` is
`eq` (default), `contains` or `regex`. Body names can be paths like `user.id`.

```yaml
overrides:
  listPets:
    rules:
      - when: { location: query, name: demo, value: empty }
        response: { status: 200, body: [] }
```

Overrides can also set `headers` and `delay`.

## Proxy

```yaml
proxy:
  url: https://api.example.test/v1
  all: false # true forwards every request, not just unmatched ones
  allowPrivate: false # allow loopback/private upstreams
  timeoutMs: 5000
  recordFile: ./proxy-examples.json
```

## CORS

```yaml
cors:
  enabled: true
  origins: ['*']
```

On by default. Disable with `--no-cors` or `enabled: false`.

## Recording

```yaml
recording:
  enabled: true
  file: ./mockline-records.jsonl
  maxRequests: 500
  redactHeaders: [x-internal-token]
```

Common credential headers are always redacted; `redactHeaders` adds more.
Request bodies are not redacted.

## Control headers

```yaml
controlHeaders:
  allow: true
```

Set to `false` when clients must not change mock behavior with `Prefer` or
`X-Mockline-*` headers.

## Inspector

```yaml
inspector:
  enabled: false
```

On by default for loopback hosts, off otherwise. It has no authentication.

## Example

See [`examples/petstore/mockline.yaml`](../examples/petstore/mockline.yaml).
