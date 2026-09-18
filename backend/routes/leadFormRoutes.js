// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lead capture forms (migration 131) — two routers in one file:
//
//   1. `router` — AUTHENTICATED form management, mounted at /api/lead-forms
//      behind requireFeature('leads_enabled'). CRUD over the org's forms.
//
//   2. `publicRouter` — the PUBLIC capture surface, mounted at
//      /api/public/lead-forms with NO auth. This is an abuse surface and is
//      treated like one:
//        • per-IP rate limited (leadCaptureLimiter, mounted in index.js)
//        • CSRF-exempt (added to csrfIgnoredRoutes — anonymous submitters
//          have no session, and the endpoint grants nothing to the caller)
//        • org resolved ONLY from the unguessable 192-bit token — no org id
//          ever appears in a request or response
//        • unknown token, inactive form, and feature-flag-off all return the
//          SAME generic 404 (no existence oracle)
//        • every stored field is length-capped + bound as a query parameter;
//          nothing the submitter sends is interpolated into SQL or HTML here
//        • responses never echo org internals — { ok: true } plus the form's
//          own redirect_url
//
// Why store-verbatim instead of HTML-encoding at rest: encoding at rest
// corrupts legitimate values ("Smith & Sons" → "Smith &amp; Sons" in CSV
// exports) and single-encodes only one renderer's context. React escapes on
// render; the email paths in this codebase escape via escapeHtml() at send
// time. Parameterized inserts kill SQLi; output-escaping kills XSS.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { authMiddleware } = require('../auth');
const leads = require('../services/leads');
const featureFlags = require('../services/featureFlags');
const notificationDispatcher = require('../services/notificationDispatcher');

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Which lead columns a form may collect beyond the always-required `name`.
// Server-side allowlist — the form's `fields` JSONB drives rendering only.
const COLLECTABLE_FIELDS = ['email', 'phone', 'company_name', 'title', 'notes'];

// ---------------------------------------------------------------------------
// Authenticated form management
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM lead_forms WHERE ${sf} = $1 ORDER BY created_at DESC`,
      [sv]
    );
    res.json(result.rows);
  } catch (error) {
    if (req.log) req.log.error('lead_forms_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch lead forms' });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const name = leads.cleanField(body.name, 'name');
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Normalize `fields` to a boolean map over the allowlist. Unknown keys
    // are dropped silently — they'd never be honored at submit time anyway.
    const fields = {};
    const requested = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : {};
    for (const f of COLLECTABLE_FIELDS) fields[f] = Boolean(requested[f]);

    // redirect_url: http(s) only — a javascript: URL stored here would be
    // handed to the public thank-you page as a navigation target.
    let redirectUrl = null;
    if (typeof body.redirect_url === 'string' && body.redirect_url.trim()) {
      const candidate = body.redirect_url.trim().slice(0, 2000);
      if (!/^https?:\/\//i.test(candidate)) {
        return res.status(400).json({ error: 'redirect_url must be an http(s) URL' });
      }
      redirectUrl = candidate;
    }

    // 192-bit random token — the sole public handle for this form. Treated
    // as a credential: unguessable, never derived from ids.
    const token = crypto.randomBytes(24).toString('hex');

    const result = await pool.query(
      `INSERT INTO lead_forms (user_id, org_id, name, public_token, fields, redirect_url, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, TRUE) RETURNING *`,
      [req.userId, req.orgId || null, name, token, JSON.stringify(fields), redirectUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('lead_form_create_failed', { error });
    res.status(500).json({ error: 'Failed to create lead form' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const body = req.body || {};

    let fieldsJson = null; // COALESCE no-op
    if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
      const fields = {};
      for (const f of COLLECTABLE_FIELDS) fields[f] = Boolean(body.fields[f]);
      fieldsJson = JSON.stringify(fields);
    }

    let redirectUrl = null;
    if (typeof body.redirect_url === 'string' && body.redirect_url.trim()) {
      const candidate = body.redirect_url.trim().slice(0, 2000);
      if (!/^https?:\/\//i.test(candidate)) {
        return res.status(400).json({ error: 'redirect_url must be an http(s) URL' });
      }
      redirectUrl = candidate;
    }

    const result = await pool.query(
      `UPDATE lead_forms SET
          name         = COALESCE($1, name),
          fields       = COALESCE($2::jsonb, fields),
          redirect_url = COALESCE($3, redirect_url),
          is_active    = COALESCE($4, is_active)
        WHERE id = $5 AND ${sf} = $6 RETURNING *`,
      [
        leads.cleanField(body.name, 'name'),
        fieldsJson,
        redirectUrl,
        typeof body.is_active === 'boolean' ? body.is_active : null,
        req.params.id, sv,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead form not found' });
    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('lead_form_update_failed', { error });
    res.status(500).json({ error: 'Failed to update lead form' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `DELETE FROM lead_forms WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead form not found' });
    res.json({ message: 'Lead form deleted' });
  } catch (error) {
    if (req.log) req.log.error('lead_form_delete_failed', { error });
    res.status(500).json({ error: 'Failed to delete lead form' });
  }
});

// ---------------------------------------------------------------------------
// Public capture surface — NO AUTH. See file header for the threat model.
// ---------------------------------------------------------------------------

const publicRouter = express.Router();

const GENERIC_404 = { error: 'Not found' };

// Quick-reject malformed tokens before touching the DB. We only ever mint
// lowercase hex, but accept a slightly wider charset so the check stays a
// format gate, not a second secret.
function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

// Resolve an ACTIVE form by token, enforcing the org's leads_enabled flag.
// Every failure mode returns null → the caller 404s generically.
async function resolveActiveForm(token) {
  if (!validToken(token)) return null;
  const result = await pool.query(
    `SELECT * FROM lead_forms WHERE public_token = $1 AND is_active = TRUE`,
    [token]
  );
  const form = result.rows[0];
  if (!form) return null;
  // Org disabled the module → the public surface disappears too. Org-less
  // (user_id-scoped) forms skip the check: feature flags are an org concept.
  if (form.org_id) {
    const enabled = await featureFlags.hasFeature(form.org_id, 'leads_enabled');
    if (!enabled) return null;
  }
  return form;
}

// GET /:token — just enough to render the public form: display name + which
// fields to collect. No org name, no ids, no owner emails.
publicRouter.get('/:token', async (req, res) => {
  try {
    const form = await resolveActiveForm(req.params.token);
    if (!form) return res.status(404).json(GENERIC_404);
    res.json({ name: form.name, fields: form.fields || {} });
  } catch (error) {
    if (req.log) req.log.error('lead_form_public_get_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/submit — create one lead from an anonymous submission.
publicRouter.post('/:token/submit', async (req, res) => {
  try {
    // Size cap: the global JSON parser allows 10mb (uploads elsewhere need
    // it); an anonymous capture never legitimately exceeds a few KB. Reject
    // oversized bodies before doing any DB work.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid submission' });
    }
    if (JSON.stringify(body).length > 16384) {
      return res.status(413).json({ error: 'Submission too large' });
    }

    const form = await resolveActiveForm(req.params.token);
    if (!form) return res.status(404).json(GENERIC_404);

    const name = leads.cleanField(body.name, 'name');
    if (!name) return res.status(400).json({ error: 'name is required' });

    if (body.email !== undefined && body.email !== null && String(body.email).trim() !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (typeof body.email !== 'string' || !emailRegex.test(body.email.trim())) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
    }

    // Only fields the form opted into are honored — everything else the
    // submitter sends is ignored. Values are trimmed + length-capped by
    // cleanField and always bound as parameters.
    const formFields = form.fields || {};
    const data = { name };
    for (const f of COLLECTABLE_FIELDS) {
      if (formFields[f]) data[f] = leads.cleanField(body[f], f);
    }

    // Round-robin the new lead across the form's org members. Best-effort:
    // an assignment failure degrades to "unassigned", never a lost lead.
    const scope = form.org_id ? ['org_id', form.org_id] : ['user_id', form.user_id];
    const owner = await leads.assignRoundRobin(scope).catch(() => null);

    const capturedLead = await leads.createLead(
      { userId: form.user_id, orgId: form.org_id || null },
      { ...data, source: 'web form', owner_user_id: owner }
    );

    // Denormalized traction counter — best-effort, never fails the submit.
    await pool.query(
      `UPDATE lead_forms SET submit_count = submit_count + 1 WHERE id = $1`,
      [form.id]
    ).catch(() => {});

    // Fire-and-forget: tell the assigned owner (or the form's owner) a lead
    // arrived. Best-effort — never fails the public submit.
    if (capturedLead && capturedLead.id) {
      notificationDispatcher.notifyLeadCaptured(capturedLead.id)
        .catch(err => console.warn('notify_lead_captured_failed', err && err.message ? err.message : err));
    }

    // Minimal response: acknowledge + the form's own redirect target.
    // Nothing org-identifying leaves this endpoint.
    res.json({ ok: true, redirect_url: form.redirect_url || null });
  } catch (error) {
    if (req.log) req.log.error('lead_form_public_submit_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
