// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Phase 3 — dual-write hooks.
//
// When a v1 lifecycle action commits (deal created, deal stage changed,
// vendor quote updated, customer quote updated), the corresponding v2 entity
// (RFQ, Purchase Order, Invoice, Allocation) gets created or updated inside
// the same transaction so v1 and v2 can never disagree.
//
// CONTRACT for each hook:
//   • takes a `client` from `pool.connect()` already inside an open
//     transaction (the caller did `client.query('BEGIN')` and will
//     `COMMIT` or `ROLLBACK`)
//   • takes the v1 entity row(s) the action just produced
//   • is idempotent — calling it twice with the same input is a no-op
//     (it queries for the v2 record before inserting; updates if found)
//   • throws on a real error so the caller's transaction rolls back the
//     v1 write too
//   • returns nothing of consequence — the caller doesn't depend on the
//     v2 result
//
// META-FLAG: every hook is gated by the per-org feature flag
// `v2_dual_write_enabled`. Default off. When off, hooks return immediately
// and have zero side effects. Flipping the flag back to false stops new
// dual-writes; existing v2 data is preserved (but goes stale until the
// flag is flipped back on and a backfill is run).
//
// NOT WIRED IN THIS PHASE:
//   • Auto-populating PO line items from quote line items at ORDACK is
//     intentionally omitted. The PO header gets created; users add lines
//     via /api/v2/purchase-orders/:id/line-items. Once we see real Zang
//     data flowing, we can encode the right line-item-copy rule.
//   • Same for invoice line items + allocations at INVOICED — header
//     only. Allocations are added explicitly via the v2 routes.

const featureFlags = require('./featureFlags');

const FLAG = 'v2_dual_write_enabled';

/**
 * Returns true if the given org has dual-write turned on.
 * @param {number} orgId
 * @returns {Promise<boolean>}
 */
async function isEnabled(orgId) {
  if (!orgId) return false;
  return featureFlags.hasFeature(orgId, FLAG);
}

// ---------------------------------------------------------------------------
// HOOK: deal created
// ---------------------------------------------------------------------------
/**
 * Called inside the deal-create transaction. If the org has dual-write
 * enabled and the deal has an external_ref (Zang #), seeds a draft RFQ
 * row for this deal so future stage transitions have something to update.
 *
 * Idempotent: a no-op if an RFQ for this deal already exists.
 *
 * @param {import('pg').PoolClient} client - already inside a transaction
 * @param {object} deal - the row returned from INSERT INTO deals ... RETURNING *
 */
async function onDealCreated(client, deal) {
  if (!await isEnabled(deal.org_id)) return;
  if (!deal.external_ref) return; // no external ref → no RFQ shape yet

  const existing = await client.query(
    `SELECT id FROM rfqs WHERE deal_id = $1 AND org_id = $2 LIMIT 1`,
    [deal.id, deal.org_id]
  );
  if (existing.rows.length > 0) return;

  await client.query(
    `INSERT INTO rfqs
       (org_id, deal_id, customer_id, vendor_id, status, title, external_ref, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $7)`,
    [
      deal.org_id, deal.id,
      deal.customer_id || null,
      deal.vendor_id || null,
      deal.title || `RFQ for deal ${deal.id}`,
      deal.external_ref,
      deal.created_by || deal.user_id,
    ]
  );
}

// ---------------------------------------------------------------------------
// HOOK: deal stage changed
// ---------------------------------------------------------------------------
/**
 * Dispatches to per-stage actions. Each per-stage helper is independently
 * idempotent — entering a stage twice doesn't create duplicate v2 records.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} deal - the row AFTER the stage update (i.e., deal.stage === toStage)
 * @param {string} fromStage
 * @param {string} toStage
 */
async function onDealStageChanged(client, deal, fromStage, toStage) {
  if (!await isEnabled(deal.org_id)) return;
  if (fromStage === toStage) return;

  switch (toStage) {
    case 'VENDOR_QUOTING':
      await ensureRfq(client, deal, 'sent');
      break;

    case 'CUSTOMER_QUOTING':
      // Link the existing customer quote row(s) for this deal to the parent RFQ.
      await linkQuotesToRfq(client, deal);
      break;

    case 'NOT_PROCESSED':
      await closeRfqs(client, deal);
      break;

    case 'ORDACK':
      await ensurePurchaseOrder(client, deal, 'sent');
      break;

    case 'RELACK':
      // PO release acknowledged — bump status if a PO exists.
      await updatePurchaseOrderStatus(client, deal, 'released');
      break;

    case 'INVOICED':
      await ensureInvoice(client, deal, 'sent');
      break;

    case 'CLOSED_PAID':
      await markInvoicePaid(client, deal);
      break;

    default:
      // No v2 side effect for stages we don't handle.
      return;
  }
}

// ---------------------------------------------------------------------------
// HOOK: vendor quote updated (placeholder for next session)
// ---------------------------------------------------------------------------
/**
 * Called from vendorQuoteRoutes.js on POST/PUT. Ensures the corresponding
 * RFQ exists (one per vendor on the deal) and updates its status to
 * 'responded' when a quote is received. Currently a stub.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} vq
 */
async function onVendorQuoteUpdated(client, vq) {
  if (!await isEnabled(vq.org_id)) return;
  // Future: ensure rfqs(deal_id=vq.deal_id, vendor_id=vq.vendor_id) exists,
  // set status='responded' if vq.quote_received_at is set.
}

// ---------------------------------------------------------------------------
// HOOK: customer quote updated (placeholder for next session)
// ---------------------------------------------------------------------------
/**
 * Called from quoteRoutes.js on POST/PUT. Sets quotes.rfq_id linkage if a
 * parent RFQ exists for this deal. Currently a stub.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} quote
 */
async function onQuoteUpdated(client, quote) {
  if (!await isEnabled(quote.org_id)) return;
  // Future: SELECT rfq_id FROM rfqs WHERE deal_id = quote.deal_id ...
  //         UPDATE quotes SET rfq_id = ... WHERE id = quote.id
}

// ===========================================================================
// PER-STAGE HELPERS
// ===========================================================================

/**
 * Ensure an RFQ row exists for this deal in the given status. Creates one
 * if missing; updates status if found.
 * @param {import('pg').PoolClient} client
 * @param {object} deal
 * @param {string} status
 */
async function ensureRfq(client, deal, status) {
  const existing = await client.query(
    `SELECT id FROM rfqs WHERE deal_id = $1 AND org_id = $2 LIMIT 1`,
    [deal.id, deal.org_id]
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE rfqs SET status = $1, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP, updated_by = $2,
              entity_version = entity_version + 1
        WHERE id = $3`,
      [status, deal.updated_by || deal.user_id, existing.rows[0].id]
    );
    return;
  }
  await client.query(
    `INSERT INTO rfqs
       (org_id, deal_id, customer_id, vendor_id, status, title, external_ref, sent_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8, $8)`,
    [
      deal.org_id, deal.id,
      deal.customer_id || null,
      deal.vendor_id || null,
      status,
      deal.title || `RFQ for deal ${deal.id}`,
      deal.external_ref || null,
      deal.updated_by || deal.user_id,
    ]
  );
}

/**
 * Set rfqs.status='closed' for all RFQs on this deal (the RFQ phase is
 * over; we have a customer PO).
 */
async function closeRfqs(client, deal) {
  await client.query(
    `UPDATE rfqs SET status = 'closed', updated_at = CURRENT_TIMESTAMP, updated_by = $1,
            entity_version = entity_version + 1
      WHERE deal_id = $2 AND org_id = $3 AND status NOT IN ('closed','cancelled')`,
    [deal.updated_by || deal.user_id, deal.id, deal.org_id]
  );
}

/**
 * Link any existing customer-quote rows to their parent RFQ.
 */
async function linkQuotesToRfq(client, deal) {
  const rfq = await client.query(
    `SELECT id FROM rfqs WHERE deal_id = $1 AND org_id = $2 ORDER BY created_at LIMIT 1`,
    [deal.id, deal.org_id]
  );
  if (rfq.rows.length === 0) return;
  await client.query(
    `UPDATE quotes SET rfq_id = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2,
            entity_version = entity_version + 1
      WHERE deal_id = $3 AND org_id = $4 AND rfq_id IS NULL`,
    [rfq.rows[0].id, deal.updated_by || deal.user_id, deal.id, deal.org_id]
  );
}

/**
 * Ensure a PO row exists for this deal+vendor. Header only — line items
 * are deliberately not auto-populated (see module-top NOT WIRED IN THIS
 * PHASE comment).
 */
async function ensurePurchaseOrder(client, deal, status) {
  if (!deal.vendor_id) return; // no vendor → no PO

  const existing = await client.query(
    `SELECT id FROM purchase_orders WHERE deal_id = $1 AND vendor_id = $2 AND org_id = $3 LIMIT 1`,
    [deal.id, deal.vendor_id, deal.org_id]
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE purchase_orders SET status = $1, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP, updated_by = $2,
              entity_version = entity_version + 1
        WHERE id = $3`,
      [status, deal.updated_by || deal.user_id, existing.rows[0].id]
    );
    return;
  }
  await client.query(
    `INSERT INTO purchase_orders
       (org_id, deal_id, vendor_id, status, po_number, external_ref, sent_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $7)`,
    [
      deal.org_id, deal.id, deal.vendor_id, status,
      deal.po_number || null,
      deal.external_ref || null,
      deal.updated_by || deal.user_id,
    ]
  );
}

async function updatePurchaseOrderStatus(client, deal, status) {
  if (!deal.vendor_id) return;
  await client.query(
    `UPDATE purchase_orders SET status = $1,
            released_at = CASE WHEN $1 = 'released' THEN CURRENT_TIMESTAMP ELSE released_at END,
            acknowledged_at = CASE WHEN $1 = 'acknowledged' THEN CURRENT_TIMESTAMP ELSE acknowledged_at END,
            updated_at = CURRENT_TIMESTAMP, updated_by = $2,
            entity_version = entity_version + 1
      WHERE deal_id = $3 AND vendor_id = $4 AND org_id = $5`,
    [status, deal.updated_by || deal.user_id, deal.id, deal.vendor_id, deal.org_id]
  );
}

/**
 * Ensure an invoice row exists for this deal. Header only — line items +
 * allocations are not auto-populated (see module-top comment).
 */
async function ensureInvoice(client, deal, status) {
  const existing = await client.query(
    `SELECT id FROM invoices WHERE deal_id = $1 AND org_id = $2 LIMIT 1`,
    [deal.id, deal.org_id]
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2,
              entity_version = entity_version + 1
        WHERE id = $3`,
      [status, deal.updated_by || deal.user_id, existing.rows[0].id]
    );
    return;
  }
  await client.query(
    `INSERT INTO invoices
       (org_id, deal_id, customer_id, status, invoice_number, external_ref, total_amount, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      deal.org_id, deal.id,
      deal.customer_id || null,
      status,
      deal.po_number || null,
      deal.external_ref || null,
      deal.amount || null,
      deal.updated_by || deal.user_id,
    ]
  );
}

async function markInvoicePaid(client, deal) {
  await client.query(
    `UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP, updated_by = $1,
            entity_version = entity_version + 1
      WHERE deal_id = $2 AND org_id = $3 AND status NOT IN ('paid','void')`,
    [deal.updated_by || deal.user_id, deal.id, deal.org_id]
  );
}

module.exports = {
  FLAG,
  isEnabled,
  onDealCreated,
  onDealStageChanged,
  onVendorQuoteUpdated,
  onQuoteUpdated,
};
