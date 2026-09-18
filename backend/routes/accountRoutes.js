// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Success — Account 360 (CS-1).
//
// GET /api/accounts/:companyId/360 returns a single account's post-sale picture:
//   • header  — the company row plus rollup counts (open tasks / issues / deals)
//               and a derived last_touch timestamp across every signal.
//   • timeline — a merged, time-ordered (DESC) list of the account's activities,
//               tasks, deals, issues, and Gmail thread summaries.
//
// "The account" is the set of deals whose customer_id = :companyId, plus the
// company's own contacts. Activities/tasks attach to a deal_id and/or a
// contact_id, so the account scope is:
//   deal_id  IN (SELECT id FROM deals    WHERE customer_id = :companyId AND <org>)
//   contact_id IN (SELECT id FROM contacts WHERE company_id = :companyId AND <org>)
//
// Org-scoping: EVERY query is filtered by qs(req) → [sf, sv]. The sub-selects
// that resolve the deal / contact id-sets are themselves org-scoped, so a
// caller can never reach across orgs by passing another org's companyId.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { pulseHealthSignal } = require('../services/relationshipPulse');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Days-since / days-until helpers. Positive days-since = past; positive
// days-until = future. Return null for a missing date so the caller can
// render an em-dash rather than a bogus number.
const DAY_MS = 86400000;
function daysSince(ts, now) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}
function daysUntil(ts, now) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / DAY_MS);
}

// GET / — the Accounts home rollup. One org-scoped, N+1-free query returns every
// account (type='customer') joined with:
//   • its latest account-health band/score (LATERAL LIMIT 1 over the append-only
//     account_health_snapshots — the newest row per company);
//   • last_touch — the most recent activity across the account's deals OR its
//     company's contacts (mirrors the 360 timeline's activity scope);
//   • next_renewal_date — the soonest active service-contract end_date >= today.
//
// Each of those is a LATERAL subquery, so the whole thing is a SINGLE SQL
// statement (the planner runs the laterals per company row) — we never issue one
// query per account from Node. Derived day-counts + the "gone quiet" / "renewing
// soon" cadence rollups are computed in JS from the single result set.
//
// Org-scoping: every clause (the base table AND all three laterals, including
// the deal/contact id sub-selects) is guarded by qs(req) → [sf, sv], so a row
// can never aggregate another org's data. Feature-gated at the index.js mount
// (requireFeature('customer_success_enabled')).
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const now = new Date();

    const result = await pool.query(
      `
      SELECT
        c.id, c.name, c.industry, c.website, c.location, c.type, c.status,
        c.lifecycle_stage, c.owner_id, c.created_at,
        hs.band        AS health_band,
        hs.score       AS health_score,
        hs.computed_at AS health_computed_at,
        lt.last_touch,
        nr.next_renewal_date,
        lp.score       AS pulse_score,
        lp.kind        AS pulse_kind,
        lp.created_at  AS pulse_recorded_at
      FROM companies c
      LEFT JOIN LATERAL (
        SELECT s.band, s.score, s.computed_at
          FROM account_health_snapshots s
         WHERE s.company_id = c.id AND s.${sf} = $1
         ORDER BY s.computed_at DESC
         LIMIT 1
      ) hs ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(a.activity_date, a.created_at)) AS last_touch
          FROM activities a
         WHERE a.${sf} = $1
           AND ( a.deal_id    IN (SELECT id FROM deals    WHERE customer_id = c.id AND ${sf} = $1)
              OR a.contact_id IN (SELECT id FROM contacts WHERE company_id = c.id AND ${sf} = $1) )
      ) lt ON TRUE
      LEFT JOIN LATERAL (
        SELECT MIN(sc.end_date) AS next_renewal_date
          FROM service_contracts sc
         WHERE sc.${sf} = $1 AND sc.customer_id = c.id
           AND sc.status = 'active' AND sc.end_date IS NOT NULL AND sc.end_date >= CURRENT_DATE
      ) nr ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.score, p.kind, p.created_at
          FROM relationship_pulses p
         WHERE p.company_id = c.id AND p.${sf} = $1
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1
      ) lp ON TRUE
      WHERE c.${sf} = $1 AND c.type = 'customer'
      ORDER BY c.name ASC
      `,
      [sv]
    );

    // "Gone quiet" (no activity in 30/60/90d) + "Renewing soon" (renewal within
    // 30/60/90d) cadence rollups. Buckets are cumulative/nested — an account 90
    // days quiet is also counted in the 30- and 60-day buckets. A never-touched
    // account (last_touch NULL) counts as gone-quiet in every bucket.
    const goneQuiet = { d30: 0, d60: 0, d90: 0 };
    const renewingSoon = { d30: 0, d60: 0, d90: 0 };

    const accounts = result.rows.map((r) => {
      const dslt = daysSince(r.last_touch, now);
      const dtr = daysUntil(r.next_renewal_date, now);
      const goneQuietFlag = dslt == null || dslt > 30;

      // Quiet rollup — never-touched (dslt null) lands in all three buckets.
      const quietDays = dslt == null ? Infinity : dslt;
      if (quietDays >= 30) goneQuiet.d30++;
      if (quietDays >= 60) goneQuiet.d60++;
      if (quietDays >= 90) goneQuiet.d90++;

      // Renewal rollup — only future/near renewals count.
      if (dtr != null && dtr >= 0) {
        if (dtr <= 30) renewingSoon.d30++;
        if (dtr <= 60) renewingSoon.d60++;
        if (dtr <= 90) renewingSoon.d90++;
      }

      return {
        id: r.id,
        name: r.name,
        industry: r.industry,
        website: r.website,
        location: r.location,
        type: r.type,
        status: r.status,
        lifecycle_stage: r.lifecycle_stage || 'active',
        owner_id: r.owner_id,
        health_band: r.health_band || null,
        health_score: r.health_score ?? null,
        health_computed_at: r.health_computed_at || null,
        last_touch: r.last_touch || null,
        days_since_last_touch: dslt,
        gone_quiet: goneQuietFlag,
        next_renewal_date: r.next_renewal_date || null,
        days_to_next_renewal: dtr,
        // Latest relationship pulse (NPS/CSAT survey) — a health SIGNAL shown
        // alongside the rules-based health band above, never replacing it.
        pulse_score: r.pulse_score ?? null,
        pulse_kind: r.pulse_kind || null,
        pulse_band: pulseHealthSignal(r.pulse_score)?.band || null,
        pulse_recorded_at: r.pulse_recorded_at || null,
      };
    });

    res.json({
      accounts,
      summary: {
        total: accounts.length,
        gone_quiet: goneQuiet,
        renewing_soon: renewingSoon,
      },
    });
  } catch (error) {
    if (req.log) req.log.error('accounts_list_failed', { error });
    else console.error('Accounts list error:', error.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// GET /:companyId/360 — merged account header + timeline.
router.get('/:companyId/360', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const companyId = parseInt(req.params.companyId, 10);
    if (!Number.isInteger(companyId)) {
      return res.status(400).json({ error: 'Invalid company id' });
    }

    // 1. Company header — org-scoped so an out-of-org id returns 404.
    const companyRes = await pool.query(
      `SELECT id, name, industry, website, location, employee_count, annual_revenue,
              status, type, owner_id, first_deal_at, last_deal_at, notes,
              created_at, updated_at
         FROM companies
        WHERE id = $1 AND ${sf} = $2`,
      [companyId, sv]
    );
    if (companyRes.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const company = companyRes.rows[0];

    // Resolve the org-scoped id-sets the timeline aggregates over. We compute
    // them inline (sub-selects) inside each query rather than round-tripping,
    // but pre-fetch the counts the header needs.

    // 2. Deals on this account (customer_id = company). Doubles as the timeline
    //    "deal" rows and the open-deal count source.
    const dealsRes = await pool.query(
      `SELECT id, title, stage, phase, amount, expected_close_date, closed_date,
              created_at, updated_at
         FROM deals
        WHERE customer_id = $1 AND ${sf} = $2
        ORDER BY updated_at DESC`,
      [companyId, sv]
    );
    const deals = dealsRes.rows;

    // 3. Activities for the account (by deal OR by the company's contacts).
    const activitiesRes = await pool.query(
      `SELECT a.id, a.type, a.title, a.description, a.activity_date, a.outcome,
              a.deal_id, a.contact_id, a.created_at
         FROM activities a
        WHERE a.${sf} = $2
          AND ( a.deal_id IN (SELECT id FROM deals    WHERE customer_id = $1 AND ${sf} = $2)
             OR a.contact_id IN (SELECT id FROM contacts WHERE company_id = $1 AND ${sf} = $2) )
        ORDER BY COALESCE(a.activity_date, a.created_at) DESC`,
      [companyId, sv]
    );

    // 4. Tasks for the account (by deal OR by the company's contacts).
    const tasksRes = await pool.query(
      `SELECT t.id, t.title, t.description, t.due_date, t.status, t.priority,
              t.deal_id, t.contact_id, t.created_at, t.updated_at
         FROM tasks t
        WHERE t.${sf} = $2
          AND ( t.deal_id IN (SELECT id FROM deals    WHERE customer_id = $1 AND ${sf} = $2)
             OR t.contact_id IN (SELECT id FROM contacts WHERE company_id = $1 AND ${sf} = $2) )
        ORDER BY COALESCE(t.due_date, t.created_at) DESC`,
      [companyId, sv]
    );

    // 5. Issues raised against the account's deals (related_type = 'deal').
    const issuesRes = await pool.query(
      `SELECT i.id, i.title, i.description, i.category, i.urgency, i.status,
              i.related_id AS deal_id, i.resolved_at, i.created_at, i.updated_at
         FROM issues i
        WHERE i.${sf} = $2
          AND i.related_type = 'deal'
          AND i.related_id IN (SELECT id FROM deals WHERE customer_id = $1 AND ${sf} = $2)
        ORDER BY i.created_at DESC`,
      [companyId, sv]
    );

    // 6. Gmail thread summaries for the account's deals (latest row per thread).
    const summariesRes = await pool.query(
      `SELECT DISTINCT ON (s.thread_link_id)
              s.id, s.deal_id, s.thread_link_id, s.summary_md, s.next_step,
              s.generated_at
         FROM deal_gmail_summaries s
        WHERE s.${sf} = $2
          AND s.deal_id IN (SELECT id FROM deals WHERE customer_id = $1 AND ${sf} = $2)
        ORDER BY s.thread_link_id, s.generated_at DESC`,
      [companyId, sv]
    );

    // 7. Synced inbound (and outbound) Gmail messages for the account's deals —
    //    the raw two-way-email surface produced by the inbound sync
    //    (services/gmailSync.syncOrg → email_thread_messages). The summaries in
    //    step 6 are the rolled-up view; these are the individual messages. We
    //    only join here when the request is org-scoped: email_thread_messages is
    //    org-only (no user_id column), so a user-fallback scope has no emails.
    //    Cap to the most recent 100 so a chatty account can't flood the timeline.
    let emailMsgs = [];
    if (req.orgId) {
      const emailMsgsRes = await pool.query(
        `SELECT m.id, m.thread_link_id, m.from_addr, m.subject, m.snippet,
                m.internal_date, t.deal_id
           FROM email_thread_messages m
           JOIN deal_email_threads t ON t.id = m.thread_link_id
          WHERE m.org_id = $2
            AND t.deal_id IN (SELECT id FROM deals WHERE customer_id = $1 AND ${sf} = $2)
          ORDER BY m.internal_date DESC NULLS LAST
          LIMIT 100`,
        [companyId, sv]
      );
      emailMsgs = emailMsgsRes.rows;
    }

    // 8. Calendar meetings for the account's deals (migration 115). Synced from
    //    Google Calendar (matched by attendee email) or created from a deal via
    //    the "Schedule meeting" action. calendar_events is org-only (no user_id
    //    column), so we only join for an org-scoped request. Cap to 100.
    let meetings = [];
    if (req.orgId) {
      const meetingsRes = await pool.query(
        `SELECT ce.id, ce.deal_id, ce.title, ce.start_at, ce.end_at,
                ce.meeting_link, ce.html_link, ce.attendees, ce.organizer_email,
                ce.status, ce.source
           FROM calendar_events ce
          WHERE ce.org_id = $2
            AND ce.deal_id IN (SELECT id FROM deals WHERE customer_id = $1 AND ${sf} = $2)
          ORDER BY ce.start_at DESC NULLS LAST
          LIMIT 100`,
        [companyId, sv]
      );
      meetings = meetingsRes.rows;
    }

    // 9. Latest relationship pulse (NPS/CSAT) for the header — a light,
    //    non-blocking enrichment: if the read fails for any reason the 360
    //    still renders (latest_pulse: null) rather than 500ing the page.
    let latestPulse = null;
    try {
      const pulseRes = await pool.query(
        `SELECT score, kind, comment, created_at
           FROM relationship_pulses
          WHERE company_id = $1 AND ${sf} = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [companyId, sv]
      );
      if (pulseRes.rows.length > 0) {
        const p = pulseRes.rows[0];
        const signal = pulseHealthSignal(p.score);
        latestPulse = {
          score: p.score,
          kind: p.kind,
          comment: p.comment,
          recorded_at: p.created_at,
          band: signal?.band || null,
          band_label: signal?.label || null,
        };
      }
    } catch (pulseErr) {
      if (req.log) req.log.warn('account_360_pulse_lookup_failed', { error: pulseErr });
    }

    // 10. Support cases for the account (CS-5, migration 134) — linked directly
    //     by company_id. Open cases first, then most severe / tightest SLA.
    //     Non-blocking like the pulse read: if the fetch fails (e.g. migration
    //     not applied yet) the 360 still renders with cases: []. NOTE: this
    //     query and everything after it must stay try/catch-tolerant — the
    //     order-queued mocks in account-360 tests rely on trailing queries
    //     never being able to 500 the route.
    let accountCases = [];
    try {
      const casesRes = await pool.query(
        `SELECT id, subject, description, status, priority, sla_due_at,
                resolved_at, contact_id, created_at, updated_at
           FROM cases
          WHERE company_id = $1 AND ${sf} = $2
          ORDER BY (status IN ('resolved', 'closed')),
                   CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                   sla_due_at ASC NULLS LAST,
                   created_at DESC
          LIMIT 100`,
        [companyId, sv]
      );
      accountCases = casesRes.rows;
    } catch (caseErr) {
      if (req.log) req.log.warn('account_360_cases_lookup_failed', { error: caseErr });
    }

    // 11. Completed NPS/CSAT survey responses for the account (CS-7, migration
    //     138) — linked directly by company_id. Additive + try/catch-tolerant
    //     like the pulse/cases reads above, so a missing table (or exhausted
    //     mock queue) can never 500 the 360.
    let surveyResponses = [];
    try {
      const srRes = await pool.query(
        `SELECT sr.id, sr.survey_id, sr.score, sr.comment, sr.responded_at,
                s.name AS survey_name, s.kind AS survey_kind
           FROM survey_responses sr
           JOIN surveys s ON s.id = sr.survey_id
          WHERE sr.company_id = $1 AND sr.${sf} = $2 AND sr.responded_at IS NOT NULL
          ORDER BY sr.responded_at DESC
          LIMIT 100`,
        [companyId, sv]
      );
      surveyResponses = srRes.rows;
    } catch (surveyErr) {
      if (req.log) req.log.warn('account_360_surveys_lookup_failed', { error: surveyErr });
    }

    // Build the merged, time-ordered timeline. Each entry is tagged with `type`
    // and carries a normalized `timestamp` used for the global DESC sort.
    const timeline = [];

    for (const a of activitiesRes.rows) {
      timeline.push({
        type: 'activity',
        id: a.id,
        timestamp: a.activity_date || a.created_at,
        title: a.title,
        detail: a.description,
        meta: { activity_type: a.type, outcome: a.outcome, deal_id: a.deal_id, contact_id: a.contact_id },
      });
    }
    for (const t of tasksRes.rows) {
      timeline.push({
        type: 'task',
        id: t.id,
        timestamp: t.due_date || t.created_at,
        title: t.title,
        detail: t.description,
        meta: { status: t.status, priority: t.priority, due_date: t.due_date, deal_id: t.deal_id, contact_id: t.contact_id },
      });
    }
    for (const d of deals) {
      timeline.push({
        type: 'deal',
        id: d.id,
        timestamp: d.updated_at || d.created_at,
        title: d.title,
        detail: null,
        meta: { stage: d.stage, phase: d.phase, amount: d.amount, expected_close_date: d.expected_close_date, closed_date: d.closed_date },
      });
    }
    for (const i of issuesRes.rows) {
      timeline.push({
        type: 'issue',
        id: i.id,
        timestamp: i.created_at,
        title: i.title,
        detail: i.description,
        meta: { category: i.category, urgency: i.urgency, status: i.status, deal_id: i.deal_id, resolved_at: i.resolved_at },
      });
    }
    for (const s of summariesRes.rows) {
      timeline.push({
        type: 'gmail_summary',
        id: s.id,
        timestamp: s.generated_at,
        title: 'Email thread summary',
        detail: s.summary_md,
        meta: { deal_id: s.deal_id, thread_link_id: s.thread_link_id, next_step: s.next_step },
      });
    }
    for (const m of emailMsgs) {
      timeline.push({
        type: 'email',
        id: m.id,
        timestamp: m.internal_date,
        title: m.subject || '(no subject)',
        detail: m.snippet,
        meta: { from: m.from_addr, deal_id: m.deal_id, thread_link_id: m.thread_link_id },
      });
    }
    for (const cs of accountCases) {
      timeline.push({
        type: 'case',
        id: cs.id,
        timestamp: cs.created_at,
        title: cs.subject,
        detail: cs.description,
        meta: { status: cs.status, priority: cs.priority, sla_due_at: cs.sla_due_at, resolved_at: cs.resolved_at, contact_id: cs.contact_id },
      });
    }
    for (const sr of surveyResponses) {
      timeline.push({
        type: 'survey_response',
        id: sr.id,
        timestamp: sr.responded_at,
        title: `${String(sr.survey_kind || 'nps').toUpperCase()} response — ${sr.survey_name}`,
        detail: sr.comment,
        meta: { survey_id: sr.survey_id, kind: sr.survey_kind, score: sr.score },
      });
    }
    for (const ev of meetings) {
      timeline.push({
        type: 'meeting',
        id: ev.id,
        timestamp: ev.start_at,
        title: ev.title || '(untitled meeting)',
        detail: null,
        meta: {
          deal_id: ev.deal_id,
          start_at: ev.start_at,
          end_at: ev.end_at,
          meeting_link: ev.meeting_link || ev.html_link,
          attendees: ev.attendees || [],
          organizer: ev.organizer_email,
          status: ev.status,
          source: ev.source,
        },
      });
    }

    // Sort DESC by timestamp. Null timestamps sink to the bottom.
    timeline.sort((x, y) => {
      const tx = x.timestamp ? new Date(x.timestamp).getTime() : 0;
      const ty = y.timestamp ? new Date(y.timestamp).getTime() : 0;
      return ty - tx;
    });

    // Header rollups.
    const openTaskCount = tasksRes.rows.filter(
      (t) => t.status && !['done', 'completed', 'cancelled'].includes(String(t.status).toLowerCase())
    ).length;
    const openIssueCount = issuesRes.rows.filter(
      (i) => i.status && !['resolved', 'closed', 'cancelled'].includes(String(i.status).toLowerCase())
    ).length;
    const openDealCount = deals.filter(
      (d) => d.stage && !['closed_won', 'closed_lost', 'CLOSED_WON', 'CLOSED_LOST'].includes(String(d.stage))
    ).length;
    const openCaseCount = accountCases.filter(
      (cs) => cs.status && !['resolved', 'closed'].includes(String(cs.status).toLowerCase())
    ).length;

    // last_touch — the most recent timestamp across the whole timeline.
    const lastTouch = timeline.length > 0
      ? timeline.reduce((acc, e) => {
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
          return ts > acc ? ts : acc;
        }, 0)
      : 0;

    res.json({
      header: {
        company,
        last_touch: lastTouch ? new Date(lastTouch).toISOString() : null,
        open_task_count: openTaskCount,
        open_issue_count: openIssueCount,
        open_deal_count: openDealCount,
        open_case_count: openCaseCount,
        latest_pulse: latestPulse,
      },
      timeline,
      // Full case rows (open-first) so the Account 360 page can render a
      // dedicated Cases section without a second fetch.
      cases: accountCases,
    });
  } catch (error) {
    console.error('Account 360 error:', error.message);
    res.status(500).json({ error: 'Failed to fetch account 360' });
  }
});

module.exports = router;
