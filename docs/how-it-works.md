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
- Requests under a user that doesn't exist return `404`, and deleting a user
  deletes their posts. Turn this off with `stateful.relations: false`.
- Data is in memory, or in a file with `--state-file`.
- `POST /__mockline/reset` restores the starting data.

## Callbacks and webhooks

- **Callbacks**: after a `2xx` response, Mockline sends each callback the
  operation declares. URLs like `{$request.body#/callbackUrl}` are filled in
  from the request and response.
- **Webhooks**: sent on demand with `POST /__mockline/webhooks/{name}` or
  `server.sendWebhook(name)`.
- Payloads come from examples or the schema.
- `localhost` is allowed. Other private addresses are blocked unless
  `events.allowPrivate` is on.
- Sent events are listed at `GET /__mockline/events` and `server.events()`.
  Use `await server.events.wait()` in tests.

## Auth

Auth checks run when `enforceAuth` is on or any `auth` value is set.

- With no `auth` values, a credential only has to be present.
- API keys, basic credentials and bearer tokens must match the configured
  values.
- JWTs are verified with `auth.jwtSecret`, including `exp` and `nbf`.
- Scopes from the spec's `security` are checked against the JWT's `scope`,
  `scp` or `scopes`.
- A missing or wrong credential returns `401`. A missing scope returns `403`.

## Recording

`mockline record <url>` forwards every request to the real API and saves each
response as an example in a copy of your spec.

- Only paths in the spec are recorded. Others are logged and skipped.
- The newest recording comes first, so it is what `serve` returns. Older ones
  stay available with `Prefer: example=recorded-2`.
- Identical responses are skipped, with at most 10 per response.
- Comments and `$ref`s in the spec are kept. Responses defined with `$ref` are
  not changed.
- An existing single `example` is moved to `examples.original`.

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
- Auth checks are for testing, not real security.
- Request bodies are recorded as-is. Credential headers are hidden.
- Swagger 2.0 is converted to OpenAPI 3 when loaded.
- Not supported: GraphQL and WebSockets.
