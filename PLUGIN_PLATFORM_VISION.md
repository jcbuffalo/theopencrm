# Plugin Platform Vision — The Open CRM

> **Strategic design document.** This frames *what we're building toward*,
> not what's in production today. Use it to inform near-term decisions
> (Phase 4+ scope, Module-toggle granularity, route boundaries, schema
> stability) so we don't accidentally close doors we want left open.
>
> **Status:** draft v1, 2026-05-12. Owner: John Coles.

---

## 1. The thesis

The Open CRM beats HubSpot, Salesforce, and Pipedrive on two axes:

1. **Price.** Per-user license cost ≥ 50% below the equivalent tier
   from those incumbents. We can do this because we're a JS monolith
   on Cloud Run with one Postgres — our cost-per-user is ~$2-4/month
   versus their ~$15-30/month bloat from sales orgs and acquisitions
   debt.
2. **Customizability without coding.** Every user can build their own
   plugins and campaigns by describing what they want in natural
   language to Claude. The CRM tailors itself to each business —
   without requiring a developer, an admin certification, or a
   six-week implementation project.

This combination is **the unfair advantage**. Cheap-but-rigid CRMs
exist (Pipedrive, Zoho). Customizable-but-expensive CRMs exist
(HubSpot, Salesforce). Customizable *and* cheap *and* AI-native is the
gap we own.

The three load-bearing constraints, in order of how much they matter:

1. **The business model pays for itself at every tier.** Free tier
   exists to drive funnel but doesn't burn unbounded compute. Paid
   tiers cover compute + AI cost + margin.
2. **Multi-tenant integrity is never breakable by a single user's
   plugin.** Sloppy or malicious user code can degrade only the org
   that owns the plugin — never the platform, never other orgs.
3. **The UX is friendly to non-coders.** A salesperson at a 10-person
   distributor can build a working plugin without seeing code. A
   developer can drop to code when they want, but it's not required.

If any of those three fails, the whole thesis breaks. Plugin platform
work that violates any of them is rejected, period.

---

## 2. Pricing model

### 2.1 Competitor benchmarks (2026)

| Competitor | Entry tier | Pro tier | Enterprise |
|---|---|---|---|
| HubSpot Sales Hub | $50/user/mo | $100/user/mo | $150+/user/mo |
| Salesforce Sales Cloud | Starter $25 → Pro $80 | Enterprise $165 | Unlimited $330 |
| Pipedrive | $14 (Essential) | $49 (Pro) | $99 (Power) |
| Zoho CRM | $14 (Standard) | $35 (Pro) | $52 (Ultimate) |
| Freshsales | $9 (Growth) | $39 (Pro) | $59 (Enterprise) |

### 2.2 The Open CRM proposed tiers

Numbers below are **proposals for owner sign-off**; final pricing is
decided by the operator. All are at least 50% below the equivalent
HubSpot tier, and competitive against the Pipedrive/Zoho price floor.

| Tier | Per user/month | Free seat cap | Limits | Key features |
|---|---|---|---|---|
| **Free** | $0 | 1 user | 100 contacts, 10 deals, no AI, no integrations | Pipeline, contacts, basic reports |
| **Starter** | **$15** | up to 10 users | 10K contacts, unlimited deals, 500 AI requests/user/month | Everything in Free + Quotes + Documents + Email integration + Limited automation |
| **Professional** | **$39** | up to 50 users | 100K contacts, 5K AI requests/user/month | Everything in Starter + Vendor RFQ + Submittals + Change Orders + QuickBooks + Reports + **Custom plugins** + **AI campaigns** |
| **Enterprise** | **Custom ($80-150)** | unlimited | quotas negotiable | Everything in Pro + Dedicated support + SLA + On-prem option + Plugin marketplace publish + Audit logs export |

**Why these numbers:**

- **Starter at $15** matches Pipedrive Essential / Zoho Standard floor.
  HubSpot Sales Hub Starter at $50 is the explicit comparator → we're
  70% below.
- **Pro at $39** is the *real* product. AI features, vendor RFQ, the
  whole Zang-flow surface. HubSpot Pro at $100 → 61% below. The Pro
  margin is where the business lives.
- **Enterprise custom** matches incumbent practice; gives sales lever
  for orgs that want SLAs, on-prem, dedicated support.
- **Free seat cap of 1** is deliberate. Hubspot's "free forever" tier
  loses them money on shared-team usage; we cap at solo-user so the
  funnel stays sustainable.

### 2.3 Plugin / campaign usage layer

Some of the most valuable features are *variable cost* — each Claude
call costs us real dollars. Per-tier quotas:

| Tier | AI requests / user / month | Plugin runs / org / month | Overage |
|---|---|---|---|
| Free | 50 | 100 | Blocked (upgrade required) |
| Starter | 500 | 5,000 | $0.02 per AI request, $0.001 per plugin run |
| Pro | 5,000 | 50,000 | $0.01 per AI request, $0.0005 per plugin run |
| Enterprise | Negotiated | Negotiated | Negotiated |

These quotas are tracked by `services/usageMeter.js` (Phase B below)
and enforced at every Claude call + every plugin invocation.

### 2.4 Unit economics

**Cost per user per month (our side):**

| Cost driver | $/user/month |
|---|---|
| Cloud Run compute | $0.30-0.80 (auto-scales with traffic) |
| Cloud SQL share | $0.50-1.00 (one DB, amortized) |
| GCS storage | $0.05-0.20 |
| Email (SendGrid/Gmail) | $0.05-0.15 |
| AI inference (Claude) — at quota | $0.30 (Starter), $1.50 (Pro) |
| Misc (DNS, monitoring) | $0.10 |
| **Total** | **$1.30-3.75** |

**Margin per tier:**

| Tier | Revenue | Cost | Margin | Margin % |
|---|---|---|---|---|
| Free | $0 | $1.30 | -$1.30 | (acquisition cost) |
| Starter | $15 | $2.50 | $12.50 | 83% |
| Pro | $39 | $3.75 | $35.25 | 90% |
| Enterprise | $100 (est) | $5.00 | $95.00 | 95% |

The free-tier burn is funded by Starter+ conversions. Free-to-Starter
conversion at >5% breaks even at scale.

### 2.5 What the website should say

Replace the current `Landing.js` placeholders (currently "TBD") with
the Starter/Pro/Enterprise numbers above plus the Free tier as a
fourth column. Wait until plugin/campaign UI is at least in beta
before claiming "custom plugins" as a Pro feature — under-promising
on the website is fine.

---

## 3. The plugin & campaign system

### 3.1 Definitions

- **Plugin:** a persistent extension that adds functionality to one
  org's CRM. Examples: a custom field on the contact record, a custom
  workflow step, a custom report, a custom integration with the user's
  Slack workspace.
- **Campaign:** a *time-based* or *trigger-based* sequence of actions.
  Examples: "30-day follow-up sequence after a quote is sent," "Send
  a survey 14 days after a deal closes," "Daily digest of stalled
  deals to the sales lead."

Plugins are **what the system can do**; campaigns are **when it does
them**. A campaign typically invokes one or more plugins.

### 3.2 Three creation paths

Different user comfort levels need different on-ramps:

1. **Conversational** (default, non-coder)
   - User: "Help me build a plugin that emails my warehouse when a
     deal moves to COORDINATE stage."
   - Claude: generates the plugin spec in JSON + a plain-English
     summary of what it'll do.
   - User: reviews summary, clicks "Deploy."
   - System: validates spec, installs to user's org sandbox.

2. **Library** (faster than conversational for common cases)
   - User browses pre-built plugins/campaigns at `/plugins/library`.
   - One-click install. Customize fields via a form, not code.
   - Examples: "QuickBooks contact sync," "30-day vendor price
     validation," "Weekly stalled-deal digest."

3. **Code** (power users + contractors)
   - Open the plugin editor at `/plugins/:id/edit`.
   - Write JavaScript directly against a documented `crm` SDK.
   - Same sandbox + quota rules apply.

The library is the **fastest path to value**; conversational is the
**broadest path** (covers cases the library doesn't); code is the
**deepest path** (covers cases conversational can't precisely
describe).

### 3.3 What a plugin looks like in code

```js
// User's plugin: "Email warehouse when deal hits COORDINATE"
// File: org/<orgId>/plugins/notify-warehouse/index.js

module.exports = {
  on: { event: 'deal.stage_changed', stage: 'COORDINATE' },
  async run({ deal, crm, logger }) {
    const customer = await crm.companies.get(deal.customer_id);
    await crm.email.send({
      to: 'warehouse@example.com',
      subject: `Deal ${deal.external_ref} ready to ship`,
      body: `Customer: ${customer.name}\nShip to: ${deal.ship_to}`,
    });
    logger.info('warehouse_notified', { dealId: deal.id });
  },
};
```

The `crm` SDK is intentionally narrow. It exposes only:

- `crm.companies` / `crm.contacts` / `crm.deals` / `crm.quotes` /
  `crm.purchase_orders` / `crm.invoices` — typed CRUD scoped to the
  user's org
- `crm.email.send({ to, subject, body })` — uses the platform's
  outbound email (rate-limited, marked as plugin-sent)
- `crm.http.fetch(url, options)` — egress proxy with per-plugin
  quota; only HTTPS, no internal IPs
- `crm.ai.complete(prompt)` — Claude inference; counts against the
  org's AI quota
- `crm.storage.put / .get` — small KV scratchpad per plugin

What the SDK does **not** expose:

- Filesystem
- `require()` of arbitrary modules
- `process.*`
- DB access outside the user's org
- Network access to internal IPs (169.254.x, 10.x, 192.168.x,
  127.x, GCP metadata endpoints)
- Other plugins' state

### 3.4 The sandbox

User plugin code runs in an **isolated v8 isolate** (via `isolated-vm`
or equivalent), not in the main Node process. Per-invocation:

- **Hard CPU timeout:** 5 seconds wall, 3 seconds CPU
- **Memory cap:** 64 MB
- **Stack depth cap:** 256 frames
- **Network egress:** through a quota'd proxy (max 10 outbound calls
  per invocation, each capped at 5MB response, 30s timeout)
- **AI calls:** counted against the org's monthly quota
- **DB queries:** through the `crm` SDK, which uses prepared
  statements bound to `org_id` — the plugin literally cannot reference
  another org's row
- **Audit log:** every plugin invocation writes a row to
  `plugin_runs` with start/end/status/cost

Per-org rate limits prevent a single org from monopolizing the
runner:

- 100 plugin runs/minute soft, 500/minute hard
- 1000 AI calls/day soft (subject to tier quota)
- Egress: 100 MB / hour outbound

### 3.5 The campaign system

Campaigns are state machines built on the existing `automation_rules`
+ `automation_runs` tables, extended with:

- **Triggers:** event (`deal.stage_changed`, `quote.sent`,
  `invoice.paid`), schedule (`every Monday at 09:00`), webhook
- **Conditions:** `if deal.amount > 10000`, `if customer.tier === 'A'`
- **Actions:** `run plugin X`, `send email`, `create task`, `move
  deal to stage Y`

Same sandbox + quota rules apply.

---

## 4. The non-coder UX

This is where the platform either succeeds or doesn't. A salesperson
who's never written code needs to ship a working plugin in under
five minutes.

### 4.1 Conversational builder flow

Mock-up:

```
[ /plugins/new — Build a plugin ]

What would you like to automate?
┌────────────────────────────────────────────────────────────┐
│ When a deal moves to ORDACK, send our purchasing team an   │
│ email with the PO details and a link back to the deal.     │
└────────────────────────────────────────────────────────────┘
                                                  [ Generate ]

→ Claude generates spec + summary:

   I'll build a plugin that:
   • Listens for: deal stage changes to ORDACK
   • Looks up: the deal's vendor, PO number, customer, and total
   • Sends: an email to purchasing@<your-domain>
            with subject "[PO Ack Needed] <deal title>"
   • Includes: a deep link to /deals/<id> in the body

   Recipients: purchasing@yourdomain.com  [ change ]
   Email format: HTML with logo  [ change to plain text ]

   [ Looks right — deploy ]  [ Edit details ]  [ Cancel ]
```

**Critically**, the user never sees code unless they click "Edit as
code." They see plain-English bullet points; they confirm; they
deploy. The platform compiles their intent into a sandboxed plugin.

### 4.2 The library

Pre-built plugins curated by the platform team. Each entry:

- One-line description
- Screenshot or short video
- "Install" button → opens a config form (no code)
- "Preview the code" link for the curious

Initial library catalog ideas:

- QuickBooks contact sync (bi-directional)
- Slack notification when a deal is won/lost
- Daily digest of stalled deals to the sales lead
- 30-day vendor price validation reminder (from the Zang vertical)
- Customer appreciation queue (annual gift / follow-up)
- Weekly KPI report to ownership
- Auto-tag deal by industry vertical
- Calendar sync for activities (Google Calendar / Outlook)

### 4.3 Editing without code

For installed plugins/campaigns:

- **Triggers:** dropdown of events + "On schedule" with a friendly
  cron-picker
- **Conditions:** rule builder ("if [field] [operator] [value]")
- **Actions:** list of action types with friendly forms (no JSON,
  no JS)
- **Recipients / templates:** rich-text editor with variable
  insertion (`{deal.title}`, `{customer.name}`)

### 4.4 The "edit as code" escape hatch

For power users — the same plugin shown in plain-English in 4.1 is
also editable as JS in a Monaco-style editor. Validation runs on save.
A plugin can flip between "edited in plain English" and "edited as
code" cleanly until the code form is more advanced than the no-code
form can represent; at that point the no-code editor shows
"Advanced — open in code editor to modify."

---

## 5. Architecture additions

### 5.1 New tables

| Table | Purpose |
|---|---|
| `plugins` | One row per installed plugin per org. (id, org_id, name, spec_jsonb, source_code, source_kind ['conversational' / 'library' / 'code'], status, created_by, updated_by, entity_version) |
| `plugin_runs` | Audit + billing. (id, plugin_id, org_id, started_at, ended_at, status, error, ai_tokens_used, db_queries, egress_bytes, cpu_ms) |
| `plugin_quota_usage` | Per-org rolling window aggregates so the limiter doesn't recompute every call |
| `campaigns` | One row per campaign. Extends `automation_rules` with the multi-step state machine |
| `campaign_runs` | Per-campaign-instance state (which step is current, last fired) |
| `usage_meter` | Per-org per-period counts (ai_tokens, plugin_runs, emails_sent, etc.). Used by billing |

All standard audit metadata. All `org_id`-scoped via `qs(req)`.

### 5.2 New services

- `services/pluginRunner.js` — invokes a plugin inside the v8 isolate
- `services/pluginCompiler.js` — turns spec JSON into runnable JS,
  validates against a schema, rejects forbidden patterns
- `services/usageMeter.js` — increments + reads counters
- `services/quotaEnforcer.js` — checks before each Claude call + each
  plugin run; throws `QuotaExceeded` to bubble back as 429
- `services/pluginSdk.js` — the `crm` SDK injected into plugin
  execution context

### 5.3 New routes

- `POST /api/plugins` — create from spec
- `POST /api/plugins/from-prompt` — Claude-assisted creation (sends
  user's natural-language description, returns generated spec for
  review)
- `GET /api/plugins/library` — public library entries
- `POST /api/plugins/:id/install` — install a library entry to caller's
  org
- `PUT /api/plugins/:id` — update
- `DELETE /api/plugins/:id` — remove
- `POST /api/plugins/:id/test-run` — run with sample data, return
  result for the user to verify before going live
- `GET /api/plugins/:id/runs` — recent invocation log
- `GET /api/usage` — caller's org usage vs. quota for current period

### 5.4 New feature flags

- `plugins_enabled` — gates the whole subsystem (default off until GA)
- `plugin_marketplace_publish` — Enterprise tier only; allow this org
  to publish to the public library
- `byok_claude` — bring-your-own-key for the AI calls (Pro/Enterprise)

---

## 6. Multi-tenant safety (the constraint that matters most)

### 6.1 Threat model

A plugin author may be:
- Honest but sloppy (writes a hot loop, calls Claude in a tight loop)
- Honest but resource-constrained (their workspace shouldn't degrade
  others)
- Malicious (tries to exfiltrate data from another org, mine crypto,
  DDoS via outbound egress, escape the sandbox)

### 6.2 Defenses

| Risk | Defense |
|---|---|
| Plugin runs a hot loop | CPU timeout (3s); isolate is killed and `plugin_runs.status = 'cpu_exceeded'` |
| Plugin allocates 10GB | Memory cap (64MB); isolate is killed with `memory_exceeded` |
| Plugin reads another org's data | DB access only through `crm` SDK, which binds `org_id` from execution context. The raw `pg` pool is not in scope |
| Plugin makes 1000 outbound HTTPS calls | Per-invocation egress quota (10 calls); per-org/hour quota (100MB) |
| Plugin tries to hit GCP metadata server (169.254.169.254) | Egress proxy denies internal IPs at the network layer |
| Plugin calls Claude in a tight loop | Quota counter increments on every call; throws `QuotaExceeded` past tier limit |
| Plugin tries to `require('fs')` | Sandbox has no `require`; `crm` SDK is the only injected globals |
| Plugin causes uncaught exception in main pool | Cannot — runs in isolate; main process catches isolate termination |
| Plugin escapes the isolate (zero-day in v8) | This is the residual risk. Mitigations: keep Node + isolated-vm patched, monitor CVEs |
| Marketplace submission with malware | Code review queue: every marketplace publish goes through a human review (Phase D below) before becoming installable by other orgs |

### 6.3 Kill switches

- Per-plugin: `UPDATE plugins SET status = 'suspended'` — runner skips
  it on next event
- Per-org: `phase2_entities` + per-module flags can be flipped off
- Per-platform: `plugins_enabled` flag set to false instance-wide
  takes the whole subsystem offline

### 6.4 Audit + observability

- Every plugin run logs to `plugin_runs` + `audit_log`
- Per-org dashboard shows last 100 runs with cost + status
- Platform-wide dashboard shows runs/minute, errors/minute, top
  resource consumers
- Alerts: any org > 1000 errors/hour, any org > 100K AI tokens/hour,
  any plugin > 50% failure rate

---

## 7. Phased roadmap

This is the order in which we ship pieces. Each phase ends with
something deployable to production.

### Phase A — Module toggle foundation (week 0-4)

**Already largely done** — `organizations.features` JSONB, feature
flags service, admin route. This phase finishes by:

- Adding 8-10 module flags (quotes_enabled, ai_features_enabled, etc.)
- Wiring `requireFeature` middleware on the matching backend routes
- Building the admin UI page so org admins toggle their org's modules
  without curl
- Frontend hides nav items + blocks routes for disabled modules

**Deliverable:** every existing module can be turned on/off per org.

### Phase B — Usage metering (week 4-8)

- `usage_meter` table
- AI cost tracking per org (intercept every `services/ai.js` call)
- Per-tier quota enforcement on AI calls
- Per-org usage dashboard at `/usage`
- Quota-exceeded UX (clear "upgrade to continue" path, not just a 429)

**Deliverable:** every Claude call costs the right org real money.

### Phase C — Plugin runtime (week 8-16)

- `plugins`, `plugin_runs`, `plugin_quota_usage` tables
- `pluginRunner` with `isolated-vm` sandbox
- `crm` SDK with the narrow API surface
- Egress proxy
- One "hello world" plugin to validate end-to-end
- Admin: install + run + delete from API only

**Deliverable:** a hand-written plugin can be installed via API and
runs safely in production.

### Phase D — Plugin builder UX (week 16-24)

- `/plugins` page (list + status + runs)
- `/plugins/new` conversational builder
- `/plugins/library` curated catalog with one-click install
- Code editor for power users
- Marketplace publish workflow with manual code review

**Deliverable:** a non-coder can build, install, and run a plugin
without touching a terminal.

### Phase E — Campaigns (week 24-36)

- `campaigns` + `campaign_runs` tables
- Extend `automation_rules` with multi-step state machine
- Campaign builder UI (triggers + conditions + actions)
- Email + Slack + Teams + Webhook actions
- Pre-built campaigns in the library

**Deliverable:** a salesperson can build a "30-day follow-up sequence"
without writing code.

### Phase F — Pricing + billing (week 36-48)

- Stripe integration for subscription billing
- Per-tier seat management (add/remove users with proration)
- Overage billing (AI request overages, plugin run overages)
- Customer portal for plan changes
- Invoicing + dunning

**Deliverable:** customers can sign up and pay automatically.

---

## 8. Open questions for owner sign-off

1. **Pricing tier numbers.** Are $15 / $39 / Custom acceptable, or do
   you want different anchor points? Anchoring lower (e.g., $9
   Starter) increases volume but hurts margin at scale.
2. **Free tier.** Necessary for funnel, or do we go trial-only? Free
   tier costs ~$1.30/user/month in cloud burn even at zero AI; we
   need >5% free-to-Starter conversion to break even.
3. **BYOK (bring your own key) for Claude.** Pro/Enterprise customers
   may want to use their own Anthropic key (better cost transparency,
   their data never co-mingles with our API quota). Worth supporting?
4. **Marketplace publishing.** Do we allow customers to publish their
   plugins to the public library, or is it staff-curated only? Public
   marketplace is a network-effect lever but introduces moderation
   load.
5. **Plugin pricing.** Do plugin authors get paid for marketplace
   installs (revenue share)? This is a separate business decision
   from base pricing.
6. **Plugin sandbox technology.** `isolated-vm` is the leading
   embedded-isolate Node library; alternatives include Cloudflare
   Workers (full isolate per call, network-only execution), WebAssembly
   (more isolation but worse DX). Want me to spike each for a
   recommendation?
7. **Phase ordering.** Anything I should reorder? Phase B (metering)
   could go after C (runtime) if we're confident our existing AI usage
   is small enough that we can defer billing, but I'd argue metering
   first because *every* feature wants to read it.

---

## 9. What this document is NOT

- **Not** a commitment that we'll ship Phases A-F in 48 weeks. The
  scope estimates are honest but ambitious; figure 1.5-2x in practice.
- **Not** a marketing roadmap. Don't promise plugins on the website
  until Phase D beta is in customer hands.
- **Not** a license to skip the multi-tenant safety work. If Phase C
  ships without the sandboxing in §6, we lose the platform on the
  first bad plugin.
- **Not** legal/compliance review. The plugin runtime processing user
  data through Claude has GDPR/CCPA implications — counsel review
  required before Phase D launch (see `legal/LEGAL_TODO.md`).

---

## 10. The litmus test for any change

Before merging any change between now and Phase F GA, ask:

1. Does it preserve the per-tier price gap with HubSpot/Salesforce?
2. Does it preserve the multi-tenant integrity boundary?
3. Does it preserve the non-coder UX path?

If a change requires sacrificing any of those three, the trade-off
must be explicit, documented, and owner-approved.

---

**Next action:** owner reviews §8 open questions. Once Q1, Q2, Q3 are
answered, Phase B work can start (Phase A is mostly done; see the
ARCHITECTURE_REWRITE_PLAN.md status section).
