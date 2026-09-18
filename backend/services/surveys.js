// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// NPS/CSAT Surveys (CS-7, migration 138) — business logic.
//
// A survey is one satisfaction question (kind 'nps' → 0–10 scale, 'csat' →
// 1–5). Response LINKS are minted explicitly (createResponseTokens) as
// pending survey_responses rows carrying an unguessable 192-bit token; the
// public respond endpoint completes a row EXACTLY ONCE (responded_at IS NULL
// guard in the UPDATE — idempotent under retries and races).
//
// ⚠️ NO AUTO-SEND. Nothing here runs on a schedule or fans out on create.
// sendSurvey() is the only path that touches email, it requires an EXPLICIT
// contact_ids list from the caller, it honors confirmed unsubscribes
// (email_unsubscribes), and it degrades gracefully when the email transport
// is unconfigured (services/email.sendMail console-logs and returns
// kind:'console' — no crash, no real mail).
//
// SCORE MATH: scores are STORED RAW on the asked scale; all rollups normalize
// to 0–10 via relationshipPulse.normalizeScore and band via pulseHealthSignal,
// so survey NPS is numerically consistent with the Relationship Pulse feature
// (9–10 promoter · 7–8 passive · 0–6 detractor; CSAT 5 promoter / 4 passive /
// ≤3 detractor; NPS = %promoters − %detractors, rounded; zero responses →
// nps null, not 0).
//
// SQL SAFETY (same contract as services/relationshipPulse.js): the only
// interpolated identifier is the scope field, validated against the two-value
// allowlist before it can touch SQL; every value is a bound parameter.

const crypto = require('crypto');
const { normalizeScore, pulseHealthSignal } = require('./relationshipPulse');
const email = require('./email');

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);
const KINDS = new Set(['nps', 'csat']);
const SCALES = { nps: { min: 0, max: 10 }, csat: { min: 1, max: 5 } };
const DEFAULT_QUESTIONS = {
  nps: 'How likely are you to recommend us to a friend or colleague?',
  csat: 'How satisfied are you with your recent experience?',
};

function assertScopeField(sf) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Invalid scope field: ${sf}`);
}

// Typed error the route layer maps to a status code.
class SurveyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- pure helpers ------------------------------------------------------------

// Normalize/validate a survey kind. Throws SurveyError(400) on anything else.
function cleanKind(kind) {
  const k = kind == null || kind === '' ? 'nps' : String(kind).toLowerCase();
  if (!KINDS.has(k)) throw new SurveyError(400, `kind must be one of: ${[...KINDS].join(', ')}`);
  return k;
}

// Validate a RAW response score against the survey's kind and return
// { raw, stored } where stored is the 0–10-normalized value used for banding.
// Delegates to relationshipPulse.normalizeScore so both features share one
// scale and one set of error messages. Throws SurveyError(400) on bad input.
function validateResponseScore(score, kind) {
  try {
    const { stored } = normalizeScore(score, kind);
    return { raw: Number(score), stored };
  } catch (err) {
    throw new SurveyError(err.status || 400, err.message);
  }
}

// Rollup over survey_responses rows joined to their survey. Rows look like
// { survey_id, name, kind, score, responded_at }. Pending rows (responded_at
// NULL) count toward `sent` only. Returns { overall, surveys: [...] } with NPS
// math identical to relationshipPulse.buildPulseSummary (null when empty).
function buildSurveySummary(rows) {
  const perSurvey = new Map();
  const overall = {
    sent: 0, responded: 0, response_rate: null,
    promoters: 0, passives: 0, detractors: 0, nps: null, latest_response_at: null,
  };

  for (const r of rows || []) {
    let s = perSurvey.get(r.survey_id);
    if (!s) {
      s = {
        id: r.survey_id, name: r.name, kind: r.kind,
        sent: 0, responded: 0, response_rate: null,
        promoters: 0, passives: 0, detractors: 0, nps: null,
        avg_score: null, _scoreSum: 0,
      };
      perSurvey.set(r.survey_id, s);
    }
    s.sent++;
    overall.sent++;
    if (r.responded_at == null) continue;

    // Normalize the raw stored score to 0–10 for banding. A malformed row
    // (shouldn't exist — the write path validates) is skipped, not fatal.
    let stored;
    try {
      stored = normalizeScore(r.score, r.kind).stored;
    } catch {
      continue;
    }
    const band = pulseHealthSignal(stored)?.band;
    s.responded++;
    overall.responded++;
    s._scoreSum += Number(r.score);
    if (band === 'green') { s.promoters++; overall.promoters++; }
    else if (band === 'amber') { s.passives++; overall.passives++; }
    else { s.detractors++; overall.detractors++; }

    const t = r.responded_at ? new Date(r.responded_at).getTime() : NaN;
    if (Number.isFinite(t) && (!overall.latest_response_at || t > new Date(overall.latest_response_at).getTime())) {
      overall.latest_response_at = new Date(t).toISOString();
    }
  }

  const finish = (o) => {
    if (o.sent > 0) o.response_rate = Math.round((o.responded / o.sent) * 100) / 100;
    if (o.responded > 0) o.nps = Math.round(((o.promoters - o.detractors) / o.responded) * 100);
    if (o._scoreSum !== undefined) {
      o.avg_score = o.responded > 0 ? Math.round((o._scoreSum / o.responded) * 10) / 10 : null;
      delete o._scoreSum;
    }
    return o;
  };

  return {
    overall: finish(overall),
    surveys: [...perSurvey.values()].map(finish),
  };
}

// --- CRUD --------------------------------------------------------------------

async function listSurveys({ sf, sv }, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM survey_responses r
              WHERE r.survey_id = s.id AND r.${sf} = $1) AS sent_count,
            (SELECT COUNT(*)::int FROM survey_responses r
              WHERE r.survey_id = s.id AND r.${sf} = $1 AND r.responded_at IS NOT NULL) AS responded_count
       FROM surveys s
      WHERE s.${sf} = $1
      ORDER BY s.created_at DESC`,
    [sv]
  );
  return res.rows;
}

async function createSurvey({ sf, orgId, userId }, { name, kind, question }, pool) {
  assertScopeField(sf);
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 255) : '';
  if (!cleanName) throw new SurveyError(400, 'name is required');
  const k = cleanKind(kind);
  const q = typeof question === 'string' && question.trim()
    ? question.trim().slice(0, 2000)
    : DEFAULT_QUESTIONS[k];
  const res = await pool.query(
    `INSERT INTO surveys (user_id, org_id, name, kind, question, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING *`,
    [userId, orgId || null, cleanName, k, q, userId]
  );
  return res.rows[0];
}

// kind is immutable after creation — responses already recorded would be on a
// different scale and the rollup math would silently lie.
async function updateSurvey({ sf, sv }, id, { name, question, is_active }, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `UPDATE surveys SET
        name      = COALESCE($1, name),
        question  = COALESCE($2, question),
        is_active = COALESCE($3, is_active)
      WHERE id = $4 AND ${sf} = $5 RETURNING *`,
    [
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 255) : null,
      typeof question === 'string' && question.trim() ? question.trim().slice(0, 2000) : null,
      typeof is_active === 'boolean' ? is_active : null,
      id, sv,
    ]
  );
  if (res.rows.length === 0) throw new SurveyError(404, 'Survey not found');
  return res.rows[0];
}

async function deleteSurvey({ sf, sv }, id, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `DELETE FROM surveys WHERE id = $1 AND ${sf} = $2 RETURNING id`,
    [id, sv]
  );
  if (res.rows.length === 0) throw new SurveyError(404, 'Survey not found');
  return true;
}

// Org-scoped fetch used by every per-survey action; 404s out-of-scope ids.
async function getSurvey({ sf, sv }, id, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `SELECT * FROM surveys WHERE id = $1 AND ${sf} = $2`,
    [id, sv]
  );
  if (res.rows.length === 0) throw new SurveyError(404, 'Survey not found');
  return res.rows[0];
}

// Per-survey results: stats + raw-scale distribution + completed responses.
async function surveyResults(scope, id, pool) {
  const survey = await getSurvey(scope, id, pool);
  const { sf, sv } = scope;
  const res = await pool.query(
    `SELECT r.id, r.contact_id, r.company_id, r.score, r.comment,
            r.responded_at, r.created_at,
            NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS contact_name
       FROM survey_responses r
       LEFT JOIN contacts c ON c.id = r.contact_id AND c.${sf} = $2
      WHERE r.survey_id = $1 AND r.${sf} = $2
      ORDER BY r.responded_at DESC NULLS LAST, r.created_at DESC`,
    [id, sv]
  );

  const scale = SCALES[survey.kind] || SCALES.nps;
  const distribution = [];
  for (let s = scale.min; s <= scale.max; s++) distribution.push({ score: s, count: 0 });

  const responded = res.rows.filter((r) => r.responded_at != null);
  for (const r of responded) {
    const bucket = distribution.find((d) => d.score === Number(r.score));
    if (bucket) bucket.count++;
  }

  const summary = buildSurveySummary(
    res.rows.map((r) => ({ survey_id: survey.id, name: survey.name, kind: survey.kind, score: r.score, responded_at: r.responded_at }))
  );
  const stats = summary.surveys[0] || {
    id: survey.id, name: survey.name, kind: survey.kind,
    sent: 0, responded: 0, response_rate: null,
    promoters: 0, passives: 0, detractors: 0, nps: null, avg_score: null,
  };

  return {
    survey,
    stats,
    distribution,
    responses: responded.map((r) => ({
      id: r.id, score: r.score, comment: r.comment, responded_at: r.responded_at,
      contact_id: r.contact_id, contact_name: r.contact_name, company_id: r.company_id,
    })),
    pending_count: res.rows.length - responded.length,
  };
}

// --- response links ------------------------------------------------------------

// Mint pending response rows (tokens). DOES NOT SEND ANYTHING — the caller
// copies/distributes the links, or explicitly calls sendSurvey.
//   • contactIds: each id is validated in-scope; out-of-scope ids are skipped
//     (never a cross-tenant row). company_id is inherited from the contact so
//     the response feeds that account's 360.
//   • count: N anonymous links (no contact/company attribution).
async function createResponseTokens(scope, surveyId, { contactIds, count } = {}, pool) {
  const survey = await getSurvey(scope, surveyId, pool);
  const { sf, sv } = scope;

  const targets = [];
  if (Array.isArray(contactIds) && contactIds.length > 0) {
    const ids = contactIds.map(Number).filter(Number.isInteger);
    if (ids.length > 0) {
      const res = await pool.query(
        `SELECT id, company_id FROM contacts WHERE id = ANY($1::int[]) AND ${sf} = $2`,
        [ids, sv]
      );
      for (const c of res.rows) targets.push({ contact_id: c.id, company_id: c.company_id || null });
    }
  }
  const n = Number(count);
  if (Number.isInteger(n) && n > 0) {
    // Cap anonymous batches so a looping client can't flood the table.
    for (let i = 0; i < Math.min(n, 100); i++) targets.push({ contact_id: null, company_id: null });
  }
  if (targets.length === 0) {
    throw new SurveyError(400, 'Provide contact_ids and/or a positive count');
  }

  const created = [];
  for (const t of targets) {
    // 192-bit random token — the sole public handle. Treated as a credential.
    const token = crypto.randomBytes(24).toString('hex');
    const ins = await pool.query(
      `INSERT INTO survey_responses (user_id, org_id, survey_id, contact_id, company_id, response_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, contact_id, company_id, response_token, created_at`,
      [scope.userId, scope.orgId || null, survey.id, t.contact_id, t.company_id, token]
    );
    created.push(ins.rows[0]);
  }
  return { survey, created };
}

// --- public (token-scoped, no auth) -------------------------------------------

// Quick-reject malformed tokens before touching the DB (mirrors leadFormRoutes).
function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

// Resolve a response row + its ACTIVE survey by token. Every failure mode
// returns null → the route 404s generically (no existence oracle). The org's
// feature flag is re-checked by the ROUTE (featureFlags is injected there) so
// disabling customer_success also removes the public surface.
async function resolveByToken(token, pool) {
  if (!validToken(token)) return null;
  const res = await pool.query(
    `SELECT r.id AS response_id, r.responded_at, r.org_id, r.user_id,
            s.id AS survey_id, s.name, s.kind, s.question, s.is_active
       FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id
      WHERE r.response_token = $1 AND s.is_active = TRUE`,
    [token]
  );
  return res.rows[0] || null;
}

// Record the response for a token — EXACTLY ONCE. The `responded_at IS NULL`
// guard makes this idempotent under retries and safe under races: the first
// write wins, every later attempt is a no-op reported as already_responded.
async function recordResponse(row, { score, comment }, pool) {
  const { raw } = validateResponseScore(score, row.kind);
  if (row.responded_at != null) return { ok: true, already_responded: true };

  const cleanComment = comment == null || comment === ''
    ? null
    : String(comment).slice(0, 4000);

  const upd = await pool.query(
    `UPDATE survey_responses
        SET score = $1, comment = $2, responded_at = NOW()
      WHERE id = $3 AND responded_at IS NULL
      RETURNING id`,
    [raw, cleanComment, row.response_id]
  );
  if (upd.rows.length === 0) return { ok: true, already_responded: true };
  return { ok: true, already_responded: false };
}

// --- rollup --------------------------------------------------------------------

// Org-wide rollup — ONE query + pure math (no N+1).
async function summary({ sf, sv }, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `SELECT r.survey_id, s.name, s.kind, r.score, r.responded_at
       FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id
      WHERE r.${sf} = $1`,
    [sv]
  );
  return buildSurveySummary(res.rows);
}

// --- optional manual email send --------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// EXPLICIT, MANUAL, per-survey send. Guardrails:
//   • requires a non-empty contact_ids list — there is no "send to everyone"
//     mode and nothing calls this automatically;
//   • skips contacts without an email and confirmed unsubscribes
//     (email_unsubscribes, same gate POST /api/emails/send uses);
//   • email unconfigured → services/email.sendMail console-logs (kind
//     'console'), so this is a safe no-op that still mints copyable links.
async function sendSurvey(scope, surveyId, { contactIds } = {}, pool) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    throw new SurveyError(400, 'contact_ids is required — surveys are only ever sent to explicitly chosen contacts');
  }
  const survey = await getSurvey(scope, surveyId, pool);
  const { sf, sv } = scope;

  const ids = contactIds.map(Number).filter(Number.isInteger);
  const contactsRes = await pool.query(
    `SELECT id, company_id, name, email FROM contacts WHERE id = ANY($1::int[]) AND ${sf} = $2`,
    [ids, sv]
  );

  const configured = email.isConfigured();
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
  const out = { configured, sent: 0, skipped_no_email: 0, skipped_unsubscribed: 0, failed: 0, links: [] };

  for (const c of contactsRes.rows) {
    const to = (c.email || '').trim();
    if (!to) { out.skipped_no_email++; continue; }

    // Confirmed opt-outs only (unsubscribed_at NOT NULL), scoped to this
    // tenant — one org's opt-out never suppresses another org's mail.
    const unsub = await pool.query(
      `SELECT 1 FROM email_unsubscribes
        WHERE org_id IS NOT DISTINCT FROM $1
          AND LOWER(email) = LOWER($2)
          AND unsubscribed_at IS NOT NULL
        LIMIT 1`,
      [scope.orgId || null, to]
    );
    if (unsub.rows.length > 0) { out.skipped_unsubscribed++; continue; }

    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO survey_responses (user_id, org_id, survey_id, contact_id, company_id, response_token)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scope.userId, scope.orgId || null, survey.id, c.id, c.company_id || null, token]
    );
    const link = `${base}/s/${token}`;
    out.links.push({ contact_id: c.id, link });

    try {
      await email.sendMail({
        to,
        subject: `Quick question: ${survey.name}`,
        html: `<p>Hi${c.name ? ` ${escapeHtml(c.name)}` : ''},</p>
<p>${escapeHtml(survey.question || DEFAULT_QUESTIONS[survey.kind] || '')}</p>
<p><a href="${escapeHtml(link)}">Answer with one click</a> — it takes less than a minute.</p>`,
        text: `${survey.question || ''}\n\nAnswer here: ${link}`,
      });
      out.sent++;
    } catch (err) {
      // A transport failure never aborts the batch — the pending link row
      // stays valid and copyable.
      out.failed++;
    }
  }
  return out;
}

module.exports = {
  SurveyError,
  KINDS,
  SCALES,
  cleanKind,
  validateResponseScore,
  buildSurveySummary,
  listSurveys,
  createSurvey,
  updateSurvey,
  deleteSurvey,
  getSurvey,
  surveyResults,
  createResponseTokens,
  validToken,
  resolveByToken,
  recordResponse,
  summary,
  sendSurvey,
};
