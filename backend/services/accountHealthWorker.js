// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Success — CS-2, account-health snapshot worker.
//
// Daily idempotent worker that recomputes a rules-based health score for every
// active account in every org that has the customer_success_enabled feature on,
// then appends a row to account_health_snapshots (migration 095). Append-only:
// we never UPDATE in place, so the history powers a trend chart and a single
// "computed_at" per (org, company, day) is the idempotency key.
//
// Modelled on services/overdueTaskWorker.js — module-level timer + tick() +
// startScheduler()/stopScheduler(). Scoring math lives in services/accountHealth.js
// (pure scoreAccount + org-scoped computeForOrg). This file only orchestrates:
// pick orgs → compute → snapshot, skipping orgs already snapshotted today so a
// restart mid-day doesn't double-write.

const pool   = require('../db');
const logger = require('./logger');
const featureFlags = require('./featureFlags');
const accountHealth = require('./accountHealth');
const workerLease = require('./workerLease');

const DEFAULT_INTERVAL_MIN = 60;   // hourly tick; the per-day guard makes it daily-effective

let timer = null;

// Orgs that own at least one account (a deal with a customer_id). We only
// score these — there's nothing to snapshot for an org with no post-sale
// relationships. Feature-gating is checked per-org below.
async function activeOrgIds() {
  const r = await pool.query(
    `SELECT DISTINCT org_id FROM deals WHERE org_id IS NOT NULL AND customer_id IS NOT NULL`
  );
  return r.rows.map((row) => row.org_id);
}

// Idempotency: has this org already been snapshotted today (UTC date)?
async function alreadySnapshottedToday(orgId) {
  const r = await pool.query(
    `SELECT 1 FROM account_health_snapshots
      WHERE org_id = $1 AND computed_at::date = (NOW() AT TIME ZONE 'UTC')::date
      LIMIT 1`,
    [orgId]
  );
  return r.rows.length > 0;
}

async function snapshotOrg(orgId, now) {
  const accounts = await accountHealth.computeForOrg(orgId, { now });
  if (accounts.length === 0) return 0;

  let inserted = 0;
  for (const a of accounts) {
    await pool.query(
      `INSERT INTO account_health_snapshots (org_id, company_id, score, band, signals, computed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [orgId, a.company_id, a.score, a.band, JSON.stringify(a.signals), now.toISOString()]
    );
    inserted++;
  }
  return inserted;
}

async function tick({ now = new Date() } = {}) {
  try {
    const orgIds = await activeOrgIds();
    if (orgIds.length === 0) {
      logger.info?.('account_health_worker_tick_idle');
      return { orgs: 0, snapshots: 0 };
    }

    let orgsProcessed = 0;
    let snapshots = 0;

    for (const orgId of orgIds) {
      try {
        // Per-org feature gate — only orgs running the CS motion get scored.
        const on = await featureFlags.hasFeature(orgId, 'customer_success_enabled');
        if (!on) continue;

        // Daily idempotency — cheap same-process/prior-run short-circuit.
        if (await alreadySnapshottedToday(orgId)) continue;

        // Cross-instance guard: claim (account_health, org:date) so two
        // instances that both passed the read check above can't both write a
        // full duplicate snapshot set. The claim is the authoritative dedupe;
        // the read check just avoids the claim/recompute cost in the common
        // case. Release on failure so a later tick this day can retry.
        const dayKey = `${orgId}:${(now.toISOString()).slice(0, 10)}`;
        if (!(await workerLease.claim('account_health', dayKey))) continue;
        try {
          const n = await snapshotOrg(orgId, now);
          snapshots += n;
          orgsProcessed++;
        } catch (err) {
          await workerLease.release('account_health', dayKey).catch(() => {});
          throw err;
        }
      } catch (err) {
        logger.warn?.('account_health_worker_one_org_failed', { orgId, error: err && err.message });
      }
    }

    logger.info?.('account_health_worker_tick_end', { orgsProcessed, snapshots });
    return { orgs: orgsProcessed, snapshots };
  } catch (err) {
    logger.warn?.('account_health_worker_tick_error', { error: err && err.message });
    return { orgs: 0, snapshots: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once shortly after startup (5s delay so migrations + the rest of boot
  // finish first), then on interval. The per-day guard keeps it daily-effective.
  setTimeout(() => { tick().catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick().catch(() => {});
  }, ms);
  logger.info?.('account_health_worker_started', { intervalMinutes });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  startScheduler,
  stopScheduler,
};
