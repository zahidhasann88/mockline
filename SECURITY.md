# Security policy

Mockline is intended for local development, tests, and demos—not as a
production API server or authorization system.

## Safe use

- Keep the bind address at the loopback default (`127.0.0.1`) unless you
  deliberately need network access.
- The inspector has no authentication. It is disabled on non-loopback binds by
  default; do not opt it in on a public or untrusted interface.
- `--enforce-auth` only checks that a credential declared in the OpenAPI
  security scheme is present. It never verifies tokens, keys, scopes, or
  permissions.
- Proxying blocks local/private destinations by default, but that check is a
  best-effort SSRF guard and does not replace network egress controls. DNS
  rebinding is not pinned away. Only configure trusted upstreams, and opt into
  private destinations only when necessary.
- Request-record headers are redacted by default, but request bodies and proxy
  response examples are not automatically redacted. Protect generated files and
  avoid recording sensitive payloads.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for
the repository, once enabled. Include affected versions, impact, and
reproduction steps; do not include live credentials or personal data. Please do
not open a public issue for an unpatched vulnerability.
