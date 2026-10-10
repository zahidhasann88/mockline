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

## Local review runs

Measured on 2026-10-11 with Node 24.15.0, Windows x64, Intel Core i7-8665U
(1.90 GHz), and 15.8 GiB RAM. Two seconds, five concurrent clients, no warm-up,
validation/recording/inspector disabled, seed 42:

| Response  | Requests |    Throughput |      p50 |      p95 | Failures |
| --------- | -------: | ------------: | -------: | -------: | -------: |
| Example   |    4,044 | 2,020.1 req/s |  1.87 ms |  5.06 ms |        0 |
| Generated |      209 |   103.6 req/s | 45.74 ms | 60.06 ms |        0 |

Both runs returned only HTTP 200. Generated responses include schema validation
on every request, which adds overhead. These short local runs are smoke checks,
not capacity estimates. Add `--generate` to benchmark generated responses.

## Original build report sample run

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
