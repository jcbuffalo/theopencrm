#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Nightly reconciliation: walk every org with v2_dual_write_enabled=true
// and verify v1 ↔ v2 consistency. Writes a JSON report to GCS, exits
// non-zero if any drift is detected.
//
// CHECKS:
//   1. Every deal in stages ≥ VENDOR_QUOTING has at least one rfqs row.
//   2. Every deal in stages ≥ ORDACK has at least one purchase_orders row.
//   3. Every deal in stages ≥ INVOICED has at least one invoices row.
//   4. Sum of invoice_allocations.allocated_quantity per PO line item ≤
//      purchase_order_line_items.quantity (no over-allocation).
//   5. Denormalized purchase_order_line_items.quantity_invoiced /
//      .amount_invoiced exactly match the sum of allocations.
//
// USAGE:
//   node scripts/reconcileV2.js                    # all phase2 orgs
//   ORG_ID=1 node scripts/reconcileV2.js           # specific org
//
// As a Cloud Scheduler job: hits this script in a one-shot Cloud Run job
// container nightly at 03:00 UTC. Exit code 0 = clean. Exit code 1 = drift.

require('dotenv').config();
const pool = require('../db');

const ORG_ID = process.env.ORG_ID;

const PRE_VENDOR_STAGES   = ['LEAD','TRIAGE','lead','qualified'];
const POST_VENDOR_STAGES  = ['VENDOR_QUOTING','CUSTOMER_QUOTING','FOLLOW_UP','NO_FOLLOW_UP','NOT_PROCESSED','PROCESSED','ORDACK','VAP','CAP','RELACK','MONITOR','COORDINATE','WHSE','TBI','COMM_WATCH','INVOICED','CLOSED_PAID','CLOSED'];
const POST_ORDER_STAGES   = ['ORDACK','VAP','CAP','RELACK','MONITOR','COORDINATE','WHSE','TBI','COMM_WATCH','INVOICED','CLOSED_PAID','CLOSED'];
const POST_INVOICE_STAGES = ['INVOICED','COMM_WATCH','CLOSED_PAID'];

function log(msg, extra) {
  // eslint-disable-next-line no-console
  console.log(`[reconcile] ${msg}`, extra || '');
}

async function listOrgs() {
  if (ORG_ID) {
    const r = await pool.query(`SELECT id, name FROM organizations WHERE id = $1`, [Number(ORG_ID)]);
    return r.rows;
  }
  const r = await pool.query(
    `SELECT id, name FROM organizations WHERE features @> '{"phase2_entities": true}'::jsonb ORDER BY id`
  );
  return r.rows;
}

async function reconcileOrg(org) {
  const drift = {
    orgId: org.id,
    orgName: org.name,
    timestamp: new Date().toISOString(),
    checks: {},
  };

  // 1. Deal → RFQ presence (only deals with external_ref need RFQs)
  const missingRfq = await pool.query(
    `SELECT d.id, d.stage, d.external_ref
       FROM deals d
       LEFT JOIN rfqs r ON r.deal_id = d.id AND r.org_id = d.org_id
      WHERE d.org_id = $1
        AND d.external_ref IS NOT NULL
        AND d.stage = ANY($2::text[])
        AND r.id IS NULL`,
    [org.id, POST_VENDOR_STAGES]
  );
  drift.checks.deals_missing_rfq = { count: missingRfq.rows.length, sample: missingRfq.rows.slice(0, 5) };

  // 2. Deal → PO presence (only deals with vendor_id need POs)
  const missingPo = await pool.query(
    `SELECT d.id, d.stage, d.vendor_id
       FROM deals d
       LEFT JOIN purchase_orders po ON po.deal_id = d.id AND po.vendor_id = d.vendor_id AND po.org_id = d.org_id
      WHERE d.org_id = $1
        AND d.vendor_id IS NOT NULL
        AND d.stage = ANY($2::text[])
        AND po.id IS NULL`,
    [org.id, POST_ORDER_STAGES]
  );
  drift.checks.deals_missing_po = { count: missingPo.rows.length, sample: missingPo.rows.slice(0, 5) };

  // 3. Deal → Invoice presence
  const missingInvoice = await pool.query(
    `SELECT d.id, d.stage
       FROM deals d
       LEFT JOIN invoices inv ON inv.deal_id = d.id AND inv.org_id = d.org_id
      WHERE d.org_id = $1
        AND d.stage = ANY($2::text[])
        AND inv.id IS NULL`,
    [org.id, POST_INVOICE_STAGES]
  );
  drift.checks.deals_missing_invoice = { count: missingInvoice.rows.length, sample: missingInvoice.rows.slice(0, 5) };

  // 4. Over-allocation (sum allocations > PO line quantity)
  const overAlloc = await pool.query(
    `SELECT po_li.id AS po_line_id, po_li.quantity, SUM(ia.allocated_quantity) AS total_allocated
       FROM purchase_order_line_items po_li
       JOIN invoice_allocations ia ON ia.purchase_order_line_item_id = po_li.id
      WHERE po_li.org_id = $1
      GROUP BY po_li.id, po_li.quantity
     HAVING SUM(ia.allocated_quantity) > po_li.quantity`,
    [org.id]
  );
  drift.checks.po_lines_over_allocated = { count: overAlloc.rows.length, sample: overAlloc.rows.slice(0, 5) };

  // 5. Denormalized totals consistency
  const denormDrift = await pool.query(
    `SELECT po_li.id AS po_line_id,
            po_li.quantity_invoiced AS denorm_qty,
            po_li.amount_invoiced AS denorm_amt,
            COALESCE(SUM(ia.allocated_quantity), 0) AS true_qty,
            COALESCE(SUM(ia.allocated_amount), 0) AS true_amt
       FROM purchase_order_line_items po_li
       LEFT JOIN invoice_allocations ia ON ia.purchase_order_line_item_id = po_li.id
      WHERE po_li.org_id = $1
      GROUP BY po_li.id
     HAVING po_li.quantity_invoiced <> COALESCE(SUM(ia.allocated_quantity), 0)
         OR po_li.amount_invoiced   <> COALESCE(SUM(ia.allocated_amount),   0)`,
    [org.id]
  );
  drift.checks.po_lines_denorm_drift = { count: denormDrift.rows.length, sample: denormDrift.rows.slice(0, 5) };

  drift.driftDetected =
    drift.checks.deals_missing_rfq.count > 0 ||
    drift.checks.deals_missing_po.count > 0 ||
    drift.checks.deals_missing_invoice.count > 0 ||
    drift.checks.po_lines_over_allocated.count > 0 ||
    drift.checks.po_lines_denorm_drift.count > 0;

  return drift;
}

async function writeReportToGcs(report) {
  // GCS upload is optional — we attempt it but don't fail the script if it
  // doesn't work (no creds, no bucket, etc.). The report is also printed
  // to stdout so Cloud Logging captures it.
  try {
    const { Storage } = require('@google-cloud/storage');
    const bucket = process.env.GCS_DOCUMENTS_BUCKET;
    if (!bucket) return false;

    const storage = new Storage();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `reconcile/v2-${date}-${Date.now()}.json`;
    await storage.bucket(bucket).file(filename).save(JSON.stringify(report, null, 2), {
      contentType: 'application/json',
    });
    log(`report written to gs://${bucket}/${filename}`);
    return true;
  } catch (err) {
    log(`GCS upload failed (non-fatal): ${err.message}`);
    return false;
  }
}

(async function main() {
  try {
    const orgs = await listOrgs();
    log(`reconciling ${orgs.length} org(s)`);

    const reports = [];
    for (const org of orgs) {
      const r = await reconcileOrg(org);
      reports.push(r);
      log(`  org ${org.id} (${org.name}): drift=${r.driftDetected}`, r.checks);
    }

    const overall = {
      timestamp: new Date().toISOString(),
      orgsChecked: reports.length,
      orgsWithDrift: reports.filter(r => r.driftDetected).length,
      reports,
    };

    // eslint-disable-next-line no-console
    console.log('\n=== RECONCILE REPORT ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(overall, null, 2));

    await writeReportToGcs(overall);

    const exitCode = overall.orgsWithDrift > 0 ? 1 : 0;
    await pool.end();
    process.exit(exitCode);
  } catch (err) {
    log('FATAL', err.message);
    await pool.end().catch(() => {});
    process.exit(2);
  }
})();
