# Mockline

[![npm](https://img.shields.io/npm/v/@zahid15/mockline)](https://www.npmjs.com/package/@zahid15/mockline)
[![CI](https://github.com/zahidhasann88/mockline/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zahidhasann88/mockline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A local mock API server built from your OpenAPI file. Use it for development,
tests and demos.

![Mockline demo: listing routes, then creating and fetching a pet with curl](docs/screenshots/demo.gif)

## Features

- OpenAPI 3.0, 3.1 and Swagger 2.0, YAML or JSON
- Responses from spec examples, or realistic data generated from schemas
- Request validation
- CRUD (create, read, update, delete) with data saved to a file if you want
- Nested resources: a user's posts need the user, and go when it's deleted
- Custom responses, delays and errors
- Response templates that use request values, like `{{request.body.name}}`
- Callbacks and webhooks from your spec
- Auth checks: API keys, basic, bearer tokens and JWT scopes
- Proxy to a real API
- Reloads when files change
- Usable as a CLI, a TypeScript library, or in Vitest/Jest tests

## Install

Requires Node.js 20 or later.

```sh
npm install --global @zahid15/mockline
```

## Quick start

```sh
mockline init                  # create openapi.yaml and mockline.yaml
mockline serve                 # start at http://127.0.0.1:4010
```

Then open `http://127.0.0.1:4010/pets`. Without a file name, Mockline uses
`openapi.yaml` (or `.yml`/`.json`) from the current folder.

Other commands:

```sh
mockline routes                # list routes
mockline validate              # check the spec
mockline --help                # all options
```

## Common options

| Option                           | Description                           |
| -------------------------------- | ------------------------------------- |
| `--port <port>`                  | Port (default `4010`)                 |
| `--config <file>`                | Config file (default `mockline.yaml`) |
| `--stateful`                     | Keep created data in memory           |
| `--state-file <file>`            | Also save that data to a JSON file    |
| `--validate <off\|warn\|strict>` | Request validation (default `warn`)   |
| `--delay <ms>`                   | Add a delay to each response          |
| `--proxy <url>`                  | Send unknown routes to a real API     |
| `--webhook-url <url>`            | Where to send webhooks                |
| `--watch`                        | Reload when files change              |

## Control a single request

| Header                   | Effect              |
| ------------------------ | ------------------- |
| `Prefer: code=404`       | Return status 404   |
| `Prefer: example=<name>` | Use a named example |
| `X-Mockline-Delay: 500`  | Wait 500 ms         |

## Use in code

```ts
import { createMockServer } from '@zahid15/mockline';

const server = await createMockServer({ spec: './openapi.yaml', port: 0 });
await fetch(`${server.url}/pets`);
await server.close();
```

## Use in tests

```ts
import { useMockline } from '@zahid15/mockline/testing';

const api = useMockline({ spec: './openapi.yaml' }); // starts before, stops after

test('creates a pet', async () => {
  await fetch(`${api.url}/pets`, { method: 'POST', body: '{}' });
  expect(api.received('POST /pets')).toHaveLength(1);
});
```

See [testing](docs/configuration.md#testing) for Vitest setup and matchers.

## Docker

```sh
docker build -t mockline .
docker run --rm -p 4010:4010 -v "$PWD:/data:ro" \
  mockline serve /data/openapi.yaml --host 0.0.0.0
```

## Learn more

- [Configuration](docs/configuration.md)
- [How it works](docs/how-it-works.md)
- [Example project](examples/petstore)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
