# Spec 202 — AI Gateway for Self-Hosters

**Status:** SPEC (2026-09-17, owner-endorsed) · **Effort:** ~1 dev-week · **Depends on:** AI metering (`services/aiMetering.js`), AI billing (`services/aiBilling.js`, Stripe meter), BYO-key plumbing (migration 153/154), PAT infrastructure (`/api/keys`).

## The business case (why this exists)

The monetization model post-publication of the public mirror:

| Segment | Pays |
|---|---|
| Hosted org | Seats + AI margin (2×) |
| Self-hoster, BYO Anthropic key | $0 — deliberate top-of-funnel |
| **Self-hoster, Open CRM AI gateway** | **AI margin (2×) — this spec** |
| Enterprise | Seats + SSO/support/white-label |

A self-hoster who doesn't want to create an Anthropic account, manage a key,
or build spend controls buys a **gateway key** from the hosted platform. Their
self-hosted instance sends AI calls through our metered proxy: we pay
Anthropic, they pay us 2× cost with the same monthly hard cap machinery
hosted orgs get. Zero marginal infra: it reuses metering, billing, and caps
that already run in production. It also monetizes every AI-powered extension
in the public library for the self-host crowd — the "integrated billing
upcharge for tokens through the framework" premise.

## Design

### Platform side (app.theopencrm.com)

1. **Gateway keys** — migration `16x_gateway_keys.sql`: `ai_gateway_keys`
   (org_id FK, key_hash SHA-256, label, status active|revoked, created_at,
   last_used_at, requests_count). Minted/revoked from `/settings#billing`
   ("AI Gateway" card, org owner/admin, shown only when `ai_billing_status`
   is active/comped — a gateway key REQUIRES pay-as-you-go billing to be on).
   Key format `ocrm_gw_<32 bytes b64url>`, shown once.
2. **Proxy endpoint** — `POST /api/gateway/v1/messages` (new
   `routes/gatewayRoutes.js`, mounted CSRF-exempt, NOT behind session auth):
   - Auth: `Authorization: Bearer ocrm_gw_...` → hash lookup → org. 401 on
     miss/revoked. Strict per-key rate limit (default 60/min) + the org's
     existing quota/caps.
   - Body: the Anthropic Messages API shape, passed through with an
     allowlist (model must be in our supported set; max_tokens capped;
     stream supported v2, non-stream v1).
   - Enforcement BEFORE the upstream call: `requireAiBilling`-equivalent
     verdict for the org (past_due/halted/hard-cap all apply — reuse
     `evaluateAiBilling` + `checkAiQuota`), then call Anthropic with the
     PLATFORM key, stamp `ai_usage_events` (endpoint='gateway',
     user_id NULL, org attributed) at cost × UPCHARGE_MULTIPLIER — identical
     to hosted metering, so the monthly Stripe meter push needs NO changes.
   - Response: upstream JSON + `X-OpenCRM-Charged-USD` header for client-side
     usage display.
   - Never log prompt/completion bodies (privacy parity with hosted AI).
3. **Usage visibility** — the existing `/usage` page already reads
   `ai_usage_events`; gateway rows appear automatically. Add an
   endpoint filter chip.

### Self-hosted side (ships in the public mirror)

4. **`services/ai.js` resolveApiKey extension** — new env pair
   `OPENCRM_AI_GATEWAY_URL` (default `https://app.theopencrm.com/api/gateway`)
   + `OPENCRM_AI_GATEWAY_KEY`. Resolution order: org BYO key → platform
   `ANTHROPIC_API_KEY` → gateway key (base URL swap on the Anthropic SDK —
   it accepts a custom baseURL; the gateway speaks the Messages API dialect,
   so the SDK works unchanged). When gateway mode is active, the AI-settings
   UI shows "AI via Open CRM gateway" with a usage link to the hosted
   billing page.
5. **Self-host quota behavior** — gateway-mode instances skip the local
   free-tier quota (the gateway enforces billing-side caps); local
   `quotaEnforcer` treats a configured gateway key like BYO (exempt).

### Safety rails

- Hard cap: the org's `ai_monthly_hard_cap_usd` (default $200) halts gateway
  usage exactly like hosted usage — same worker, same auto-resume.
- Abuse: per-key rate limit + max body size (1 MB) + model allowlist +
  max_tokens ceiling (8192) + reject tool-use blocks v1 (plain messages
  only) to keep the proxy surface small.
- Key hygiene: hashed at rest, prefix-identifiable (`ocrm_gw_`), revocable,
  last_used_at surfaced.
- Terms: gateway usage is AI pay-as-you-go — §5a of the Terms already covers
  it verbatim ("where AI billing applies to your organization"); add one
  clarifying sentence at build time.

## Acceptance

A fresh self-hosted instance with only `OPENCRM_AI_GATEWAY_KEY` set: chat
copilot + AI extensions work; every call lands an org-attributed
`ai_usage_events` row on the platform at 2× cost; usage shows on the
hosted `/usage` page; crossing the hard cap halts with the standard
message; revoking the key 401s within 30s (cache TTL).

## Out of scope (v1)

Streaming, tool-use passthrough, non-Anthropic models, per-key sub-budgets,
reseller/multi-instance keys.
