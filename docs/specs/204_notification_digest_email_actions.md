# Spec 204 — Consolidated notification email + one-click actions from the email

**Status:** SHIPPED (2026-09-21, migration 173) · **Driven by:** owner dogfood feedback the same
day: *"the email alerts should be consolidated for a user so that I don't just get 6 meh emails
regularly, and then a CTA that automatically does the task should be in the email itself so
that I can get work done right from your reminder email link."*
**Effort:** 1 day (backend service + worker + routes + Settings card + landing page + 28 tests).

---

## What was wrong

`services/notificationDispatcher.js` had exactly one email send site, and it sent **one email
per event**: an hourly overdue-task worker produced one mail per overdue task (dedupe was
per task per 24h, not per user), every assignment/mention/lead was its own mail, and the
weekly summary was placeholder copy. Nothing in any email could be *acted on* — every link
was "Open in The Open CRM" → sign in → find the record.

## What shipped

### 1. Delivery mode per user — `notification_preferences.email_delivery`

```json
{ "mode": "instant" | "batched" | "daily", "hour": 7, "tz": "America/New_York" }
```

| mode | behaviour |
|---|---|
| `daily` (**default**, `DEFAULT_EMAIL_DELIVERY_MODE`) | One email at `hour` in `tz` containing everything queued since the last digest **plus the live My Day queue** (tasks due, next steps due, accounts gone quiet, deals needing attention, renewals in 30 days). Nothing due + nothing queued → no email. |
| `batched` | Queued alerts flush together once the oldest is 15 min old (`DIGEST_BATCH_WINDOW_MINUTES`). A burst becomes one email. |
| `instant` | Exactly the old behaviour (one email per alert), but each now carries the buttons. |

The per-category email/SMS toggles still gate *what* is included; `email_delivery` only
controls *how it is delivered*. A user with every email category off gets no digest.
Timezone: the Settings card sends the browser's IANA zone with every save; until a user
has saved once, `DEFAULT_TIMEZONE` (env, `America/New_York`) applies.

### 2. One-click actions — `services/emailActions.js`, `email_action_tokens`

Every row in a digest (and every instant alert about a task) carries buttons:

| button | action | mirrors |
|---|---|---|
| Mark done | `task.complete` | `PUT /api/tasks/:id {status:'done'}` incl. recurrence spawn + `task.completed` plugin event |
| Snooze a day | `task.snooze` | due_date → max(today, due)+1 |
| Step done / Snooze a day | `deal.next_step.complete` / `.snooze` | My Day's next-step buttons |
| Log a touch | `company.touch` | `POST /api/companies/:id/touch` |

Token hygiene copies `password_reset_tokens`: 256-bit random, **sha256 stored**, single-use
(atomic claim), 7-day expiry, org + user scope taken from the token row, user must still be
active. The email link is a GET to the SPA page `/act/:token`, which POSTs
`/api/email-actions/:token/apply` — so mail-client link scanners never mutate anything.
A 404 (record gone) consumes the token; an unexpected error gives it back so the same
email link is retryable. Spent tokens and flushed queue rows are swept after 14 / 30 days.

### 3. Plumbing

- `notification_email_queue` (migration 173) — where non-instant emails park; `digest_id`
  is the per-user claim; rows are the audit trail of what went into which digest.
- `services/notificationDigest.js` — `deliveryPref`, `enqueue`, `buildEmail`, `flushUser`,
  `tick`, `sweep`. `services/notificationDigestWorker.js` ticks every 5 min
  (`DIGEST_WORKER_INTERVAL_MINUTES`), registered in `index.js` under `automationEnabled`.
- `services/myDay.js` — the My Day queue extracted from `routes/myDayRoutes.js` so the
  digest renders the same queue the `/today` page shows (query order preserved for the
  ordered-mock tests).
- `POST /api/me/notification-digest/send-now` — sends the caller their daily digest
  immediately (1/min); the Settings card's "Send me today's digest now".
- Settings → Notifications → **Email delivery** card (mode radio, hour picker, timezone shown,
  send-now button).

### 4. Decision made on the owner's behalf (D7)

**Default mode is `daily` for every existing user**, not just new ones. Rationale: the ask
was "consolidate", the owner is the main affected user, and the other live tenant's users
had only the default categories on (task assigned/overdue, weekly summary) — a morning
digest is strictly less noise than one mail per overdue task. Cost: a task assigned at 10:00
is emailed at 07:00 the next day unless the user picks instant/batched (the in-app bell is
still immediate). **Revert:** set Cloud Run env `DEFAULT_EMAIL_DELIVERY_MODE=instant` — users
who never saved a preference go back to per-alert mail; nothing else changes.

## Not done / follow-ups

- Weekly summary is still placeholder copy (`notifyWeeklySummary`); with a daily digest
  it is arguably redundant — candidate for removal or a "week in numbers" rewrite.
- No "undo" from the `/act` page (the record link is one click away). Adding an undo
  token per action is straightforward if it turns out to matter.
- Quiet accounts / deals needing attention are org-wide in My Day and therefore in every
  user's digest; a per-owner filter is a My Day change, not a digest change.
- SMS is untouched (still per-alert, per-category).

## Verification

`backend/test/emailActions.test.js` (9), `backend/test/notificationDigest.test.js` (14),
`frontend/src/pages/EmailDigest.test.jsx` (5); dispatcher suites pinned to `instant`.
Manual: Settings → Notifications → "Send me today's digest now" → click "Mark done" on a
task in the email → `/act/…` shows the outcome; the task is done in `/tasks`; clicking the
same button again shows "Already done".
