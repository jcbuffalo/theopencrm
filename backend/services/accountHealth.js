// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Success — CS-2, rules-based account-health scoring.
//
// Two pieces live here:
//   • scoreAccount(signals)  — a PURE function. No DB, no clock that isn't
//     handed to it. Given a normalized `signals` bag (numbers/booleans about
//     an account), it returns { score, band, signals } where `signals` is a
//     human-readable breakdown of what moved the score. This is what the
//     vitest exercises and what the worker calls once it has gathered inputs.
//   • computeForOrg(orgId, { now }) — gathers the inputs for every active
//     account in an org via ORG-SCOPED queries, runs scoreAccount per company,
//     and returns the rows to snapshot. NO writes here — the worker owns the
//     INSERT so this stays easy to test / reason about.
//
// WHY rules-based (not AI): the spec is explicit. deals.ai_health_score is a
// separate, deal-level signal populated elsewhere; account health is a
// transparent, explainable rollup so a CSM can see *why* an account is red.
//
// SCORE MODEL: start at 100 (perfectly healthy) and subtract penalties for
// each negative signal, clamped to [0, 100]. Bands:
//   green  : score >= 70
//   yellow : 40 <= score < 70
//   red    : score < 40
// The breakdown array records every penalty applied (label + points) plus the
// raw inputs, so the UI can render "−25  Open blocking issue (2)" style chips.

const pool = require('../db');

const GREEN_MIN  = 70;
const YELLOW_MIN = 40;

function bandFor(score) {
  if (score >= GREEN_MIN) return 'green';
  if (score >= YELLOW_MIN) return 'yellow';
  return 'red';
}

function clampScore(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Pure scoring. `signals` shape (all optional; missing = neutral):
//   daysSinceLastTouch   number  — days since the most recent account touch
//                                   (activity / task / email / deal update).
//                                   null/undefined => "never touched" worst case.
//   openBlockingIssues   number  — open issues that block workflow.
//   openRedIssues        number  — open issues with urgency = 'red'.
//   daysToNextRenewal    number  — days until the soonest service-contract
//                                   end_date (null => no upcoming renewal).
//   atRiskOpenDeals      number  — open post-sale/post-ship deals that are on
//                                   hold, flagged hot, or low ai_health_score.
//   openDeals            number  — total open deals on the account (context).
//   emailsSent30d        number  — emails sent to the account in last 30 days.
//   emailsOpened30d      number  — of those, how many were opened.
//
// Returns { score, band, signals: [{ key, label, points }] } where a negative
// `points` lowered the score. Entries with points === 0 are informational.
function scoreAccount(rawSignals = {}) {
  const s = rawSignals || {};
  const breakdown = [];
  let score = 100;

  function penalize(key, label, points, meta) {
    if (points !== 0) score -= points;
    breakdown.push({ key, label, points: -points, ...(meta ? { meta } : {}) });
  }

  // 1. RECENCY of last touch. The single biggest health signal. We treat a
  //    null/undefined last-touch as "never" (worst). Thresholds: <=14d clean,
  //    then escalating penalties out to 90d+.
  const dslt = s.daysSinceLastTouch;
  if (dslt == null) {
    penalize('recency', 'No recorded touch on this account', 30);
  } else if (dslt > 90) {
    penalize('recency', `No touch in ${Math.round(dslt)} days (>90)`, 30);
  } else if (dslt > 60) {
    penalize('recency', `No touch in ${Math.round(dslt)} days (>60)`, 20);
  } else if (dslt > 30) {
    penalize('recency', `No touch in ${Math.round(dslt)} days (>30)`, 10);
  } else {
    penalize('recency', `Last touch ${Math.round(dslt)} days ago`, 0);
  }

  // 2. OPEN BLOCKING ISSUES — each one is a hard −15 (capped at −30).
  const blocking = Number(s.openBlockingIssues) || 0;
  if (blocking > 0) {
    penalize('blocking_issues', `Open blocking issue(s) (${blocking})`, Math.min(30, blocking * 15));
  }

  // 3. OPEN RED-URGENCY ISSUES — −10 each (capped at −20).
  const red = Number(s.openRedIssues) || 0;
  if (red > 0) {
    penalize('red_issues', `Open red-urgency issue(s) (${red})`, Math.min(20, red * 10));
  }

  // 4. RENEWAL PROXIMITY — a renewal coming up soon with the rest of the
  //    account unhealthy compounds risk. Within 30d => −15, within 90d => −5.
  const dtr = s.daysToNextRenewal;
  if (dtr != null && dtr >= 0) {
    if (dtr <= 30) {
      penalize('renewal', `Renewal due in ${Math.round(dtr)} days (<30)`, 15);
    } else if (dtr <= 90) {
      penalize('renewal', `Renewal due in ${Math.round(dtr)} days (<90)`, 5);
    } else {
      penalize('renewal', `Renewal due in ${Math.round(dtr)} days`, 0);
    }
  }

  // 5. AT-RISK OPEN DEALS — post-sale deals on hold / hot / low ai_health.
  //    −12 each (capped at −24).
  const atRisk = Number(s.atRiskOpenDeals) || 0;
  if (atRisk > 0) {
    penalize('deals_at_risk', `At-risk open deal(s) (${atRisk})`, Math.min(24, atRisk * 12));
  }

  // 6. EMAIL ENGAGEMENT — only penalize when we actually sent a meaningful
  //    number of emails and nothing got opened (a cold relationship). With
  //    >=3 sends and a 0% open rate, −10. We never reward; absence of email
  //    is neutral.
  const sent = Number(s.emailsSent30d) || 0;
  const opened = Number(s.emailsOpened30d) || 0;
  if (sent >= 3 && opened === 0) {
    penalize('email_engagement', `No opens on ${sent} emails sent (30d)`, 10);
  } else if (sent > 0) {
    penalize('email_engagement', `${opened}/${sent} emails opened (30d)`, 0);
  }

  score = clampScore(score);
  return { score, band: bandFor(score), signals: breakdown };
}

// Returns [scopeField, scopeValue] for an org. account-health runs per-org,
// so we always scope by org_id when we have one (workers iterate orgs that
// have the feature on); falls back to user_id for org-less owners.
function scopePair(orgId, userId) {
  return orgId ? ['org_id', orgId] : ['user_id', userId];
}

// Gather inputs + score every active account in one org. An "active account"
// is a company that has at least one deal where customer_id = company.id
// (i.e. a real post-sale relationship), org-scoped.
//
// Returns [{ company_id, score, band, signals }]. NO DB writes — the worker
// persists. `now` is injectable for testing.
async function computeForOrg(orgId, { now = new Date(), userId = null } = {}) {
  const [sf, sv] = scopePair(orgId, userId);

  // The set of accounts (companies that are a deal's customer). One query,
  // org-scoped, that also pulls every rollup signal via correlated
  // sub-aggregates so we don't N+1 across companies. All sub-selects repeat
  // the org-scope guard so a row can never aggregate another org's data.
  const nowIso = now.toISOString();
  const rows = await pool.query(
    `
    WITH accounts AS (
      SELECT DISTINCT customer_id AS company_id
        FROM deals
       WHERE ${sf} = $1 AND customer_id IS NOT NULL
    )
    SELECT
      a.company_id,
      -- most recent "touch": activity / task update / email / deal update
      GREATEST(
        COALESCE((SELECT MAX(COALESCE(act.activity_date, act.created_at))
                    FROM activities act
                   WHERE act.${sf} = $1
                     AND (act.deal_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
                       OR act.contact_id IN (SELECT id FROM contacts WHERE company_id = a.company_id AND ${sf} = $1))
                 ), to_timestamp(0)),
        COALESCE((SELECT MAX(d.updated_at)
                    FROM deals d
                   WHERE d.customer_id = a.company_id AND d.${sf} = $1
                 ), to_timestamp(0)),
        COALESCE((SELECT MAX(es.sent_at)
                    FROM email_sends es
                   WHERE es.${sf} = $1
                     AND es.to_deal_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
                 ), to_timestamp(0))
      ) AS last_touch,
      (SELECT COUNT(*) FROM issues i
        WHERE i.${sf} = $1 AND i.status = 'open' AND i.blocks_workflow = TRUE
          AND i.related_type = 'deal'
          AND i.related_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
      ) AS open_blocking_issues,
      (SELECT COUNT(*) FROM issues i
        WHERE i.${sf} = $1 AND i.status = 'open' AND i.urgency = 'red'
          AND i.related_type = 'deal'
          AND i.related_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
      ) AS open_red_issues,
      (SELECT MIN(sc.end_date) FROM service_contracts sc
        WHERE sc.${sf} = $1 AND sc.customer_id = a.company_id
          AND sc.status = 'active' AND sc.end_date IS NOT NULL AND sc.end_date >= $2::date
      ) AS next_renewal_date,
      (SELECT COUNT(*) FROM deals d
        WHERE d.customer_id = a.company_id AND d.${sf} = $1
          AND d.phase IN ('post_sale', 'post_ship')
          AND COALESCE(d.stage, '') NOT IN ('CLOSED_WON','CLOSED_LOST','closed_won','closed_lost')
          AND (d.release_status = 'hold' OR d.hot_flag = TRUE OR COALESCE(d.ai_health_score, 100) < 30)
      ) AS at_risk_open_deals,
      (SELECT COUNT(*) FROM deals d
        WHERE d.customer_id = a.company_id AND d.${sf} = $1
          AND COALESCE(d.stage, '') NOT IN ('CLOSED_WON','CLOSED_LOST','closed_won','closed_lost')
      ) AS open_deals,
      (SELECT COUNT(*) FROM email_sends es
        WHERE es.${sf} = $1 AND es.sent_at >= $2::timestamptz - INTERVAL '30 days'
          AND es.to_deal_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
      ) AS emails_sent_30d,
      (SELECT COUNT(*) FROM email_sends es
        WHERE es.${sf} = $1 AND es.sent_at >= $2::timestamptz - INTERVAL '30 days'
          AND es.opened_at IS NOT NULL
          AND es.to_deal_id IN (SELECT id FROM deals WHERE customer_id = a.company_id AND ${sf} = $1)
      ) AS emails_opened_30d
    FROM accounts a
    `,
    [sv, nowIso]
  );

  const out = [];
  for (const r of rows.rows) {
    const lastTouch = r.last_touch ? new Date(r.last_touch) : null;
    // to_timestamp(0) (epoch) is our "never" sentinel from GREATEST.
    const hasTouch = lastTouch && lastTouch.getTime() > 0;
    const daysSinceLastTouch = hasTouch
      ? (now.getTime() - lastTouch.getTime()) / 86400000
      : null;
    const daysToNextRenewal = r.next_renewal_date
      ? (new Date(r.next_renewal_date).getTime() - now.getTime()) / 86400000
      : null;

    const signals = {
      daysSinceLastTouch,
      openBlockingIssues: Number(r.open_blocking_issues) || 0,
      openRedIssues:      Number(r.open_red_issues) || 0,
      daysToNextRenewal,
      atRiskOpenDeals:    Number(r.at_risk_open_deals) || 0,
      openDeals:          Number(r.open_deals) || 0,
      emailsSent30d:      Number(r.emails_sent_30d) || 0,
      emailsOpened30d:    Number(r.emails_opened_30d) || 0,
    };

    const scored = scoreAccount(signals);
    out.push({
      company_id: r.company_id,
      score: scored.score,
      band: scored.band,
      // Persist both the raw inputs and the human breakdown so the UI can
      // explain the score without re-deriving it.
      signals: { inputs: signals, breakdown: scored.signals },
    });
  }
  return out;
}

module.exports = {
  scoreAccount,
  computeForOrg,
  bandFor,
  GREEN_MIN,
  YELLOW_MIN,
};
