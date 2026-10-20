# Releasing

npm package: `@zahid15/mockline`. GitHub: `zahidhasann88/mockline`.

## Each release

1. Run the checks listed in the README.
2. Run `corepack pnpm schema:config` and review `npm pack --dry-run`.
3. Update the version in `package.json` and add a `CHANGELOG.md` entry.
4. Commit, push, and wait for CI on `main` to pass.
5. Push an annotated tag `v<version>`. The release workflow does the rest.

Never move a tag that has already been published.

## One-time setup

- **First npm publish:** run `npm login` and `npm publish --access public`
  locally. Later releases publish from CI.
- **Trusted publishing:** in the npm package settings, add GitHub as a trusted
  publisher (repo `mockline`, workflow `release.yml`, environment `npm`). Then
  set the repository variable `PUBLISH_TO_NPM=true`.
- **Docker image (optional):** set `PUBLISH_DOCKER=true` to publish
  `ghcr.io/zahidhasann88/mockline`.
