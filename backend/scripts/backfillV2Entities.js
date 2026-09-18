#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// One-shot backfill: walk every deal in the target org in created_at ASC
// order and re-run the dualWrite hooks against it, populating v2 entities
// (RFQ, PO, Invoice) for deals that pre-date dual-write being turned on.
//
// IDEMPOTENT: each hook checks for existing v2 records before inserting.
// Running this script twice produces the same result as running it once.
//
// USAGE:
//   ORG_ID=1 node scripts/backfillV2Entities.js          # one org
//   ORG_ID=all node scripts/backfillV2Entities.js        # every org with phase2_entities=true
//   DRY_RUN=true ORG_ID=1 node scripts/backfillV2Entities.js   # report only
//
// Required env vars (same as backend boot): DB_USER/DB_PASSWORD/DB_NAME/
// INSTANCE_CONNECTION_NAME (Cloud SQL) or DB_HOST/DB_PORT (local).
//
// IMPORTANT: this script flips through every deal — for the Zang org, that's
// dozens to thousands of rows. It works one deal at a time inside its own
// transaction so a failure on one deal doesn't block the rest. Failures are
// logged with the deal ID so you can inspect them after the fact.
//
// META-FLAG: this script bypasses the v2_dual_write_enabled check by calling
// the per-stage helpers directly (or temporarily setting the flag during the
// run). Default behavior: temporarily flip the flag on for the duration of
// the backfill, then back off. This way the user doesn't have to flip it in
// advance and run the risk of regular traffic dual-writing during a backfill.

require('dotenv').config();
const pool = require('../db');
const featureFlags = require('../services/featureFlags');
const v2DualWrite = require('../services/v2DualWrite');

const ORG_ID = process.env.ORG_ID;
const DRY_RUN = process.env.DRY_RUN === 'true';

function log(msg, extra) {
  // eslint-disable-next-line no-console
  console.log(`[backfill] ${msg}`, extra || '');
}

async function listOrgs() {
  if (ORG_ID === 'all') {
    const r = await pool.query(
      `SELECT id, name FROM organizations WHERE features @> '{"phase2_entities": true}'::jsonb ORDER BY id`
    );
    return r.rows;
  }
  if (!ORG_ID) {
    throw new Error('ORG_ID env required (set to a number, or "all" for every phase2-enabled org)');
  }
  const r = await pool.query(`SELECT id, name FROM organizations WHERE id = $1`, [Number(ORG_ID)]);
  if (r.rows.length === 0) throw new Error(`Organization ${ORG_ID} not found`);
  return r.rows;
}

async function backfillDealsForOrg(org) {
  log(`backfilling org ${org.id} (${org.name})`);
  const deals = await pool.query(
    `SELECT * FROM deals WHERE org_id = $1 ORDER BY created_at ASC`,
    [org.id]
  );
  log(`  ${deals.rows.length} deals to process`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  for (const deal of deals.rows) {
    if (DRY_RUN) {
      // Dry-run: report what would happen without actually writing.
      const wouldCreateRfq = !!deal.external_ref;
      const wouldCreatePo = !!deal.vendor_id && ['ORDACK','VAP','CAP','RELACK','MONITOR','COORDINATE','WHSE','TBI','INVOICED','COMM_WATCH','CLOSED_PAID','CLOSED'].includes(deal.stage);
      const wouldCreateInvoice = ['INVOICED','COMM_WATCH','CLOSED_PAID'].includes(deal.stage);
      log(`  deal ${deal.id} stage=${deal.stage}: rfq=${wouldCreateRfq} po=${wouldCreatePo} invoice=${wouldCreateInvoice}`);
      ok++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Replay the create hook (idempotent — no-op if already exists)
      await v2DualWrite.onDealCreated(client, deal);
      // Replay the stage transition for the current stage. Pass null
      // fromStage so it always fires (the hook short-circuits on
      // fromStage===toStage but null===toStage is false).
      await v2DualWrite.onDealStageChanged(client, deal, null, deal.stage);
      await client.query('COMMIT');
      ok++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      failed++;
      failures.push({ dealId: deal.id, stage: deal.stage, error: err.message });
      log(`  ✗ deal ${deal.id} (${deal.stage}): ${err.message}`);
    } finally {
      client.release();
    }
  }

  return { orgId: org.id, processed: deals.rows.length, ok, skipped, failed, failures };
}

(async function main() {
  let preExistingFlag = null;
  try {
    const orgs = await listOrgs();
    log(`will process ${orgs.length} org(s); DRY_RUN=${DRY_RUN}`);

    const results = [];
    for (const org of orgs) {
      // Temporarily flip v2_dual_write_enabled on for this org so the hooks
      // execute. Save prior value so we can restore it.
      preExistingFlag = await featureFlags.hasFeature(org.id, v2DualWrite.FLAG);
      if (!DRY_RUN) {
        await featureFlags.setFeature(org.id, v2DualWrite.FLAG, true);
      }
      try {
        const result = await backfillDealsForOrg(org);
        results.push(result);
      } finally {
        // Restore the flag to whatever it was before (off, by default).
        if (!DRY_RUN) {
          await featureFlags.setFeature(org.id, v2DualWrite.FLAG, preExistingFlag);
        }
      }
    }

    log('summary:');
    for (const r of results) {
      log(`  org ${r.orgId}: processed=${r.processed} ok=${r.ok} failed=${r.failed}`);
      if (r.failures.length > 0) {
        for (const f of r.failures.slice(0, 5)) {
          log(`    - deal ${f.dealId} (${f.stage}): ${f.error}`);
        }
        if (r.failures.length > 5) log(`    ...and ${r.failures.length - 5} more`);
      }
    }

    const exitCode = results.some(r => r.failed > 0) ? 1 : 0;
    await pool.end();
    process.exit(exitCode);
  } catch (err) {
    log('FATAL', err.message);
    await pool.end().catch(() => {});
    process.exit(2);
  }
})();
