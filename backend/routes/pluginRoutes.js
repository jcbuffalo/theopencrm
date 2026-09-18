// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin CRUD routes. Gated by plugins_enabled feature flag (default off).
//
// Endpoints:
//   GET    /api/plugins              — list this org's plugins
//   GET    /api/plugins/:id          — fetch one + recent runs
//   POST   /api/plugins              — create from raw spec
//   POST   /api/plugins/from-prompt  — conversational: NL description → AI-generated
//                                      + validator-screened draft (returns 201)
//   PUT    /api/plugins/:id          — update
//   DELETE /api/plugins/:id          — hard delete
//   POST   /api/plugins/:id/test-run — manual invocation (returns runner result)
//   POST   /api/plugins/:id/run      — production invocation (rate-limited)
//   POST   /api/plugins/:id/apply    — confirm-first writer for run proposals
//   PATCH  /api/plugins/:id/run-mode — owner/admin: 'preview' ⇄ 'autonomous'
//                                      (migration 167; audited)
//   GET    /api/plugins/:id/runs     — recent invocation log
//
// The conversational endpoint validates the model output against
// services/pluginSpecValidator (SDK method + trigger event allowlists,
// dangerous-pattern scan) before inserting. The sandbox runner and the raw
// POST /api/plugins are untouched.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { requireFeature } = require('../middleware/featureGate');
const { pluginRunLimiter } = require('../middleware/rateLimits');
const pluginRunner = require('../services/pluginRunner');
const { validateBody } = require('../middleware/validate');
const pluginSchemas = require('../schemas/plugins');
const { validateSpec } = require('../services/pluginSpecValidator');
const pluginGenerator = require('../services/pluginGenerator');
const pluginLibrary = require('../services/pluginLibrary');
const extensionInstall = require('../services/extensionInstall');
const audit = require('../services/audit');
const { friendlyStatus } = require('../services/pluginRunFormatter');
const pluginActions = require('../services/pluginActions');

const router = express.Router();
router.use(authMiddleware);
// AI Pay-as-you-go billing gate. Plugins burn Claude on the conversational
// /from-prompt endpoint, so the gate sits in front of the whole plugin
// surface. Super-admins bypass; orgs in active/comped/trial allow through.
const { requireAiBilling } = require('../middleware/requireAiBilling');
router.use(requireAiBilling());
router.use(requireFeature('plugins_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Cap the serialized input payload accepted by POST /:id/run. The Express
// body parser has its own limit but it varies by mount and we want a hard,
// explicit, plugin-runtime-specific ceiling. 64KB is enough for any
// reasonable structured input — automations work on individual deals or
// short lists, not bulk-uploaded blobs.
const MAX_INPUT_PAYLOAD_BYTES = 64 * 1024;

// Patterns that look like literal secrets pasted into plugin source. Match
// at save-time only, and only as a WARNING — authors may legitimately want
// to paste a test key. The frontend can render the warnings array however
// it likes; we just have to emit the right shape.
//
// Each pattern is anchored or specific enough that ordinary code (variable
// names, short hex literals, etc.) doesn't fire. Order is not significant —
// the loop reports a single warning tag if ANY pattern matches.
const SECRET_PATTERNS = [
  // Long hex strings on their own line (common shape of API keys / token
  // signatures dumped into source).
  /^\s*['"`]?[a-f0-9]{40,}['"`]?\s*[,;]?\s*$/im,
  // Stripe-style live/test secret keys.
  /sk_live_[A-Za-z0-9]{16,}/,
  /sk_test_[A-Za-z0-9]{16,}/,
  // Bearer tokens.
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  // AWS-style identifier embedded in an AWS hostname.
  /[A-Z0-9]{20,}@[^\s'"`]*\.amazonaws/,
  // password = "..." / password: "..." literals.
  /password\s*[=:]\s*["'][^"']{6,}["']/i,
  // Generic api_key / apikey assignments.
  /api[_-]?key\s*[=:]\s*["'][A-Za-z0-9._-]{16,}["']/i,
];

/**
 * Scan plugin source for shapes that look like literal secrets. Returns an
 * array of warning tags (empty when nothing matched). We don't return WHICH
 * pattern matched — that's a finger-pointing UX we'd rather not expose to
 * the author yet; the warning tag is enough signal to surface a banner.
 */
function scanForSecretWarnings(source) {
  if (!source || typeof source !== 'string') return [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(source)) return ['code-may-contain-secrets'];
  }
  return [];
}

router.get('/', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const r = await pool.query(
      `SELECT id, name, description, source_kind, status, trigger_event, public_id,
              run_mode, last_triggered_at, created_at, updated_at, entity_version
         FROM plugins WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.orgId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list plugins' });
  }
});

// IMPORTANT: GET /library is registered BEFORE GET /:id so the literal
// "library" path doesn't get swallowed by the param-matching handler. Same
// reasoning for any future static path segments — register them first.
router.get('/library', async (req, res) => {
  try {
    let items = pluginLibrary.list();
    // Per-entry install status for the caller's org — ONE query, not N.
    // Best-effort: a status-lookup failure degrades to the bare catalog
    // (installed/active simply absent) rather than a 500.
    try {
      const statusBySlug = await extensionInstall.getLibraryStatusForOrg(req.orgId);
      items = extensionInstall.enrichLibraryList(items, statusBySlug);
    } catch (statusErr) {
      if (req.log) req.log.warn('plugin_library_status_lookup_failed', { error: statusErr.message });
    }
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load library' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const p = await pool.query(`SELECT * FROM plugins WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (p.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });
    const runs = await pool.query(
      `SELECT id, started_at, ended_at, status, error_message, cpu_ms,
              proposed_actions, applied_at
         FROM plugin_runs WHERE plugin_id = $1
         ORDER BY started_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...p.rows[0], recent_runs: runs.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch plugin' });
  }
});

router.post('/', validateBody(pluginSchemas.createSchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const { name, description, spec_json, source_code, source_kind, trigger_event, trigger_filter_json } = req.body;
    // zod enforced `name` presence + shape gates.
    const r = await pool.query(
      `INSERT INTO plugins (org_id, name, description, spec_json, source_code, source_kind,
                            trigger_event, trigger_filter_json, status, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, '{}')::jsonb, $5, COALESCE($6, 'conversational'),
               $7, $8::jsonb, 'draft', $9, $9)
       RETURNING *`,
      [
        req.orgId, name, description || null,
        spec_json ? JSON.stringify(spec_json) : null,
        source_code || null,
        source_kind || null,
        trigger_event || null,
        trigger_filter_json ? JSON.stringify(trigger_filter_json) : null,
        req.userId,
      ]
    );
    // Save-time secret scan. Warn but do NOT reject — the author may have
    // intentionally pasted a test key. Frontend can render the warning
    // banner; the response shape is always { success, data, warnings? }.
    const warnings = scanForSecretWarnings(source_code);
    const body = { success: true, data: r.rows[0] };
    if (warnings.length > 0) body.warnings = warnings;
    res.status(201).json(body);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to create plugin', detail: err.message });
  }
});

router.put('/:id', validateBody(pluginSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, description, spec_json, source_code, status, trigger_event, trigger_filter_json } = req.body;
    const r = await pool.query(
      `UPDATE plugins SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         spec_json   = COALESCE($3::jsonb, spec_json),
         source_code = COALESCE($4, source_code),
         status      = COALESCE($5, status),
         trigger_event = COALESCE($6, trigger_event),
         trigger_filter_json = COALESCE($7::jsonb, trigger_filter_json),
         updated_at  = CURRENT_TIMESTAMP,
         updated_by  = $8,
         entity_version = entity_version + 1
       WHERE id = $9 AND ${sf} = $10
       RETURNING *`,
      [
        name, description,
        spec_json ? JSON.stringify(spec_json) : null,
        source_code, status, trigger_event,
        trigger_filter_json ? JSON.stringify(trigger_filter_json) : null,
        req.userId, req.params.id, sv,
      ]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });
    // Re-run the secret scan if the author updated source_code in this PUT.
    // If they didn't pass source_code, we trust the stored value untouched
    // (no need to re-scan unchanged content). Warning emission shape
    // mirrors POST: only present when there's something to warn about.
    const warnings = (source_code !== undefined && source_code !== null) ? scanForSecretWarnings(source_code) : [];
    const body = { success: true, data: r.rows[0] };
    if (warnings.length > 0) body.warnings = warnings;
    res.json(body);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update plugin' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(`DELETE FROM plugins WHERE id = $1 AND ${sf} = $2 RETURNING id`, [req.params.id, sv]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete plugin' });
  }
});

router.post('/:id/test-run', pluginRunLimiter, async (req, res) => {
  try {
    const result = await pluginRunner.run({
      pluginId: Number(req.params.id),
      orgId: req.orgId,
      userId: req.userId,
      triggerKind: 'test_run',
      triggerSource: 'manual',
      triggerData: req.body || null,
      input: req.body || null,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Test run failed', detail: err.message });
  }
});

/**
 * POST /api/plugins/:id/run — manual invocation with an explicit input
 * payload. The body is { input?: object }. Returns { success, result }
 * where `result` mirrors the pluginRunner contract:
 *   { ok, status, runId, output, logs, error, cpu_ms, db_queries }
 *
 * Rate-limited at 60/min per user (see middleware/rateLimits.js). Audit
 * trail is owned by pluginRunner — every call is logged there.
 */
router.post('/:id/run', pluginRunLimiter, validateBody(pluginSchemas.runSchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const pluginId = Number(req.params.id);
    if (!Number.isInteger(pluginId) || pluginId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid plugin id' });
    }
    const input = (req.body && typeof req.body === 'object') ? (req.body.input ?? null) : null;

    // Explicit input payload size cap. The body parser has its own ceiling
    // but we want a hard, plugin-runtime-specific limit independent of the
    // global parser config so a future bump to `express.json({ limit })`
    // doesn't accidentally widen this surface. JSON.stringify gives a
    // byte-length proxy (it's UTF-16 char count, but our cap is generous
    // enough that the difference doesn't matter for ASCII payloads).
    if (input !== null && input !== undefined) {
      const serialized = JSON.stringify(input);
      if (serialized && serialized.length > MAX_INPUT_PAYLOAD_BYTES) {
        return res.status(413).json({
          success: false,
          error: `Input payload too large. Max ${MAX_INPUT_PAYLOAD_BYTES} bytes; received ${serialized.length}.`,
          code: 'PLUGIN_INPUT_TOO_LARGE',
        });
      }
    }

    // CONFIRM-FIRST: runs in the default 'preview' posture. The sandbox
    // executes live against the org's data but any crm.update*/createTask call
    // is CAPTURED as a proposal (result.proposed_actions), NOT written. The
    // caller must Apply the proposals via POST /:id/apply. A plugin can never
    // write directly from this route.
    const result = await pluginRunner.run(pluginId, input, {
      orgId: req.orgId,
      userId: req.userId,
      triggerSource: 'manual',
    });
    // Surface non-200 status for quota / rejection so the client can render
    // a meaningful banner. Sandbox-side errors (timeout, memory, plugin
    // throw) stay 200 because the call itself succeeded — they're recorded
    // in the runs log and the response body describes the failure.
    if (result.status === 'quota_exceeded') {
      return res.status(429).json({ success: false, result, error: result.error || 'Plugin quota exceeded' });
    }
    if (result.status === 'concurrent_limit_exceeded') {
      // 429 like the monthly quota — same "back off and retry" semantics
      // for the client, but with a different sub-status the UI can surface.
      return res.status(429).json({ success: false, result, error: result.error || 'Too many concurrent runs for this org. Retry shortly.' });
    }
    if (result.status === 'rejected') {
      return res.status(409).json({ success: false, result, error: result.error || result.reason });
    }
    res.json({ success: true, result });
  } catch (err) {
    if (req.log) req.log.error('plugin_run_failed', { error: err });
    res.status(500).json({ success: false, error: 'Run failed', detail: err.message });
  }
});

/**
 * POST /api/plugins/:id/apply — the CONFIRM-FIRST writer for plugin proposals.
 *
 * Body: { runId }. Loads that run's proposed_actions SERVER-SIDE (the client
 * never supplies the fields to write — it can only name the run it wants
 * applied), re-validates every proposal against the plugin write allowlist,
 * ownership-checks referenced ids, and applies them all in ONE org-scoped
 * transaction. Idempotent: a run can only be applied once (applied_at guard).
 *
 * SECURITY: this is the ONLY place a plugin-proposed write reaches the DB. The
 * sandbox itself never commits. Because the payload is (runId) only, a caller
 * cannot inject arbitrary fields; and because every write is
 * `WHERE id = $target AND org_id = $orgId`, a proposal naming a foreign id
 * cannot cross org boundaries even if the stored row were tampered with.
 */
router.post('/:id/apply', pluginRunLimiter, validateBody(pluginSchemas.applySchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    // Applying plugin proposals commits real writes to CRM records. Any member
    // may run/preview a plugin, but committing its proposed changes is a
    // privileged action gated to the org owner/admin.
    if (!['owner', 'admin'].includes(req.orgRole)) {
      return res.status(403).json({ success: false, error: 'Only an organization owner or admin can apply plugin changes', code: 'FORBIDDEN' });
    }
    const pluginId = Number(req.params.id);
    const runId = Number(req.body.runId);
    if (!Number.isInteger(pluginId) || pluginId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid plugin id' });
    }

    // Shared commit machinery (services/pluginActions.applyRunProposals) —
    // the SAME path pluginRunner's autonomous auto-apply uses, so the human
    // Apply button and run_mode='autonomous' can never diverge: identical
    // server-side proposal load, re-validation, ref ownership checks, and the
    // single org-scoped transaction with the FOR UPDATE applied_at guard.
    let outcome;
    try {
      outcome = await pluginActions.applyRunProposals({
        runId, pluginId, orgId: req.orgId, appliedBy: req.userId,
      });
    } catch (err) {
      if (req.log) req.log.error('plugin_apply_txn_failed', { error: err.message, runId });
      return res.status(500).json({ success: false, error: 'Failed to apply proposals', detail: err.message });
    }
    if (!outcome.ok) {
      return res.status(outcome.http).json({
        success: false,
        error: outcome.error,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.validation_errors ? { validation_errors: outcome.validation_errors } : {}),
      });
    }

    // Audit every applied plugin write. One event per applied row so the
    // append-only audit_log has the same granularity as chat's action_applied.
    for (const a of outcome.result.applied) {
      if (!a.ok) continue;
      audit.fromReq(req, {
        event: audit.EVENTS.PLUGIN_ACTION_APPLIED,
        targetType: a.entity,
        targetId: a.target_id,
        success: true,
        meta: { runId, plugin_id: pluginId, op: a.op },
      });
    }

    return res.json({ success: true, result: outcome.result });
  } catch (err) {
    if (req.log) req.log.error('plugin_apply_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Apply failed', detail: err.message });
  }
});

/**
 * PATCH /api/plugins/:id/run-mode — flip a plugin between confirm-first
 * 'preview' (default) and 'autonomous' (migration 167).
 *
 * AUTONOMOUS is the owner-authorized reversal of the "a plugin can never
 * write directly" invariant: a successful run's proposals are auto-applied
 * server-side through the same commit machinery as the Apply button. Because
 * that grants the plugin standing write authority, changing run_mode is
 * gated to org owner/admin — the same bar as applying plugin writes and
 * enabling extensions — and every change is audited
 * (plugin.run_mode_changed, meta { old, new }).
 *
 * Body: { run_mode: 'preview' | 'autonomous' }.
 */
router.patch('/:id/run-mode', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    if (!['owner', 'admin'].includes(req.orgRole)) {
      return res.status(403).json({ success: false, error: 'Only an organization owner or admin can change how an extension applies its changes', code: 'FORBIDDEN' });
    }
    const pluginId = Number(req.params.id);
    if (!Number.isInteger(pluginId) || pluginId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid plugin id' });
    }
    const next = req.body && req.body.run_mode;
    if (!['preview', 'autonomous'].includes(next)) {
      return res.status(400).json({ success: false, error: "run_mode must be 'preview' or 'autonomous'", code: 'INVALID_RUN_MODE' });
    }

    const cur = await pool.query(
      `SELECT id, name, run_mode FROM plugins WHERE id = $1 AND org_id = $2`,
      [pluginId, req.orgId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });
    const old = cur.rows[0].run_mode || 'preview';
    if (old === next) {
      return res.json({ success: true, data: cur.rows[0], unchanged: true });
    }

    const r = await pool.query(
      `UPDATE plugins
          SET run_mode = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2,
              entity_version = entity_version + 1
        WHERE id = $3 AND org_id = $4
        RETURNING id, name, status, run_mode, trigger_event, updated_at`,
      [next, req.userId, pluginId, req.orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });

    audit.fromReq(req, {
      event: audit.EVENTS.PLUGIN_RUN_MODE_CHANGED,
      targetType: 'plugin',
      targetId: pluginId,
      success: true,
      meta: { old, new: next, via: 'route' },
    });

    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (req.log) req.log.error('plugin_run_mode_change_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to change run mode' });
  }
});

// ============================================================================
// CONVERSATIONAL PLUGIN GENERATION
// ============================================================================
// POST /api/plugins/from-prompt — takes a natural-language description, asks
// Claude to emit a structured plugin spec matching the same shape the curated
// templates in services/pluginLibrary.js use, validates it through the
// pluginSpecValidator (allowlisted SDK methods + recognized trigger events +
// dangerous-pattern scan), and inserts the row as a draft. Returns the saved
// plugin so the frontend can navigate straight to /plugins/:id.
//
// The plugin is ALWAYS saved as status='draft' — nothing fires until the
// operator flips it to active. The sandbox runner stays untouched.
//
// NOTE: the generation engine (system prompt + parse/retry + Claude call)
// lives in services/pluginGenerator.js — it is SHARED with the chat copilot's
// confirm-first `propose_build_plugin` tool. Change it there, not here.
const { generatePluginSpec } = pluginGenerator;

/**
 * POST /api/plugins/from-prompt
 *
 * Conversational plugin authoring. Body: { description: string (10..2000),
 * name?: string }. Asks Claude to produce a strict JSON plugin spec, validates
 * the spec against the SDK + trigger-event allowlists, and inserts it as a
 * draft. Returns 201 with { ok: true, plugin: { id, name, public_id, status,
 * source_kind, description } }.
 *
 * Error shapes:
 *   400  validation failure (zod or missing org_id)
 *   422  spec rejected by the validator — reason array in `errors`
 *   429  AI quota exceeded for the org (also the global aiLimiter / express-rate-limit)
 *   502  AI returned unparseable JSON after one retry
 *   503  AI not configured on this server (mirror the existing /api/ai shape)
 *   409  (org_id, name) UNIQUE collision — the operator can retry with a
 *        custom `name` in the body to override
 */
router.post('/from-prompt', validateBody(pluginSchemas.fromPromptSchema), async (req, res) => {
  try {
    if (!req.orgId) {
      return res.status(400).json({ success: false, error: 'Org context required' });
    }
    const description = req.body.description;
    const nameOverride = req.body.name || null;

    const genResult = await generatePluginSpec({
      description,
      orgId: req.orgId,
      userId: req.userId,
    });

    if (!genResult.ok) {
      if (genResult.configured === false) {
        return res.status(503).json({
          success: false,
          error: 'AI is not configured on this server',
          code: 'AI_NOT_CONFIGURED',
        });
      }
      if (genResult.code === 'QUOTA_EXCEEDED') {
        return res.status(429).json({
          success: false,
          error: genResult.error || 'AI quota exceeded',
          code: 'QUOTA_EXCEEDED',
        });
      }
      if (genResult.parseFailed) {
        if (req.log) req.log.warn('plugin_from_prompt_parse_failed', {
          error: genResult.error,
          rawPreview: genResult.rawText ? genResult.rawText.slice(0, 300) : null,
        });
        return res.status(502).json({
          success: false,
          error: 'AI returned unparseable JSON. Try rephrasing your description.',
          code: 'AI_PARSE_FAILED',
        });
      }
      return res.status(502).json({
        success: false,
        error: genResult.error || 'AI generation failed',
      });
    }

    // Apply the optional name override BEFORE validation so the same shape
    // gets persisted as the validator sees.
    const spec = genResult.spec;
    if (nameOverride) spec.name = nameOverride;
    // Force the source_kind — the route's contract is "conversational"
    // regardless of what the model returned.
    spec.source_kind = 'conversational';

    const validation = validateSpec(spec);
    if (!validation.ok) {
      if (req.log) req.log.warn('plugin_from_prompt_spec_rejected', {
        errors: validation.errors,
        specName: spec.name,
      });
      return res.status(422).json({
        success: false,
        error: 'Generated spec failed validation',
        code: 'SPEC_REJECTED',
        errors: validation.errors,
      });
    }

    // Save-time secret scan on the model-emitted source_code — defense in
    // depth against a creative prompt that asks Claude to "include my API
    // key". A non-empty warnings array is returned alongside the plugin so
    // the UI can surface a banner.
    const warnings = scanForSecretWarnings(spec.source_code);

    // INSERT — same columns as the raw POST handler, status forced to 'draft'.
    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO plugins (org_id, name, description, spec_json, source_code, source_kind,
                              trigger_event, trigger_filter_json, status, created_by, updated_by)
         VALUES ($1, $2, $3, COALESCE($4, '{}')::jsonb, $5, 'conversational',
                 $6, $7::jsonb, 'draft', $8, $8)
         RETURNING id, name, public_id, status, source_kind, description`,
        [
          req.orgId,
          spec.name,
          spec.description || null,
          spec.spec_json ? JSON.stringify(spec.spec_json) : null,
          spec.source_code || null,
          spec.trigger_event,
          spec.spec_json && spec.spec_json.triggerFilter
            ? JSON.stringify(spec.spec_json.triggerFilter)
            : null,
          req.userId,
        ]
      );
    } catch (err) {
      // 23505 = PostgreSQL unique_violation. The plugins table has UNIQUE
      // (org_id, name); a collision is fixable client-side by supplying
      // `name` in the request body, so we surface a 409 with that hint
      // rather than a generic 500.
      if (err && err.code === '23505') {
        return res.status(409).json({
          success: false,
          error: `A plugin named "${spec.name}" already exists. Pass a unique "name" in the request body to override.`,
          code: 'NAME_CONFLICT',
          generatedName: spec.name,
        });
      }
      throw err;
    }

    const body = {
      success: true,
      ok: true,
      plugin: inserted.rows[0],
    };
    if (warnings.length > 0) body.warnings = warnings;
    return res.status(201).json(body);
  } catch (err) {
    if (req.log) req.log.error('plugin_from_prompt_failed', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Generation failed',
      detail: err.message,
    });
  }
});

// Map UI-friendly status filter keywords to the raw status values stored in
// plugin_runs. Keeps the API contract loose enough that the runs UI can switch
// pill labels ("Worked" / "Didn't finish" / "Hit a limit") without forcing a
// schema-level rename of the status column.
//
// `all` and unknown values fall through with no filter applied. Each bucket
// matches the same buckets services/pluginRunFormatter#friendlyStatus exposes.
const RUNS_STATUS_BUCKETS = {
  success:         ['success', 'ok'],
  failed:          ['failed', 'error'],
  budget_exceeded: ['budget_exceeded', 'query_budget_exceeded', 'task_budget_exceeded', 'memory_exceeded'],
  timed_out:       ['timed_out', 'timeout'],
  running:         ['running'],
};

const RUNS_SINCE_WINDOWS = { '24h': 24, '7d': 168, '30d': 720 };

router.get('/:id/runs', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const plugin = await pool.query(
      `SELECT id, name FROM plugins WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    if (plugin.rows.length === 0) return res.status(404).json({ success: false, error: 'Plugin not found' });

    // `limit` is user-supplied but bounded — between 1 and 100 for the new
    // runs UI, defaulting to 25 per page. The hard ceiling prevents a
    // pathological client from streaming the org's entire run history.
    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    if (limit > 100) limit = 100;

    // Status pill filter. `status=all` (or unknown) means "no status filter".
    const statusKey = typeof req.query.status === 'string' ? req.query.status : 'all';
    const statusValues = RUNS_STATUS_BUCKETS[statusKey] || null;

    // Time window. Default to the most recent 24 hours so the empty-state for
    // a brand-new plugin is the customer's actual recent history, not an
    // unbounded scan.
    const sinceKey = typeof req.query.since === 'string' ? req.query.since : '24h';
    const sinceHours = RUNS_SINCE_WINDOWS[sinceKey] || RUNS_SINCE_WINDOWS['24h'];

    const conds = [`plugin_id = $1`, `started_at > NOW() - ($2 || ' hours')::interval`];
    const params = [req.params.id, String(sinceHours)];
    if (statusValues && statusValues.length > 0) {
      // Build a $3, $4, $5 IN (...) list against the param array length so
      // each new param picks up the next placeholder index cleanly.
      const placeholders = statusValues.map((_, i) => `$${params.length + 1 + i}`).join(', ');
      conds.push(`status IN (${placeholders})`);
      params.push(...statusValues);
    }

    const r = await pool.query(
      `SELECT id, plugin_id, org_id, started_at, ended_at, status, trigger_kind,
              trigger_source, triggered_by, trigger_data, input_payload, output_payload,
              log_lines, result_summary, error_message, cpu_ms,
              db_queries, egress_bytes, proposed_actions, applied_at, applied_result,
              run_mode
         FROM plugin_runs
        WHERE ${conds.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    // Decorate each row with friendly_status so the runs UI, the chat tool,
    // and any future analytics dashboard read the same labels. Computed
    // server-side so the source of truth stays in one module
    // (services/pluginRunFormatter.js).
    const rows = r.rows.map(row => ({
      ...row,
      friendly_status: friendlyStatus(row.status),
    }));
    res.json({
      success: true,
      data: rows,
      // Echo back the filter state so a client that builds the URL from the
      // response can keep itself in sync without re-parsing query strings.
      filter: { status: statusKey, since: sinceKey, limit },
      plugin: { id: plugin.rows[0].id, name: plugin.rows[0].name },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list runs' });
  }
});

// ============================================================================
// CURATED PLUGIN LIBRARY — clone-from-template
// ============================================================================
// GET  /api/plugins/library                      — list the curated templates
//                                                  (registered earlier, before
//                                                  GET /:id — see the comment
//                                                  above that handler).
// POST /api/plugins/from-template                — clone one into this org as
//                                                  a draft (NEW non-technical UX)
// POST /api/plugins/library/:slug/install        — legacy clone endpoint kept
//                                                  for the existing PluginLibrary
//                                                  page; identical semantics.
//
// All three are gated by plugins_enabled (mounted at router scope). Cloning
// validates the curated spec through the same pluginSpecValidator the
// /from-prompt route uses — so a future regression in a curated template
// surfaces here rather than at run time.

// Shared internals for the two clone endpoints live in
// services/extensionInstall.js — the SAME module the chat copilot's
// propose_install_extension apply branch calls, so "Enable from the library
// page" and "Enable from chat" can never diverge. This wrapper owns the
// req-bound audit trail.
async function cloneTemplateForOrg({ slug, req, activate = false, runMode = undefined }) {
  const result = await extensionInstall.installLibraryTemplate({
    orgId: req.orgId,
    userId: req.userId,
    slug,
    activate,
    runMode,
    log: req.log,
  });
  if (result.body && result.body.success && result.body.plugin) {
    const row = result.body.plugin;
    audit.fromReq(req, {
      event: audit.EVENTS.PLUGIN_CLONED_FROM_TEMPLATE,
      targetType: 'plugin',
      targetId: row.id,
      success: true,
      meta: {
        template_slug: slug,
        plugin_id: row.id,
        name: row.name,
        activated: !!result.body.activated,
        ...(runMode ? { run_mode: runMode } : {}),
        ...(result.body.activated_existing ? { activated_existing: true } : {}),
        ...(result.body.already_active ? { already_active: true } : {}),
      },
    });
    // Setting run_mode='autonomous' at install time is a run-mode change like
    // any other — give it the same dedicated audit row the PATCH emits.
    if (runMode === 'autonomous') {
      audit.fromReq(req, {
        event: audit.EVENTS.PLUGIN_RUN_MODE_CHANGED,
        targetType: 'plugin',
        targetId: row.id,
        success: true,
        meta: { old: 'preview', new: 'autonomous', via: 'install' },
      });
    }
  }
  return result;
}

// Requested run mode on an Enable call ({ run_mode: 'autonomous' }). Setting
// autonomous requires the same owner/admin bar as PATCH /:id/run-mode —
// requestedRunMode() returns { error } for a non-admin asking for autonomous,
// and undefined (leave default) when nothing was requested.
function requestedRunMode(req) {
  const raw = req.body && req.body.run_mode;
  if (raw === undefined || raw === null || raw === '' ) return { runMode: undefined };
  if (!['preview', 'autonomous'].includes(raw)) {
    return { error: { http: 400, body: { success: false, error: "run_mode must be 'preview' or 'autonomous'", code: 'INVALID_RUN_MODE' } } };
  }
  if (raw === 'autonomous' && !['owner', 'admin'].includes(req.orgRole)) {
    return { error: { http: 403, body: { success: false, error: 'Only an organization owner or admin can enable autonomous mode', code: 'FORBIDDEN' } } };
  }
  return { runMode: raw };
}

// `activate` (body { activate: true } or ?activate=1): atomic install+activate
// — the "Enable" one-click. Idempotent per template: an existing clone is
// activated in place rather than duplicated.
function wantsActivate(req) {
  const q = req.query?.activate;
  return req.body?.activate === true || q === '1' || q === 'true';
}

router.post('/from-template', async (req, res) => {
  try {
    // Accept either `template_id` (the contract the new UX uses) or `slug` /
    // `template_slug` for callers that already speak the library's natural id.
    // Both map to the same library-entry slug field on the server.
    const slug = String(req.body?.template_id || req.body?.template_slug || req.body?.slug || '').trim();
    if (!slug) {
      return res.status(400).json({ success: false, error: 'template_id is required' });
    }
    const rm = requestedRunMode(req);
    if (rm.error) return res.status(rm.error.http).json(rm.error.body);
    const result = await cloneTemplateForOrg({ slug, req, activate: wantsActivate(req), runMode: rm.runMode });
    return res.status(result.http).json(result.body);
  } catch (err) {
    if (req.log) req.log.error('plugin_from_template_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Clone failed', detail: err.message });
  }
});

// Legacy clone endpoint: same semantics as /from-template but addressed by
// path param. The current PluginLibrary page calls this; keeping it lets the
// frontend roll out the new UX incrementally without breaking existing pages.
router.post('/library/:slug/install', async (req, res) => {
  try {
    const rm = requestedRunMode(req);
    if (rm.error) return res.status(rm.error.http).json(rm.error.body);
    const result = await cloneTemplateForOrg({ slug: req.params.slug, req, activate: wantsActivate(req), runMode: rm.runMode });
    return res.status(result.http).json(result.body);
  } catch (err) {
    if (req.log) req.log.error('plugin_library_install_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Install failed', detail: err.message });
  }
});

module.exports = router;

// Test-only exports. Underscored to signal "not for runtime use" — the
// secret-pattern scanner is a pure function with no Express dependency, so
// the test suite imports it directly rather than going through supertest +
// a fully-mocked DB. Keeping the export here (rather than extracting to a
// helper module) avoids churn in the require graph for callers.
module.exports._scanForSecretWarnings = scanForSecretWarnings;
module.exports._SECRET_PATTERNS = SECRET_PATTERNS;
// Re-exported from services/pluginGenerator (the shared generation engine) so
// existing tests keep importing them from the route module.
module.exports._parseSpecReply = pluginGenerator.parseSpecReply;
module.exports._FROM_PROMPT_SYSTEM = pluginGenerator.FROM_PROMPT_SYSTEM;
