# Examples

- `petstore/openapi.yaml` and `petstore/mockline.yaml`: CLI, config, seeded
  stateful CRUD, and a conditional override.
- `programmatic.ts`: typed Node.js library usage. Build Mockline first, install
  the published package or use this repository after building, then run with a TS
  runner such as `pnpm exec tsx examples/programmatic.ts`.

From the repository root, try the CLI example with:

```sh
mockline routes examples/petstore/openapi.yaml
mockline validate examples/petstore/openapi.yaml
mockline serve examples/petstore/openapi.yaml --config examples/petstore/mockline.yaml --port 4010
```

The sample config binds only to `127.0.0.1`. To exercise the conditional
`listPets` override, request `GET /v1/pets?demo=empty`.

- `docker/compose.yaml`: local-only published port and a read-only spec mount.
- `workflows/e2e.yml`: start the published CLI and wait for a healthy server.
