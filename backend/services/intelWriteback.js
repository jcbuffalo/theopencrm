// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — write-back-to-CRM suggestions service.
//
// Lifecycle:
//   1. proposeUpdates({ orgId, dealId, summaryId, userId })
//      Loads the deal_intel_summaries row + current deal field values,
//      asks Claude for per-field update suggestions against a TIGHT
//      allowlist, drops anything off-allowlist silently, and persists one
//      `deal_intel_suggestions` row per suggestion (status='pending').
//      Returns the inserted suggestion rows.
//
//   2. applySuggestion({ orgId, dealId, suggestionId, userId })
//      Transactional: SELECT … FOR UPDATE on suggestion + deal; if the
//      deal's current value no longer matches suggestion.current_value,
//      mark status='stale' and throw STALE_DATA. Otherwise write the
//      field, INSERT a deal_intel_writebacks row, flip suggestion.status
//      to 'applied'. Bumps deals.last_activity_at automatically.
//
//   3. rejectSuggestion({ orgId, dealId, suggestionId, userId })
//      Flip status='rejected' (no DB write to the deal).
//
//   4. undoWriteback({ orgId, dealId, wbId, userId })
//      Transactional: SELECT … FOR UPDATE; refuses if past UNDO_WINDOW
//      (7 days). Restores prior_value onto the deal, marks
//      writeback.undone_at / undone_by_user_id. Suggestion remains
//      'applied' — the writeback row is the canonical undo record.
//
// ALLOWLIST (server-authoritative):
//   - 'stage'                — must be in VALID_STAGES; transitions
//                              validated via stageTransitions.check for
//                              the org's profile.
//   - 'notes'                — APPEND-ONLY. The proposed text is
//                              prefixed with a separator block so the
//                              audit trail is visible inline in the deal.
//   - 'expected_close_date'  — ISO-date within today-30d .. today+5y.
//
// REJECTED at validation (regex-blocklist + explicit deny):
//   - amount, owner_user_id, user_id, org_id, customer_id
//   - custom_fields.*
//   - any column starting with `ai_`
//   - any column not on the explicit allow set above
//
// AI ENDPOINT TAG: 'deal-intel-writeback-suggest' — so usage shows up
// distinctly in ai_usage_events.

const pool   = require('../db');
const logger = require('./logger');
const ai     = require('./ai');
const stageTransitions = require('./stageTransitions');
const { VALID_STAGES } = require('../utils/dealStages');

const PROMPT_VERSION = 'writeback-v1';
const UNDO_WINDOW_DAYS = 7;
const UNDO_WINDOW_MS   = UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Allowlist of fields the writeback service may ever touch.
const ALLOWED_FIELDS = new Set(['stage', 'notes', 'expected_close_date']);

// Belt-and-braces blocklist — every field name that matches any of these
// gets dropped even if it sneaks past ALLOWED_FIELDS for any reason.
const BLOCKED_FIELD_REGEXES = [
  /^ai_/i,
  /^amount$/i,
  /^owner_user_id$/i,
  /^user_id$/i,
  /^org_id$/i,
  /^customer_id$/i,
  /^custom_fields($|\.)/i,
];

const SYSTEM_PROMPT = [
  'You suggest concrete CRM-field updates for a B2B sales opportunity ("deal"),',
  'based on a freshly generated "state of the deal" narrative + key facts.',
  '',
  'You may ONLY propose updates to these three fields:',
  '  - "stage"                — one of the valid stage identifiers listed below',
  '  - "notes"                — an APPEND-ONLY text addition (do NOT replace existing)',
  '  - "expected_close_date"  — an ISO date (YYYY-MM-DD), reasonable horizon',
  '',
  'You MUST output a single JSON object — no markdown, no prose preamble, no code',
  'fence. Shape:',
  '{',
  '  "suggestions": [',
  '    { "field": "stage", "proposed_value": "NEGOTIATION", "confidence": 0.82,',
  '      "reason": "Customer signed the proposal on 5/27 per email-thread.docx." },',
  '    { "field": "expected_close_date", "proposed_value": "2026-07-15",',
  '      "confidence": 0.60, "reason": "Customer mentioned a July close window." }',
  '  ]',
  '}',
  '',
  'Rules:',
  '  - confidence is a float in [0,1]. Round to 2 decimals.',
  '  - Suggest 0-3 fields. If the documents do not support a confident change, return',
  '    { "suggestions": [] }. NEVER fabricate.',
  '  - For "stage", only propose if the docs clearly justify a new stage; do NOT',
  '    propose for cosmetic / minor signals.',
  '  - For "notes", proposed_value is JUST the new content (no separator headers —',
  '    the server prepends those). Aim for 1-3 short sentences of concrete fact.',
  '  - For "expected_close_date", propose ONLY if a date is stated or strongly implied.',
].join('\n');

/**
 * Reject a field name against the allowlist + blocklist. Pure function.
 * Returns true when the field passes (allowed), false when blocked.
 */
function isFieldAllowed(field) {
  if (typeof field !== 'string' || !field) return false;
  if (!ALLOWED_FIELDS.has(field)) return false;
  for (const re of BLOCKED_FIELD_REGEXES) {
    if (re.test(field)) return false;
  }
  return true;
}

/**
 * Validate a per-field proposed value. Returns { ok, value, error }.
 *
 * `ctx` carries the org profile + current stage so we can validate
 * stage transitions, plus today's date for the close-date window.
 */
function validateProposed(field, rawValue, ctx) {
  if (!isFieldAllowed(field)) {
    return { ok: false, error: `field_not_allowed:${field}` };
  }

  if (field === 'stage') {
    if (typeof rawValue !== 'string' || !rawValue) {
      return { ok: false, error: 'stage_must_be_string' };
    }
    if (!VALID_STAGES.includes(rawValue)) {
      return { ok: false, error: `stage_not_in_valid_set:${rawValue}` };
    }
    const guard = stageTransitions.check(ctx.profile || 'generic', ctx.currentStage, rawValue);
    if (!guard.allowed) {
      return {
        ok: false,
        error: `stage_transition_invalid:${guard.reason || 'unknown'}`,
      };
    }
    return { ok: true, value: rawValue };
  }

  if (field === 'notes') {
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return { ok: false, error: 'notes_must_be_nonempty_string' };
    }
    // Cap to a reasonable size to defend against runaway model output.
    const clipped = rawValue.length > 4000 ? rawValue.slice(0, 4000) : rawValue;
    return { ok: true, value: clipped };
  }

  if (field === 'expected_close_date') {
    if (typeof rawValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
      return { ok: false, error: 'expected_close_date_must_be_iso_date' };
    }
    const parsed = new Date(`${rawValue}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'expected_close_date_not_parseable' };
    }
    const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
    const minMs = now - 30 * 24 * 60 * 60 * 1000;
    const maxMs = now + 5 * 365 * 24 * 60 * 60 * 1000;
    if (parsed.getTime() < minMs || parsed.getTime() > maxMs) {
      return { ok: false, error: 'expected_close_date_out_of_window' };
    }
    return { ok: true, value: rawValue };
  }

  return { ok: false, error: `unhandled_field:${field}` };
}

/**
 * Parse Claude's reply. Permissive about fenced code blocks and prose
 * around the JSON object — same as services/intelSummary.parseModelReply.
 */
function parseModelReply(text) {
  if (!text) return { ok: false, error: 'empty reply' };
  let raw = String(text).trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return { ok: false, error: 'no JSON object found' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return { ok: false, error: 'suggestions array missing' };
  }
  return { ok: true, parsed };
}

// Build the per-summary user prompt. Deterministic given the same input.
function buildPrompt({ summary, deal, summaryIndex }) {
  const keyFacts = Array.isArray(summary.key_facts_json)
    ? summary.key_facts_json
    : (typeof summary.key_facts_json === 'string'
        ? safeJSON(summary.key_facts_json, [])
        : []);
  const factsBlock = keyFacts.length
    ? keyFacts.map(kf => `  - ${kf.label || ''}: ${kf.value || ''}${kf.source_file_id ? `  (src=${kf.source_file_id})` : ''}`).join('\n')
    : '  (no extracted key facts)';

  const validNext = stageTransitions.PROFILES?.[deal.profile || 'generic']?.[deal.stage] || [];

  return [
    `Deal: ${deal.title || `#${deal.id}`} (stage=${deal.stage || 'unknown'})`,
    `Current notes (existing — DO NOT propose replacing):`,
    deal.notes ? deal.notes.slice(0, 1500) : '(none)',
    '',
    `Current expected_close_date: ${deal.expected_close_date || '(unset)'}`,
    '',
    `Valid stages for this org's profile: ${VALID_STAGES.join(', ')}`,
    `Valid NEXT stages from current "${deal.stage}": ${validNext.length ? validNext.join(', ') : '(unrestricted — propose any VALID_STAGES value if justified)'}`,
    '',
    `Intel summary #${summaryIndex} (snapshot below):`,
    summary.summary_md || '(no narrative)',
    '',
    `Key facts:`,
    factsBlock,
    '',
    `Produce the JSON object now. Output nothing other than JSON.`,
  ].join('\n');
}

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Generate per-field CRM update suggestions for the deal off the latest
 * (or specified) summary. Persists one row per proposed-and-validated
 * suggestion. Returns the inserted rows.
 */
async function proposeUpdates({ orgId, dealId, summaryId, userId = null }) {
  if (!orgId || !dealId || !summaryId) {
    throw new Error('proposeUpdates requires { orgId, dealId, summaryId }');
  }
  if (!ai.isConfigured()) {
    const err = new Error('AI not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  // Load summary + deal + org profile in one round-trip each.
  const sumRes = await pool.query(
    `SELECT * FROM deal_intel_summaries WHERE id = $1 AND org_id = $2 AND deal_id = $3`,
    [summaryId, orgId, dealId]
  );
  if (sumRes.rows.length === 0) {
    const err = new Error('Intel summary not found for this deal');
    err.code = 'NO_SUMMARY';
    err.statusCode = 400;
    throw err;
  }
  const summary = sumRes.rows[0];

  const dealRes = await pool.query(
    `SELECT d.id, d.title, d.stage, d.notes, d.expected_close_date,
            COALESCE(o.profile, 'generic') AS profile
       FROM deals d LEFT JOIN organizations o ON d.org_id = o.id
      WHERE d.id = $1 AND d.org_id = $2`,
    [dealId, orgId]
  );
  if (dealRes.rows.length === 0) {
    const err = new Error('Deal not found');
    err.code = 'NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }
  const deal = dealRes.rows[0];

  // Compute the summary index — count of prior summaries +1 — for the prompt.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deal_intel_summaries
      WHERE deal_id = $1 AND org_id = $2 AND id <= $3`,
    [dealId, orgId, summaryId]
  );
  const summaryIndex = countRes.rows[0]?.n || 1;

  const prompt = buildPrompt({ summary, deal, summaryIndex });

  const result = await ai.callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1000,
    orgId,
    userId,
    endpoint: 'deal-intel-writeback-suggest',
  });

  if (result.code === 'QUOTA_EXCEEDED') {
    const err = new Error(result.error || 'AI quota exceeded for this org');
    err.code = 'QUOTA_EXCEEDED';
    err.statusCode = 402;
    err.details = result.details;
    throw err;
  }
  if (result.configured === false) {
    const err = new Error(result.message || 'AI not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  if (!result.ok) {
    const err = new Error(result.error || 'AI call failed');
    err.code = 'AI_CALL_FAILED';
    err.statusCode = 502;
    throw err;
  }

  const parsed = parseModelReply(result.text);
  if (!parsed.ok) {
    logger.warn('drive_intel_writeback_parse_failed', {
      orgId, dealId, summaryId, error: parsed.error,
    });
    const err = new Error(`Could not parse model reply: ${parsed.error}`);
    err.code = 'BAD_MODEL_REPLY';
    err.statusCode = 502;
    throw err;
  }

  const insertedRows = [];
  const ctx = {
    profile: deal.profile,
    currentStage: deal.stage,
    now: Date.now(),
  };

  for (const sug of parsed.parsed.suggestions) {
    const field = sug?.field;
    if (!isFieldAllowed(field)) {
      logger.info('writeback_field_rejected', {
        orgId, dealId, summaryId, field, reason: 'not_in_allowlist',
      });
      continue;
    }
    const v = validateProposed(field, sug.proposed_value, ctx);
    if (!v.ok) {
      logger.info('writeback_field_rejected', {
        orgId, dealId, summaryId, field, reason: v.error,
      });
      continue;
    }
    const currentValue = currentValueForField(field, deal);
    const confidence = clampConfidence(sug.confidence);
    const reason = typeof sug.reason === 'string' ? sug.reason.slice(0, 1000) : null;

    const ins = await pool.query(
      `INSERT INTO deal_intel_suggestions
         (org_id, deal_id, summary_id, field, current_value, proposed_value,
          confidence, reason, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'pending')
       RETURNING *`,
      [
        orgId, dealId, summaryId, field,
        JSON.stringify(currentValue),
        JSON.stringify(v.value),
        confidence, reason,
      ]
    );
    insertedRows.push(ins.rows[0]);
  }

  logger.info('drive_intel_writeback_proposed', {
    orgId, dealId, summaryId,
    suggestion_count: insertedRows.length,
    fields: insertedRows.map(r => r.field),
  });

  return insertedRows;
}

function currentValueForField(field, deal) {
  if (field === 'stage')                return deal.stage || null;
  if (field === 'notes')                return deal.notes || null;
  if (field === 'expected_close_date')  return formatDateValue(deal.expected_close_date);
  return null;
}

function formatDateValue(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date)     return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function clampConfidence(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Number(n.toFixed(3));
}

/**
 * Apply a pending suggestion to the deal. Transactional + stale-data
 * checked. Returns { writeback, deal } on success.
 */
async function applySuggestion({ orgId, dealId, suggestionId, userId = null }) {
  if (!orgId || !dealId || !suggestionId) {
    throw new Error('applySuggestion requires { orgId, dealId, suggestionId }');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sugRes = await client.query(
      `SELECT * FROM deal_intel_suggestions
        WHERE id = $1 AND org_id = $2 AND deal_id = $3
        FOR UPDATE`,
      [suggestionId, orgId, dealId]
    );
    if (sugRes.rows.length === 0) {
      const err = new Error('Suggestion not found');
      err.code = 'NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    const sug = sugRes.rows[0];
    if (sug.status !== 'pending' && sug.status !== 'accepted') {
      const err = new Error(`Suggestion is ${sug.status}; cannot apply`);
      err.code = 'BAD_STATE';
      err.statusCode = 409;
      throw err;
    }
    if (!isFieldAllowed(sug.field)) {
      // Defensive — should be impossible thanks to the DB CHECK + the
      // proposeUpdates filter, but keep the bouncer at the door.
      const err = new Error(`field_not_allowed:${sug.field}`);
      err.code = 'BAD_FIELD';
      err.statusCode = 400;
      throw err;
    }

    const dealRes = await client.query(
      `SELECT d.id, d.stage, d.notes, d.expected_close_date,
              COALESCE(o.profile, 'generic') AS profile
         FROM deals d LEFT JOIN organizations o ON d.org_id = o.id
        WHERE d.id = $1 AND d.org_id = $2
        FOR UPDATE`,
      [dealId, orgId]
    );
    if (dealRes.rows.length === 0) {
      const err = new Error('Deal not found');
      err.code = 'NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    const deal = dealRes.rows[0];

    const live = currentValueForField(sug.field, deal);
    const snapshot = sug.current_value === undefined || sug.current_value === null
      ? null
      : (typeof sug.current_value === 'string' ? safeJSON(sug.current_value, sug.current_value) : sug.current_value);
    if (!valueEquals(live, snapshot)) {
      await client.query(
        `UPDATE deal_intel_suggestions
            SET status = 'stale', decided_at = NOW(), decided_by_user_id = $1
          WHERE id = $2`,
        [userId, suggestionId]
      );
      await client.query('COMMIT');
      const err = new Error('Deal field changed since suggestion was generated');
      err.code = 'STALE_DATA';
      err.statusCode = 409;
      throw err;
    }

    // Re-validate the proposed value (e.g. stage transition may have
    // become illegal if the deal moved between propose and apply).
    const proposed = typeof sug.proposed_value === 'string'
      ? safeJSON(sug.proposed_value, sug.proposed_value)
      : sug.proposed_value;
    const v = validateProposed(sug.field, proposed, {
      profile: deal.profile, currentStage: deal.stage, now: Date.now(),
    });
    if (!v.ok) {
      const err = new Error(`Proposed value no longer valid: ${v.error}`);
      err.code = 'INVALID_AT_APPLY';
      err.statusCode = 400;
      throw err;
    }

    const priorValue = currentValueForField(sug.field, deal);
    let newValue;

    if (sug.field === 'stage') {
      newValue = v.value;
      await client.query(
        `UPDATE deals SET stage = $1,
                last_activity_at = NOW(),
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [newValue, dealId, orgId]
      );
    } else if (sug.field === 'notes') {
      const ts = new Date().toISOString();
      const headerN = await summaryIndexForSuggestion(client, sug);
      const appendBlock = `\n\n--- AI suggestion (summary #${headerN}, ${ts}) ---\n${v.value}`;
      newValue = (deal.notes || '') + appendBlock;
      await client.query(
        `UPDATE deals SET notes = $1,
                last_activity_at = NOW(),
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [newValue, dealId, orgId]
      );
    } else if (sug.field === 'expected_close_date') {
      newValue = v.value;
      await client.query(
        `UPDATE deals SET expected_close_date = $1::date,
                last_activity_at = NOW(),
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [newValue, dealId, orgId]
      );
    } else {
      const err = new Error(`field_not_allowed:${sug.field}`);
      err.code = 'BAD_FIELD';
      err.statusCode = 400;
      throw err;
    }

    const wbIns = await client.query(
      `INSERT INTO deal_intel_writebacks
         (org_id, deal_id, suggestion_id, field, prior_value, new_value, applied_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        orgId, dealId, suggestionId, sug.field,
        JSON.stringify(priorValue),
        JSON.stringify(newValue),
        userId,
      ]
    );

    await client.query(
      `UPDATE deal_intel_suggestions
          SET status = 'applied', decided_at = NOW(), decided_by_user_id = $1
        WHERE id = $2`,
      [userId, suggestionId]
    );

    await client.query('COMMIT');
    return { writeback: wbIns.rows[0], suggestion: sug, priorValue, newValue };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Approximate "summary #N" for notes-prefix labelling — counts how many
// summaries exist for this deal up to and including the suggestion's
// summary_id. Pure ordinal; matches what the UI shows in IntelSummaryPanel.
async function summaryIndexForSuggestion(client, sug) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM deal_intel_summaries
      WHERE deal_id = $1 AND org_id = $2 AND id <= $3`,
    [sug.deal_id, sug.org_id, sug.summary_id]
  );
  return r.rows[0]?.n || 1;
}

/**
 * Reject a pending suggestion. No deal mutation.
 */
async function rejectSuggestion({ orgId, dealId, suggestionId, userId = null }) {
  if (!orgId || !dealId || !suggestionId) {
    throw new Error('rejectSuggestion requires { orgId, dealId, suggestionId }');
  }
  const res = await pool.query(
    `UPDATE deal_intel_suggestions
        SET status = 'rejected', decided_at = NOW(), decided_by_user_id = $1
      WHERE id = $2 AND org_id = $3 AND deal_id = $4
        AND status IN ('pending', 'accepted')
      RETURNING *`,
    [userId, suggestionId, orgId, dealId]
  );
  if (res.rows.length === 0) {
    const err = new Error('Suggestion not found or already decided');
    err.code = 'NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }
  return res.rows[0];
}

/**
 * Undo an applied writeback within UNDO_WINDOW_DAYS. Transactional.
 */
async function undoWriteback({ orgId, dealId, wbId, userId = null }) {
  if (!orgId || !dealId || !wbId) {
    throw new Error('undoWriteback requires { orgId, dealId, wbId }');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wbRes = await client.query(
      `SELECT * FROM deal_intel_writebacks
        WHERE id = $1 AND org_id = $2 AND deal_id = $3
        FOR UPDATE`,
      [wbId, orgId, dealId]
    );
    if (wbRes.rows.length === 0) {
      const err = new Error('Writeback not found');
      err.code = 'NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    const wb = wbRes.rows[0];
    if (wb.undone_at) {
      const err = new Error('Writeback already undone');
      err.code = 'ALREADY_UNDONE';
      err.statusCode = 409;
      throw err;
    }
    const ageMs = Date.now() - new Date(wb.applied_at).getTime();
    if (ageMs > UNDO_WINDOW_MS) {
      const err = new Error(`Undo window of ${UNDO_WINDOW_DAYS} days has passed`);
      err.code = 'UNDO_WINDOW_EXPIRED';
      err.statusCode = 409;
      throw err;
    }
    if (!isFieldAllowed(wb.field)) {
      const err = new Error(`field_not_allowed:${wb.field}`);
      err.code = 'BAD_FIELD';
      err.statusCode = 400;
      throw err;
    }

    const restored = wb.prior_value === undefined || wb.prior_value === null
      ? null
      : (typeof wb.prior_value === 'string' ? safeJSON(wb.prior_value, wb.prior_value) : wb.prior_value);

    if (wb.field === 'stage') {
      await client.query(
        `UPDATE deals SET stage = $1, last_activity_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [restored, dealId, orgId]
      );
    } else if (wb.field === 'notes') {
      await client.query(
        `UPDATE deals SET notes = $1, last_activity_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [restored, dealId, orgId]
      );
    } else if (wb.field === 'expected_close_date') {
      await client.query(
        `UPDATE deals SET expected_close_date = $1::date,
                last_activity_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [restored, dealId, orgId]
      );
    }

    const wbUpd = await client.query(
      `UPDATE deal_intel_writebacks
          SET undone_at = NOW(), undone_by_user_id = $1
        WHERE id = $2
        RETURNING *`,
      [userId, wbId]
    );

    await client.query('COMMIT');
    return { writeback: wbUpd.rows[0], restoredValue: restored };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Pure equality for current_value vs live deal value. JSON-shaped scalars.
function valueEquals(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const sa = typeof a === 'string' ? a : JSON.stringify(a);
  const sb = typeof b === 'string' ? b : JSON.stringify(b);
  return sa === sb;
}

module.exports = {
  proposeUpdates,
  applySuggestion,
  rejectSuggestion,
  undoWriteback,
  // Exposed for tests:
  isFieldAllowed,
  validateProposed,
  parseModelReply,
  buildPrompt,
  ALLOWED_FIELDS,
  BLOCKED_FIELD_REGEXES,
  UNDO_WINDOW_DAYS,
  UNDO_WINDOW_MS,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
};
