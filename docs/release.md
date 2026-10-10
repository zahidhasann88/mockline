# Release checklist

The repository deliberately has no git remote and the package/GitHub identity is
a template. Do not tag or publish until the publisher has configured the real
identity and reviewed the diff.

## One-time setup

1. Replace `@your-github-username/mockline` in `package.json` and examples with
   the publisher's available lowercase npm scope. Keep the CLI binary name
   `mockline`; the unscoped npm name is taken.
2. Replace `YOUR_GITHUB_USERNAME` in the package repository, bugs, and homepage
   URLs and update `LICENSE`'s `YOUR NAME` copyright holder.
3. Create the GitHub repository and configure npm trusted publishing for that
   exact GitHub owner/repository and `.github/workflows/release.yml`. No
   long-lived npm token is required. The release job grants `id-token: write`
   and runs `npm publish --provenance --access public` from Node 22 with a
   recent npm CLI.
4. Enable GitHub Actions and grant the repository's `GITHUB_TOKEN` permission
   to publish packages to GHCR. Confirm repository/package visibility and
   naming. The release workflow publishes `ghcr.io/<owner>/<repository>` with
   the version tag and `latest`.
5. Confirm the license holder, README claims, changelog, security contact, and
   package contents. Do not commit secrets or generated request/response logs.

## Before each release

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

Review the test coverage output, `npm pack` contents, `CHANGELOG.md`, config
schema, and Docker build. Update `package.json`'s version and changelog, commit,
then create and push a matching `v<version>` tag. The tag triggers CI checks;
after they pass, the release workflow publishes npm provenance, creates the
GitHub Release, and pushes the GHCR image. Publishing requires the one-time npm
trusted-publisher configuration above; this template intentionally has no
registry token.
