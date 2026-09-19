// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Leads — pre-qualification records and their lifecycle (migration 130).
//
// Every function takes the route layer's qs(req) tuple ([scopeField,
// scopeValue]) so queries are org-scoped exactly like the routes that call
// them: a lead in another org can't be listed, updated, converted, or even
// counted from here.
//
// STATUSES form a small state machine enforced at the API layer (allowlist
// below, no CHECK constraint so it can evolve without a migration):
//   new → working → qualified → converted
//                 ↘ unqualified
// 'converted' is terminal and ONLY set by convertLead(), never by a plain
// update — it must always be accompanied by the contact (and optional deal)
// it produced, in the same transaction.

const pool = require('../db');
const leadScoring = require('./leadScoring'); // scoring/routing (147); requires us lazily, no cycle
// Per-org effective pipeline (migration 155/156) — convert() resolves the
// deal's default stage from THIS, not a hardcoded constant (see convertLead).
const pipelines = require('./pipelines');
const dealStages = require('../utils/dealStages');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit
// dispatch. Emitting here (not the routes) covers BOTH lead entry points:
// manual creates and public lead-form captures.
const pluginEvents = require('./pluginEvents');

const LEAD_STATUSES = ['new', 'working', 'qualified', 'unqualified', 'converted'];

// Statuses a plain update may set. 'converted' is excluded: reaching it any
// way other than convertLead() would strand a lead with no converted_* ids.
const UPDATABLE_STATUSES = LEAD_STATUSES.filter((s) => s !== 'converted');

// Field length caps shared by the authenticated routes and the public capture
// endpoint. These mirror the column widths in migration 130 — enforcing them
// in JS gives a clean 400 instead of a 22001 five layers down, and bounds
// what an anonymous submitter can make us store.
const FIELD_LIMITS = {
  name: 200,
  email: 254,
  phone: 50,
  company_name: 200,
  title: 200,
  source: 64,
  notes: 10000,
};

// Trim + cap a string field. Returns null for empty/non-string input; the
// value is stored VERBATIM (no HTML entity-encoding at rest — escaping is the
// renderer's job, and both our React UI and the notification-email path
// escape on output). What matters here: it is always a bounded plain string
// bound as a query PARAMETER, never interpolated into SQL or HTML by us.
function cleanField(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, FIELD_LIMITS[field] || 200);
}

async function listLeads([sf, sv], { status, search, limit, sort } = {}) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
  let query = `SELECT * FROM leads WHERE ${sf} = $1`;
  const params = [sv];
  if (status && LEAD_STATUSES.includes(status)) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR company_name ILIKE $${params.length})`;
  }
  // sort is an allowlist ('score' or default), never interpolated from input.
  const orderBy = sort === 'score'
    ? 'ORDER BY score DESC NULLS LAST, created_at DESC'
    : 'ORDER BY created_at DESC';
  params.push(capped);
  query += ` ${orderBy} LIMIT $${params.length}`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function getLead([sf, sv], id) {
  const result = await pool.query(
    `SELECT * FROM leads WHERE id = $1 AND ${sf} = $2`,
    [id, sv]
  );
  return result.rows[0] || null;
}

// Create a lead. `actor` carries { userId, orgId } — user_id is always
// stamped (NOT for tenancy when an org exists, but for attribution), org_id
// when present, mirroring the contacts/deals insert convention. For public
// captures the "actor" is the form's stored owner (user_id/org_id columns of
// the lead_forms row), passed through by the route.
async function createLead(actor, data) {
  const name = cleanField(data.name, 'name');
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const status = data.status && UPDATABLE_STATUSES.includes(data.status) ? data.status : 'new';
  const fields = {
    email: cleanField(data.email, 'email'),
    phone: cleanField(data.phone, 'phone'),
    company_name: cleanField(data.company_name, 'company_name'),
    title: cleanField(data.title, 'title'),
    source: cleanField(data.source, 'source'),
  };
  // Score against the actor's tenancy (covers both manual creates and public
  // captures — the capture route passes the form owner as the actor). A
  // scoring failure must never block a create.
  const scope = actor.orgId ? ['org_id', actor.orgId] : ['user_id', actor.userId];
  const score = await leadScoring.scoreLead(scope, fields).catch(() => 0);
  const result = await pool.query(
    `INSERT INTO leads (user_id, org_id, name, email, phone, company_name, title, source, status, owner_user_id, notes, score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      actor.userId || null,
      actor.orgId || null,
      name,
      fields.email,
      fields.phone,
      fields.company_name,
      fields.title,
      fields.source,
      status,
      Number.isInteger(data.owner_user_id) ? data.owner_user_id : null,
      cleanField(data.notes, 'notes'),
      score,
    ]
  );
  // Plugin trigger (migration 164) — post-commit, fire-and-forget, deduped
  // per lead id. Org-scoped only: plugins don't exist for org-less users.
  if (actor.orgId && result.rows[0]) {
    const lead = result.rows[0];
    pluginEvents.emit(actor.orgId, 'lead.created', {
      id: lead.id,
      name: lead.name,
      email: lead.email,
      source: lead.source,
      status: lead.status,
      score: lead.score,
    });
  }
  return result.rows[0];
}

// COALESCE-style partial update (same convention as the contacts PUT).
// Status writes are allowlisted; 'converted' is rejected here by design.
// Returns null when the id isn't visible under the caller's scope.
async function updateLead([sf, sv], id, data) {
  if (data.status !== undefined && data.status !== null && !UPDATABLE_STATUSES.includes(data.status)) {
    const err = new Error(`status must be one of: ${UPDATABLE_STATUSES.join(', ')} (converted is set via /convert)`);
    err.status = 400;
    throw err;
  }
  let ownerValue = null; // COALESCE no-op default
  if ('owner_user_id' in data && data.owner_user_id !== undefined) {
    if (data.owner_user_id !== null && !Number.isInteger(data.owner_user_id)) {
      const err = new Error('owner_user_id must be an integer or null');
      err.status = 400;
      throw err;
    }
    ownerValue = data.owner_user_id;
  }
  const result = await pool.query(
    `UPDATE leads SET
        name         = COALESCE($1, name),
        email        = COALESCE($2, email),
        phone        = COALESCE($3, phone),
        company_name = COALESCE($4, company_name),
        title        = COALESCE($5, title),
        source       = COALESCE($6, source),
        status       = COALESCE($7, status),
        owner_user_id = COALESCE($8, owner_user_id),
        notes        = COALESCE($9, notes),
        updated_at   = CURRENT_TIMESTAMP
      WHERE id = $10 AND ${sf} = $11 AND status <> 'converted'
      RETURNING *`,
    [
      cleanField(data.name, 'name'),
      cleanField(data.email, 'email'),
      cleanField(data.phone, 'phone'),
      cleanField(data.company_name, 'company_name'),
      cleanField(data.title, 'title'),
      cleanField(data.source, 'source'),
      data.status || null,
      ownerValue,
      cleanField(data.notes, 'notes'),
      id, sv,
    ]
  );
  const updated = result.rows[0];
  if (!updated) return null;

  // Recompute the score against the row's FINAL values (COALESCE means we
  // only know them post-update). Persist only when it moved; a scoring
  // failure never breaks the update — the stale score just stands.
  try {
    const score = await leadScoring.scoreLead([sf, sv], updated);
    if (score !== (Number(updated.score) || 0)) {
      const rescored = await pool.query(
        `UPDATE leads SET score = $1 WHERE id = $2 AND ${sf} = $3 RETURNING *`,
        [score, id, sv]
      );
      return rescored.rows[0] || updated;
    }
  } catch { /* keep the successful update */ }
  return updated;
}

async function deleteLead([sf, sv], id) {
  const result = await pool.query(
    `DELETE FROM leads WHERE id = $1 AND ${sf} = $2 RETURNING *`,
    [id, sv]
  );
  return result.rows[0] || null;
}

// Round-robin owner assignment: pick the org member whose MOST RECENT lead
// assignment is oldest (never-assigned members go first, ties break on the
// lower user id so the order is deterministic). This is self-balancing
// without a rotation-pointer table: each assignment automatically pushes the
// picked member to the back of the queue.
//
// For user_id-scoped (org-less) workspaces there is exactly one candidate —
// the user themselves.
//
// Returns a user id, or null when the org has no members (shouldn't happen,
// but a public capture must degrade to "unassigned", never fail).
async function assignRoundRobin([sf, sv]) {
  if (sf === 'user_id') return sv;
  const result = await pool.query(
    `SELECT u.id
       FROM users u
       LEFT JOIN leads l ON l.owner_user_id = u.id AND l.org_id = $1
      WHERE u.org_id = $1
      GROUP BY u.id
      ORDER BY MAX(l.created_at) ASC NULLS FIRST, u.id ASC
      LIMIT 1`,
    [sv]
  );
  return result.rows[0]?.id ?? null;
}

// Best-effort first/last split for the contacts row (first_name + last_name
// are NOT NULL there). Single-token names get a placeholder last name rather
// than inventing data.
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Unknown', last: 'Lead' };
  if (parts.length === 1) return { first: parts[0], last: '—' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Convert a lead into a contact (and optionally a deal) in ONE transaction:
//   1. Lock + re-check the lead under the caller's scope (cross-org → null).
//   2. Find-or-create the company by name (case-insensitive, org-scoped) —
//      a real companies row, not a note (see below).
//   3. INSERT the contacts row from the lead's fields, linked to that company.
//   4. Optionally INSERT a deals row linked to the contact + company, staged
//      on the org's EFFECTIVE pipeline (services/pipelines.js) rather than a
//      hardcoded constant.
//   5. Stamp the lead: status='converted', converted_contact_id/_deal_id.
// Any failure rolls the whole thing back — a lead can never end up
// 'converted' without its contact, or vice versa.
//
// scope: qs(req) tuple. actor: { userId, orgId } for the created rows'
// attribution columns. opts: { createDeal, dealTitle, dealAmount, dealStage }.
//
// Returns { lead, contact, deal } — or null (not found / cross-org), or
// throws err.status=409 when the lead is already converted, or
// err.status=400 (INVALID_STAGE) when opts.dealStage isn't on the pipeline.
async function convertLead(scope, id, actor, opts = {}) {
  const [sf, sv] = scope;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT * FROM leads WHERE id = $1 AND ${sf} = $2 FOR UPDATE`,
      [id, sv]
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const lead = found.rows[0];
    if (lead.status === 'converted') {
      await client.query('ROLLBACK');
      const err = new Error('Lead is already converted');
      err.status = 409;
      throw err;
    }

    // Resolve + validate the deal's stage against the org's EFFECTIVE
    // pipeline up front (before touching companies/contacts) so a bad
    // caller-supplied stage 400s cleanly instead of writing a deal that then
    // silently vanishes off the board — the bug this replaces: a hardcoded
    // 'LEAD' that generic/rin orgs (lowercase stages) never recognized.
    let dealStage = null;
    let dealPhase = null;
    if (opts.createDeal) {
      const pipeline = await pipelines.getEffectivePipeline(actor.orgId, undefined, {});
      dealStage = pipeline.default_stage;
      if (typeof opts.dealStage === 'string' && opts.dealStage.trim()) {
        const candidate = opts.dealStage.trim().slice(0, 64);
        if (!dealStages.isValidStage(candidate, pipeline)) {
          await client.query('ROLLBACK');
          const err = new Error('Invalid stage');
          err.status = 400;
          err.body = { error: 'Invalid stage', code: 'INVALID_STAGE', stage: candidate, valid_stages: pipeline.stages.map((st) => st.id) };
          throw err;
        }
        dealStage = candidate;
      }
      dealPhase = dealStages.phaseForStage(dealStage, pipeline);
    }

    // Company upsert (case-insensitive, org-scoped): a lead's free-text
    // company_name becomes a real companies row linked to the contact/deal
    // instead of being stuffed into the contact's notes.
    let companyId = null;
    if (lead.company_name) {
      const existingCompany = await client.query(
        `SELECT id FROM companies WHERE ${sf} = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [sv, lead.company_name]
      );
      if (existingCompany.rows.length > 0) {
        companyId = existingCompany.rows[0].id;
      } else {
        const createdCompany = await client.query(
          `INSERT INTO companies (user_id, org_id, name) VALUES ($1, $2, $3) RETURNING id`,
          [actor.userId, actor.orgId || null, lead.company_name]
        );
        companyId = createdCompany.rows[0].id;
      }
    }

    const { first, last } = splitName(lead.name);
    const contactNotes = [
      `Converted from lead #${lead.id}${lead.source ? ` (source: ${lead.source})` : ''}.`,
      lead.notes || null,
    ].filter(Boolean).join('\n');

    const contactResult = await client.query(
      `INSERT INTO contacts (user_id, org_id, first_name, last_name, email, phone, job_title, status, notes, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        actor.userId,
        actor.orgId || null,
        first, last,
        lead.email || null,
        lead.phone || null,
        lead.title || null,
        'prospect',
        contactNotes,
        companyId,
      ]
    );
    const contact = contactResult.rows[0];

    let deal = null;
    if (opts.createDeal) {
      const dealTitle = cleanField(opts.dealTitle, 'name')
        || (lead.company_name ? `${lead.company_name} — ${lead.name}` : lead.name).slice(0, 255);
      const amountNum = Number(opts.dealAmount);
      const dealAmount = Number.isFinite(amountNum) && amountNum >= 0 ? amountNum : null;
      const dealResult = await client.query(
        `INSERT INTO deals (user_id, org_id, contact_id, company_id, title, amount, stage, phase, notes, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          actor.userId,
          actor.orgId || null,
          contact.id,
          companyId,
          dealTitle,
          dealAmount,
          dealStage,
          dealPhase,
          `Created by converting lead #${lead.id}.`,
          [],
        ]
      );
      deal = dealResult.rows[0];
    }

    const updated = await client.query(
      `UPDATE leads
          SET status = 'converted',
              converted_contact_id = $1,
              converted_deal_id = $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *`,
      [contact.id, deal ? deal.id : null, lead.id]
    );

    await client.query('COMMIT');
    return { lead: updated.rows[0], contact, deal };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  LEAD_STATUSES,
  UPDATABLE_STATUSES,
  FIELD_LIMITS,
  cleanField,
  listLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  assignRoundRobin,
  convertLead,
  splitName,
};
