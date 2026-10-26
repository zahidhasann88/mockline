# How Mockline works

## Which response is sent

The first that applies wins:

1. **Control headers**: `Prefer` or `X-Mockline-*` on the request.
2. **Overrides** from the config.
3. **Stateful data**, for detected collections.
4. **Examples** from the spec.
5. **Generated data** from the schema.

- The status is the lowest `2xx` in the spec, or `default` (sent as 200).
- Unknown paths return `404`. Wrong methods return `405`.
- `Accept` picks the media type. No match returns `406`.
- Non-JSON responses need an example, or return `501`.

## Generated data

- The same seed and path always give the same data.
- Types, formats, limits and required fields are followed. `writeOnly` fields
  are left out.
- If no valid value can be made (e.g. a complex regex), it returns `500`. Add an
  example to the spec for that operation.

## Stateful mode

A collection needs `GET /pets` (returns an array), `POST /pets`, and
`GET /pets/{petId}` (returns one item). Then:

- `PUT`, `PATCH` and `DELETE` on `/pets/{petId}` work too.
- The id field is `id`, `petId`, `uuid` or `_id`, whichever the item has.
- Lists support `limit`/`offset` (if declared) and filters like `?tag=dog`.
- Nested lists like `/users/{userId}/posts` are kept per user.
- Data is in memory, or in a file with `--state-file`.
- `POST /__mockline/reset` restores the starting data.

## Validation

- `off`: no checks.
- `warn` (default): respond anyway, with the header `X-Mockline-Validation: failed`.
- `strict`: reject with `400` (parameters) or `422` (body).

## Inspector

On by default for `127.0.0.1`. It has no authentication.

- `GET /__mockline/health`: status
- `GET /__mockline/spec`: routes and warnings
- `GET /__mockline/config`: current config
- `GET /__mockline/requests`: recent requests (filter by `method`, `path`,
  `status`, `operationId`, `since`, `limit`)
- `DELETE /__mockline/requests`: clear them
- `POST /__mockline/reset`: reset data and counters

## Limits

- For development and tests only. It binds to `127.0.0.1` by default.
- Auth only checks that credentials are present. They are not verified.
- Request bodies are recorded as-is. Credential headers are hidden.
- Swagger 2.0 is converted to OpenAPI 3 when loaded.
- Not supported: webhooks, callbacks, GraphQL and WebSockets.
