// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Pulse — lightweight NPS / CSAT capture per account.
//
// A pulse is one satisfaction reading (score + optional contact/comment)
// recorded against a company. Pulses are append-only; the LATEST pulse per
// company is the account's current sentiment, and it feeds the Accounts
// rollup as a health SIGNAL alongside — never replacing — the rules-based
// account_health_snapshots band (services/accountHealth.js).
//
// SCORE SCALE: everything is STORED 0–10 (the NPS scale). A CSAT response
// (1–5) is normalized to 0–10 on write — (s − 1) × 2.5, rounded — so the
// banding math has exactly one scale. `kind` ('nps' | 'csat') records what
// the respondent was actually asked, so the UI can label honestly.
//
// SQL SAFETY (same contract as services/retention.js):
//   • The only interpolated identifier is the scope field, validated against
//     the two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//   • No user input is ever concatenated into a query.
//
// Pure math (normalizeScore, pulseHealthSignal, buildPulseSummary) is DB-free
// so it unit-tests cleanly; the exported query helpers each run exactly ONE
// org-scoped, parameterized query (no N+1 — the per-company "latest" reads use
// DISTINCT ON, not a loop).

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);
const KINDS = new Set(['nps', 'csat']);

function assertScopeField(sf) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Invalid scope field: ${sf}`);
}

// Typed error the route layer maps to a status code (400 / 404).
class PulseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- pure helpers ------------------------------------------------------------

// Validate a raw (score, kind) pair and return the STORED 0–10 score.
// NPS: integer 0–10 as-is. CSAT: integer 1–5, normalized (s − 1) × 2.5 →
// 0 / 3 / 5 / 8 / 10 (so CSAT 5 is a promoter, 4 a passive, ≤3 a detractor).
// Throws PulseError(400) on anything else.
function normalizeScore(score, kind) {
  const k = kind == null || kind === '' ? 'nps' : String(kind).toLowerCase();
  if (!KINDS.has(k)) throw new PulseError(400, `kind must be one of: ${[...KINDS].join(', ')}`);
  const s = Number(score);
  if (!Number.isInteger(s)) throw new PulseError(400, 'score must be an integer');
  if (k === 'csat') {
    if (s < 1 || s > 5) throw new PulseError(400, 'csat score must be between 1 and 5');
    return { kind: k, stored: Math.round((s - 1) * 2.5) };
  }
  if (s < 0 || s > 10) throw new PulseError(400, 'nps score must be between 0 and 10');
  return { kind: k, stored: s };
}

// Map a STORED 0–10 score to the consistent health band the account surfaces
// render: 9–10 promoter/green · 7–8 passive/amber · 0–6 detractor/red.
// Null / non-numeric → null (render "no pulse yet", not a fake band).
function pulseHealthSignal(score) {
  const s = Number(score);
  if (score == null || !Number.isFinite(s)) return null;
  if (s >= 9) return { band: 'green', label: 'Promoter' };
  if (s >= 7) return { band: 'amber', label: 'Passive' };
  return { band: 'red', label: 'Detractor' };
}

// NPS rollup over "latest pulse per company" rows: promoter / passive /
// detractor counts + the NPS number (%promoters − %detractors, rounded).
// Zero rows → nps null (there is no NPS, not an NPS of 0).
function buildPulseSummary(latestRows) {
  const out = { total_accounts: 0, promoters: 0, passives: 0, detractors: 0, nps: null, latest_at: null };
  for (const r of latestRows || []) {
    const sig = pulseHealthSignal(r.score);
    if (!sig) continue;
    out.total_accounts++;
    if (sig.band === 'green') out.promoters++;
    else if (sig.band === 'amber') out.passives++;
    else out.detractors++;
    const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
    if (Number.isFinite(t) && (!out.latest_at || t > new Date(out.latest_at).getTime())) {
      out.latest_at = new Date(t).toISOString();
    }
  }
  if (out.total_accounts > 0) {
    out.nps = Math.round(((out.promoters - out.detractors) / out.total_accounts) * 100);
  }
  return out;
}

// --- query helpers -----------------------------------------------------------

// Record one pulse. Verifies the company (and contact, when given) belongs to
// the caller's scope BEFORE writing, so an out-of-org id 404s rather than
// attaching a pulse across tenants. Returns the inserted row.
async function recordPulse({ sf, sv, orgId, userId }, { companyId, contactId, score, kind, comment }, pool) {
  assertScopeField(sf);

  const cid = Number(companyId);
  if (!Number.isInteger(cid)) throw new PulseError(400, 'company_id is required');
  const { kind: k, stored } = normalizeScore(score, kind);

  const companyRes = await pool.query(
    `SELECT id FROM companies WHERE id = $1 AND ${sf} = $2`,
    [cid, sv]
  );
  if (companyRes.rows.length === 0) throw new PulseError(404, 'Company not found');

  let contact = null;
  if (contactId != null && contactId !== '') {
    contact = Number(contactId);
    if (!Number.isInteger(contact)) throw new PulseError(400, 'contact_id must be an integer');
    const contactRes = await pool.query(
      `SELECT id FROM contacts WHERE id = $1 AND ${sf} = $2`,
      [contact, sv]
    );
    if (contactRes.rows.length === 0) throw new PulseError(404, 'Contact not found');
  }

  const insert = await pool.query(
    `INSERT INTO relationship_pulses (user_id, org_id, company_id, contact_id, score, kind, comment, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, orgId || null, cid, contact, stored, k,
     comment == null || comment === '' ? null : String(comment), userId]
  );
  return insert.rows[0];
}

// Latest pulse per company for a batch of company ids — ONE query (DISTINCT ON),
// never a loop. Returns { [companyId]: { score, kind, comment, created_at } }.
async function latestPulseByCompany({ sf, sv }, companyIds, pool) {
  assertScopeField(sf);
  const ids = (companyIds || []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return {};
  const res = await pool.query(
    `SELECT DISTINCT ON (company_id) company_id, score, kind, comment, created_at
       FROM relationship_pulses
      WHERE ${sf} = $1 AND company_id = ANY($2::int[])
      ORDER BY company_id, created_at DESC, id DESC`,
    [sv, ids]
  );
  const out = {};
  for (const r of res.rows) {
    out[r.company_id] = { score: r.score, kind: r.kind, comment: r.comment, created_at: r.created_at };
  }
  return out;
}

// Org-wide NPS rollup over the latest pulse per company — one query + pure math.
async function pulseSummary({ sf, sv }, pool) {
  assertScopeField(sf);
  const res = await pool.query(
    `SELECT DISTINCT ON (company_id) company_id, score, created_at
       FROM relationship_pulses
      WHERE ${sf} = $1
      ORDER BY company_id, created_at DESC, id DESC`,
    [sv]
  );
  return buildPulseSummary(res.rows);
}

module.exports = {
  PulseError,
  normalizeScore,
  pulseHealthSignal,
  buildPulseSummary,
  recordPulse,
  latestPulseByCompany,
  pulseSummary,
};
