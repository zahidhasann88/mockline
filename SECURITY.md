# Security policy

Mockline is intended for local development and tests, not as a production API
server. Keep it bound to loopback unless you understand the exposure. Proxying to
private and link-local addresses is blocked by default; do not enable that guard
for untrusted inputs.

Please report vulnerabilities privately to the repository owner through GitHub's
security advisory feature. Include affected versions, impact, and reproduction
steps. Do not include live credentials in an issue or test fixture.
