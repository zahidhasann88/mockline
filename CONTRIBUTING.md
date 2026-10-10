# Contributing

Thanks for helping improve Mockline. Before opening a pull request:

1. Install Node.js 20 or 22 and pnpm (`corepack enable`).
2. Run `pnpm install`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Add or update focused tests and user-facing documentation for behavior changes.
4. Keep the implementation dependency-light, typed, and compatible with Node 20.

Use conventional commits (for example, `fix: respect path-level servers`). Do not
commit credentials, generated coverage, or local record files. For security
issues, please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.
