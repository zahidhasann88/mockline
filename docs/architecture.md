# Architecture notes

Mockline has a small dependency surface and keeps request handling in Node's
built-in `node:http` server. The main path is:

```text
OpenAPI file
  ├─ validate/dereference + warnings (src/spec/load.ts)
  ├─ compile method/path table (src/router.ts)
  └─ create seeded in-memory stores (src/state/)

HTTP request
  ├─ parse bounded body and apply CORS (src/server.ts)
  ├─ serve inspector, short-circuit preflight, match route, or proxy
  ├─ check declared credentials and validate the request (src/validate.ts)
  ├─ select override/state/example/schema response (src/select.ts)
  ├─ optionally delay, serialize, and write response safely
  └─ record redacted headers, result, validation issues, and duration
```

## Runtime ownership

Each `createMockServer()` call owns its HTTP listener, router/spec references,
state store, deterministic counters, request recorder, proxy-example writer, and
optional file watcher. There is no shared singleton state between server
instances. The returned `close()` stops watching, closes the listener, and
flushes queued file writes; `reset()` clears state and response counters without
clearing recorded request history.

The CLI is a thin adapter for config loading, option validation, log setup,
shutdown signals, and the `init`, `routes`, and `validate` commands. The package
entry point exports server/config/spec/router/generation/validation/state
primitives for programmatic use.

## Reload behavior

`--watch` watches the spec and config file (or the conventional config names).
Changes are debounced. A candidate spec or config is parsed and validated before
its reference is swapped into the live server. Invalid changes are logged and
the last good version stays active. State and request/sequence counters are
reset when the spec changes; state is reset when seed/state/generation settings
change. Host and port remain those of the original listener and cannot be hot
changed.

## Safety boundaries

- Default bind is loopback, and the inspector has no authentication.
- Request bodies are streamed with a byte limit; HTTP request/header timeouts
  are configurable.
- Proxying checks resolved addresses and blocks local/private destinations by
  default; an opt-in is needed for local upstreams. It is a best-effort SSRF
  guard, not a replacement for network egress controls (DNS rebinding is not
  pinned away).
- Hop-by-hop headers are removed and redirects are not followed by the proxy.
- Common credential headers are redacted from request records; request bodies
  and proxied example response bodies are not automatically redacted.
- This is a development/testing tool, not a hardened production API server or
  a replacement for network egress controls.

## Known scope limits

- Swagger 2.0 is rejected; use OpenAPI 3.0 or 3.1.
- Mockline serves HTTP operations, not OpenAPI webhooks or callbacks. It reports
  unsupported/documentation-only features through validation warnings.
- Stateful mode only detects conventional list/create/item REST shapes; it is
  not a general workflow engine or persistent database.
- Binary/non-JSON responses require explicit examples; Mockline does not
  synthesize files or media streams from schemas.
- Authentication checks presence only when enabled; it does not verify tokens
  or authorization policy.
