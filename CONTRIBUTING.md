# Contributing to The Open CRM

Thanks for considering it. A few ground rules keep this sustainable for a
small team:

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` line
(`git commit -s`), certifying the
[Developer Certificate of Origin](https://developercertificate.org/). By
signing off you certify you have the right to contribute the code and that
it may be distributed under this repository's license (AGPL-3.0-or-later)
**and relicensed by the project maintainer** — single-maintainer copyright
is what lets the project offer commercial licensing that funds development.
If that's not acceptable, please open an issue describing your change
instead of a PR.

## What lands easily

- Bug fixes with a failing-then-passing test.
- Features a small business would actually use, matching existing patterns:
  org-scoping via `qs(req)` on every tenant query, idempotent numbered
  migrations, graceful degradation for optional integrations, confirm-first
  writes for anything the AI copilot can do.
- Docs corrections — `API.md` and the SDK reference are kept truthful.

## What needs an issue first

New dependencies, new tables, anything touching auth/billing/tenant
isolation, and vertical-specific features (those usually belong in tenant
config, not core — see the white-label profile pattern).

## Dev setup

`SETUP_GUIDE.md` for the full walkthrough. Tests: `cd backend && npm test`
(Vitest; the pool is mocked — no database needed) and
`cd frontend && npm test`. Both suites must be green; PRs run them in CI.

## Mirror note

This repository is a curated mirror synced by squash commits, so PRs may be
integrated internally and land here in the next sync with attribution in
the commit message rather than a merge bubble. Your `Signed-off-by` and
authorship are preserved in the sync notes.
