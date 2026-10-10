# Changelog

All notable changes to Mockline are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-10

### Added

- OpenAPI 3.0/3.1 YAML and JSON loading, route compilation, validation, summaries,
  and warnings for unsupported mocking features.
- Example selection and deterministic JSON Schema response generation with
  reusable schemas, composition, formats, constraints, hints, and recursion
  depth limits.
- Request validation modes, conditional/sequence response overrides, latency,
  and injected errors.
- Optional stateful REST collections, pagination, reset, and CRUD operations.
- In-memory and JSONL request recording with credential-header redaction, plus
  the local inspector API.
- Guarded HTTP(S) proxying, proxy-response example capture, and debounced
  OpenAPI/config hot reload.
- A CLI, typed ESM library API, generated configuration schema, tests, examples,
  Docker image, CI, npm provenance/GHCR release workflow, and benchmark notes.
