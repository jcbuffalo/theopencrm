# The Open CRM

**A full, open-source CRM with an AI copilot as the front door.**
Self-host it free under the AGPL-3.0, or use the managed cloud at
[app.theopencrm.com](https://app.theopencrm.com) from $15/seat.

The incumbents charge $90–100 a seat for tools you hunt through, meter your
contacts, and lock your data into their ecosystem. The Open CRM is the
opposite bet: a lean, complete core you own, an AI copilot that actually does
the work, and the freedom to build whatever you need on top.

## What's in the box

- **Core CRM** — companies, contacts, leads with public capture forms, deals
  on editable multi-pipeline Kanban boards (per-org stages, multiple pipelines
  via `deal_type`), activities, tasks (incl. recurring), meetings.
- **Chat-first AI copilot** — a conversational front door with ~50 tools:
  read anything, propose any write (every change is confirm-first — the
  copilot never writes without an explicit Apply), build reports, automations,
  custom fields, and pipelines from plain English.
- **Revenue tooling** — quotes + product catalog (CPQ), deal line items with
  revenue/cost kinds and per-deal margin, forecasting, commission plans
  (rep and partner/channel), custom report builder, dashboards.
- **Customer success** — account 360 timelines, health scores, renewals,
  playbook checklists (lifecycle- and deal-stage-triggered), NPS/CSAT surveys,
  support cases with SLAs, win-back, a tokenized customer portal (cases,
  quote approvals, messages, document uploads).
- **Automation** — rule engine (stage triggers, idle deals, overdue tasks,
  offsets from any custom date field), email sequences, background workers.
- **Extensibility** — REST API with personal access tokens, outbound
  webhooks, custom fields, sandboxed JavaScript plugins (isolated-vm; see
  [PLUGIN_SDK_REFERENCE.md](./PLUGIN_SDK_REFERENCE.md)) you can generate
  from a chat prompt, plus a curated extension library.
- **Switching?** — HubSpot and Salesforce CSV import presets with automatic
  column and stage mapping.
- **Enterprise-leaning bits already here** — SSO (OIDC) + SCIM, TOTP 2FA,
  append-only audit log, per-org feature flags, white-label branding,
  GDPR export/deletion tooling.

## Self-hosting (quick version)

Node 18 + PostgreSQL 15. Full walkthrough: [SETUP_GUIDE.md](./SETUP_GUIDE.md)
and [QUICKSTART.md](./QUICKSTART.md).

```bash
# backend
cd backend && npm install && npm run dev     # :5001
# frontend (second terminal)
cd frontend && npm install && npm start      # :3000
```

Migrations run automatically on production boot. Optional integrations
(email, AI, object storage, QuickBooks, Stripe, Google/Microsoft sync)
detect missing configuration and degrade gracefully — the app runs fine
with none of them.

**AI:** bring your own Anthropic API key (`ANTHROPIC_API_KEY`, or per-org
keys in-app) and pay Anthropic directly — no markup, no middleman. Prefer
zero key management? The hosted cloud meters AI usage pay-as-you-go.

## Hosted cloud

Same codebase, zero ops: [app.theopencrm.com](https://app.theopencrm.com) —
free to start, $15/seat Starter, $39/seat Pro, AI usage metered with a
monthly spending cap you control. Hosting revenue is what funds this
project's development.

## License

[GNU AGPL-3.0-or-later](./LICENSE). You can run, modify, and self-host it
freely; if you host a modified version for others, the AGPL requires you to
share your modifications with your users. Docs for policies we run the
hosted service under are in [`legal/`](./legal/).

## Security

Please report vulnerabilities responsibly — see [SECURITY.md](./SECURITY.md).
The threat model we build against is documented in
[THREAT_MODEL.md](./THREAT_MODEL.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO sign-off required). Issues and
PRs welcome — the roadmap favors things a small business would actually use.

---

*This is a curated mirror of the working repository, synced by squash
commits. Internal operational documents are not published; everything needed
to run, audit, and extend the product is.*
