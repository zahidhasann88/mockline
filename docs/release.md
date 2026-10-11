# Releasing Mockline

GitHub repository: zahidhasann88/mockline. npm package: @zahid15/mockline.
The CLI remains mockline. The npm account must own the zahid15 scope.

## First npm publication

Push the repository and wait for all CI jobs. npm trusted publishing is configured
from an existing package's settings. For a new package, first publish the checked
0.1.0 build interactively from your own npm account with npm login and npm publish
--access public. Review npm pack --dry-run before publishing. Do not upload npm
credentials to GitHub. This first local publication does not carry Actions OIDC
provenance; future CI publications do.

After the package exists, add a GitHub trusted publisher in its npm settings:
owner zahidhasann88, repository mockline, workflow release.yml, environment npm.
Allow npm publish. Create the npm GitHub environment and repository variable
PUBLISH_TO_NPM=true. The workflow uses Node 22 and npm 11 with id-token: write.
See https://docs.npmjs.com/trusted-publishers/ for current registry requirements.

GHCR publication is separate: enable repository variable PUBLISH_DOCKER=true
only when ready. The image is ghcr.io/zahidhasann88/mockline. GitHub release
assets are created independently of npm/GHCR publication.

## Each release

Run the checks documented in CONTRIBUTING.md. Regenerate the config schema,
review tarball contents, update package.json and CHANGELOG.md, commit and push.
Only after main CI passes, push a matching annotated v<version> tag. Release
checks validate the tag/version before publishing and test the tagged checkout.
An existing npm version is skipped on retries. Manual dispatch accepts an
existing tag; it never changes where that tag points. Never move a published tag.
