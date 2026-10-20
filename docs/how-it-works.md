# How Mockline works

## Request flow

```text
OpenAPI file  → validate + dereference → route table → in-memory stores

HTTP request  → parse body, CORS → match route (or proxy)
              → check credentials, validate request
              → pick a response → optional delay → send → record
```

Unknown paths return `404`; wrong methods return `405` with an `Allow` header.
Strict validation runs first and can reject a request before any response is
picked.

## Which response is sent

Mockline checks these sources in order and uses the first that applies:

1. **Control headers** – `Prefer` / `X-Mockline-*` request a status, a named
   example, an error, or a delay.
2. **Config overrides** – by `operationId` or `METHOD /path`; rules, then a
   sequence or fixed response.
3. **In-memory state** – CRUD for detected collections (see below).
4. **Spec examples** – named example, media example, then schema examples.
5. **Schema generation** – deterministic JSON from the schema.

The default status is the lowest declared `2xx`, then `default` (sent as 200).
`Accept` picks the media type; no match returns `406`. Non-JSON media with no
example returns `501`. Injected errors (`errors.rate`) can replace any response.

## Generated data

- The same seed, method and path always produce the same body, unless
  `generation.counter` is on.
- Dates use a fixed 2020-01-01 reference, so output does not drift.
- Types, formats, limits, required fields, arrays, compositions and references
  are respected. `writeOnly` fields are left out of responses.
- Every generated value is validated against its schema. If no valid value is
  found, the server returns `500` instead of invalid data.
- Complex regexes or tight composition rules may fail to generate. Add an
  example to the spec for those operations.

## Stateful mode

A collection is detected when the spec has all of:

- `GET /things` returning an array
- `POST /things`
- `GET /things/{id}` returning the same item shape, with an `id` property

`PUT`, `PATCH` and `DELETE` on `/things/{id}` then work too. Three items are
seeded by default. `PATCH` is a shallow merge, `DELETE` returns `204`, and
missing items return `404`. `limit`/`offset` query parameters paginate lists.

State lives in memory only: it is lost on restart and has no relations or
transactions. `reset()` or `POST /__mockline/reset` restores the seed data.

## Request validation

- `off`: no validation.
- `warn` (default): serve the response anyway, add
  `X-Mockline-Validation: failed`, and record the issues.
- `strict`: reject with `application/problem+json` (`400` for parameters or
  content type, `422` for the body).

## Inspector

Enabled by default on loopback hosts. It has no authentication.

| Method   | Path                       | Purpose                                                                                 |
| -------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/__mockline/health`       | Health and operation count.                                                             |
| `GET`    | `/__mockline/spec`         | Spec summary and warnings.                                                              |
| `GET`    | `/__mockline/config`       | Effective config (secrets redacted).                                                    |
| `GET`    | `/__mockline/requests`     | Recent requests. Filter by `method`, `path`, `status`, `operationId`, `since`, `limit`. |
| `GET`    | `/__mockline/requests/:id` | One request.                                                                            |
| `DELETE` | `/__mockline/requests`     | Clear in-memory history.                                                                |
| `POST`   | `/__mockline/reset`        | Reset state and counters.                                                               |

The last 500 requests are kept in memory. `--record-file` also writes them to a
JSONL file.

## Watch mode

`--watch` reloads the spec and config on change. Invalid changes are logged and
the last good version keeps running. Host and port cannot change while running.

## Safety and limits

- Binds to `127.0.0.1` by default. The inspector has no authentication.
- Request bodies have a size limit; request timeouts are configurable.
- The proxy blocks private and loopback addresses unless `allowPrivate` is set.
  It is a basic guard, not a replacement for network controls.
- Credential headers are redacted in records; request bodies are not.
- Auth checks only that credentials are present; tokens are not verified.
- Not supported: Swagger 2.0, webhooks, callbacks, GraphQL and WebSockets.

Mockline is a development and testing tool, not a production API server.
