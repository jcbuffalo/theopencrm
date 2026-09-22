# Spec 205 — Platform AI budget guardrails (trial slots, per-trial cap, monthly unbilled budget, self-alerting)

**Status:** SHIPPED (2026-09-22, migration 174) · **Driven by:** the owner approving D1 (14-day AI
trial at signup) with the condition *"make sure that we cap the # of trial participants and AI
costs or at least have alerting to me (using our own system as part of the dogfooding vision)
so that we don't get overspent."*

---

## The gap

Per-org protection existed: a $50 soft warning and a $200/month hard-cap auto-halt
(`aiThresholdWorker`). Nothing bounded the **aggregate**. With every self-serve signup getting
a trial, the platform's exposure was `N trials × $200`, and the only alert channel was the
legacy `adminNotify` email (its own preference shape, throttled per pod, not part of the
product's notification system).

## What shipped

| guardrail | env (default) | behaviour |
|---|---|---|
| Max live trials | `AI_TRIAL_MAX_ACTIVE` (25) | Past it, a new self-serve org gets its workspace with AI `unconfigured` (the copilot asks for a card). |
| Per-trial-org cap | `AI_TRIAL_ORG_HARD_CAP_USD` (25) | A trial org's monthly hard cap is `min(its cap, this)`. Applied inside `aiThresholdWorker` via `platformBudget.effectiveHardCap`. |
| Monthly unbilled budget | `AI_UNBILLED_MONTHLY_BUDGET_USD` (300) | Month-to-date **raw Anthropic cost** (`ai_usage_events.cost_usd_micro`, what we pay) across orgs with `ai_billing_status` in (`trial`, `comped`). At 100%, new trials are auto-paused. |
| Manual switch | `platform_settings.ai_trials_enabled` | Pause / resume new trials: `/admin/ai-billing` card, `POST /api/billing/ai/admin/platform-budget/trials`, or the one-click button in the alert email. |

Existing trials are never cut off by the aggregate guardrails — they keep running under their
own (now $25) cap. The provisioning gate **fails closed**: if the status query errors (pre-174
DB, connection blip) the org still gets its workspace, just no trial.

## Alerting — through the product, not around it

`services/platformBudgetWorker.js` (hourly) → `platformBudget.checkAndAlert()`:

- thresholds: 50 / 80 / 100% of the unbilled budget, 80 / 100% of the trial slots;
- each fires **once per (threshold, month)** — ledger `platform_budget_alerts`;
- delivery: `notificationDispatcher.notifyPlatformBudget` → every super-admin, new category
  `platform_budget` (migration 174 backfills `email: true` for super-admins only). That means:
  the bell always; email in the admin's own delivery mode (daily digest / batched / instant,
  spec 204); and a one-click **Pause new trials** / **Resume new trials** button
  (`emailActions` `platform.trials.pause|resume`, super-admin re-checked at apply time).

So the owner reads "AI trial budget at 80%: $240.00 of $300.00 this month" inside the same
morning digest as his tasks, and can act on it from the email.

## Surfaces

- `GET /api/billing/ai/admin/list` now includes `platform_budget` (the status object).
- `GET /api/billing/ai/admin/platform-budget`, `POST …/platform-budget/trials { enabled }` (super-admin).
- `/admin/ai-billing` → **Platform AI budget** card: unbilled cost vs budget, live trials vs
  slots, accepting / off (why), pause / resume button.
- Settings → Notifications: `platform_budget` row (only super-admins ever receive it).

## Tests

`backend/test/platformBudget.test.js` (status math, verdict precedence, effective cap, the
provisioning gate incl. fail-closed, once-per-month alerts + auto-pause, one-click pause
with super-admin check), `frontend/src/pages/AdminAiBilling.test.jsx` (card render + pause).

## Not done

- No per-org "trial spend so far" column on the admin table (the per-org cap makes it
  bounded; the card shows the aggregate).
- Comped orgs (the owner's own workspaces, the comped customer) count toward the unbilled
  budget by design — that is real cost — but nothing pauses *them*; a comped org past the
  general $200 cap is still halted by the existing per-org rule.
- Budget defaults ($300 / 25 trials / $25 per trial) are a first guess; raise via env once
  there is a month of data on `/admin/ai-billing`.
