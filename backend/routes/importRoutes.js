// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { authMiddleware } = require('../auth');
const { importExecuteLimiter } = require('../middleware/rateLimits');
const pool = require('../db');
const { resolveStageId, phaseForStage } = require('../utils/dealStages');
const pipelines = require('../services/pipelines');
const importPresets = require('../services/importPresets');

const router = express.Router();

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Switcher-migration presets (services/importPresets.js): an optional
// `preset` body param ('hubspot' | 'salesforce') on each execute route
// pre-applies that platform's column mapping server-side — the caller's
// explicit mapping keys always win over the preset's. Returns the merged
// mapping, or null after sending a 400 for an unknown preset id.
function resolveMapping(req, res, entity) {
  const { rows, mapping, preset } = req.body;
  if (preset === undefined || preset === null || preset === '') return mapping || {};
  if (!importPresets.isPreset(preset)) {
    res.status(400).json({ error: `Unknown preset "${preset}" (valid: ${importPresets.PRESET_IDS.join(', ')})` });
    return null;
  }
  const headers = Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [];
  const auto = importPresets.buildMapping(preset, entity, headers).mapping;
  const merged = { ...auto };
  for (const [k, v] of Object.entries(mapping || {})) {
    if (v) merged[k] = v;         // explicit user choice wins
    else if (v === null || v === '') delete merged[k]; // explicit "skip this field"
  }
  return merged;
}

// Owner matching by email (switcher imports): "Deal owner" / "Contact owner"
// columns → users of the org by email. Unmatched (or a plain name instead of
// an email) is a WARNING and the record imports unowned — never an error.
// Cache is per-import so a 5k-row CSV with 4 owners runs 4 lookups.
async function lookupOwnerId(req, rawValue, cache, warnings, rowNum) {
  const value = String(rawValue == null ? '' : rawValue).trim();
  if (!value) return null;
  const key = value.toLowerCase();
  if (cache.has(key)) {
    const hit = cache.get(key);
    if (!hit.id && hit.warning) warnings.push({ row: rowNum, reason: hit.warning });
    return hit.id;
  }
  let id = null;
  let warning = null;
  if (!value.includes('@')) {
    warning = `Owner "${value}" is not an email address — record imported unowned (re-export with the owner email column, or assign owners after import)`;
  } else {
    const found = req.orgId
      ? await pool.query(`SELECT id FROM users WHERE org_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`, [req.orgId, value])
      : await pool.query(`SELECT id FROM users WHERE id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`, [req.userId, value]);
    id = found.rows[0]?.id || null;
    if (!id) warning = `No team member with email "${value}" — record imported unowned`;
  }
  cache.set(key, { id, warning });
  if (warning) warnings.push({ row: rowNum, reason: warning });
  return id;
}

// GET /api/import/presets — descriptors for the wizard's platform cards.
router.get('/presets', authMiddleware, (req, res) => {
  res.json({ presets: importPresets.listPresets() });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

// POST /api/import/parse — upload CSV, return headers + all rows
router.post('/parse', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
    });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV has no data rows' });
    }

    const headers = Object.keys(rows[0]);

    res.json({
      headers,
      totalRows: rows.length,
      preview: rows.slice(0, 5),
      rows,
    });
  } catch (err) {
    res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }
});

// POST /api/import/contacts — execute contact import
router.post('/contacts', authMiddleware, importExecuteLimiter, async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  const mapping = resolveMapping(req, res, 'contacts');
  if (mapping === null) return;
  if (!mapping.first_name || !mapping.last_name) {
    return res.status(400).json({ error: 'Mapping must include first_name and last_name' });
  }

  let created = 0;
  const errors = [];
  const warnings = [];
  const ownerCache = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const firstName = row[mapping.first_name]?.trim();
    const lastName = row[mapping.last_name]?.trim();

    if (!firstName || !lastName) {
      errors.push({ row: rowNum, reason: 'Missing first_name or last_name' });
      continue;
    }

    try {
      let companyId = null;
      if (mapping.company_name && row[mapping.company_name]?.trim()) {
        const compName = row[mapping.company_name].trim();
        const [sf, sv] = qs(req);
        const found = await pool.query(
          `SELECT id FROM companies WHERE ${sf} = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [sv, compName]
        );
        companyId = found.rows[0]?.id || null;
      }

      // Owner by email ("Contact owner" columns) — unmatched is a warning,
      // the contact imports unowned (contacts.owner_user_id, migration 125).
      let ownerUserId = null;
      if (mapping.owner_email && row[mapping.owner_email]?.trim()) {
        ownerUserId = await lookupOwnerId(req, row[mapping.owner_email], ownerCache, warnings, rowNum);
      }

      await pool.query(
        `INSERT INTO contacts (user_id, org_id, company_id, owner_user_id, first_name, last_name, email, phone, job_title, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          req.userId,
          req.orgId || null,
          companyId,
          ownerUserId,
          firstName,
          lastName,
          mapping.email ? row[mapping.email]?.trim() || null : null,
          mapping.phone ? row[mapping.phone]?.trim() || null : null,
          mapping.job_title ? row[mapping.job_title]?.trim() || null : null,
          mapping.notes ? row[mapping.notes]?.trim() || null : null,
          mapping.status ? row[mapping.status]?.trim() || 'prospect' : 'prospect',
        ]
      );
      created++;
    } catch (err) {
      errors.push({ row: rowNum, reason: err.message });
    }
  }

  res.json({ created, skipped: errors.length, errors: errors.slice(0, 25), warnings: warnings.slice(0, 25) });
});

// POST /api/import/companies — execute company import
router.post('/companies', authMiddleware, importExecuteLimiter, async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  const mapping = resolveMapping(req, res, 'companies');
  if (mapping === null) return;
  if (!mapping.name) {
    return res.status(400).json({ error: 'Mapping must include name' });
  }

  let created = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const name = row[mapping.name]?.trim();
    if (!name) {
      errors.push({ row: rowNum, reason: 'Missing company name' });
      continue;
    }

    try {
      const rawRevenue = mapping.annual_revenue ? row[mapping.annual_revenue] : null;
      const revenue = rawRevenue ? parseInt(rawRevenue.toString().replace(/[^0-9]/g, '')) || null : null;
      const empCount = mapping.employee_count ? parseInt(row[mapping.employee_count]) || null : null;

      await pool.query(
        `INSERT INTO companies (user_id, org_id, name, industry, website, location, employee_count, annual_revenue, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          req.userId,
          req.orgId || null,
          name,
          mapping.industry ? row[mapping.industry]?.trim() || null : null,
          mapping.website ? row[mapping.website]?.trim() || null : null,
          mapping.location ? row[mapping.location]?.trim() || null : null,
          empCount,
          revenue,
          mapping.notes ? row[mapping.notes]?.trim() || null : null,
        ]
      );
      created++;
    } catch (err) {
      errors.push({ row: rowNum, reason: err.message });
    }
  }

  res.json({ created, skipped: errors.length, errors: errors.slice(0, 25), warnings: [] });
});

// POST /api/import/deals — execute deal import. Mirrors the contacts/companies
// imports: per-row validation, org-scoped inserts, returns created/skipped
// counts + up to 25 row errors. Companies referenced by name are matched
// case-insensitively within the caller's scope and CREATED when missing (a
// deals CSV usually arrives before the account list is fully groomed).
//
// Mapping keys: title (required), company_name, stage, amount,
// expected_close_date, notes, deal_type (spec 201 — validated per-row
// against the org's known types), owner_email (owner matched by email,
// unmatched = warning + unowned).
//
// Deliberately a plain INSERT like the sibling imports — no v2 dual-write
// (imported rows carry no external_ref, so onDealCreated would no-op anyway)
// and no per-row webhooks (a 5k-row import must not fan out 5k dispatches).
router.post('/deals', authMiddleware, importExecuteLimiter, async (req, res) => {
  const { rows, preset } = req.body;

  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  const mapping = resolveMapping(req, res, 'deals');
  if (mapping === null) return;
  if (!mapping.title) {
    return res.status(400).json({ error: 'Mapping must include title' });
  }

  const [sf, sv] = qs(req);
  let created = 0;
  const errors = [];
  const warnings = [];
  const ownerCache = new Map();
  // Company name → id cache so a CSV with 500 rows for the same account runs
  // one lookup, not 500.
  const companyIdByName = new Map();
  // Deal types (spec 201): an optional per-row `deal_type` column, validated
  // against the org's known types ('default' + every type with a pipeline
  // row). Each type's effective pipeline is resolved once and cached — stage
  // validation runs against the pipeline for THAT row's type.
  const knownTypes = (await pipelines.listPipelines(req.orgId)).map((p) => p.deal_type);
  const pipelineByType = new Map();
  const pipelineFor = async (type) => {
    if (!pipelineByType.has(type)) {
      pipelineByType.set(type, await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType: type }));
    }
    return pipelineByType.get(type);
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const title = row[mapping.title]?.trim();
    if (!title) {
      errors.push({ row: rowNum, reason: 'Missing title' });
      continue;
    }

    // deal_type: lowercase slug; anything not a known org type is a row
    // error listing the valid types, never a silent default.
    let dealType = pipelines.DEFAULT_DEAL_TYPE;
    if (mapping.deal_type && row[mapping.deal_type]?.trim()) {
      const rawType = row[mapping.deal_type].trim().toLowerCase();
      if (!knownTypes.includes(rawType)) {
        errors.push({ row: rowNum, reason: `Invalid deal_type "${row[mapping.deal_type].trim()}" (valid: ${knownTypes.join(', ')})` });
        continue;
      }
      dealType = rawType;
    }
    const pipeline = await pipelineFor(dealType);
    // Legacy quirk kept for compat: a plain (no-preset) import of a row with
    // no stage lands on 'TRIAGE' for non-custom orgs. Preset (switcher)
    // imports use the pipeline's real default stage instead.
    const defaultStage = (pipeline.is_custom || preset) ? pipeline.default_stage : 'TRIAGE';

    // Stage: validate against the pipeline for the row's deal type. Accept
    // the exact id, its lower/upper-cased form, or the stage LABEL (CSVs are
    // rarely case-faithful). Without a preset, anything else is a row error,
    // never a silent default. WITH a preset (switcher migration), the
    // platform's default stage names map through the preset's stage map
    // (HubSpot appointmentscheduled → lead, Salesforce Prospecting → lead,
    // ...) and a stage nobody recognizes lands on the pipeline's default
    // stage with a per-row WARNING — a switcher's first import must not
    // bounce on a custom stage name.
    let stage = defaultStage;
    if (mapping.stage && row[mapping.stage]?.trim()) {
      const raw = row[mapping.stage].trim();
      if (preset) {
        const mapped = importPresets.mapStage(preset, raw, pipeline);
        stage = mapped.stage || defaultStage;
        if (mapped.warning) warnings.push({ row: rowNum, reason: mapped.warning });
      } else {
        const match = resolveStageId(raw, pipeline);
        if (!match) {
          errors.push({ row: rowNum, reason: `Invalid stage "${raw}"` });
          continue;
        }
        stage = match;
      }
    }

    // Amount / value: strip currency symbols + thousands separators, keep
    // decimals. A non-empty value that still isn't a number is a row error.
    let amount = null;
    if (mapping.amount && row[mapping.amount] != null && String(row[mapping.amount]).trim() !== '') {
      amount = parseFloat(String(row[mapping.amount]).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(amount)) {
        errors.push({ row: rowNum, reason: `Invalid amount "${row[mapping.amount]}"` });
        continue;
      }
    }

    // Expected close date: anything Date.parse understands, normalized to
    // YYYY-MM-DD. A non-empty unparseable value is a row error.
    let expectedCloseDate = null;
    if (mapping.expected_close_date && row[mapping.expected_close_date]?.trim()) {
      const rawDate = row[mapping.expected_close_date].trim();
      const parsedMs = Date.parse(rawDate);
      if (Number.isNaN(parsedMs)) {
        errors.push({ row: rowNum, reason: `Invalid expected_close_date "${rawDate}"` });
        continue;
      }
      expectedCloseDate = new Date(parsedMs).toISOString().slice(0, 10);
    }

    try {
      let companyId = null;
      if (mapping.company_name && row[mapping.company_name]?.trim()) {
        const compName = row[mapping.company_name].trim();
        const cacheKey = compName.toLowerCase();
        if (companyIdByName.has(cacheKey)) {
          companyId = companyIdByName.get(cacheKey);
        } else {
          const found = await pool.query(
            `SELECT id FROM companies WHERE ${sf} = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
            [sv, compName]
          );
          if (found.rows[0]) {
            companyId = found.rows[0].id;
          } else {
            const createdCompany = await pool.query(
              `INSERT INTO companies (user_id, org_id, name) VALUES ($1, $2, $3) RETURNING id`,
              [req.userId, req.orgId || null, compName]
            );
            companyId = createdCompany.rows[0].id;
          }
          companyIdByName.set(cacheKey, companyId);
        }
      }

      // Owner by email ("Deal owner" / "Opportunity Owner" columns) —
      // unmatched is a warning, the deal imports unowned.
      let ownerUserId = null;
      if (mapping.owner_email && row[mapping.owner_email]?.trim()) {
        ownerUserId = await lookupOwnerId(req, row[mapping.owner_email], ownerCache, warnings, rowNum);
      }

      await pool.query(
        `INSERT INTO deals (user_id, org_id, company_id, salesman_id, owner_user_id, title, amount, stage, phase, deal_type,
                            expected_close_date, notes, created_by, updated_by, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $4, $4, CURRENT_TIMESTAMP)`,
        [
          req.userId,
          req.orgId || null,
          companyId,
          req.userId,
          ownerUserId,
          title,
          amount,
          stage,
          phaseForStage(stage, pipeline),
          dealType,
          expectedCloseDate,
          mapping.notes ? row[mapping.notes]?.trim() || null : null,
        ]
      );
      created++;
    } catch (err) {
      errors.push({ row: rowNum, reason: err.message });
    }
  }

  res.json({ created, skipped: errors.length, errors: errors.slice(0, 25), warnings: warnings.slice(0, 25) });
});

module.exports = router;
