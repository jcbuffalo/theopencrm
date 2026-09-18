# Security Policy

## Reporting a vulnerability

Please email **johncolesassistant@gmail.com** with subject line
`[SECURITY] The Open CRM` — include reproduction steps and impact. You'll
get an acknowledgment within 3 business days. Please give us a reasonable
window to ship a fix before public disclosure; we'll credit you in the fix
notes unless you prefer otherwise.

Please do NOT open public GitHub issues for security reports, and do not
test against the hosted service (app.theopencrm.com) with accounts or data
you don't own.

## Scope notes for researchers

- Multi-tenant isolation is the crown jewel: every tenant query is scoped
  through the `qs(req)` helper (see `API.md`). Cross-org data access is
  always in scope and treated as critical.
- The plugin sandbox (`isolated-vm`) threat model is documented in
  `THREAT_MODEL.md` §5 — escapes and quota bypasses are in scope.
- Self-hosted deployments are configured by their operators; findings that
  amount to "the operator can misconfigure X" are appreciated as hardening
  suggestions rather than vulnerabilities.

## Supported versions

The `main` branch of this mirror and the current hosted release. Fixes ship
forward only.
