// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Triggered-automation engine.
//
// Each rule is a small async function that scans for matches and inserts into
// `automation_runs` to dedupe (so the same trigger fires only once per target).
// On match, the rule may also: create a task, log an issue, queue a survey,
// fire a QuickBooks invoice, send an email, etc.
//
// The engine runs on a fixed interval (default every 60 minutes) and on demand
// via the admin UI. It is best-effort: if a rule fails for one tenant we log
// the error and continue with the rest.
//
// New rules: add to RULES[]. Each rule defines `id`, `description`, and `run()`.

const pool = require('../db');
const logger = require('./logger');
const email = require('./email');
const crypto = require('crypto');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.theopencrm.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Per-target dedupe. Most rules now enforce this inline in their scan via a
// `NOT EXISTS (SELECT 1 FROM automation_runs ...)` anti-join, which keeps the
// already-fired rows OUT of the LIMIT window (so rows past the limit aren't
// starved) and avoids a per-row N+1. `alreadyFired` is retained for rules whose
// scan is already self-excluding after they fire (e.g. renewal_at_risk flips
// its row out of the 'upcoming' scan filter), where a lightweight guard suffices.
async function alreadyFired(rule, targetType, targetId, withinDays = 365) {
  const r = await pool.query(
    `SELECT 1 FROM automation_runs
     WHERE rule = $1 AND target_type = $2 AND target_id = $3
       AND fired_at > NOW() - ($4 || ' days')::INTERVAL
     LIMIT 1`,
    [rule, targetType, targetId, String(withinDays)]
  );
  return r.rows.length > 0;
}

async function recordRun(rule, { orgId, targetType, targetId, status = 'fired', meta = null }) {
  await pool.query(
    `INSERT INTO automation_runs (org_id, rule, target_type, target_id, status, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId || null, rule, targetType || null, targetId || null, status, meta ? JSON.stringify(meta) : null]
  );
}

async function createTaskForOrg(orgId, ownerUserId, payload) {
  // Insert a task scoped to the org. The task itself won't have a user_id of
  // a real owner unless we know one — fall back to the org owner.
  const r = await pool.query(
    `INSERT INTO tasks (user_id, org_id, contact_id, deal_id, company_id, title, description, due_date, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
     RETURNING id`,
    [
      ownerUserId, orgId,
      payload.contact_id || null, payload.deal_id || null, payload.company_id || null,
      payload.title, payload.description || null,
      payload.due_date || null, payload.priority || 'medium',
    ]
  );
  if (!r.rows.length) throw new Error('createTaskForOrg: INSERT ... RETURNING produced no row');
  return r.rows[0].id;
}

async function ensureIssueForDeal(orgId, ownerUserId, dealId, urgency, title, description) {
  // Check if there's already an open issue with this title for this deal —
  // avoids piling up duplicates from rules that re-fire (defence in depth on
  // top of automation_runs deduping).
  const existing = await pool.query(
    `SELECT id FROM issues WHERE org_id = $1 AND related_type = 'deal' AND related_id = $2 AND title = $3 AND status IN ('open', 'in_progress') LIMIT 1`,
    [orgId, dealId, title]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const r = await pool.query(
    `INSERT INTO issues (user_id, org_id, related_type, related_id, title, description, urgency, status, category)
     VALUES ($1, $2, 'deal', $3, $4, $5, $6, 'open', 'logistics')
     RETURNING id`,
    [ownerUserId, orgId, dealId, title, description, urgency]
  );
  if (!r.rows.length) throw new Error('ensureIssueForDeal: INSERT ... RETURNING produced no row');
  return r.rows[0].id;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES = [
  // ----- Pre-Sale: vendor quote sent more than 30 days ago without response.
  {
    id: 'vendor_rfq_30d_stale',
    description: 'Flag vendor RFQs that were sent ≥30 days ago and never received a response',
    async run() {
      const rows = await pool.query(
        `SELECT vq.id, vq.deal_id, vq.vendor_id, vq.org_id, vq.user_id, vq.rfq_sent_at,
                v.name AS vendor_name, d.title AS deal_title
         FROM vendor_quotes vq
         JOIN deals d ON vq.deal_id = d.id
         LEFT JOIN companies v ON vq.vendor_id = v.id
         WHERE vq.rfq_sent_at IS NOT NULL
           AND vq.rfq_sent_at < NOW() - INTERVAL '30 days'
           AND vq.status = 'requested'
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'vendor_rfq_30d_stale'
                AND ar.target_type = 'vendor_quote'
                AND ar.target_id = vq.id
                AND ar.fired_at > NOW() - INTERVAL '30 days'
           )
         ORDER BY vq.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const vq of rows.rows) {
        try {
          await ensureIssueForDeal(
            vq.org_id, vq.user_id, vq.deal_id, 'yellow',
            `Vendor quote stale: ${vq.vendor_name}`,
            `RFQ sent ${new Date(vq.rfq_sent_at).toLocaleDateString()} — no response after 30 days. Consider following up or marking declined.`
          );
          await recordRun('vendor_rfq_30d_stale', {
            orgId: vq.org_id, targetType: 'vendor_quote', targetId: vq.id,
            meta: { vendorId: vq.vendor_id, dealId: vq.deal_id },
          });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'vendor_rfq_30d_stale', vqId: vq.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Pre-Sale: hot deal with no activity in 7 days.
  {
    id: 'hot_deal_stale_7d',
    description: 'Flag hot deals with no activity in 7 days',
    async run() {
      const rows = await pool.query(
        `SELECT id, org_id, user_id, owner_user_id, title, last_activity_at, created_at
         FROM deals
         WHERE hot_flag = TRUE
           AND COALESCE(last_activity_at, created_at) < NOW() - INTERVAL '7 days'
           AND stage NOT IN ('LOST', 'COLD', 'CLOSED', 'CLOSED_PAID', 'CANCELLED', 'closed_won', 'closed_lost')
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'hot_deal_stale_7d'
                AND ar.target_type = 'deal'
                AND ar.target_id = deals.id
                AND ar.fired_at > NOW() - INTERVAL '7 days'
           )
         ORDER BY id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const d of rows.rows) {
        try {
          const staleSince = d.last_activity_at || d.created_at;
          await ensureIssueForDeal(
            // Record ownership (migration 135): route the alert to the record
            // owner when one is set; fall back to the historical creator.
            d.org_id, d.owner_user_id || d.user_id, d.id, 'red',
            `🔥 HOT deal needs attention: ${d.title}`,
            `Deal is flagged hot but has had no activity since ${new Date(staleSince).toLocaleDateString()}.`
          );
          await recordRun('hot_deal_stale_7d', { orgId: d.org_id, targetType: 'deal', targetId: d.id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'hot_deal_stale_7d', dealId: d.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Pre-Sale: quote about to expire (valid_until within 7 days).
  {
    id: 'quote_expiring_7d',
    description: 'Create a follow-up task for quotes expiring within 7 days',
    async run() {
      const rows = await pool.query(
        `SELECT q.id, q.org_id, q.user_id, q.title, q.deal_id, q.valid_until, q.customer_id,
                co.name AS customer_name
         FROM quotes q
         LEFT JOIN companies co ON q.customer_id = co.id
         WHERE q.valid_until IS NOT NULL
           AND q.valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
           AND q.status NOT IN ('accepted', 'rejected', 'expired')
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'quote_expiring_7d'
                AND ar.target_type = 'quote'
                AND ar.target_id = q.id
                AND ar.fired_at > NOW() - INTERVAL '7 days'
           )
         ORDER BY q.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const q of rows.rows) {
        try {
          await createTaskForOrg(q.org_id, q.user_id, {
            deal_id: q.deal_id || null,
            title: `Quote expiring soon: ${q.title}`,
            description: `Quote for ${q.customer_name || 'customer'} expires ${new Date(q.valid_until).toLocaleDateString()}. Follow up or revise.`,
            due_date: q.valid_until,
            priority: 'high',
          });
          await recordRun('quote_expiring_7d', { orgId: q.org_id, targetType: 'quote', targetId: q.id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'quote_expiring_7d', quoteId: q.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Post-Sale: deal moved to INVOICED — queue customer survey + (when QB
  // is connected) trigger invoice creation. The survey is queued here and the
  // separate dispatcher sends it. QuickBooks side is fired by the QB module.
  {
    id: 'invoiced_queue_survey',
    description: 'Queue a customer-experience survey when a deal hits INVOICED',
    async run() {
      const rows = await pool.query(
        `SELECT d.id, d.org_id, d.user_id, d.poc_email, d.title
         FROM deals d
         WHERE d.stage IN ('INVOICED', 'CLOSED_PAID')
           AND d.poc_email IS NOT NULL
           AND d.updated_at > NOW() - INTERVAL '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM survey_invitations si WHERE si.deal_id = d.id
           )
         ORDER BY d.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const d of rows.rows) {
        try {
          const token = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `INSERT INTO survey_invitations (user_id, org_id, deal_id, customer_email, survey_token)
             VALUES ($1, $2, $3, $4, $5)`,
            [d.user_id, d.org_id, d.id, d.poc_email, token]
          );
          await recordRun('invoiced_queue_survey', { orgId: d.org_id, targetType: 'deal', targetId: d.id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'invoiced_queue_survey', dealId: d.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Auto-fire QuickBooks invoice on INVOICED stage (no-op if QB not connected).
  // Implements SOW §4.5a "Trigger-based invoicing upon shipment".
  {
    id: 'qb_create_invoice_on_invoiced',
    description: 'Create a QuickBooks invoice when a deal hits INVOICED (no-op if QB not connected for the org)',
    async run() {
      const qb = require('./quickbooks');
      if (!qb.isConfigured()) return { fired: 0, scanned: 0, skipped: 'qb_not_configured' };

      const rows = await pool.query(
        `SELECT d.id, d.org_id, d.user_id, d.title, d.amount, d.po_number, d.customer_id,
                co.name AS customer_name, d.poc_name
         FROM deals d
         LEFT JOIN companies co ON d.customer_id = co.id
         WHERE d.stage IN ('INVOICED', 'CLOSED_PAID')
           AND d.qb_invoice_id IS NULL
           AND d.amount IS NOT NULL AND d.amount > 0
           AND EXISTS (SELECT 1 FROM quickbooks_connections WHERE org_id = d.org_id)
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'qb_create_invoice_on_invoiced'
                AND ar.target_type = 'deal'
                AND ar.target_id = d.id
                AND ar.fired_at > NOW() - INTERVAL '365 days'
           )
         ORDER BY d.id ASC
         LIMIT 50`
      );
      let fired = 0;
      for (const d of rows.rows) {
        try {
          const result = await qb.createInvoiceForDeal(d);
          await recordRun('qb_create_invoice_on_invoiced', {
            orgId: d.org_id, targetType: 'deal', targetId: d.id,
            meta: { invoiceId: result.invoiceId, amount: result.amount },
          });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'qb_create_invoice_on_invoiced', dealId: d.id, error: err.message });
          await pool.query(
            `UPDATE quickbooks_connections SET last_sync_at = NOW(), last_sync_status = 'error', last_sync_error = $1 WHERE org_id = $2`,
            [err.message?.slice(0, 500), d.org_id]
          ).catch(() => {});
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Commission watch: flag deals stuck in COMM_WATCH for >30 days.
  // Implements SOW Exhibit A "COMM WATCH — waiting for commission to be paid".
  {
    id: 'commission_payable_30d',
    description: 'Alert when a deal has been in COMM_WATCH for more than 30 days (commission overdue)',
    async run() {
      const rows = await pool.query(
        `SELECT id, org_id, user_id, owner_user_id, salesman_id, title, last_activity_at
         FROM deals
         WHERE stage = 'COMM_WATCH'
           AND COALESCE(last_activity_at, updated_at) < NOW() - INTERVAL '30 days'
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'commission_payable_30d'
                AND ar.target_type = 'deal'
                AND ar.target_id = deals.id
                AND ar.fired_at > NOW() - INTERVAL '30 days'
           )
         ORDER BY id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const d of rows.rows) {
        try {
          await ensureIssueForDeal(
            // Record ownership (migration 135): prefer the record owner, then
            // the selling rep, then the historical creator.
            d.org_id, d.owner_user_id || d.salesman_id || d.user_id, d.id, 'yellow',
            `Commission overdue: ${d.title}`,
            `Deal has been in COMM_WATCH for >30 days. Verify commission receipt with accounting.`
          );
          await recordRun('commission_payable_30d', { orgId: d.org_id, targetType: 'deal', targetId: d.id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'commission_payable_30d', dealId: d.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Dormant customer outreach: customer with no deal activity in 180 days.
  // Implements SOW Exhibit A page 19 filter "DORMANT CUSTOMER".
  {
    id: 'dormant_customer_outreach',
    description: 'Create a re-engagement task for the original salesman when a customer has been dormant >180 days',
    async run() {
      const rows = await pool.query(
        `SELECT c.id AS customer_id, c.name AS customer_name, c.org_id, c.user_id, c.last_deal_at,
                (SELECT salesman_id FROM deals WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_salesman_id
         FROM companies c
         WHERE c.type = 'customer'
           AND c.last_deal_at IS NOT NULL
           AND c.last_deal_at < NOW() - INTERVAL '180 days'
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'dormant_customer_outreach'
                AND ar.target_type = 'company'
                AND ar.target_id = c.id
                AND ar.fired_at > NOW() - INTERVAL '90 days'
           )
         ORDER BY c.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const c of rows.rows) {
        try {
          await createTaskForOrg(c.org_id, c.last_salesman_id || c.user_id, {
            title: `Re-engage dormant customer: ${c.customer_name}`,
            description: `No deal activity since ${new Date(c.last_deal_at).toLocaleDateString()}. Time to reach out.`,
            due_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            priority: 'medium',
          });
          await recordRun('dormant_customer_outreach', { orgId: c.org_id, targetType: 'company', targetId: c.customer_id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'dormant_customer_outreach', customerId: c.customer_id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Service contract renewal: flag contracts inside their renewal-notice window.
  {
    id: 'service_contract_renewal_due',
    description: 'Create a renewal task for service contracts within their renewal-notice window',
    async run() {
      const rows = await pool.query(
        `SELECT sc.id, sc.org_id, sc.user_id, sc.name, sc.end_date, sc.renewal_notice_days, sc.customer_id, sc.deal_id
         FROM service_contracts sc
         WHERE sc.status = 'active'
           AND sc.end_date IS NOT NULL
           AND sc.end_date <= CURRENT_DATE + (COALESCE(sc.renewal_notice_days, 30) || ' days')::INTERVAL
           AND sc.end_date >= CURRENT_DATE
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'service_contract_renewal_due'
                AND ar.target_type = 'service_contract'
                AND ar.target_id = sc.id
                AND ar.fired_at > NOW() - INTERVAL '30 days'
           )
         ORDER BY sc.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const sc of rows.rows) {
        try {
          await createTaskForOrg(sc.org_id, sc.user_id, {
            deal_id: sc.deal_id || null,
            title: `Service contract renewal: ${sc.name}`,
            description: `Contract ends ${new Date(sc.end_date).toLocaleDateString()}. Reach out to renew or notify of expiry.`,
            due_date: sc.end_date,
            priority: 'high',
          });
          await recordRun('service_contract_renewal_due', { orgId: sc.org_id, targetType: 'service_contract', targetId: sc.id });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'service_contract_renewal_due', scId: sc.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Renewals (CS-3): flip renewal_stage to 'at_risk' when a contract is
  // inside its renewal-notice window but has had no recent activity on its
  // linked deal / customer. Complements service_contract_renewal_due (which
  // creates the task); this rule advances the renewals Kanban automatically so
  // an unattended renewal surfaces in the 'at_risk' column.
  {
    id: 'service_contract_renewal_at_risk',
    description: 'Flip a contract renewal_stage to at_risk when inside the notice window with no recent activity',
    async run() {
      const rows = await pool.query(
        `SELECT sc.id, sc.org_id, sc.user_id, sc.name, sc.end_date, sc.renewal_notice_days,
                sc.customer_id, sc.deal_id
         FROM service_contracts sc
         WHERE sc.status = 'active'
           AND COALESCE(sc.renewal_stage, 'upcoming') = 'upcoming'
           AND sc.end_date IS NOT NULL
           AND sc.end_date <= CURRENT_DATE + (COALESCE(sc.renewal_notice_days, 30) || ' days')::INTERVAL
           AND sc.end_date >= CURRENT_DATE
           AND NOT EXISTS (
             SELECT 1 FROM activities a
             WHERE a.activity_date > NOW() - INTERVAL '30 days'
               AND a.org_id = sc.org_id
               AND (
                 (sc.deal_id IS NOT NULL AND a.deal_id = sc.deal_id)
                 OR (sc.customer_id IS NOT NULL AND a.deal_id IN (
                       SELECT d.id FROM deals d WHERE d.customer_id = sc.customer_id AND d.org_id = sc.org_id))
               )
           )
         ORDER BY sc.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const sc of rows.rows) {
        // This rule is self-excluding once it fires (the flip to 'at_risk'
        // drops the row out of the 'upcoming' scan filter), so a lightweight
        // per-row dedup guard is sufficient here.
        if (await alreadyFired('service_contract_renewal_at_risk', 'service_contract', sc.id, 30)) continue;
        try {
          await pool.query(
            `UPDATE service_contracts SET renewal_stage = 'at_risk', updated_at = NOW()
             WHERE id = $1 AND COALESCE(renewal_stage, 'upcoming') = 'upcoming'`,
            [sc.id]
          );
          await recordRun('service_contract_renewal_at_risk', {
            orgId: sc.org_id, targetType: 'service_contract', targetId: sc.id,
            meta: { endDate: sc.end_date, customerId: sc.customer_id, dealId: sc.deal_id },
          });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'service_contract_renewal_at_risk', scId: sc.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Support cases (CS-5): SLA breached — case is past its sla_due_at and
  // still open/pending. Creates a follow-up task for the case owner (falling
  // back to the case creator). The scan rides the partial index
  // idx_cases_org_sla_open (status NOT IN resolved/closed). Dedupe: once per
  // case per 7 days via the standard automation_runs anti-join, so a breached
  // case re-surfaces weekly until someone resolves it.
  {
    id: 'case_sla_breach',
    description: 'Create a follow-up task when a support case blows past its SLA due date while still open',
    async run() {
      const rows = await pool.query(
        `SELECT c.id, c.org_id, c.user_id, c.subject, c.priority, c.sla_due_at,
                c.owner_user_id, c.company_id, co.name AS company_name
         FROM cases c
         LEFT JOIN companies co ON c.company_id = co.id
         WHERE c.sla_due_at IS NOT NULL
           AND c.sla_due_at < NOW()
           AND c.status NOT IN ('resolved', 'closed')
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs ar
              WHERE ar.rule = 'case_sla_breach'
                AND ar.target_type = 'case'
                AND ar.target_id = c.id
                AND ar.fired_at > NOW() - INTERVAL '7 days'
           )
         ORDER BY c.id ASC
         LIMIT 200`
      );
      let fired = 0;
      for (const c of rows.rows) {
        try {
          await createTaskForOrg(c.org_id, c.owner_user_id || c.user_id, {
            title: `⏰ Case SLA breached: ${c.subject}`,
            description: `Support case #${c.id}${c.company_name ? ` (${c.company_name})` : ''} was due ${new Date(c.sla_due_at).toLocaleDateString()} and is still open. Resolve it or update the customer.`,
            priority: c.priority === 'urgent' || c.priority === 'high' ? 'high' : 'medium',
          });
          await recordRun('case_sla_breach', {
            orgId: c.org_id, targetType: 'case', targetId: c.id,
            meta: { companyId: c.company_id, priority: c.priority, slaDueAt: c.sla_due_at },
          });
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'case_sla_breach', caseId: c.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },

  // ----- Send queued surveys (best-effort; only if email transport configured).
  {
    id: 'survey_send_pending',
    description: 'Send queued customer surveys via email (when SMTP is configured)',
    async run() {
      if (!email.isConfigured()) return { fired: 0, scanned: 0, skipped: 'email_not_configured' };
      const rows = await pool.query(
        `SELECT s.id, s.customer_email, s.survey_token, s.deal_id, d.title
         FROM survey_invitations s
         JOIN deals d ON s.deal_id = d.id
         WHERE s.sent_at IS NULL
         LIMIT 50`
      );
      let fired = 0;
      for (const s of rows.rows) {
        try {
          const surveyUrl = `${PUBLIC_BASE_URL}/survey/${s.survey_token}`;
          await email.sendMail({
            to: s.customer_email,
            subject: `How did we do? — Quick survey on "${s.title}"`,
            html: `<p>Hi,</p><p>We just wrapped your project "<strong>${s.title}</strong>". Could we get 30 seconds of your time?</p><p><a href="${surveyUrl}">Open the survey</a></p><p>Thank you!</p>`,
          });
          await pool.query(`UPDATE survey_invitations SET sent_at = NOW() WHERE id = $1`, [s.id]);
          fired++;
        } catch (err) {
          logger.warn('automation_rule_failed', { rule: 'survey_send_pending', invitationId: s.id, error: err.message });
        }
      }
      return { fired, scanned: rows.rowCount };
    },
  },
];

// ---------------------------------------------------------------------------
// User-defined rules (automation_rules table)
//
// Org admins author simple "when X, do Y" rules from the UI. Each enabled rule
// is loaded and evaluated on the SAME tick as the built-in RULES[] above. The
// evaluator is deliberately small + org-scoped: every scan filters on the
// rule's own org_id, and firings dedupe through the shared automation_runs
// ledger keyed rule='user_rule:<id>' (a NOT EXISTS anti-join in the scan keeps
// already-fired targets out of the LIMIT window). Rule JSON is re-validated
// with the same zod schema the API uses, so a malformed stored row is skipped
// rather than fatal.
//
// Triggers:  deal_stage_is { stage } · deal_idle_days { days } · task_overdue {}
//            · custom_date_offset { entity, field_name, offset_days } (CMN §1.3)
// Actions:   create_task { title, priority? } · notify · set_hot_flag (deal-only)
//            · create_task_and_notify { title, priority? } (date rule only)
// ---------------------------------------------------------------------------

const { createSchema: userRuleSchema } = require('../schemas/automationRules');

const USER_RULE_SCAN_LIMIT = 200;
const USER_RULE_DEDUPE_DAYS = 30;

// custom_date_offset: per-entity scan metadata. Custom-field VALUES live in
// each table's custom_fields JSONB store (migration 070); the definition —
// including its type — lives in org_field_definitions, which the scan JOINs
// so a field that was deleted or retyped away from 'date' stops matching
// instead of misfiring. Keys mirror schemas/automationRules.DATE_RULE_ENTITIES.
const DATE_RULE_TABLES = {
  deals: {
    table: 'deals', targetType: 'deal',
    nameExpr: 'r.title', ownerExpr: 'r.owner_user_id',
  },
  companies: {
    table: 'companies', targetType: 'company',
    nameExpr: 'r.name', ownerExpr: 'r.owner_user_id',
  },
  contacts: {
    table: 'contacts', targetType: 'contact',
    nameExpr: `TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, ''))`,
    ownerExpr: 'NULL::int', // contacts have no owner_user_id (migration 135 is companies/deals only)
  },
};

// How far past the boundary a match may still fire. Without this, enabling a
// rule (or adding the field) years after the dates passed would blast a task
// per ancient record; with it, the rule catches up on the last N days only.
const DATE_RULE_CATCHUP_DAYS = 30;

function ymdUTC(d) { return d.toISOString().slice(0, 10); }
function addDaysUTC(base, days) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Tiny placeholder substitution for the date rule's task-title template:
// {name} = record name/title, {date} = the field's date, {field} = field name.
function renderDateRuleTemplate(tpl, target, rule) {
  const date = target.field_date ? String(target.field_date).slice(0, 10) : '';
  return String(tpl)
    .replace(/\{name\}/g, target.record_name || '')
    .replace(/\{date\}/g, date)
    .replace(/\{field\}/g, (rule.conditions && rule.conditions.field_name) || '');
}

// Deal stages we consider "closed / dead" and therefore exclude from the
// idle-deal trigger — mirrors the built-in hot_deal_stale_7d exclusion set.
const CLOSED_DEAL_STAGES = "('LOST','COLD','CLOSED','CLOSED_PAID','CANCELLED','closed_won','closed_lost','CLOSED_WON','CLOSED_LOST')";

// Build the org-scoped scan for a rule's trigger. Returns { targetType, text,
// params } or null when the trigger is unknown / its conditions are missing
// (the evaluator treats null as a no-op). `dedupeKey` is the
// automation_runs.rule value the NOT EXISTS anti-join filters on.
function buildTriggerScan(rule, dedupeKey) {
  const orgId = rule.org_id;
  const conditions = rule.conditions || {};

  if (rule.trigger === 'deal_stage_is') {
    if (!conditions.stage) return null;
    return {
      targetType: 'deal',
      text: `
        SELECT d.id, d.org_id, d.user_id, d.title, d.stage
        FROM deals d
        WHERE d.org_id = $1
          AND d.stage = $2
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs ar
            WHERE ar.rule = $3 AND ar.target_type = 'deal' AND ar.target_id = d.id
              AND ar.fired_at > NOW() - ($4 || ' days')::INTERVAL
          )
        ORDER BY d.id ASC
        LIMIT ${USER_RULE_SCAN_LIMIT}`,
      params: [orgId, String(conditions.stage), dedupeKey, String(USER_RULE_DEDUPE_DAYS)],
    };
  }

  if (rule.trigger === 'deal_idle_days') {
    const days = Number(conditions.days);
    if (!Number.isFinite(days) || days <= 0) return null;
    return {
      targetType: 'deal',
      text: `
        SELECT d.id, d.org_id, d.user_id, d.title, d.stage
        FROM deals d
        WHERE d.org_id = $1
          AND COALESCE(d.last_activity_at, d.created_at) < NOW() - ($2 || ' days')::INTERVAL
          AND d.stage NOT IN ${CLOSED_DEAL_STAGES}
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs ar
            WHERE ar.rule = $3 AND ar.target_type = 'deal' AND ar.target_id = d.id
              AND ar.fired_at > NOW() - ($4 || ' days')::INTERVAL
          )
        ORDER BY d.id ASC
        LIMIT ${USER_RULE_SCAN_LIMIT}`,
      params: [orgId, String(days), dedupeKey, String(USER_RULE_DEDUPE_DAYS)],
    };
  }

  if (rule.trigger === 'custom_date_offset') {
    // "N days before/after <date custom field> on <entity>". A record matches
    // once TODAY >= field_date + offset_days (negative offset = before the
    // date), i.e. field_date <= today - offset. Dates in the JSONB store are
    // 'YYYY-MM-DD[…]' strings, which compare correctly as text — no ::date
    // cast that a malformed value could blow up. The dedupe is per record ×
    // rule × DATE VALUE via automation_runs.meta->>'trigger_date' (no time
    // window: it never re-fires for the same date, but a rescheduled date
    // fires again).
    const meta = DATE_RULE_TABLES[conditions.entity];
    const offset = Number(conditions.offset_days);
    const fieldName = conditions.field_name;
    if (!meta || !Number.isInteger(offset) || typeof fieldName !== 'string' || fieldName === '') return null;
    const now = new Date();
    const dueMax = ymdUTC(addDaysUTC(now, -offset));                          // newest field_date that has reached its boundary
    const dueMin = ymdUTC(addDaysUTC(now, -offset - DATE_RULE_CATCHUP_DAYS)); // catch-up horizon
    return {
      targetType: meta.targetType,
      text: `
        SELECT r.id, r.org_id, r.user_id, ${meta.ownerExpr} AS owner_user_id,
               ${meta.nameExpr} AS record_name,
               (r.custom_fields->>$2) AS field_date
        FROM ${meta.table} r
        JOIN org_field_definitions fd
          ON fd.org_id = r.org_id AND fd.entity = '${conditions.entity}'
         AND fd.name = $2 AND fd.type = 'date'
        WHERE r.org_id = $1
          AND (r.custom_fields->>$2) ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND substring(r.custom_fields->>$2 from 1 for 10) <= $3
          AND substring(r.custom_fields->>$2 from 1 for 10) >= $4
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs ar
            WHERE ar.rule = $5 AND ar.target_type = '${meta.targetType}' AND ar.target_id = r.id
              AND ar.meta->>'trigger_date' = (r.custom_fields->>$2)
          )
        ORDER BY r.id ASC
        LIMIT ${USER_RULE_SCAN_LIMIT}`,
      params: [orgId, fieldName, dueMax, dueMin, dedupeKey],
    };
  }

  if (rule.trigger === 'task_overdue') {
    return {
      targetType: 'task',
      text: `
        SELECT t.id, t.org_id, t.user_id, t.assigned_to, t.deal_id, t.title
        FROM tasks t
        WHERE t.org_id = $1
          AND t.due_date IS NOT NULL
          AND t.due_date < NOW()
          AND t.status NOT IN ('done','completed','cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs ar
            WHERE ar.rule = $2 AND ar.target_type = 'task' AND ar.target_id = t.id
              AND ar.fired_at > NOW() - ($3 || ' days')::INTERVAL
          )
        ORDER BY t.id ASC
        LIMIT ${USER_RULE_SCAN_LIMIT}`,
      params: [orgId, dedupeKey, String(USER_RULE_DEDUPE_DAYS)],
    };
  }

  return null;
}

// The create_task body shared by 'create_task' and 'create_task_and_notify'.
// For the date rule the title is a template ({name}/{date}/{field}) and the
// task links to the matched record + is due on the field's own date.
async function createTaskForTarget(rule, target, targetType) {
  const action = rule.action || {};
  const ownerUserId = target.owner_user_id || target.assigned_to || target.user_id || rule.created_by || null;
  const isDateRule = rule.trigger === 'custom_date_offset';
  const rawTitle = action.title || `Automation: ${rule.name}`;
  await createTaskForOrg(rule.org_id, ownerUserId, {
    deal_id: targetType === 'deal' ? target.id : (target.deal_id || null),
    contact_id: targetType === 'contact' ? target.id : null,
    company_id: targetType === 'company' ? target.id : null,
    title: isDateRule ? renderDateRuleTemplate(rawTitle, target, rule) : rawTitle,
    description: action.description || `Created by automation rule "${rule.name}".`,
    priority: action.priority || 'medium',
    due_date: isDateRule && target.field_date ? String(target.field_date).slice(0, 10) : null,
  });
}

// The notify body shared by 'notify' and 'create_task_and_notify'. Best-effort
// per-user notification: deals/tasks ride the existing dispatcher helpers
// (which honour per-channel preferences); companies/contacts get an in-app
// Notification Center row for the record owner (companies) or record creator —
// the always-on channel, without minting a new dispatcher category. Errors are
// swallowed — a failed notify must not block the run from being recorded (we
// don't want to re-notify every tick).
async function notifyForTarget(rule, target, targetType) {
  // Lazy-required to avoid any load-order coupling.
  const dispatcher = require('./notificationDispatcher');
  const inApp = require('./notifications');
  try {
    if (targetType === 'deal') {
      await dispatcher.notifyDealActivity(target.id, null);
    } else if (targetType === 'task') {
      await dispatcher.notifyTaskOverdue(target.id);
    } else if (targetType === 'company' || targetType === 'contact') {
      const recipient = target.owner_user_id || target.user_id || rule.created_by || null;
      if (!recipient) return;
      const fieldName = (rule.conditions && rule.conditions.field_name) || 'date';
      const date = target.field_date ? String(target.field_date).slice(0, 10) : null;
      await inApp.create({
        orgScope: ['org_id', rule.org_id],
        userId: recipient,
        type: 'automation_rule',
        title: `${rule.name}: ${target.record_name || `${targetType} #${target.id}`}`,
        body: date ? `${fieldName} = ${date}` : `Matched automation rule "${rule.name}".`,
        link: targetType === 'company' ? '/companies' : '/contacts',
        entityType: targetType,
        entityId: target.id,
      });
    }
  } catch (err) {
    logger.warn('automation_user_rule_notify_failed', { ruleId: rule.id, targetId: target.id, error: err.message });
  }
}

// Apply a rule's action to one matched target. Throws on hard failure so the
// caller can log + skip (and NOT record a run, so it retries next tick).
async function applyUserAction(rule, target, targetType) {
  const action = rule.action || {};
  const orgId = rule.org_id;

  switch (action.type) {
    case 'create_task':
      await createTaskForTarget(rule, target, targetType);
      return;
    case 'create_task_and_notify':
      await createTaskForTarget(rule, target, targetType);
      await notifyForTarget(rule, target, targetType);
      return;
    case 'set_hot_flag': {
      // Deal-only (schema-enforced). Org-scoped so a colliding id in another
      // tenant can't be flipped.
      await pool.query(
        `UPDATE deals SET hot_flag = TRUE, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [target.id, orgId]
      );
      return;
    }
    case 'notify':
      await notifyForTarget(rule, target, targetType);
      return;
    default:
      // Unknown action — no-op (zod should have blocked it at write time).
      return;
  }
}

// Evaluate a single user rule row (as loaded from automation_rules). Re-validates
// the stored JSON, builds the org-scoped scan, applies the action per matched
// target, and dedupes via automation_runs. Best-effort per target.
async function evaluateUserRule(rawRule) {
  const parsed = userRuleSchema.safeParse({
    name: rawRule.name,
    trigger: rawRule.trigger,
    conditions: rawRule.conditions,
    action: rawRule.action,
    enabled: rawRule.enabled,
  });
  if (!parsed.success) {
    logger.warn('automation_user_rule_invalid', { ruleId: rawRule.id, error: parsed.error.issues?.[0]?.message });
    return { id: rawRule.id, name: rawRule.name, ok: false, skipped: 'invalid', fired: 0, scanned: 0 };
  }
  // Keep id / org_id / created_by from the row; take validated fields from zod.
  const rule = { ...rawRule, ...parsed.data };

  if (!rule.org_id) {
    return { id: rule.id, name: rule.name, ok: true, skipped: 'no_org', fired: 0, scanned: 0 };
  }

  const dedupeKey = `user_rule:${rule.id}`;
  const scan = buildTriggerScan(rule, dedupeKey);
  if (!scan) {
    return { id: rule.id, name: rule.name, ok: true, skipped: 'unknown_trigger', fired: 0, scanned: 0 };
  }

  const rows = await pool.query(scan.text, scan.params);
  let fired = 0;
  for (const target of rows.rows) {
    try {
      await applyUserAction(rule, target, scan.targetType);
      await recordRun(dedupeKey, {
        orgId: rule.org_id,
        targetType: scan.targetType,
        targetId: target.id,
        meta: {
          ruleId: rule.id, trigger: rule.trigger, action: rule.action && rule.action.type,
          // custom_date_offset dedupes per record × rule × DATE — the scan's
          // anti-join matches this against the record's current field value.
          ...(target.field_date != null ? { trigger_date: target.field_date } : {}),
        },
      });
      fired++;
    } catch (err) {
      logger.warn('automation_user_rule_failed', { ruleId: rule.id, targetId: target.id, error: err.message });
    }
  }
  return { id: rule.id, name: rule.name, trigger: rule.trigger, ok: true, fired, scanned: rows.rowCount };
}

// Load every org's enabled user rules and evaluate them. Missing table (pre
// migration 110) or a load failure degrades to "no user rules" rather than
// crashing the tick.
async function runUserRules() {
  let rules;
  try {
    const r = await pool.query(
      `SELECT id, org_id, name, trigger, conditions, action, enabled, created_by
       FROM automation_rules
       WHERE enabled = TRUE
       ORDER BY id ASC`
    );
    rules = r.rows;
  } catch (err) {
    logger.warn('automation_user_rules_load_failed', { error: err.message });
    return [];
  }
  const results = [];
  for (const rule of rules) {
    const start = Date.now();
    try {
      const res = await evaluateUserRule(rule);
      results.push({ ...res, durationMs: Date.now() - start });
    } catch (err) {
      logger.error('automation_user_rule_error', { ruleId: rule.id, error: err.message });
      results.push({ id: rule.id, name: rule.name, ok: false, error: err.message, durationMs: Date.now() - start });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

async function runAll() {
  const summary = { startedAt: new Date().toISOString(), rules: [] };
  for (const rule of RULES) {
    const start = Date.now();
    try {
      const result = await rule.run();
      summary.rules.push({ id: rule.id, ok: true, durationMs: Date.now() - start, ...result });
    } catch (err) {
      logger.error('automation_engine_rule_error', { rule: rule.id, error: err.message });
      summary.rules.push({ id: rule.id, ok: false, durationMs: Date.now() - start, error: err.message });
    }
  }
  // User-defined rules run on the same tick as the built-ins. A failure here is
  // isolated to the user-rules block so it can't abort the built-in summary.
  try {
    summary.userRules = await runUserRules();
  } catch (err) {
    logger.error('automation_user_rules_run_failed', { error: err.message });
    summary.userRules = [];
  }
  summary.finishedAt = new Date().toISOString();
  logger.info('automation_engine_run', summary);
  return summary;
}

let intervalHandle = null;
function startScheduler({ intervalMinutes = 60 } = {}) {
  if (intervalHandle) return;
  // Run once on boot (after a short delay so migrations finish), then on the interval.
  setTimeout(() => { runAll().catch(err => logger.error('automation_initial_run_failed', { error: err.message })); }, 30_000);
  intervalHandle = setInterval(() => {
    runAll().catch(err => logger.error('automation_scheduled_run_failed', { error: err.message }));
  }, intervalMinutes * 60 * 1000);
  logger.info('automation_scheduler_started', { intervalMinutes });
}

function listRules() {
  return RULES.map(r => ({ id: r.id, description: r.description }));
}

module.exports = { runAll, startScheduler, listRules, runUserRules, evaluateUserRule };
