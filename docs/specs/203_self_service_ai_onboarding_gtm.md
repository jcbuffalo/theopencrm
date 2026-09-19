# Spec 203 — Self-Service AI Onboarding & the "Configure, Don't Adapt" GTM Wedge

**Status:** SPEC (2026-09-19) · **Driven by:** two independent external market/positioning
reviews (ChatGPT — Unbound Boston conference positioning; Gemini — competitive landscape +
GTM), cross-checked against `PRICING_AND_FEATURES.md`, `NEXT_STEPS.md`, and
`CHAT_TOOLS_REFERENCE.md`. Supersedes no prior spec; extends `memory/project_business_model.md`.
**Effort:** Phase 0 ~1–2d (already tracked) · Phase 1 ~4–6d · Phase 2 ~5–7d · Phase 3 ~3–5d ·
Phase 4 ongoing process, not a build item.

---

## Part 0 — Does the revenue model actually work? (the thing that was asked first)

**Verdict: the shape is right; the enforcement mechanism is not live, and that's the real risk
— not the pricing philosophy.**

The layered open-core model (`memory/project_business_model.md`, endorsed 2026-08-02: free
self-host, hosted seat, AI usage/BYO-key, enterprise) is sound on margin grounds — software
seat revenue is high-margin, AI is billed separately at a 2× pass-through or zero (BYO key), and
marginal infra cost per additional org on shared Cloud Run/Cloud SQL is low. Both external
reviews independently converged on the same correction to how it's *presented*: don't lead with
the number, lead with the adaptive-CRM value and let price be evidence of the philosophy. That
matches the already-endorsed model — no philosophy change needed.

**Three things need fixing before "does it work" can even be tested:**

1. **Both external chats cite $12/seat. The live number is $15 (Starter) / $39 (Pro)**
   (`services/stripe.js`, confirmed in `PRICING_AND_FEATURES.md` line 40–41). Any copy, deck, or
   positioning material built from that feedback needs the correction — don't let a stale number
   from an LLM's paraphrase of an old memory leak into new marketing.
2. **Self-serve upgrade pressure — verified LIVE on code review 2026-09-19 (corrects the first
   draft of this spec, which relied on a stale `NEXT_STEPS.md` entry).** `limits_tier='free'`
   is set at self-serve org creation (`routes/authRoutes.js`, `routes/accessRequestRoutes.js`),
   the Stripe webhook moves it with the purchased tier (`routes/billingRoutes.js`), a hit cap
   402s into `TierLimitToast` → the plan picker at `/settings#billing`. The one real gap was
   pre-2026-09-14 orgs still at NULL (= unlimited) — closed by migration 170. Two stale
   surfaces were also lying about it (the copilot's `tier_limits` capability entry told users
   "nothing is capped by default"; `tierLimits.js`'s header said "inert on deploy") — fixed in
   the same commit. **So the paywall is real; what's missing is traffic and a reason to
   convert, which is what Phases 1–3 are for.**
3. **Zero WTP signal exists today.** Both live orgs (the one early customer, the owner's dogfood workspace) are comped
   (`memory/project_live_orgs.md`). The GTM wedge in this spec exists specifically to generate
   the first real paying-stranger signal — that's the point of Phase 0–1, not a side effect.

**One thing this spec deliberately does NOT do:** build out Stripe metered-billing plumbing
further or change the tier prices. Per the standing 2026-08-02 decision, that stays parked until
a live prospect states willingness-to-pay. Phase 0 here is narrower — it's *turning on the
enforcement that already has code* (`tierLimits.js` is fully built and inert), not building new
billing infrastructure.

**Data gap to close before finalizing anything pricing-related:** neither external review, nor
this spec, has real $/org AI cost data. `ai_usage_events` has ~2 months of real (if comped)
usage from the two live orgs. Pull actual $/seat/month AI spend from there before
trusting any unit-economics assumption — don't let an LLM's plausible-sounding token-cost
estimate substitute for the real ledger you already have.

---

## Part 1 — Positioning synthesis (where the two reviews agree, and the one place they don't)

Both reviews, independently, reject "open-source HubSpot alternative" as the frame — it's
commodity and it's getting crowded (Twenty, Relaticle, EspoCRM, Frappe CRM, Codext all occupy
adjacent territory; Twenty in particular is a real, well-funded strategic competitor worth
tracking, not a rounding error). Both land on the same replacement frame:

> **The CRM that configures around your business, instead of making your business adapt to it.**

The proof point both reviews independently zero in on is **exactly a primitive that already
ships today**: the 5 confirm-first "workspace-building" chat tools
(`propose_add_custom_field`, `propose_automation_rule`, `propose_saved_view`, `propose_report`,
`propose_update_pipeline` — `CHAT_TOOLS_REFERENCE.md` line 45). That's not a roadmap item to
build from scratch — it's a **packaging and onboarding gap**. Today those tools sit inside `/chat`
for an existing, already-configured org to *edit* its workspace. Nothing chains them into a
first-run "describe your business, get a built workspace" moment, and nothing lets that result
be saved, browsed, or cloned by someone who hasn't signed up yet.

**Where the reviews disagree, and the correction is right:** the first (ChatGPT) pass leaned on
the manufacturer's-rep/Zang workflow as the flagship proof; the follow-up Gemini pass explicitly
argued the GTM can't be built around Zang/manufacturing alone — it should be self-service-first,
horizontal, with verticals (including Zang) as accelerator templates, not the entry point, so
that support scales as "one hire + productization," not a consulting practice. That correction is
adopted here. `zang`/`jcp`/`rin` stay as *proof the platform can represent a real, gnarly
process* (the 29-stage Zang board is a legitimate demo asset) — they are not the ICP.

**ICP for this wedge:** 10–100 employee B2B companies whose sales process doesn't fit a
standard 6-stage pipeline cleanly — not "manufacturer's reps," not "SMBs" generally. The
self-selection Gemini's second pass describes is the right test: if a prospect's process *is*
standard, the generic 6-stage board already serves them fine and this wedge doesn't need to sell
them anything extra.

---

## Part 2 — User stories

### Phase 0 — Make the free-tier wall real — ✅ all three stories verified shipped

- As a free-tier signup, when I hit my plan's seat/contact/deal cap, I see a clear upgrade
  prompt that goes somewhere — not a silent pass-through. *(402 → `TierLimitToast` → `/settings#billing`)*
- As John, when a Stripe checkout completes, the org's `limits_tier` is set from the purchased
  price. *(`routes/billingRoutes.js` webhook, tested in `billingTierRoutes.test.js`)*
- As a new self-serve signup, my org is armed with `limits_tier='free'` at creation.
  *(`authRoutes.js` / `accessRequestRoutes.js`, tested in `signupTierLimits.test.js`; legacy orgs via migration 170)*

### Phase 1 — "Describe your business" onboarding builder (the core wedge)

- As a new signup, on first login I'm asked "How does your business sell?" in one box — mirroring
  the existing first-session Terms-modal gate pattern in `AuthContext.js` — instead of landing on
  an empty Dashboard with nothing in it.
- As a new signup, when I describe my process in plain English, the copilot proposes a bundle —
  pipeline stages, a custom field or two, one automation, one saved view — as a reviewable
  "Here's what I built" moment, using the *existing* `propose_add_custom_field` /
  `propose_automation_rule` / `propose_saved_view` / `propose_update_pipeline` tools, so I approve
  once instead of discovering four separate settings pages.
- As a new signup who doesn't want to type a paragraph, I can instead pick a starting template
  (SaaS, Professional Services, Distribution, Agency, Manufacturer's Rep, …) and get the same
  kind of result.
- As John, the onboarding flow is additive to the existing confirm-first apply path
  (`POST /api/ai/actions/apply`) — it introduces no new unreviewed write path, so the "plugins/AI
  never write directly" invariant holds for the very first thing a stranger does in the product.

### Phase 2 — Templates as a first-class, shareable object

- As an org owner, I can save my current pipeline + fields + automations as a named template, so
  I can reuse it (new workspace, new deal type) or hand it to a colleague.
- As a prospect who hasn't signed up, I can browse a public template gallery by vertical and
  clone one into a fresh trial workspace in one click — no sales call, no talking to John.
- As John, a template is a versioned JSON config (stages/fields/automations/playbooks/views) with
  no tenant data in it, so cloning one can never leak another org's records — this needs to be
  reviewed for the same class of cross-org leak risk every `qs(req)`-scoped table gets.

### Phase 3 — Marketing surfaces that make the wedge findable

- As a prospect who searched "HubSpot alternative," the landing page I hit names the specific
  pain (contact-tier pricing, feature bloat) and ends in the *same* "describe your business" CTA
  the product itself uses — so the ad promise and the product experience are the same thing, not
  a bait-and-switch into a generic signup form.
- As a prospect sizing the cost difference, I can run a calculator that estimates my current
  CRM's all-in cost (seats + implementation + admin time) against Open CRM, so the savings claim
  is something I compute, not something I'm told.
- As John, every claim on these new pages is added to the marketing-claim registry in
  `PRICING_AND_FEATURES.md` (existing convention, just extended) so nothing drifts silently.

### Phase 4 — Support-to-product loop (the thing that keeps this from becoming a services company)

- As support (John, or a future hire), when the same "how do I…" question comes up twice, I turn
  it into a template entry, a prompt-library entry, or a self-service flow — mirrors the existing
  `/chat` Debug-mode pattern of turning support tickets into read-only diagnostic tools.
- As a user stuck mid-onboarding, I can request paid help without leaving the product, but it's
  never the default path the product pushes me toward.

---

## Part 3 — Scope by phase

### Phase 0 — Enforcement — ✅ DONE (verified live 2026-09-19)

Already shipped 2026-09-14 (signup arms `limits_tier`, webhook keeps it in step, toast → plan
picker). Closed out 2026-09-19 with migration `170_backfill_limits_tier.sql` (legacy free orgs)
and truth fixes to `tierLimits.js`, `chatCapabilities.js`, `PRICING_AND_FEATURES.md`,
`NEXT_STEPS.md`.

### Phase 1 — Onboarding builder — ✅ SHIPPED 2026-09-19

**Design change from the first draft:** instead of steering the chat loop into emitting five
`propose_*` calls in one turn (capped at ~1k output tokens/round, 5 tool rounds, 4 action chips
— too tight to reliably hand a stranger a whole workspace), a dedicated planner makes ONE
structured Claude call and does the rest deterministically. No new write path: every piece is
normalized into the exact action shape the existing confirm-first machinery accepts and pushed
through `chatActions.validateAction` — the same validator `POST /api/ai/actions/apply` re-runs.

- `backend/services/onboardingPlanner.js` — `planWorkspace({ orgId, userId, description })`:
  strict-JSON prompt (current stages, existing custom fields, reserved columns, the automation
  vocabulary, allowed view filters) → validated `pipeline.update` / `custom_field.create` /
  `automation_rule.create` / `saved_view.create` proposals in apply order. Bad pieces are
  skipped with a reason (never fatal); automation/view stage labels resolve against the
  PROPOSED pipeline; a missing won/lost stage is added deterministically; deals in dropped
  stages get `moveDealsTo` = first new stage, noted on the card.
- `backend/services/onboardingTemplates.js` — 12 starting templates written as first-person
  "how we sell" paragraphs that go through the same planner (one code path; a template can be
  edited by appending "…but we also X"). Phase 2's persisted `workspace_templates` replaces this.
- `backend/routes/onboardingRoutes.js` — `GET /api/onboarding/templates` (any member, no AI) +
  `POST /api/onboarding/plan` (AI-billing gated + `ai_features_enabled`; `can_apply` by role).
- `backend/services/selfServeOrg.js` — **the enabling decision:** every new self-serve org is
  provisioned with a 14-day AI trial (`AI_SIGNUP_TRIAL_DAYS`, `0` disables) so the builder works
  before a card is on file. The previous session recommended this ("grant a 14-day AI trial at
  signup — recommended yes") and it was still an open owner decision; a stranger cannot describe
  their business to a 402, so it was made here. Bounded by the free-tier AI quota, the chat
  daily cap, and the $200/mo hard cap (which already covers `trial`). Three signup paths now
  share one provisioning helper instead of three hand-rolled INSERTs.
- `frontend/src/components/WorkspaceBuilder.js` — compose (textarea + template chips) → review
  (grouped checkboxes, notes, "N things I left out") → build (sequential applies through
  `/ai/actions/apply`, per-item status, failure inline and non-fatal, `refreshPipeline()` after
  a pipeline lands) → done (deal board / import / copilot). 402 renders the billing hand-off.
- Entry points: `/setup` (`pages/Setup.js`), first task on the Chat `WelcomeCard` and first-run
  starters (owner/admin only), and a "Build from a description" action in `/settings/pipeline`.
- Tests: `backend/test/onboardingPlan.test.js` (18), `frontend/src/components/WorkspaceBuilder.test.jsx` (5).

### Phase 2 — Templates — ✅ SHIPPED 2026-09-19

**Design change from the first draft:** a template's `config` is stored in the planner's *input*
shape (`{ pipeline, fields, automations, views }`), so cloning = `onboardingPlanner.assemblePlan`
— deterministic, **no AI call**, works for an org with AI off, and inherits every confirm-first
guarantee (the client still applies through `POST /api/ai/actions/apply`). There is no
`clone` writer.

- Migration `171_workspace_templates.sql` — `org_id NULL` = platform-authored; unique slug per
  org (`COALESCE(org_id,0), slug`); `is_public`; `use_count`.
- `backend/services/workspaceTemplates.js` — `snapshotOrg` (definitions only: effective
  pipeline, `org_field_definitions`, enabled planner-vocabulary `automation_rules`, shared deal
  `saved_views`), `sanitizeConfig` (key whitelist — ids/org refs cannot survive),
  `validateConfig` (pure, for save), `planFromTemplate`, `generatePlatformTemplates`
  (super-admin: 12 static descriptions → public platform rows, one AI call each).
- `backend/routes/workspaceTemplateRoutes.js` — CRUD (owner/admin writes, own-org SQL scope),
  `/:id/plan` (any member, `can_apply` by role), `/generate-platform` (super-admin), and an
  unauthenticated `GET /api/public/workspace-templates` (summaries only, rate-limited, cached).
- Planner refactor: `loadContext` / `draftRaw` / `assemblePlan` split so the model call and the
  validation are separately reusable.
- Frontend: `/templates` gallery (yours / starters / community; save snapshot; share/unshare;
  delete; super-admin generate), saved-template mode + chips in `WorkspaceBuilder`,
  `/setup?template=wt:<id>` + `?template=<static id>` deep links (`Setup.parseTemplateParam`),
  "Save as template" in `/settings/pipeline`, cards on Settings → Workspace.
- Tests: `backend/test/workspaceTemplates.test.js` (13), `frontend/src/pages/Templates.test.jsx` (7),
  `WorkspaceBuilder.test.jsx` (+2).
- **Starter gallery (evening follow-up):** hand-authored, reviewed configs in
  `backend/data/platformWorkspaceTemplates.json`, pinned by `test/platformTemplatesSeed.test.js`
  and seeded at boot (`seedPlatformTemplates`, upsert by slug). No owner click needed; the
  super-admin AI regenerate remains as an optional refresh (`scripts/generate-platform-templates.js`).
- **Hero rewrite (evening follow-up, D5):** Landing headline is now "Your CRM. Your rules." with
  the adaptive-CRM subhead and a "Build my CRM" CTA; the crawlable shell + meta mirror it;
  `HeroPreview` shows the `/setup` moment. One-commit revert documented in `REVIEW_2026_09_22_TUESDAY.md`.

### Phase 3 — Marketing surfaces (~3–5 days; mostly content, a little app code)

> **Status 2026-09-19: shipped on branch.** `/hubspot-alternative`, `/salesforce-alternative`,
> `/pipedrive-alternative`, `/zoho-alternative`, `/spreadsheet-crm`, `/custom-crm-alternative`
> (`pages/Compare.js` + `marketing/comparisons.js`), `/crm-for/:slug` for all 12 builder
> templates (`pages/Vertical.js` + `marketing/verticals.js`, parity-tested against
> `onboardingTemplates.js`), `components/CrmCostCalculator.js` (pure `computeCrmCost`, unit-tested),
> a "Built for how you sell" section on `Landing.js`, `PUBLIC_META` + sitemap rows, and the
> "Build my CRM" CTA that lands the new user in `/setup` after signup (`marketing/cta.js`,
> honoured by `Login.js`; also added the missing public `/verify-email` page the emailed link
> pointed at). Competitor list prices verified 2026-09-19 and registered in
> `PRICING_AND_FEATURES.md`. The hero repositioning is deliberately NOT done — owner's call.

- New public routes alongside the existing `Landing.js` pattern (`App.js` public-route block,
  `frontend/server.js` `PUBLIC_META` for SEO): `/hubspot-alternative`, `/salesforce-alternative`,
  `/manufacturer-rep-crm`, `/agency-crm`, etc. — reuse `Landing.js` sections, don't fork the
  component.
- Cost calculator: client-side only component, no backend — inputs (seats, current CRM,
  estimated implementation cost) → comparative output. Feeds SEO/lead-gen, not a new data model.
- Registry entries in `PRICING_AND_FEATURES.md`'s marketing-claims table for every new
  quantitative claim these pages make.

### Phase 4 — Support-to-product loop (ongoing process, not a sprint item)

Not a build phase — an operating discipline once a support channel exists (paid `$/hr` help,
whenever that's staffed): every repeated question becomes a template, a prompt-library entry, or
a product fix in the same week it's asked twice. Track it the same way `NEXT_STEPS.md` tracks
everything else — a running list, not a separate system.

---

## What this spec deliberately leaves as roadmap, not scope

- **Publish/share template virality loop** (public template → one-click clone → that user
  publishes their own variant) — real but speculative; revisit once Phase 2's gallery has any
  organic usage to observe.
- **Consultant/partner channel program** — Gemini's suggestion to turn CRM consultants into a
  distribution channel is interesting but is a go-to-market motion, not engineering scope; no
  code follows from it today.
- **Twenty/Relaticle/Codext competitive tracking** — worth a standing watch (Twenty especially,
  given its traction), but that's a `COMPETITIVE_ANALYSIS_2026-07.md` refresh, not this spec.
