# Configuration reference

Mockline reads an explicit file passed by `--config`, or discovers the first
`mockline.yaml`, `mockline.yml`, or `mockline.json` in the current directory.
The config is validated at startup; malformed config is an error rather than
silently falling back to defaults. CLI options override matching values.

The editor schema is [`config.schema.json`](config.schema.json). Regenerate it
after changing `src/config/schema.ts` with `corepack pnpm schema:config`.

## Top-level fields

| Field              | Default          | Meaning                                                                         |
| ------------------ | ---------------- | ------------------------------------------------------------------------------- |
| `port`             | `4010`           | TCP port; `0` requests an ephemeral port.                                       |
| `host`             | `127.0.0.1`      | Bind address. Non-loopback addresses expose the mock to other hosts.            |
| `seed`             | `0` when omitted | Base for deterministic response generation.                                     |
| `prefer`           | `example`        | `example` selects documented examples first; `generate` generates from schemas. |
| `latency`          | `0`              | Delay in milliseconds; see [Latency and errors](#latency-and-errors).           |
| `validate`         | `warn`           | `off`, `warn`, or `strict` request validation.                                  |
| `enforceAuth`      | `false`          | Require declared security credentials to be present. Does not verify them.      |
| `requestBodyLimit` | `1048576`        | Maximum request-body size in bytes.                                             |
| `requestTimeoutMs` | `30000`          | HTTP request/header timeout in milliseconds.                                    |

## Nested fields

### `errors`

```yaml
errors:
  rate: 0.05
  statuses: [500, 503]
  perOperationRates:
    createPet: 0.2
```

`rate` and operation-specific rates are between 0 and 1. An operation-specific
entry takes precedence over `rate`; `statuses` is the pool used for injected
failures. `X-Mockline-Error: true` forces the first configured status.

### `stateful`

```yaml
stateful:
  enabled: true
  seedItems: 3
  idProperty: id
```

Stateful behavior is in-memory and only activates for structurally detected
REST collections (see [Stateful mode](../README.md#stateful-mode)). Numeric IDs
are allocated for numeric schemas; string IDs are generated from the declared
schema. `seedItems` must be a non-negative integer.

### `generation`

```yaml
generation:
  hints: true
  counter: false
  maxDepth: 3
  minArrayItems: 1
  maxArrayItems: 3
```

- `hints` enables field-name hints, or supplies a map of property names to
  string/number/boolean/null/primitive-array values. Hints are applied only
  where a schema does not already constrain the generated value.
- `counter` varies generation by per-operation request count. The default is
  repeatable output for the same seed and operation.
- `maxDepth` bounds recursive schemas (0–20).
- `minArrayItems` and `maxArrayItems` bound generated array lengths. Use
  non-negative integers; keep the minimum no greater than the maximum.

### `overrides`

Overrides are keyed by `operationId` or by a case-insensitive `METHOD /path`
key. Fixed overrides can set `status`, `body`, `headers`, and `delay`:

```yaml
overrides:
  listPets:
    status: 200
    body:
      - id: 1
        name: Fixed response
```

A `sequence` provides successive responses; it holds on the last item by
default, or cycles with `loop: true`:

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

Conditional `rules` are checked in order; the first matching rule wins. A
single `when`/`response` pair is also supported. Condition locations are
`query`, `header`, and `body`; operations are `eq` (default), `contains`, and
`regex`:

```yaml
overrides:
  listPets:
    rules:
      - when: { location: query, name: demo, op: eq, value: empty }
        response: { status: 200, body: [] }
      - when: { location: header, name: x-fixture, op: contains, value: pets }
        response: { status: 200, body: [{ id: 7, name: Matched }] }
```

For a body condition, `name` may be a dotted property path such as `user.id`
or a JSON Pointer-like path such as `/user/id`. Regex conditions use JavaScript
regular-expression syntax; keep config patterns simple and trusted.

### `proxy`

```yaml
proxy:
  url: https://api.example.test/v1
  all: false
  allowPrivate: false
  timeoutMs: 5000
  recordFile: ./proxy-examples.json
```

With `all: false`, only unmatched requests are proxied. `all: true` forwards all
non-inspector requests. The upstream must use HTTP(S). Private/loopback/link-
local destinations are blocked unless `allowPrivate` is explicitly enabled.
`timeoutMs` is a positive integer. `recordFile` stores upstream response
examples as JSON.

### `cors`

```yaml
cors:
  enabled: true
  origins: ['*']
```

CORS is enabled by default for local development. `origins` accepts exact
origin strings; `*` allows any origin. Disable it with `--no-cors` or set
`enabled: false`.

### `recording`

```yaml
recording:
  enabled: true
  file: ./mockline-records.jsonl
  maxRequests: 500
  redactHeaders: [authorization, cookie, set-cookie, x-api-key, api-key]
```

Records are kept in a bounded in-memory ring. If `file` is set, each record is
also appended as JSONL. Common credential headers are always redacted; this list
adds more names. Header-name matching is case-insensitive. Request bodies are
not redacted—use a private file and avoid recording sensitive payloads.

### `controlHeaders`

```yaml
controlHeaders:
  allow: true
```

When enabled, `Prefer` and `X-Mockline-*` control headers can influence example,
status, delay, and injected-error selection. Disable them when requests come
from clients that must not control mock behavior.

### `inspector`

```yaml
inspector:
  enabled: false
```

On a loopback bind the inspector is enabled by default unless explicitly set to
`false`. On non-loopback binds it is disabled by default unless explicitly set
to `true` (or `--inspector` is passed). It has no authentication; expose it only
on a trusted interface.

## Latency and errors

Latency accepts a fixed number, a two-number inclusive range, or a distribution
object:

```yaml
latency: 25
# or: latency: [10, 80]
# or:
# latency:
#   min: 10
#   max: 80
#   distribution: normal  # uniform (default) or normal
# A fixed form is also available: latency: { fixed: 25 }
```

CLI `--delay` accepts a fixed number or `min-max` range and overrides config
latency. `X-Mockline-Delay` (when control headers are allowed) has higher
precedence than a per-override delay, which has higher precedence than global
latency.

## Example files

- [`../examples/petstore/mockline.yaml`](../examples/petstore/mockline.yaml)
- [`../examples/petstore/openapi.yaml`](../examples/petstore/openapi.yaml)
- [`../README.md`](../README.md) for CLI, API, security, and Docker usage.
