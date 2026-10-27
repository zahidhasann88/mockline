# Changelog

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
