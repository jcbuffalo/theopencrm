// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin trigger engine — the dispatch seam between CRM writes and the
// plugin runtime (migration 164).
//
// Before this module existed, plugins carried trigger_event /
// trigger_filter_json but nothing ever dispatched an event: pluginRunner.run
// was only reachable from the manual routes and the chat run_plugin tool.
// emit() is the missing seam. Call sites (dealRoutes, contactRoutes,
// companyRoutes, caseRoutes, quoteRoutes, services/leads.js,
// services/overdueTaskWorker.js, aiRoutes' confirm-first apply path) fire it
// POST-COMMIT, best-effort — exactly the same posture as
// webhookDispatcher.dispatch and the playbook stage-change hooks that
// already live next to it.
//
// CONTRACT:
//   • emit() NEVER throws and NEVER blocks the calling write. It returns a
//     promise (so workers/tests can await it) that always resolves — every
//     failure is swallowed into a structured log line.
//   • Only plugins with status = 'active' auto-trigger (draft / suspended /
//     errored plugins are skipped at the SQL level).
//   • The org's `plugins_enabled` feature flag is honored — same effective
//     resolution as the /api/plugins mount gate (explicit setting wins,
//     missing key falls back to the profile default via
//     featureFlags.hasFeature).
//   • The platform kill switch PLUGIN_RUNTIME_DISABLED=1 short-circuits
//     dispatch before any DB work (the runner would reject anyway; skipping
//     here avoids junk run rows).
//   • Triggered runs execute through pluginRunner.run in its DEFAULT
//     'preview' (confirm-first) posture: reads run live, writes are captured
//     as proposals on the run row for a human to Apply via
//     POST /api/plugins/:id/apply. Auto-committing writes from an unattended
//     trigger would silently reverse the platform's "a plugin can never
//     write directly" invariant — that flip is a deliberate product/security
//     decision, not something this seam takes on its own.
//
// TRIGGER FILTER SEMANTICS (trigger_filter_json):
//   A plain object of field → expected value, matched against the event
//   payload with loose string equality (String(payload[k]) ===
//   String(filter[k]); null only matches null/undefined-as-null). Every key
//   must match ("AND"). A null / empty / non-object filter matches every
//   payload. Nested objects and arrays are NOT supported — a non-primitive
//   filter value never matches (fail closed).
//
// DEDUPE:
//   Each delivery claims a (plugin_id, dedupe_key) row in
//   plugin_trigger_dedupe via INSERT ... ON CONFLICT DO NOTHING (the
//   workerLease pattern). Losing the claim = someone already delivered this
//   logical event to this plugin — skip. Call sites pick keys that encode
//   the event identity:
//     '<event>:<entityId>'                      (creations — fire once ever)
//     'deal.stage_changed:<id>:<from>-><to>'    (retries of one transition
//                                                dedupe; a NEW transition,
//                                                even back to a prior stage
//                                                via a different `from`,
//                                                fires again)
//     'task.overdue:<id>:<YYYY-MM-DD>'          (at most once per task-day)
//     'schedule.daily:<YYYY-MM-DD>'             (once per plugin per UTC day)
//     'schedule.hourly:<YYYY-MM-DDTHH>'         (once per plugin per UTC hour)
//   If the claim query itself errors we FAIL CLOSED (skip the run) — dedupe
//   integrity beats delivery, because a double-fired automation is worse
//   than a missed one.
//
// CONCURRENCY: dispatch is sequential per event (for..of + await).
// pluginRunner's per-org concurrency cap + monthly quota still apply to
// every triggered run.
//
// KILL SWITCH / AUTO-PAUSE:
//   After every triggered run the engine stamps plugins.last_triggered_at.
//   A successful run resets consecutive_trigger_failures to 0; an EXECUTION
//   failure (error / timeout / killed / memory_exceeded /
//   query_budget_exceeded / task_budget_exceeded) increments it.
//   Environmental outcomes (quota_exceeded, concurrent_limit_exceeded,
//   rejected) are neutral — they neither punish nor forgive the streak.
//   At AUTO_PAUSE_THRESHOLD (5) consecutive failures the plugin is paused
//   (status -> 'errored', an existing value in the plugins status CHECK)
//   and every org owner/admin gets an in-app notification.

const pool = require('../db');
const logger = require('./logger');
const featureFlags = require('./featureFlags');
const pluginRunner = require('./pluginRunner');
const notifications = require('./notifications');

// ---------------------------------------------------------------------------
// Canonical event taxonomy. Every name here is dispatched by a real call
// site; payload shapes are documented inline. pluginSpecValidator's
// TRIGGER_EVENTS is the authoring-side allowlist and MUST stay a superset of
// the dispatched names (test-enforced in test/pluginEvents.test.js).
// ---------------------------------------------------------------------------
const PLUGIN_EVENTS = Object.freeze({
  // { id, title, stage, deal_type, amount } — POST /api/deals
  DEAL_CREATED: 'deal.created',
  // { id, title, stage, prev_stage, deal_type, amount } — PATCH
  // /api/deals/:id/stage, stage-changing PUT /api/deals/:id, and the
  // confirm-first AI apply path (prev_stage null there — the writer doesn't
  // capture the before-row).
  DEAL_STAGE_CHANGED: 'deal.stage_changed',
  // { id, first_name, last_name, email, company_id } — POST /api/contacts
  CONTACT_CREATED: 'contact.created',
  // { id, name, type, industry, lifecycle_stage } — POST /api/companies
  COMPANY_CREATED: 'company.created',
  // { id, name, email, source, status, score } — services/leads.createLead
  // (covers manual creates AND public lead-form captures)
  LEAD_CREATED: 'lead.created',
  // { id, subject, status, priority, company_id, contact_id } —
  // POST /api/cases (portal-submitted cases go through a separate public
  // route and do NOT emit — see routes/publicPortalRoutes.js)
  CASE_CREATED: 'case.created',
  // { id, title, due_date, priority, assigned_to, deal_id, contact_id } —
  // overdueTaskWorker, once per task per 24h notification window (dedupe key
  // adds the UTC date so a still-overdue task fires at most daily)
  TASK_OVERDUE: 'task.overdue',
  // { id, title, status, deal_id, customer_id, total_amount } — quoteRoutes:
  // PUT that transitions status to 'sent', or POST created directly as
  // 'sent'. Fires at most once per quote (dedupe 'quote.sent:<id>').
  QUOTE_SENT: 'quote.sent',
  // { date, hour } — pluginScheduleWorker, once per plugin per UTC hour
  SCHEDULE_HOURLY: 'schedule.hourly',
  // { date } — pluginScheduleWorker, once per plugin per UTC day
  SCHEDULE_DAILY: 'schedule.daily',
});

// Events the schedule worker owns (no CRM call site fires these).
const SCHEDULE_EVENTS = Object.freeze([
  PLUGIN_EVENTS.SCHEDULE_HOURLY,
  PLUGIN_EVENTS.SCHEDULE_DAILY,
]);

// Run outcomes that count toward the auto-pause failure streak. These are
// "the plugin's code (or its resource appetite) is broken" outcomes.
// Environmental outcomes — quota_exceeded, concurrent_limit_exceeded,
// rejected — are excluded: pausing a healthy plugin because the org hit its
// monthly cap would be wrong.
const FAILURE_STATUSES = new Set([
  'error',
  'timeout',
  'killed',
  'memory_exceeded',
  'query_budget_exceeded',
  'task_budget_exceeded',
]);

const AUTO_PAUSE_THRESHOLD = 5;
// plugins.status value used for the auto-pause (from the migration 061 CHECK:
// draft | active | suspended | errored).
const AUTO_PAUSE_STATUS = 'errored';

/**
 * Loose-equality field match for trigger_filter_json. Exported for tests.
 * See "TRIGGER FILTER SEMANTICS" in the module header.
 */
function matchesTriggerFilter(filter, payload) {
  if (filter === null || filter === undefined) return true;
  if (typeof filter !== 'object' || Array.isArray(filter)) return true; // malformed filter → don't silently drop the plugin
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  const p = (payload && typeof payload === 'object') ? payload : {};
  for (const k of keys) {
    const want = filter[k];
    const got = p[k];
    if (want === null) {
      if (!(got === null || got === undefined)) return false;
      continue;
    }
    // Primitive-only comparison; a nested-object/array filter value never
    // matches (fail closed rather than deep-compare untrusted shapes).
    if (typeof want === 'object') return false;
    if (got === null || got === undefined) return false;
    if (String(got) !== String(want)) return false;
  }
  return true;
}

/**
 * Atomically claim a (plugin, dedupe_key) delivery. Returns true exactly once
 * across all instances for a given key. A null/empty key means "no dedupe" —
 * always claimed. On a DB error we FAIL CLOSED (return false) — see module
 * header.
 */
async function claimDedupe(pluginId, dedupeKey) {
  if (!dedupeKey) return true;
  try {
    const r = await pool.query(
      `INSERT INTO plugin_trigger_dedupe (plugin_id, dedupe_key)
       VALUES ($1, $2)
       ON CONFLICT (plugin_id, dedupe_key) DO NOTHING
       RETURNING plugin_id`,
      [pluginId, String(dedupeKey).slice(0, 200)]
    );
    return r.rows.length > 0;
  } catch (err) {
    logger.warn('plugin_trigger_dedupe_claim_failed', {
      pluginId, dedupeKey, error: err && err.message,
    });
    return false;
  }
}

/**
 * Post-run bookkeeping for a TRIGGERED run: liveness stamp, failure streak,
 * auto-pause + admin notification. Best-effort — never throws.
 */
async function recordTriggerOutcome(plugin, orgId, result) {
  try {
    const status = result && result.status;
    if (result && result.ok) {
      await pool.query(
        `UPDATE plugins
            SET last_triggered_at = NOW(), consecutive_trigger_failures = 0
          WHERE id = $1 AND org_id = $2`,
        [plugin.id, orgId]
      );
      return;
    }
    if (!FAILURE_STATUSES.has(status)) {
      // Environmental outcome (quota / concurrency / rejected) — stamp
      // liveness, leave the streak untouched.
      await pool.query(
        `UPDATE plugins SET last_triggered_at = NOW()
          WHERE id = $1 AND org_id = $2`,
        [plugin.id, orgId]
      );
      return;
    }
    const r = await pool.query(
      `UPDATE plugins
          SET last_triggered_at = NOW(),
              consecutive_trigger_failures = consecutive_trigger_failures + 1
        WHERE id = $1 AND org_id = $2
        RETURNING consecutive_trigger_failures, name`,
      [plugin.id, orgId]
    );
    const row = r.rows[0];
    if (!row || row.consecutive_trigger_failures < AUTO_PAUSE_THRESHOLD) return;

    // Auto-pause. Guard on status='active' so a concurrent pause (or a
    // manual suspend) can't be overwritten, and so the notification fires
    // exactly once per pause.
    const paused = await pool.query(
      `UPDATE plugins SET status = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND org_id = $2 AND status = 'active'
        RETURNING id, name`,
      [plugin.id, orgId, AUTO_PAUSE_STATUS]
    );
    if (paused.rows.length === 0) return;

    logger.warn('plugin_auto_paused', {
      pluginId: plugin.id, orgId,
      failures: row.consecutive_trigger_failures,
      lastStatus: status,
    });

    // Tell every org owner/admin. Notification failures are swallowed —
    // the pause itself already happened.
    try {
      const admins = await pool.query(
        `SELECT id FROM users
          WHERE org_id = $1 AND org_role IN ('owner', 'admin')`,
        [orgId]
      );
      const name = paused.rows[0].name || row.name || `#${plugin.id}`;
      for (const admin of admins.rows) {
        await notifications.create({
          orgScope: ['org_id', orgId],
          userId: admin.id,
          type: 'plugin_auto_paused',
          title: `Extension "${name}" was paused`,
          body: `It failed ${AUTO_PAUSE_THRESHOLD} triggered runs in a row (last: ${status}). Fix it on its page and set it back to active to resume.`,
          link: `/plugins/${plugin.id}`,
          entityType: 'plugin',
          entityId: plugin.id,
        }).catch((err) => {
          logger.warn('plugin_auto_pause_notify_failed', {
            pluginId: plugin.id, userId: admin.id, error: err && err.message,
          });
        });
      }
    } catch (err) {
      logger.warn('plugin_auto_pause_notify_failed', {
        pluginId: plugin.id, orgId, error: err && err.message,
      });
    }
  } catch (err) {
    logger.warn('plugin_trigger_outcome_record_failed', {
      pluginId: plugin && plugin.id, orgId, error: err && err.message,
    });
  }
}

/**
 * Run ONE plugin for a trigger delivery: dedupe claim → pluginRunner.run →
 * outcome bookkeeping. Shared by emit() and pluginScheduleWorker. Never
 * throws.
 *
 * @param {{id:number, name?:string}} plugin
 * @param {number} orgId
 * @param {string} eventName
 * @param {object} payload — spread into input.trigger alongside `event`
 * @param {{dedupeKey?:string|null, triggerKind?:string}} [opts]
 * @returns {Promise<object>} the runner result, or { skipped } shapes
 */
async function runTriggeredPlugin(plugin, orgId, eventName, payload, { dedupeKey = null, triggerKind = 'event' } = {}) {
  try {
    const claimed = await claimDedupe(plugin.id, dedupeKey);
    if (!claimed) {
      return { ok: false, skipped: 'dedupe', pluginId: plugin.id };
    }
    const result = await pluginRunner.run({
      pluginId: plugin.id,
      orgId,
      triggerKind,               // 'event' | 'schedule' → plugin_runs.trigger_kind
      triggerSource: eventName,  // e.g. 'deal.stage_changed' → plugin_runs.trigger_source
      triggerData: payload || null,
      input: { trigger: { event: eventName, ...(payload || {}) } },
    });
    await recordTriggerOutcome(plugin, orgId, result);
    return result;
  } catch (err) {
    logger.warn('plugin_triggered_run_failed', {
      pluginId: plugin && plugin.id, orgId, event: eventName, error: err && err.message,
    });
    return { ok: false, skipped: 'dispatch_error', error: err && err.message };
  }
}

/**
 * Internal dispatch. Looks up the org's active listeners for `eventName`,
 * applies trigger_filter_json, and runs each match sequentially. May throw —
 * emit() wraps it.
 */
async function dispatch(orgId, eventName, payload, opts = {}) {
  const oid = Number(orgId);
  if (!orgId || !Number.isInteger(oid) || oid <= 0 || !eventName) {
    return { dispatched: 0, skipped: 'bad_args' };
  }
  // Test-suite bypass — same opt-in convention as requireAiBilling /
  // orgAiKeys / tierLimits. emit() fires DB queries AFTER a route's own
  // writes, which would steal queued mockResolvedValueOnce responses from
  // hundreds of existing ordered-mock route tests. The plugin-events suites
  // opt back in via PLUGIN_EVENTS_IN_TESTS=true.
  if (process.env.NODE_ENV === 'test' && process.env.PLUGIN_EVENTS_IN_TESTS !== 'true') {
    return { dispatched: 0, skipped: 'test_env' };
  }
  if (process.env.PLUGIN_RUNTIME_DISABLED === '1') {
    return { dispatched: 0, skipped: 'runtime_disabled' };
  }

  // Same effective-flag resolution as the /api/plugins mount gate
  // (middleware/featureGate.js → featureFlags.hasFeature): explicit org
  // setting wins, a missing key falls back to the profile default.
  const enabled = await featureFlags.hasFeature(orgId, 'plugins_enabled');
  if (!enabled) return { dispatched: 0, skipped: 'plugins_disabled' };

  const listeners = await pool.query(
    `SELECT id, name, trigger_filter_json
       FROM plugins
      WHERE org_id = $1 AND trigger_event = $2 AND status = 'active'
      ORDER BY id`,
    [oid, eventName]
  );
  if (listeners.rows.length === 0) return { dispatched: 0 };

  // Default dedupe key: once per (event, entity). Call sites with
  // legitimately-repeating events pass an explicit discriminated key.
  const entityId = payload && payload.id !== undefined && payload.id !== null ? payload.id : null;
  const dedupeKey = opts.dedupeKey !== undefined
    ? opts.dedupeKey
    : (entityId !== null ? `${eventName}:${entityId}` : null);

  const results = [];
  for (const plugin of listeners.rows) {
    if (!matchesTriggerFilter(plugin.trigger_filter_json, payload)) {
      results.push({ pluginId: plugin.id, skipped: 'filter' });
      continue;
    }
    // Sequential on purpose — bounds host pressure; the runner's per-org
    // concurrency cap is the backstop for parallel emits.
    const result = await runTriggeredPlugin(plugin, oid, eventName, payload, {
      dedupeKey,
      triggerKind: opts.triggerKind || 'event',
    });
    results.push({ pluginId: plugin.id, status: result.status, ok: result.ok, skipped: result.skipped });
  }
  const dispatched = results.filter((r) => !r.skipped).length;
  if (dispatched > 0) {
    logger.info?.('plugin_events_dispatched', { orgId, event: eventName, dispatched });
  }
  return { dispatched, results };
}

/**
 * Fire a plugin trigger event. FIRE-AND-FORGET: never throws, never rejects,
 * never blocks the calling write — call it without await from HTTP handlers
 * (awaiting from workers/tests is fine; the returned promise always
 * resolves).
 *
 * @param {number} orgId       — tenant to dispatch within (org-less users have no plugins)
 * @param {string} eventName   — one of the PLUGIN_EVENTS values
 * @param {object} payload     — event payload; becomes input.trigger (minus `event`)
 * @param {object} [opts]
 * @param {string|null} [opts.dedupeKey] — override the default `${event}:${payload.id}` key;
 *                                         pass null to disable dedupe entirely
 * @returns {Promise<{dispatched:number}>}
 */
function emit(orgId, eventName, payload, opts = {}) {
  return dispatch(orgId, eventName, payload, opts).catch((err) => {
    logger.warn('plugin_event_dispatch_failed', {
      orgId, event: eventName, error: err && err.message,
    });
    return { dispatched: 0, skipped: 'dispatch_failed' };
  });
}

module.exports = {
  emit,
  PLUGIN_EVENTS,
  SCHEDULE_EVENTS,
  matchesTriggerFilter,
  runTriggeredPlugin,
  FAILURE_STATUSES,
  AUTO_PAUSE_THRESHOLD,
  AUTO_PAUSE_STATUS,
  // Exposed for tests only.
  _internal: { dispatch, claimDedupe, recordTriggerOutcome },
};
