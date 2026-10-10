# Performance notes

Mockline includes a dependency-free loopback smoke benchmark:

```sh
corepack pnpm benchmark -- --duration 5 --concurrency 10
```

It starts one server with `examples/petstore/openapi.yaml`, disables request
recording/validation/inspector overhead, then issues concurrent Node `fetch`
requests to `GET /v1/pets` for the requested duration. It consumes each response
body and reports successful responses per second, sampled p50/p95 request
latency, status counts, failures, Node version, and platform. Defaults are five
seconds and ten workers; duration is in seconds and concurrency must be a
positive integer.

## Sample run

One 5-second run in the Arena sandbox on 2026-10-10, using Node.js 20.20.2 on
Linux x64:

| Duration | Concurrency | Requests |    Throughput |     p50 |     p95 | Failures |
| -------- | ----------: | -------: | ------------: | ------: | ------: | -------: |
| 5.00 s   |          10 |   12,445 | 2,487.9 req/s | 3.05 ms | 7.65 ms |        0 |

All responses were HTTP 200. This is a single shared-container smoke result,
not a stable performance claim or a production capacity estimate. It has no
warm-up phase, generates no large payloads, and does not model TLS, external
networks, real upstreams, request recording, load balancing, or contention.
Repeat it on your own target hardware, report multiple runs and configuration,
and use a purpose-built load-testing tool for capacity planning. The benchmark
script is intentionally small and adds no runtime dependency.
