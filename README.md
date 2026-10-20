# Mockline

Mockline is a local OpenAPI mock server and TypeScript library. Point it at an
OpenAPI 3 file to serve its routes with examples or generated data, validate
requests, and optionally keep CRUD state in memory.

> **npm package:** `@zahid15/mockline`. The command is `mockline`.

## Features

- OpenAPI 3.0/3.1, YAML or JSON
- Spec examples or repeatable, seeded data generated from schemas
- Request validation (`off`, `warn`, `strict`)
- In-memory CRUD for REST collections
- Overrides, rules, sequences, latency and injected errors
- Request recording with an inspector API
- Optional proxy to a real upstream
- Hot reload, typed programmatic API, no web framework

Mockline is for local development, tests and demos, not production traffic.

![Mockline route listing showing HTTP methods, paths, operation IDs, response statuses, and response sources](docs/screenshots/demo.png)

## Install

Requires Node.js 20+.

```sh
npm install --global @zahid15/mockline
```

## Quick start

```sh
mockline init                  # writes mockline.yaml and openapi.yaml
mockline routes openapi.yaml   # list operations
mockline validate openapi.yaml # check the spec
mockline serve openapi.yaml    # start on http://127.0.0.1:4010
```

Then try `GET /pets`. To use the bundled example:

```sh
mockline serve examples/petstore/openapi.yaml --config examples/petstore/mockline.yaml
```

## CLI options

`mockline serve <spec>` accepts:

| Option                               | Description                                        |
| ------------------------------------ | -------------------------------------------------- |
| `--config <file>`                    | Config file (default: `mockline.yaml` if present). |
| `--port <port>`                      | Port, default `4010`. `0` picks a free port.       |
| `--host <host>`                      | Bind address, default `127.0.0.1`.                 |
| `--seed <n>`                         | Seed for generated data.                           |
| `--prefer <example\|generate>`       | Use examples first, or always generate.            |
| `--validate <off\|warn\|strict>`     | Request validation mode.                           |
| `--stateful`                         | Enable in-memory CRUD collections.                 |
| `--delay <ms\|min-max>`              | Add latency.                                       |
| `--error-rate <0..1>`                | Chance of an injected error.                       |
| `--error-statuses <codes>`           | Error statuses, e.g. `500,503`.                    |
| `--proxy <url>`                      | Forward unmatched requests upstream.               |
| `--proxy-all`                        | Forward all requests upstream.                     |
| `--proxy-record <file>`              | Save upstream responses as examples.               |
| `--proxy-allow-private`              | Allow private/loopback upstreams.                  |
| `--watch`                            | Reload spec and config on change.                  |
| `--record-file <path>`               | Append request records as JSON Lines.              |
| `--enforce-auth`                     | Require declared credentials (not verified).       |
| `--seed-counter`                     | Vary generated data per request.                   |
| `--cors` / `--no-cors`               | Toggle CORS (on by default).                       |
| `--inspector`                        | Enable the inspector on a non-loopback host.       |
| `--quiet`, `--verbose`, `--no-color` | Logging options.                                   |

## Control headers

Test clients can steer responses per request:

| Header                   | Effect                    |
| ------------------------ | ------------------------- |
| `Prefer: example=<name>` | Use a named example.      |
| `Prefer: code=404`       | Return a specific status. |
| `X-Mockline-Status: 404` | Same as above.            |
| `X-Mockline-Delay: 25`   | Add a 25 ms delay.        |
| `X-Mockline-Error: true` | Force an injected error.  |

Disable them with `controlHeaders.allow: false`.

## Configuration

`mockline init` creates a commented `mockline.yaml`. A minimal one:

```yaml
port: 4010
seed: 42
validate: warn
stateful:
  enabled: true
```

See [configuration](docs/configuration.md) for every field.

## Programmatic API

```ts
import { createMockServer } from '@zahid15/mockline';

const server = await createMockServer({
  spec: './openapi.yaml',
  port: 0,
  config: { validate: 'strict' },
});

try {
  await fetch(`${server.url}/pets`);
  console.log(server.requests({ method: 'GET' }));
} finally {
  await server.close();
}
```

The server also has `reset()` and `setOverride(key, override)`. See
[`examples/programmatic.ts`](examples/programmatic.ts).

## Docker

```sh
docker build -t mockline .
docker run --rm -p 127.0.0.1:4010:4010 \
  -v "$PWD/examples/petstore:/data:ro" \
  mockline serve /data/openapi.yaml --host 0.0.0.0
```

## Learn more

- [How it works](docs/how-it-works.md): response order, generated data,
  stateful mode, inspector, safety and limits
- [Configuration](docs/configuration.md)
- [Releasing](docs/release.md)

## Development

```sh
corepack pnpm install
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm publint
corepack pnpm attw
corepack pnpm pack:check
```

`pnpm demo` runs an end-to-end demo. `pnpm benchmark` runs a quick local
smoke benchmark.

## License

[MIT](LICENSE)
