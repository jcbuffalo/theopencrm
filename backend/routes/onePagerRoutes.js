// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record one-pager PDFs (CMN_REQUIREMENTS.md §1.7) + template CRUD.
//
// Two routers:
//   pdfRouter (mounted at /api — auth attached PER ROUTE so unmatched /api/*
//   requests fall through untouched):
//     GET /deals/:id/one-pager.pdf      ?template_id= optional
//     GET /companies/:id/one-pager.pdf
//     GET /contacts/:id/one-pager.pdf
//   templatesRouter (mounted at /api/one-pager-templates):
//     GET    /            — list templates visible to this scope (?entity=)
//     POST   /            — create (org owner/admin; any user in a personal workspace)
//     PUT    /:id         — update, same perms
//     DELETE /:id         — delete, same perms
//
// Core surface like the PO/quote PDFs — no feature flag. Every query
// org-scopes via qs(req). Photos and the branding logo degrade silently:
// a sheet with no images is still a valid sheet.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const {
  FIELD_DEF_ENTITY,
  getDefaultTemplate,
  normalizeTemplateConfig,
  loadPhotos,
  renderOnePagerPdf,
} = require('../services/pdfOnePager');

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const ENTITIES = new Set(['deal', 'company', 'contact']);

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

const RECORD_QUERIES = {
  deal: (sf) => `
    SELECT d.*,
           c.name  AS company_name,
           cu.name AS customer_name,
           v.name  AS vendor_name,
           NULLIF(TRIM(CONCAT(ct.first_name, ' ', ct.last_name)), '') AS contact_name
      FROM deals d
      LEFT JOIN companies c  ON d.company_id  = c.id
      LEFT JOIN companies cu ON d.customer_id = cu.id
      LEFT JOIN companies v  ON d.vendor_id   = v.id
      LEFT JOIN contacts  ct ON d.contact_id  = ct.id
     WHERE d.id = $1 AND d.${sf} = $2`,
  company: (sf) => `SELECT c.* FROM companies c WHERE c.id = $1 AND c.${sf} = $2`,
  contact: (sf) => `
    SELECT ct.*, c.name AS company_name
      FROM contacts ct
      LEFT JOIN companies c ON ct.company_id = c.id
     WHERE ct.id = $1 AND ct.${sf} = $2`,
};

async function resolveTemplate(req, entity) {
  const [sf, sv] = qs(req);
  const templateId = req.query.template_id;
  if (templateId !== undefined && templateId !== '') {
    const id = Number(templateId);
    if (!Number.isInteger(id)) return { status: 400, error: 'Invalid template_id' };
    const r = await pool.query(
      `SELECT * FROM one_pager_templates WHERE id = $1 AND entity = $2 AND ${sf} = $3`,
      [id, entity, sv]
    );
    if (r.rows.length === 0) return { status: 404, error: 'Template not found' };
    return { template: r.rows[0] };
  }
  const r = await pool.query(
    `SELECT * FROM one_pager_templates
      WHERE entity = $1 AND ${sf} = $2 AND is_default = TRUE
      LIMIT 1`,
    [entity, sv]
  );
  return { template: r.rows[0] || getDefaultTemplate(entity) };
}

async function loadOrgBranding(req) {
  if (!req.orgId) return { orgName: null, branding: null };
  const r = await pool.query(`SELECT name, branding FROM organizations WHERE id = $1`, [req.orgId]);
  return { orgName: r.rows[0]?.name || null, branding: r.rows[0]?.branding || null };
}

async function loadFieldDefs(req, entity) {
  if (!req.orgId) return [];
  const r = await pool.query(
    `SELECT name, label, type FROM org_field_definitions
      WHERE org_id = $1 AND entity = $2
      ORDER BY position, id`,
    [req.orgId, FIELD_DEF_ENTITY[entity]]
  );
  return r.rows;
}

// The branding logo is an operator-configured URL (organizations.branding),
// not user input — but we still fetch it defensively: https only, short
// timeout, image content types only, 2MB cap. Any failure → no logo.
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

async function fetchLogo(branding) {
  const url = branding?.logoUrl;
  if (!url || typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/image\/(png|jpe?g)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) return null;
    return { buffer: buf };
  } catch (_) {
    return null; // unreachable host, timeout, DNS — sheet ships without a logo
  }
}

function safeFilename(base) {
  return String(base || 'record').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'record';
}

// ---------------------------------------------------------------------------
// PDF routes
// ---------------------------------------------------------------------------

const pdfRouter = express.Router();

function onePagerHandler(entity) {
  return async (req, res) => {
    try {
      const [sf, sv] = qs(req);
      const rec = await pool.query(RECORD_QUERIES[entity](sf), [req.params.id, sv]);
      if (rec.rows.length === 0) {
        const label = entity.charAt(0).toUpperCase() + entity.slice(1);
        return res.status(404).json({ error: `${label} not found` });
      }
      const record = rec.rows[0];

      const t = await resolveTemplate(req, entity);
      if (t.error) return res.status(t.status).json({ error: t.error });
      const template = t.template;
      const config = normalizeTemplateConfig(entity, template.config);

      const { orgName, branding } = await loadOrgBranding(req);
      const fieldDefs = await loadFieldDefs(req, entity);
      const photos = config.include_photos
        ? await loadPhotos({ entity, recordId: record.id, scopeField: sf, scopeValue: sv, limit: config.photo_count })
        : [];
      const logo = await fetchLogo(branding);

      const titleBase = entity === 'contact'
        ? [record.first_name, record.last_name].filter(Boolean).join('-')
        : (record.title || record.name);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(titleBase)}-one-pager.pdf"`);
      renderOnePagerPdf({ entity, record, template, fieldDefs, branding, orgName, photos, logo }, res);
    } catch (error) {
      console.error(`One-pager PDF error (${entity}):`, error);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to generate one-pager PDF' });
      else res.end();
    }
  };
}

// Auth per route (NOT router.use) — this router is mounted at /api, and a
// router-level authMiddleware would run for every /api/* request that falls
// through it.
pdfRouter.get('/deals/:id/one-pager.pdf', authMiddleware, onePagerHandler('deal'));
pdfRouter.get('/companies/:id/one-pager.pdf', authMiddleware, onePagerHandler('company'));
pdfRouter.get('/contacts/:id/one-pager.pdf', authMiddleware, onePagerHandler('contact'));

// ---------------------------------------------------------------------------
// Template CRUD
// ---------------------------------------------------------------------------

const templatesRouter = express.Router();
templatesRouter.use(authMiddleware);

// Org members read; org owner/admin write. A personal workspace (no org) is
// its own owner, so writes pass. No DB hit — req.orgRole comes from
// authMiddleware.
const WRITE_ROLES = new Set(['owner', 'admin']);
function requireTemplateWrite(req, res, next) {
  if (!req.orgId) return next();
  if (WRITE_ROLES.has(req.orgRole)) return next();
  return res.status(403).json({ error: 'Org owner or admin role required' });
}

function validateTemplateBody(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.entity !== undefined) {
    if (!ENTITIES.has(body.entity)) errors.push(`entity must be one of: ${Array.from(ENTITIES).join(', ')}`);
  }
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 120) {
      errors.push('name must be a non-empty string of at most 120 characters');
    }
  }
  if (body.config !== undefined && (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config))) {
    errors.push('config must be an object');
  }
  if (body.is_default !== undefined && typeof body.is_default !== 'boolean') {
    errors.push('is_default must be a boolean');
  }
  return errors;
}

templatesRouter.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { entity } = req.query;
    if (entity !== undefined && !ENTITIES.has(entity)) {
      return res.status(400).json({ error: `entity must be one of: ${Array.from(ENTITIES).join(', ')}` });
    }
    const params = [sv];
    let sql = `SELECT * FROM one_pager_templates WHERE ${sf} = $1`;
    if (entity) { params.push(entity); sql += ` AND entity = $${params.length}`; }
    sql += ` ORDER BY entity, is_default DESC, LOWER(name)`;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (error) {
    console.error('One-pager template list error:', error);
    res.status(500).json({ error: 'Failed to load one-pager templates' });
  }
});

templatesRouter.post('/', requireTemplateWrite, async (req, res) => {
  const errors = validateTemplateBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const { entity, name, config, is_default } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (is_default === true) {
      const [sf, sv] = qs(req);
      await client.query(
        `UPDATE one_pager_templates SET is_default = FALSE
          WHERE entity = $1 AND ${sf} = $2 AND is_default = TRUE`,
        [entity, sv]
      );
    }
    const r = await client.query(
      `INSERT INTO one_pager_templates (user_id, org_id, entity, name, config, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.userId, req.orgId || null, entity, name.trim(), JSON.stringify(config || {}), is_default === true]
    );
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('One-pager template create error:', error);
    res.status(500).json({ error: 'Failed to create one-pager template' });
  } finally {
    client.release();
  }
});

templatesRouter.put('/:id', requireTemplateWrite, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const errors = validateTemplateBody(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const { name, config, is_default } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [sf, sv] = qs(req);
    const existing = await client.query(
      `SELECT id, entity FROM one_pager_templates WHERE id = $1 AND ${sf} = $2`,
      [id, sv]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Template not found' });
    }
    if (is_default === true) {
      await client.query(
        `UPDATE one_pager_templates SET is_default = FALSE
          WHERE entity = $1 AND ${sf} = $2 AND id <> $3 AND is_default = TRUE`,
        [existing.rows[0].entity, sv, id]
      );
    }
    const r = await client.query(
      `UPDATE one_pager_templates SET
         name       = COALESCE($1, name),
         config     = COALESCE($2::jsonb, config),
         is_default = COALESCE($3, is_default),
         updated_at = NOW()
       WHERE id = $4 AND ${sf} = $5
       RETURNING *`,
      [
        typeof name === 'string' ? name.trim() : null,
        config === undefined ? null : JSON.stringify(config),
        typeof is_default === 'boolean' ? is_default : null,
        id, sv,
      ]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('One-pager template update error:', error);
    res.status(500).json({ error: 'Failed to update one-pager template' });
  } finally {
    client.release();
  }
});

templatesRouter.delete('/:id', requireTemplateWrite, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM one_pager_templates WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('One-pager template delete error:', error);
    res.status(500).json({ error: 'Failed to delete one-pager template' });
  }
});

module.exports = { pdfRouter, templatesRouter };
