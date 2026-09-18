// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Extension (curated plugin library) install internals — SHARED by:
//   • POST /api/plugins/from-template + POST /api/plugins/library/:slug/install
//     (routes/pluginRoutes.js)
//   • the chat copilot's confirm-first propose_install_extension apply branch
//     (POST /api/ai/actions/apply, routes/aiRoutes.js)
// so "Enable from the library page" and "Enable from chat" can never diverge.
//
// Semantics:
//   installLibraryTemplate({ orgId, userId, slug })                → clone as DRAFT
//   installLibraryTemplate({ orgId, userId, slug, activate:true }) → one-click
//     ENABLE: if the org already has a clone of this template, the most recent
//     one is activated in place (idempotent — a second click never duplicates);
//     otherwise the template is cloned and inserted status='active' atomically
//     (one INSERT — there is no draft-then-PATCH window).
//
// Callers own the audit trail (they hold the req); this module never audits.

const pool = require('../db');
const pluginLibrary = require('./pluginLibrary');
const { validateSpec } = require('./pluginSpecValidator');

/**
 * One query: which library templates does this org already have clones of?
 * Returns { [slug]: { plugin_id, status, active } } — `active` is true when
 * ANY clone of that slug is active; plugin_id/status describe the "best" row
 * (an active one if it exists, else the most recent).
 */
async function getLibraryStatusForOrg(orgId) {
  if (!orgId) return {};
  const r = await pool.query(
    `SELECT id, library_slug, status
       FROM plugins
      WHERE org_id = $1 AND library_slug IS NOT NULL
      ORDER BY (status = 'active') ASC, created_at ASC`,
    [orgId]
  );
  // Later rows win: ordering puts active rows (then newest) last so the map
  // ends up pointing at the active clone when one exists.
  const bySlug = {};
  for (const row of r.rows) {
    const prev = bySlug[row.library_slug];
    bySlug[row.library_slug] = {
      plugin_id: row.id,
      status: row.status,
      active: row.status === 'active' || (prev ? prev.active : false),
    };
  }
  return bySlug;
}

/** Decorate pluginLibrary.list() items with the org's install status. */
function enrichLibraryList(items, statusBySlug) {
  return items.map((item) => {
    const st = statusBySlug[item.slug];
    return {
      ...item,
      installed: !!st,
      active: !!(st && st.active),
      installed_plugin_id: st ? st.plugin_id : null,
      installed_status: st ? st.status : null,
    };
  });
}

// Project a curated library entry onto the validator's expected spec shape.
// Mirrors what the historical clone endpoint did — source_kind forced to
// 'library' so the row is visibly a clone.
function projectTemplateSpec(tpl) {
  return {
    name:          tpl.spec.name,
    description:   tpl.summary,
    trigger_event: tpl.spec.triggerEvent,
    source_kind:   'library',
    spec_json: {
      summary:       tpl.spec.summary || tpl.summary,
      triggerEvent:  tpl.spec.triggerEvent,
      triggerFilter: tpl.spec.triggerFilter || null,
      actions:       Array.isArray(tpl.spec.actions) ? tpl.spec.actions : [],
    },
    // Library templates declare actions, not a JS body — the runner only
    // fires plugins with non-empty source_code, so a clone with a placeholder
    // body stays inert until the author (or the copilot) converts the spec.
    source_code:   tpl.spec.source_code || '// Library template — actions are declarative.\n// Tell the copilot what to change to convert this into runnable code.',
  };
}

/**
 * Install (and optionally activate) a curated library template for an org.
 * Returns { http, body } for the caller to send / translate. On success the
 * body carries { success: true, plugin, template_slug, activated,
 * already_active?, activated_existing? }.
 */
async function installLibraryTemplate({ orgId, userId, slug, activate = false, log } = {}) {
  if (!orgId) {
    return { http: 400, body: { success: false, error: 'Org context required', code: 'ORG_REQUIRED' } };
  }
  const tpl = pluginLibrary.getBySlug(slug);
  if (!tpl) {
    return { http: 404, body: { success: false, error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' } };
  }

  const specForValidation = projectTemplateSpec(tpl);
  const validation = validateSpec(specForValidation);
  if (!validation.ok) {
    // A failed validation here is a CURATOR-side issue (someone added a bad
    // template), not a customer-input error.
    if (log) log.warn('plugin_library_template_failed_validation', { slug, errors: validation.errors });
    return {
      http: 422,
      body: {
        success: false,
        error: 'Library template failed validation',
        code: 'TEMPLATE_INVALID',
        errors: validation.errors,
      },
    };
  }

  // One-click Enable is idempotent: if the org already cloned this template,
  // activate that clone instead of stamping a duplicate row.
  if (activate) {
    const existing = await pool.query(
      `SELECT id, name, public_id, status, source_kind, description, trigger_event, library_slug
         FROM plugins
        WHERE org_id = $1 AND library_slug = $2
        ORDER BY (status = 'active') DESC, created_at DESC
        LIMIT 1`,
      [orgId, slug]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.status === 'active') {
        return { http: 200, body: { success: true, plugin: row, template_slug: slug, activated: true, already_active: true } };
      }
      const updated = await pool.query(
        `UPDATE plugins
            SET status = 'active', updated_at = CURRENT_TIMESTAMP, updated_by = $1,
                entity_version = entity_version + 1
          WHERE id = $2 AND org_id = $3
          RETURNING id, name, public_id, status, source_kind, description, trigger_event, library_slug`,
        [userId, row.id, orgId]
      );
      if (updated.rows.length > 0) {
        return { http: 200, body: { success: true, plugin: updated.rows[0], template_slug: slug, activated: true, activated_existing: true } };
      }
      // Row vanished between SELECT and UPDATE — fall through to a fresh clone.
    }
  }

  // Suffix the name with " (Draft)" if (org_id, name) collides. The template
  // name is fixed, so a second draft install of the same template would
  // collide — serve "try it twice" automatically rather than 409'ing.
  let candidateName = specForValidation.name;
  const clash = await pool.query(
    `SELECT 1 FROM plugins WHERE org_id = $1 AND name = $2`,
    [orgId, candidateName]
  );
  if (clash.rows.length > 0) {
    candidateName = `${candidateName} (Draft)`;
    let i = 2;
    while (i < 50) {
      const more = await pool.query(
        `SELECT 1 FROM plugins WHERE org_id = $1 AND name = $2`,
        [orgId, candidateName]
      );
      if (more.rows.length === 0) break;
      candidateName = `${specForValidation.name} (Draft ${i})`;
      i++;
    }
  }

  const status = activate ? 'active' : 'draft';
  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO plugins (org_id, name, description, spec_json, source_code, source_kind,
                            trigger_event, trigger_filter_json, status, created_by, updated_by,
                            library_slug)
       VALUES ($1, $2, $3, COALESCE($4, '{}')::jsonb, $5, 'library',
               $6, $7::jsonb, $8, $9, $9, $10)
       RETURNING id, name, public_id, status, source_kind, description, trigger_event, library_slug`,
      [
        orgId,
        candidateName,
        specForValidation.description || null,
        JSON.stringify(specForValidation.spec_json),
        specForValidation.source_code || null,
        specForValidation.trigger_event,
        specForValidation.spec_json.triggerFilter ? JSON.stringify(specForValidation.spec_json.triggerFilter) : null,
        status,
        userId,
        slug,
      ]
    );
  } catch (err) {
    // Unique violation should be defended-against by the loop above; if we
    // still land here, surface a clean 409 so the client can retry.
    if (err && err.code === '23505') {
      return {
        http: 409,
        body: {
          success: false,
          error: `A plugin named "${candidateName}" already exists. Try renaming the existing one first.`,
          code: 'NAME_CONFLICT',
        },
      };
    }
    throw err;
  }

  return {
    http: 201,
    body: { success: true, plugin: inserted.rows[0], template_slug: slug, activated: status === 'active' },
  };
}

module.exports = {
  getLibraryStatusForOrg,
  enrichLibraryList,
  installLibraryTemplate,
  projectTemplateSpec,
};
