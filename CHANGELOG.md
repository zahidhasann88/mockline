# Changelog

## [Unreleased]

### Changed

- Requires Node.js 22.22 or later. Node.js 20 is end of life; stay on 0.5.x if
  you need it.
- Upgraded dependencies, including zod 4, faker 10, chokidar 6, cac 7 and
  swagger-parser 13. Generated data for a given seed may differ from 0.5.x.
- `config.schema.json` now lists settings at the top level instead of under
  `definitions`.
- For Vitest 5, add `toHaveReceived` types with `interface Matchers<R, T> extends
MocklineMatchers<R, T>` (see the testing docs).

### Fixed

- Types used in the public API, such as `JsonSchema`, `MatchedRoute` and
  `MockResponse`, are now exported.

## [0.5.0] - 2026-10-27

### Added

- `mockline record <url>`: proxy a real API and save its responses as examples
  in a copy of your spec (`proxy.recordSpec`), then replay them with `serve`.
- `generation.locale` and `--locale`: fake names and addresses in other
  languages, such as `de`, `fr`, `ja` or `pt_BR`.

## [0.4.0] - 2026-10-27

### Added

- Response templates: override bodies and headers can use request values, e.g.
  `{{request.path.petId}}`, `{{request.body.name}}`, `{{now}}` and `{{uuid}}`.
- Stateful relations: requests under a parent that doesn't exist return 404, and
  deleting a parent deletes its nested items. Turn off with `stateful.relations: false`.

### Changed

- Nested collections now require the parent item to exist (see above).

### Fixed

- The `config` option of `createMockServer` no longer requires fields that have
  defaults, such as `op` in override rules.

## [0.3.0] - 2026-10-27

### Added

- Callbacks: after a `2xx` response, Mockline sends the callbacks declared in the spec.
- Webhooks: send spec webhooks with `POST /__mockline/webhooks/{name}` or
  `server.sendWebhook()`, with `--webhook-url` or `events.webhooks` for targets.
- `server.events()` and `GET /__mockline/events` list sent callbacks and webhooks.
- Auth checks with the new `auth` config: API keys, basic credentials, bearer
  tokens, and JWTs (HS256/384/512) with expiry and scopes. Missing scopes return 403.
- `--no-callbacks` turns callbacks off.

### Changed

- Specs with callbacks or webhooks no longer show "not supported" warnings.

## [0.2.0] - 2026-10-27

### Added

- Save stateful data to a JSON file with `--state-file` (`stateful.file`).
- Start collections from your own data with `--seed-data` (`stateful.seed`).
- Nested collections such as `/users/{userId}/posts`, with items kept per parent.
- Id properties named after the path parameter (`petId`), `uuid` or `_id`.
- Filter lists by item fields, e.g. `GET /pets?tag=dog`.
- Swagger 2.0 support (converted to OpenAPI 3 on load).
- Test helpers: `useMockline()` and the `toHaveReceived` matcher from
  `@zahid15/mockline/testing`.
- `mockline serve` logs each request.
- `serve`, `routes` and `validate` use `openapi.yaml` from the current folder when
  no file is given.

### Fixed

- Column alignment in `mockline routes` output.

## [0.1.1] - 2026-10-11

### Changed

- Package is now published as `@zahid15/mockline`.
- Docker image uses Node.js 25.

### Fixed

- `mockline` command path after a global npm install.
- Colored CLI output and line endings on Windows.

## [0.1.0] - 2026-10-10

### Added

- First release: OpenAPI 3.0/3.1 mock server and TypeScript library.
- Spec examples and seeded data generation from schemas.
- Request validation, overrides, delays and injected errors.
- In-memory CRUD collections.
- Request recording, inspector API, proxy and hot reload.
- CLI and Docker image.
