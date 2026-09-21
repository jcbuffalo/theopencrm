// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// My Day — the personal relationship work-queue. Extracted from
// routes/myDayRoutes.js (2026-09-21) so the daily notification digest email
// (services/notificationDigest.js) can render the SAME queue the /today
// page shows, with one-click action buttons. The route is now a thin
// wrapper: loadMyDay({ sf, sv, userId, log }) → the exact payload GET
// /api/my-day returns.
//
// Query ORDER is part of the contract: test/myDay.test.js drives the loader
// with ordered mocks (sections 1-6, then has_data, then nextSteps LAST).
// Add new sections after nextSteps.
//
// Scoping: every query is scoped via [sf, sv] (['org_id', id] or
// ['user_id', id] — the qs(req) tuple). tasksDue is ADDITIONALLY user-scoped.
// Resilience: each section degrades to [] on failure.

const pool = require('../db');

// Statuses that mean a task no longer needs anyone. Mirrors the open-task
// filter used by the Account 360 header rollup (routes/accountRoutes.js).
const TASK_DONE_STATUSES = ['done', 'completed', 'cancelled'];

// Stages that mean a deal already reached an outcome. Mirrors CLOSED_STAGES in
// routes/dealRoutes.js — covers the generic pipeline AND the Zang lifecycle.
const CLOSED_DEAL_STAGES = [
  'CLOSED_WON', 'CLOSED_LOST', 'closed_won', 'closed_lost',
  'CLOSED', 'CLOSED_PAID', 'LOST',
];

const DAY_MS = 86400000;
function daysSince(ts, now) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

// Run one section's loader; degrade to [] on ANY failure so a single missing
// table / broken source never turns the whole work-queue into a 500.
async function section(name, req, loader) {
  // `req` is any object with an optional `.log` (a real request or the digest worker's logger shim).
  try {
    return await loader();
  } catch (error) {
    if (req.log) req.log.warn('my_day_section_failed', { section: name, error: error.message });
    else console.warn(`My Day section "${name}" failed:`, error.message);
    return [];
  }
}


async function loadMyDay({ sf, sv, userId, log = null }) {
  const req = { log, userId };
    const now = new Date();

    // 1. My open tasks due today or overdue — soonest (most overdue) first.
    const tasksDue = await section('tasksDue', req, async () => {
      const r = await pool.query(
        `SELECT t.id, t.title, t.description, t.due_date, t.status, t.priority,
                t.deal_id, t.contact_id,
                d.title AS deal_title,
                CASE WHEN c.id IS NOT NULL THEN c.first_name || ' ' || c.last_name END AS contact_name
           FROM tasks t
           LEFT JOIN deals d    ON t.deal_id = d.id
           LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE t.${sf} = $1
            AND (t.assigned_to = $2 OR (t.assigned_to IS NULL AND t.user_id = $2))
            AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE
            AND LOWER(COALESCE(t.status, 'open')) NOT IN ('done', 'completed', 'cancelled')
          ORDER BY t.due_date ASC, t.created_at ASC
          LIMIT 25`,
        [sv, userId]
      );
      return r.rows.map((t) => ({
        ...t,
        overdue_days: Math.max(0, daysSince(t.due_date, now) ?? 0),
      }));
    });

    // 2. Service contracts renewing inside 30 days. Same shape as the renewals
    //    surface (routes/serviceContractRoutes.js). Missing table → [].
    const renewals = await section('renewals', req, async () => {
      const r = await pool.query(
        `SELECT sc.id, sc.name, sc.customer_id, sc.end_date, sc.status,
                sc.monthly_amount,
                (sc.end_date - CURRENT_DATE) AS days_to_end,
                c.name AS customer_name
           FROM service_contracts sc
           LEFT JOIN companies c ON sc.customer_id = c.id AND c.${sf} = $1
          WHERE sc.${sf} = $1
            AND sc.status = 'active'
            AND sc.end_date IS NOT NULL
            AND sc.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
          ORDER BY sc.end_date ASC
          LIMIT 25`,
        [sv]
      );
      return r.rows;
    });

    // 3. At-risk accounts — the lifecycle_stage='at_risk' roster the Accounts
    //    home also surfaces. lifecycle_stage may not exist on older DBs → [].
    const atRiskAccounts = await section('atRiskAccounts', req, async () => {
      const r = await pool.query(
        `SELECT id, name, industry, status, lifecycle_stage
           FROM companies
          WHERE ${sf} = $1 AND type = 'customer' AND lifecycle_stage = 'at_risk'
          ORDER BY name ASC
          LIMIT 10`,
        [sv]
      );
      return r.rows;
    });

    // 4. Gone-quiet accounts — same last-touch scope as the Accounts rollup
    //    (activities against the account's deals OR its company's contacts),
    //    quiet = no touch in > 30 days (never-touched counts as quiet).
    //    Quietest (oldest / never touched) first. `c.last_touch_at` (migration
    //    169) is an explicit "Log a touch" override for accounts with no
    //    matching Activity row yet — GREATEST'd against the activity-derived
    //    value so either kind of touch resets the quiet clock.
    const quietAccounts = await section('quietAccounts', req, async () => {
      const r = await pool.query(
        `SELECT c.id, c.name, c.industry, c.lifecycle_stage,
                GREATEST(lt.last_touch, c.last_touch_at) AS last_touch
           FROM companies c
           LEFT JOIN LATERAL (
             SELECT MAX(COALESCE(a.activity_date, a.created_at)) AS last_touch
               FROM activities a
              WHERE a.${sf} = $1
                AND ( a.deal_id    IN (SELECT id FROM deals    WHERE customer_id = c.id AND ${sf} = $1)
                   OR a.contact_id IN (SELECT id FROM contacts WHERE company_id = c.id AND ${sf} = $1) )
           ) lt ON TRUE
          WHERE c.${sf} = $1 AND c.type = 'customer'
            AND COALESCE(c.lifecycle_stage, 'active') <> 'churned'
            AND (GREATEST(lt.last_touch, c.last_touch_at) IS NULL
                 OR GREATEST(lt.last_touch, c.last_touch_at) < NOW() - INTERVAL '30 days')
          ORDER BY GREATEST(lt.last_touch, c.last_touch_at) ASC NULLS FIRST, c.name ASC
          LIMIT 10`,
        [sv]
      );
      return r.rows.map((a) => ({
        ...a,
        days_since_last_touch: daysSince(a.last_touch, now),
      }));
    });

    // 5. Open deals needing attention — past expected close date, or no
    //    activity logged in > 14 days (including never). Most urgent first.
    const dealsNeedingAttention = await section('dealsNeedingAttention', req, async () => {
      const r = await pool.query(
        `SELECT d.id, d.title, d.stage, d.phase, d.amount, d.expected_close_date,
                co.name AS company_name,
                cu.name AS customer_name,
                la.last_activity
           FROM deals d
           LEFT JOIN companies co ON d.company_id  = co.id
           LEFT JOIN companies cu ON d.customer_id = cu.id
           LEFT JOIN LATERAL (
             SELECT MAX(COALESCE(a.activity_date, a.created_at)) AS last_activity
               FROM activities a
              WHERE a.deal_id = d.id AND a.${sf} = $1
           ) la ON TRUE
          WHERE d.${sf} = $1
            AND d.stage NOT IN (${CLOSED_DEAL_STAGES.map((s) => `'${s}'`).join(', ')})
            AND (
                 (d.expected_close_date IS NOT NULL AND d.expected_close_date < CURRENT_DATE)
              OR la.last_activity IS NULL
              OR la.last_activity < NOW() - INTERVAL '14 days'
            )
          ORDER BY d.expected_close_date ASC NULLS LAST, la.last_activity ASC NULLS FIRST
          LIMIT 10`,
        [sv]
      );
      return r.rows.map((d) => {
        const closeDays = daysSince(d.expected_close_date, now);
        return {
          ...d,
          past_close_date: closeDays != null && closeDays > 0,
          days_since_last_activity: daysSince(d.last_activity, now),
        };
      });
    });

    // 6. Cheap "does this org have anything yet?" counts. One round-trip,
    //    three indexed COUNTs, org-scoped like everything else. null (not [])
    //    on failure so the client knows to fall back to its own detection.
    let has_data = null;
    try {
      const r = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM deals     WHERE ${sf} = $1) AS deals,
                (SELECT COUNT(*)::int FROM contacts  WHERE ${sf} = $1) AS contacts,
                (SELECT COUNT(*)::int FROM companies WHERE ${sf} = $1) AS companies`,
        [sv]
      );
      const row = (r && r.rows && r.rows[0]) || {};
      has_data = {
        deals:     Number(row.deals)     || 0,
        contacts:  Number(row.contacts)  || 0,
        companies: Number(row.companies) || 0,
      };
    } catch (error) {
      if (req.log) req.log.warn('my_day_section_failed', { section: 'has_data', error: error.message });
      else console.warn('My Day section "has_data" failed:', error.message);
    }

    // 7. Next steps (migration 172) — open deals whose committed next step is
    //    due today or overdue, most overdue first. Runs LAST so the query
    //    order the ordered-mock tests rely on for sections 1–6 is unchanged;
    //    a pre-172 database (no column) simply degrades this section to [].
    const nextSteps = await section('nextSteps', req, async () => {
      const r = await pool.query(
        `SELECT d.id, d.title, d.stage, d.deal_type, d.amount, d.next_step, d.next_step_date,
                COALESCE(cu.name, co.name) AS company_name,
                CASE WHEN c.id IS NOT NULL THEN c.first_name || ' ' || c.last_name END AS contact_name
           FROM deals d
           LEFT JOIN companies co ON d.company_id  = co.id
           LEFT JOIN companies cu ON d.customer_id = cu.id
           LEFT JOIN contacts  c  ON d.contact_id  = c.id
          WHERE d.${sf} = $1
            AND d.next_step_date IS NOT NULL AND d.next_step_date <= CURRENT_DATE
            AND d.stage NOT IN (${CLOSED_DEAL_STAGES.map((s) => `'${s}'`).join(', ')})
          ORDER BY d.next_step_date ASC, d.amount DESC NULLS LAST, d.id ASC
          LIMIT 25`,
        [sv]
      );
      return r.rows.map((d) => ({
        ...d,
        overdue_days: Math.max(0, daysSince(d.next_step_date, now) ?? 0),
      }));
    });


  return {
    tasksDue,
    renewals,
    atRiskAccounts,
    quietAccounts,
    dealsNeedingAttention,
    nextSteps,
    has_data,
    counts: {
      tasksDue: tasksDue.length,
      renewals: renewals.length,
      atRiskAccounts: atRiskAccounts.length,
      quietAccounts: quietAccounts.length,
      dealsNeedingAttention: dealsNeedingAttention.length,
      nextSteps: nextSteps.length,
      total: tasksDue.length + renewals.length + atRiskAccounts.length
           + quietAccounts.length + dealsNeedingAttention.length + nextSteps.length,
    },
  };
}

module.exports = { loadMyDay, TASK_DONE_STATUSES, CLOSED_DEAL_STAGES, daysSince };
