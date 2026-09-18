// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contacts — people at companies. Each contact optionally belongs to one
// company (via company_id FK).
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                  — list (filters: status, company_id, search)
//   GET    /:id               — fetch one
//   GET    /:id/activities    — activities related to this contact
//   GET    /:id/deals         — deals where contact_id = :id
//   POST   /                  — create contact
//   PUT    /:id               — update (COALESCE-style partial)
//   DELETE /:id               — hard delete; cascades to activities/tasks/deals via FK
//
// Tenancy: scoped via qs(req). Company linkage is by integer FK; CSV import
// resolves "company name" strings to existing companies (case-insensitive)
// before insert.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { buildBulkUpdate, buildBulkDelete } = require('./_bulkOps');
const { validateCustomFieldsPayload } = require('./customFieldsRoutes');
const { validateBody } = require('../middleware/validate');
const contactSchemas = require('../schemas/contacts');
const audit = require('../services/audit');
const enrichment = require('../services/enrichment');
const { requireFeature } = require('../middleware/featureGate');
const { mergeContacts } = require('../services/mergeRecords');
const contactCadence = require('../services/contactCadence');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit dispatch.
const pluginEvents = require('../services/pluginEvents');
const { toCsv, sendCsv } = require('../utils/csvExport');
// Tier record caps (migration 136) — inert unless the org has an explicit
// capped limits_tier; comped/paid/super-admin exempt. See services/tierLimits.js.
const tierLimits = require('../services/tierLimits');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Only org owners/admins may merge — it hard-deletes a record and rewrites
// child FKs, so it's a privileged, irreversible data operation. Users without
// an org (user_id scope) are their own admin.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// Bulk routes must be mounted BEFORE /:id routes so /bulk isn't captured as
// an id. Columns allowed in bulk-update are intentionally narrow — owner,
// company, and status only. Anything else still needs the per-record PUT.
// zod validates body SHAPE; allowlist inside buildBulkUpdate is the
// authoritative gate against unexpected columns.
router.patch('/bulk', validateBody(contactSchemas.bulkPatchSchema), buildBulkUpdate({
  resource:  'contacts',
  table:     'contacts',
  allowlist: ['owner_id', 'company_id', 'status'],
  qs, pool,
}));
router.delete('/bulk', buildBulkDelete({
  resource: 'contacts', table: 'contacts', qs, pool,
}));

// GET /duplicates — candidate duplicate groups within the caller's org. Two
// signals, in priority order:
//   1. same normalized email (lower(trim(email))) — the strongest signal
//   2. same normalized full name (lower(trim(first || ' ' || last)))
// A group is any signal value shared by 2+ contacts. Each group returns its
// member rows (id/name/email/company/created_at) so the UI can let the admin
// pick a winner. Mounted BEFORE /:id so "duplicates" isn't captured as an id.
router.get('/duplicates', async (req, res) => {
  try {
    const [sf, sv] = qs(req);

    // By email.
    const byEmail = await pool.query(
      `SELECT lower(trim(email)) AS key,
              json_agg(json_build_object(
                'id', id, 'first_name', first_name, 'last_name', last_name,
                'email', email, 'company_id', company_id, 'status', status,
                'created_at', created_at
              ) ORDER BY created_at ASC) AS members
         FROM contacts
        WHERE ${sf} = $1 AND email IS NOT NULL AND trim(email) <> ''
        GROUP BY lower(trim(email))
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC`,
      [sv]
    );

    // By full name (excludes pairs already surfaced by the email match so a
    // group doesn't appear twice with the same members).
    const byName = await pool.query(
      `SELECT lower(trim(first_name || ' ' || last_name)) AS key,
              json_agg(json_build_object(
                'id', id, 'first_name', first_name, 'last_name', last_name,
                'email', email, 'company_id', company_id, 'status', status,
                'created_at', created_at
              ) ORDER BY created_at ASC) AS members
         FROM contacts
        WHERE ${sf} = $1
        GROUP BY lower(trim(first_name || ' ' || last_name))
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC`,
      [sv]
    );

    const groups = [
      ...byEmail.rows.map(r => ({ reason: 'email', key: r.key, members: r.members })),
      ...byName.rows.map(r => ({ reason: 'name', key: r.key, members: r.members })),
    ];
    res.json({ groups });
  } catch (error) {
    if (req.log) req.log.error('contact_duplicates_failed', { error });
    else console.error('Contact duplicates error:', error);
    res.status(500).json({ error: 'Failed to detect duplicate contacts' });
  }
});

// GET /export.csv — download the caller's contact list as a CSV attachment.
// Org-scoped and honours the same filters as GET / (status, company_id,
// search). Server-authoritative: the frontend never assembles export data
// client-side. Mounted BEFORE /:id so "export.csv" isn't captured as an id.
router.get('/export.csv', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, company_id, search } = req.query;
    let query = `
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.job_title,
             co.name AS company_name, c.status, c.notes, c.created_at
        FROM contacts c
        LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.${sf} = $1`;
    const params = [sv];

    if (status)     { query += ` AND c.status = $${params.length + 1}`;     params.push(status); }
    if (company_id) { query += ` AND c.company_id = $${params.length + 1}`; params.push(company_id); }
    if (search) {
      query += ` AND (c.first_name ILIKE $${params.length + 1} OR c.last_name ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY c.created_at DESC';
    const result = await pool.query(query, params);

    sendCsv(res, 'contacts-export.csv', toCsv([
      { key: 'id',           label: 'ID' },
      { key: 'first_name',   label: 'First Name' },
      { key: 'last_name',    label: 'Last Name' },
      { key: 'email',        label: 'Email' },
      { key: 'phone',        label: 'Phone' },
      { key: 'job_title',    label: 'Job Title' },
      { key: 'company_name', label: 'Company' },
      { key: 'status',       label: 'Status' },
      { key: 'notes',        label: 'Notes' },
      { key: 'created_at',   label: 'Created At' },
    ], result.rows));
  } catch (error) {
    if (req.log) req.log.error('contact_export_failed', { error });
    else console.error('Contact export error:', error);
    res.status(500).json({ error: 'Failed to export contacts' });
  }
});

// POST /:id/merge  { loserId } — fold loserId into :id (winner). Org-admin
// gated. Verifies BOTH ids are in the caller's scope, then reassigns every
// child FK, backfills blank winner fields, deletes the loser, and audits —
// all in one transaction.
router.post('/:id/merge', validateBody(contactSchemas.mergeSchema), async (req, res) => {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can merge contacts' });
  }
  const winnerId = parseInt(req.params.id, 10);
  const loserId = parseInt(req.body.loserId, 10);
  if (!Number.isInteger(winnerId) || !Number.isInteger(loserId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  if (winnerId === loserId) {
    return res.status(400).json({ error: 'Cannot merge a contact into itself' });
  }

  const [sf, sv] = qs(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify BOTH ids belong to the caller's scope. A cross-org (or missing)
    // id yields fewer than 2 rows -> 404, and the txn rolls back untouched.
    const scoped = await client.query(
      `SELECT id FROM contacts WHERE id IN ($1, $2) AND ${sf} = $3 FOR UPDATE`,
      [winnerId, loserId, sv]
    );
    if (scoped.rows.length < 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contact not found' });
    }

    const { reassigned } = await mergeContacts(client, winnerId, loserId);

    await client.query('COMMIT');

    // Audit is append-only + fire-and-forget (own pool connection); write it
    // after COMMIT so a rolled-back merge never leaves a phantom audit row.
    await audit.record({
      event: audit.EVENTS.CONTACT_MERGED,
      actorUserId: req.userId || null,
      orgId: req.orgId || null,
      targetType: 'contact',
      targetId: winnerId,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { winner_id: winnerId, loser_id: loserId, reassigned },
    });

    const winner = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [winnerId]);
    res.json({ message: 'Contacts merged', winner: winner.rows[0], reassigned });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (req.log) req.log.error('contact_merge_failed', { error });
    else console.error('Contact merge error:', error);
    res.status(500).json({ error: 'Failed to merge contacts' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Relationship cadence (migration 125) — gone-quiet list, cadence editor, and
// explicit "mark touched". Gated by customer_success_enabled like the other
// post-sale relationship surfaces (/api/accounts, /api/retention). GET
// /gone-quiet is mounted BEFORE /:id so "gone-quiet" isn't captured as an id.
// ---------------------------------------------------------------------------

// GET /gone-quiet — contacts with a cadence set whose last touch is older than
// their cadence_days (never-touched counts as maximally overdue), most overdue
// first. ?limit caps the list (default 50, max 200).
router.get('/gone-quiet', requireFeature('customer_success_enabled'), async (req, res) => {
  try {
    const contacts = await contactCadence.goneQuiet(qs(req), { limit: req.query.limit });
    res.json({ contacts, total: contacts.length });
  } catch (error) {
    if (req.log) req.log.error('contacts_gone_quiet_failed', { error });
    else console.error('Contacts gone-quiet error:', error);
    res.status(500).json({ error: 'Failed to fetch gone-quiet contacts' });
  }
});

// PATCH /:id/cadence — set/clear cadence_days and/or owner_user_id. Strict
// allowlist: ONLY those two columns are writeable here (explicit null clears a
// value — unlike the COALESCE-style PUT, which can't). Org-scoped.
router.patch('/:id/cadence', requireFeature('customer_success_enabled'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [];

    if ('cadence_days' in body) {
      const v = body.cadence_days;
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 3650)) {
        return res.status(400).json({ error: 'cadence_days must be an integer between 1 and 3650, or null to clear' });
      }
      params.push(v);
      sets.push(`cadence_days = $${params.length}`);
    }
    if ('owner_user_id' in body) {
      const v = body.owner_user_id;
      if (v !== null && (!Number.isInteger(v) || v < 1)) {
        return res.status(400).json({ error: 'owner_user_id must be a positive integer, or null to clear' });
      }
      params.push(v);
      sets.push(`owner_user_id = $${params.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'Provide cadence_days and/or owner_user_id' });
    }

    const [sf, sv] = qs(req);
    params.push(req.params.id, sv);
    const result = await pool.query(
      `UPDATE contacts SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${params.length - 1} AND ${sf} = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('contact_cadence_patch_failed', { error });
    else console.error('Contact cadence patch error:', error);
    res.status(500).json({ error: 'Failed to update contact cadence' });
  }
});

// POST /:id/touch — stamp last_touch_at = now ("I just reconnected with this
// person"). Org-scoped via the service; cross-org ids 404.
router.post('/:id/touch', requireFeature('customer_success_enabled'), async (req, res) => {
  try {
    const contact = await contactCadence.touchContact(qs(req), req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  } catch (error) {
    if (req.log) req.log.error('contact_touch_failed', { error });
    else console.error('Contact touch error:', error);
    res.status(500).json({ error: 'Failed to mark contact touched' });
  }
});

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, company_id, search } = req.query;
    let query = `SELECT * FROM contacts WHERE ${sf} = $1`;
    const params = [sv];

    if (status)     { query += ` AND status = $${params.length + 1}`;     params.push(status); }
    if (company_id) { query += ` AND company_id = $${params.length + 1}`; params.push(company_id); }
    if (search) {
      query += ` AND (first_name ILIKE $${params.length + 1} OR last_name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM contacts WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

router.get('/:id/activities', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM activities WHERE contact_id = $1 AND ${sf} = $2 ORDER BY activity_date DESC`,
      [req.params.id, sv]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/:id/deals', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM deals WHERE contact_id = $1 AND ${sf} = $2 ORDER BY created_at DESC`,
      [req.params.id, sv]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

router.post('/', validateBody(contactSchemas.createSchema), async (req, res) => {
  try {
    const { first_name, last_name, email, phone, company_id, job_title, status, tags, notes, custom_fields, owner_user_id, cadence_days } = req.body;
    // zod has enforced first_name + last_name presence and shape gates.

    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'contacts', payload: custom_fields, isCreate: true });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // --- Tier record cap (inert-by-default) -------------------------------
    // 402s ONLY when the org is explicitly on a capped limits_tier, is
    // neither comped nor paid, the caller isn't a super-admin, AND the org is
    // at its contact cap. Fails OPEN on any internal error.
    const tierGate = await tierLimits.recordLimitGate(req, 'contacts');
    if (tierGate) return res.status(tierGate.statusCode).json(tierGate.body);
    // -----------------------------------------------------------------------

    // SOFT duplicate check — same signals as GET /duplicates (normalized
    // email first, then normalized full name), but as cheap single-key
    // org-scoped lookups instead of a full grouping scan. NEVER blocks the
    // create: matches only decorate the 201 response with a warning, and a
    // failure in the check itself is swallowed so it can't fail the save.
    let possibleDuplicates = [];
    try {
      const [sf, sv] = qs(req);
      if (email && String(email).trim()) {
        const dup = await pool.query(
          `SELECT id, first_name, last_name, email FROM contacts
            WHERE ${sf} = $1 AND email IS NOT NULL AND lower(trim(email)) = lower(trim($2))
            LIMIT 5`,
          [sv, email]
        );
        possibleDuplicates = dup.rows;
      }
      if (possibleDuplicates.length === 0) {
        const dup = await pool.query(
          `SELECT id, first_name, last_name, email FROM contacts
            WHERE ${sf} = $1 AND lower(trim(first_name || ' ' || last_name)) = lower(trim($2))
            LIMIT 5`,
          [sv, `${first_name} ${last_name}`]
        );
        possibleDuplicates = dup.rows;
      }
    } catch (dupError) {
      if (req.log) req.log.warn('contact_duplicate_check_failed', { error: dupError });
    }

    const result = await pool.query(
      `INSERT INTO contacts (user_id, org_id, first_name, last_name, email, phone, company_id, job_title, status, tags, notes, custom_fields, owner_user_id, cadence_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14) RETURNING *`,
      [req.userId, req.orgId || null, first_name, last_name, email || null, phone || null, company_id || null, job_title || null, status || 'prospect', tags || [], notes || null, JSON.stringify(custom_fields || {}), owner_user_id || null, cadence_days || null]
    );

    // Plugin trigger (migration 164) — post-commit, fire-and-forget, deduped
    // per contact id.
    if (req.orgId && result.rows[0]) {
      pluginEvents.emit(req.orgId, 'contact.created', {
        id: result.rows[0].id,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        email: result.rows[0].email,
        company_id: result.rows[0].company_id,
      });
    }

    if (possibleDuplicates.length > 0) {
      return res.status(201).json({
        ...result.rows[0],
        warning: {
          possibleDuplicates: possibleDuplicates.map((d) => ({
            id: d.id,
            name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
            email: d.email || null,
          })),
        },
      });
    }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

router.put('/:id', validateBody(contactSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { first_name, last_name, email, phone, company_id, job_title, status, tags, notes, custom_fields, owner_user_id, cadence_days } = req.body;

    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'contacts', payload: custom_fields, isCreate: false });
    if (cfErr) return res.status(400).json({ error: cfErr });

    const result = await pool.query(
      `UPDATE contacts SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
       email = COALESCE($3, email), phone = COALESCE($4, phone), company_id = COALESCE($5, company_id),
       job_title = COALESCE($6, job_title), status = COALESCE($7, status), tags = COALESCE($8, tags),
       notes = COALESCE($9, notes),
       custom_fields = CASE WHEN $12::jsonb IS NULL THEN custom_fields ELSE custom_fields || $12::jsonb END,
       owner_user_id = COALESCE($13, owner_user_id), cadence_days = COALESCE($14, cadence_days),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 AND ${sf} = $11 RETURNING *`,
      [first_name, last_name, email, phone, company_id, job_title, status, tags, notes, req.params.id, sv, custom_fields ? JSON.stringify(custom_fields) : null, owner_user_id, cadence_days]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM contacts WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Contact deleted', contact: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// POST /:id/enrich — fetch an enrichment PROPOSAL for this contact. Gated by
// enrichment_enabled. Org-scoped: we look the contact up under qs(req) before
// touching the provider, so a cross-org id 404s. Never mutates the contact —
// the response is a { configured, fields } proposal the user reviews and
// applies via /:id/enrich/apply. Degrades gracefully to configured:false.
router.post('/:id/enrich', requireFeature('enrichment_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const found = await pool.query(`SELECT id, email FROM contacts WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    const contact = found.rows[0];

    const result = await enrichment.enrichContact({ email: contact.email, orgId: req.orgId });
    audit.fromReq(req, {
      event: audit.EVENTS.RECORD_ENRICHED,
      targetType: 'contact',
      targetId: String(contact.id),
      meta: { configured: result.configured, cached: !!result.cached, has_email: !!contact.email },
    });
    res.json({
      configured: result.configured,
      cached: !!result.cached,
      message: result.message || null,
      fields: result.fields || {},
    });
  } catch (error) {
    if (req.log) req.log.error('contact_enrich_failed', { error });
    res.status(500).json({ error: 'Failed to enrich contact' });
  }
});

// POST /:id/enrich/apply — merge user-accepted enrichment fields into the
// contact's custom_fields JSONB (namespaced under enrichment_* keys so they
// never collide with org-defined custom fields). Org-scoped + audited.
router.post('/:id/enrich/apply', requireFeature('enrichment_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const fields = req.body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'A `fields` object of accepted values is required' });
    }
    const merged = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || v === '') continue;
      merged[`enrichment_${k}`] = v;
    }
    if (Object.keys(merged).length === 0) {
      return res.status(400).json({ error: 'No non-empty fields to apply' });
    }
    const result = await pool.query(
      `UPDATE contacts
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $1::jsonb,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [JSON.stringify(merged), req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    audit.fromReq(req, {
      event: audit.EVENTS.RECORD_ENRICHMENT_APPLIED,
      targetType: 'contact',
      targetId: String(req.params.id),
      meta: { applied_keys: Object.keys(merged) },
    });
    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('contact_enrich_apply_failed', { error });
    res.status(500).json({ error: 'Failed to apply enrichment' });
  }
});

module.exports = router;
