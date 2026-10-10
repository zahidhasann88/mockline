# Contributing

Thanks for helping improve Mockline. Node.js 20+ and pnpm 9 are required for
development. Before opening a pull request, run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm schema:config
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm publint
corepack pnpm attw
corepack pnpm pack:check
```

Add focused tests and user-facing documentation for behavior changes. Keep
`src/` strict-TypeScript and free of explicit `any`; preserve loopback defaults,
Node 20 compatibility, and the minimal runtime dependency set. Regenerate
`docs/config.schema.json` after config-schema edits.

Use conventional commits (for example, `fix: respect path-level servers`). Do
not commit credentials, generated coverage, local request records, or temporary
test output. For security issues, follow [SECURITY.md](SECURITY.md) rather than
opening a public issue.
