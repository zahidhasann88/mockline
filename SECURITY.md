# Security

Mockline is for local development and tests. It is not a production server.

- It binds to `127.0.0.1` by default. Keep it that way unless you need network access.
- The inspector has no authentication.
- `--enforce-auth` only checks that credentials are present. It does not verify them.
- Request bodies and proxy recordings are not redacted.

To report a vulnerability, use
[GitHub Security Advisories](https://github.com/zahidhasann88/mockline/security/advisories/new).
Please don't open a public issue.
