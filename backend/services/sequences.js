// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email-sequence engine (migrations 132/133).
//
// CRUD for sequences + steps, enrollment management, and the send tick
// (processDueEnrollments) the leased sequenceWorker calls. Route handlers in
// routes/sequenceRoutes.js are thin wrappers around this module.
//
// Tenancy: every function that touches tenant data takes a `scope` object
// ({ orgId, userId }) and derives the same [scopeField, scopeValue] pair the
// qs(req) route convention produces — org_id when the caller belongs to an
// org, user_id fallback otherwise. The worker path (processDueEnrollments)
// runs across ALL tenants but every per-row query is keyed by the
// enrollment's own org_id/user_id, so rows can't cross tenants.
//
// GUARDRAILS (this module sends real email):
//   1. Suppression first. Before ANY transport call we check
//      email_unsubscribes for a confirmed opt-out of the recipient address
//      (same org-scoped gate POST /api/emails/send uses). A suppressed
//      contact's enrollment flips to 'unsubscribed' and is never emailed.
//   2. No double-send. The step advance (current_step + last_sent_at +
//      next_send_at) is claimed ATOMICALLY before the transport call:
//      UPDATE ... WHERE status = 'active' AND current_step = <expected>
//      RETURNING. A second tick racing on the same enrollment loses the
//      claim and skips. Claim-before-send means a transport failure can at
//      worst SKIP a step (logged), never repeat one.
//   3. Bounded blast radius. The due-scan is capped per tick (worker default
//      in sequenceWorker.js); leftovers catch the next tick.
//   4. Graceful degradation. When services/email.js is unconfigured the tick
//      logs and leaves every enrollment due (no claim, no console-send) so
//      real delivery starts only once a transport exists.
//
// Every dispatch is recorded in email_sends (like the rest of the app) with
// an unsubscribe-token row + footer link and the open-tracking pixel, so
// sequence mail is indistinguishable from one-off CRM mail in the timeline
// and the recipient always has a working opt-out.

const crypto = require('crypto');
const pool = require('../db');
const email = require('./email');
const logger = require('./logger');
const notificationDispatcher = require('./notificationDispatcher');

// Mirrors qs(req) in the route files.
function scopeOf({ orgId, userId }) {
  return orgId ? ['org_id', orgId] : ['user_id', userId];
}

const ENROLLMENT_STATUSES = ['active', 'completed', 'stopped', 'unsubscribed'];

// ---------------------------------------------------------------------------
// Rendering helpers — kept consistent with routes/emailRoutes.js so a
// sequence step renders exactly like a one-off send. (emailRoutes exports
// only its router, so the small helpers are mirrored here with the same
// escape-first discipline; keep the two in sync if the syntax grows.)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(body) {
  const escaped = escapeHtml(body);
  let html = escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return html.replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n');
}

// {{contact.name}} — same merge field email_templates documents. Unresolved
// tokens are left as literals (don't drop the email).
function renderMergeFields(text, contact) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
  let out = text;
  if (name) out = out.split('{{contact.name}}').join(name);
  return out;
}

// Same best-effort public base URL emailRoutes uses for unsubscribe/pixel links.
function publicApiBase() {
  return (
    process.env.PUBLIC_BACKEND_URL
    || process.env.BACKEND_URL
    || 'https://app.theopencrm.com'
  ).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// CRUD — sequences + steps
// ---------------------------------------------------------------------------

async function listSequences(scope) {
  const [sf, sv] = scopeOf(scope);
  const r = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
            (SELECT COUNT(*)::int FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_enrollments
       FROM sequences s
      WHERE s.${sf} = $1
      ORDER BY s.created_at DESC`,
    [sv]
  );
  return r.rows;
}

async function getSequence(scope, id) {
  const [sf, sv] = scopeOf(scope);
  const r = await pool.query(
    `SELECT * FROM sequences WHERE id = $1 AND ${sf} = $2`,
    [id, sv]
  );
  if (r.rows.length === 0) return null;
  const steps = await pool.query(
    `SELECT id, step_order, delay_days, subject, body_template
       FROM sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC, id ASC`,
    [id]
  );
  return { ...r.rows[0], steps: steps.rows };
}

// Normalize + validate an incoming steps array. Returns { steps } or { error }.
function normalizeSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return { error: 'steps must be an array' };
  if (rawSteps.length > 50) return { error: 'A sequence supports at most 50 steps' };
  const steps = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i] || {};
    const delay = Number(s.delay_days ?? 0);
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) {
      return { error: `Step ${i + 1}: delay_days must be an integer between 0 and 365` };
    }
    const subject = typeof s.subject === 'string' ? s.subject.trim() : '';
    const body = typeof s.body_template === 'string' ? s.body_template : '';
    if (!subject) return { error: `Step ${i + 1}: subject is required` };
    if (!body.trim()) return { error: `Step ${i + 1}: body_template is required` };
    steps.push({ step_order: i, delay_days: delay, subject, body_template: body });
  }
  return { steps };
}

async function createSequence(scope, { name, is_active = true, steps = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO sequences (org_id, user_id, name, is_active, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [scope.orgId || null, scope.userId, name, Boolean(is_active), scope.userId]
    );
    const seq = r.rows[0];
    for (const st of steps) {
      await client.query(
        `INSERT INTO sequence_steps (sequence_id, org_id, step_order, delay_days, subject, body_template)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [seq.id, scope.orgId || null, st.step_order, st.delay_days, st.subject, st.body_template]
      );
    }
    await client.query('COMMIT');
    return { ...seq, steps };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally {
    client.release();
  }
}

// Update name / is_active; when `steps` is provided the full step list is
// replaced transactionally (the builder always saves the whole ordered list).
// In-flight enrollments keep their current_step index against the new list —
// documented behavior for the v1 builder.
async function updateSequence(scope, id, { name, is_active, steps }) {
  const [sf, sv] = scopeOf(scope);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE sequences SET
         name       = COALESCE($1, name),
         is_active  = COALESCE($2, is_active),
         updated_at = NOW()
       WHERE id = $3 AND ${sf} = $4
       RETURNING *`,
      [name ?? null, typeof is_active === 'boolean' ? is_active : null, id, sv]
    );
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    if (Array.isArray(steps)) {
      await client.query(`DELETE FROM sequence_steps WHERE sequence_id = $1`, [id]);
      for (const st of steps) {
        await client.query(
          `INSERT INTO sequence_steps (sequence_id, org_id, step_order, delay_days, subject, body_template)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, scope.orgId || null, st.step_order, st.delay_days, st.subject, st.body_template]
        );
      }
    }
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally {
    client.release();
  }
}

async function deleteSequence(scope, id) {
  const [sf, sv] = scopeOf(scope);
  const r = await pool.query(
    `DELETE FROM sequences WHERE id = $1 AND ${sf} = $2 RETURNING id`,
    [id, sv]
  );
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

// Enroll contacts into a sequence. Skips contacts already enrolled (UNIQUE
// (sequence_id, contact_id) + ON CONFLICT DO NOTHING) and contacts outside
// the caller's tenancy (the INSERT ... SELECT is scoped). next_send_at =
// NOW() + first step's delay_days.
// Returns { enrolled, skipped } or null when the sequence isn't visible, or
// { error } when it has no steps.
async function enroll(scope, sequenceId, contactIds) {
  const [sf, sv] = scopeOf(scope);
  const ids = [...new Set((contactIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { error: 'contact_ids required' };
  if (ids.length > 500) return { error: 'Enroll at most 500 contacts per call' };

  const seqR = await pool.query(
    `SELECT s.id,
            (SELECT st.delay_days FROM sequence_steps st
              WHERE st.sequence_id = s.id ORDER BY st.step_order ASC, st.id ASC LIMIT 1) AS first_delay_days,
            (SELECT COUNT(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count
       FROM sequences s
      WHERE s.id = $1 AND s.${sf} = $2`,
    [sequenceId, sv]
  );
  if (seqR.rows.length === 0) return null;
  const seq = seqR.rows[0];
  if (Number(seq.step_count) === 0) return { error: 'Add at least one step before enrolling contacts' };

  const delay = Number(seq.first_delay_days) || 0;
  const ins = await pool.query(
    `INSERT INTO sequence_enrollments (org_id, user_id, sequence_id, contact_id, status, next_send_at)
     SELECT $1, $2, $3, c.id, 'active', NOW() + ($4 || ' days')::interval
       FROM contacts c
      WHERE c.id = ANY($5::int[]) AND c.${sf} = $6
     ON CONFLICT (sequence_id, contact_id) DO NOTHING
     RETURNING id, contact_id`,
    [scope.orgId || null, scope.userId, sequenceId, String(delay), ids, sv]
  );
  return { enrolled: ins.rows.length, skipped: ids.length - ins.rows.length };
}

async function listEnrollments(scope, sequenceId) {
  const [sf, sv] = scopeOf(scope);
  const r = await pool.query(
    `SELECT e.id, e.contact_id, e.current_step, e.status, e.enrolled_at,
            e.next_send_at, e.last_sent_at,
            c.first_name, c.last_name, c.email
       FROM sequence_enrollments e
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.sequence_id = $1 AND e.${sf} = $2
      ORDER BY e.enrolled_at DESC
      LIMIT 500`,
    [sequenceId, sv]
  );
  return r.rows;
}

// Manual stop. Only an active enrollment can be stopped (terminal states stay).
async function stop(scope, enrollmentId) {
  const [sf, sv] = scopeOf(scope);
  const r = await pool.query(
    `UPDATE sequence_enrollments
        SET status = 'stopped', next_send_at = NULL
      WHERE id = $1 AND ${sf} = $2 AND status = 'active'
      RETURNING *`,
    [enrollmentId, sv]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Analytics — GET /api/sequences/:id/stats
// ---------------------------------------------------------------------------

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000; // 0–1, 3dp
}

/**
 * Per-sequence + per-step rollup:
 *   totals — enrolled / active / completed / stopped / unsubscribed (from
 *            sequence_enrollments) + sent / opened (from email_sends rows
 *            tagged with sequence_id, migration 143) + open_rate / unsub_rate.
 *   steps  — one entry per configured step (by step_order): sent, opened,
 *            open_rate, and unsubscribed = enrollments that opted out while
 *            DUE at that step (suppression flips status before sending, so
 *            current_step points at the step they never received).
 *
 * Click tracking doesn't exist in email_sends (only the opened_at pixel), so
 * there is deliberately no `clicked` field — omitted rather than always-zero.
 *
 * Defensive by construction: pure SQL aggregates over existing rows, so an
 * unconfigured email transport (nothing sent yet) yields zeros, never errors.
 * Returns null when the sequence isn't visible to the caller's tenancy.
 */
async function sequenceStats(scope, sequenceId) {
  const [sf, sv] = scopeOf(scope);

  const seqR = await pool.query(
    `SELECT id, name, is_active FROM sequences WHERE id = $1 AND ${sf} = $2`,
    [sequenceId, sv]
  );
  if (seqR.rows.length === 0) return null;
  const seq = seqR.rows[0];

  const stepsR = await pool.query(
    `SELECT step_order, delay_days, subject
       FROM sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC, id ASC`,
    [sequenceId]
  );

  const enrR = await pool.query(
    `SELECT COUNT(*)::int                                          AS enrolled,
            COUNT(*) FILTER (WHERE status = 'active')::int         AS active,
            COUNT(*) FILTER (WHERE status = 'completed')::int      AS completed,
            COUNT(*) FILTER (WHERE status = 'stopped')::int        AS stopped,
            COUNT(*) FILTER (WHERE status = 'unsubscribed')::int   AS unsubscribed
       FROM sequence_enrollments
      WHERE sequence_id = $1 AND ${sf} = $2`,
    [sequenceId, sv]
  );

  // email_sends carries org_id only (no user_id), so tenancy here is the
  // ownership check above + an org match (IS NOT DISTINCT FROM handles the
  // no-org user_id-fallback tenancy, whose sends have org_id NULL).
  const sendsR = await pool.query(
    `SELECT sequence_step_order AS step_order,
            COUNT(*)::int        AS sent,
            COUNT(opened_at)::int AS opened
       FROM email_sends
      WHERE sequence_id = $1 AND org_id IS NOT DISTINCT FROM $2
      GROUP BY sequence_step_order`,
    [sequenceId, scope.orgId || null]
  );

  const unsubR = await pool.query(
    `SELECT current_step AS step_order, COUNT(*)::int AS unsubscribed
       FROM sequence_enrollments
      WHERE sequence_id = $1 AND ${sf} = $2 AND status = 'unsubscribed'
      GROUP BY current_step`,
    [sequenceId, sv]
  );

  const sendsByStep = new Map(sendsR.rows.map((r) => [Number(r.step_order), r]));
  const unsubByStep = new Map(unsubR.rows.map((r) => [Number(r.step_order), Number(r.unsubscribed) || 0]));

  let totalSent = 0;
  let totalOpened = 0;
  const steps = stepsR.rows.map((st) => {
    const s = sendsByStep.get(Number(st.step_order)) || {};
    const sent = Number(s.sent) || 0;
    const opened = Number(s.opened) || 0;
    totalSent += sent;
    totalOpened += opened;
    return {
      step_order: Number(st.step_order),
      subject: st.subject,
      delay_days: Number(st.delay_days) || 0,
      sent,
      opened,
      open_rate: rate(opened, sent),
      unsubscribed: unsubByStep.get(Number(st.step_order)) || 0,
    };
  });

  const enr = enrR.rows[0] || {};
  const enrolled = Number(enr.enrolled) || 0;
  const unsubscribed = Number(enr.unsubscribed) || 0;

  return {
    sequence: { id: seq.id, name: seq.name, is_active: seq.is_active },
    totals: {
      enrolled,
      active: Number(enr.active) || 0,
      completed: Number(enr.completed) || 0,
      stopped: Number(enr.stopped) || 0,
      unsubscribed,
      sent: totalSent,
      opened: totalOpened,
      open_rate: rate(totalOpened, totalSent),
      unsub_rate: rate(unsubscribed, enrolled),
    },
    steps,
  };
}

// ---------------------------------------------------------------------------
// Send tick — called by services/sequenceWorker.js
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SENDS_PER_TICK = 50;

/**
 * Process due enrollments: for each active enrollment whose sequence is
 * active and next_send_at <= NOW(), send the current step (suppression
 * checked first, advance claimed atomically before transport) and schedule
 * the next one — or mark completed / unsubscribed / stopped as appropriate.
 *
 * Returns { sent, completed, unsubscribed, skipped, failed } counters, or
 * { skipped: 'email_not_configured' } when there is no transport.
 */
async function processDueEnrollments({ maxPerRun = DEFAULT_MAX_SENDS_PER_TICK } = {}) {
  // Graceful degradation: with no transport we do NOTHING — no claim, no
  // console-send. Enrollments stay due and start flowing the moment a
  // transport is configured. (email.sendMail would happily console-log, but
  // silently "consuming" real drip steps in a misconfigured prod would lose
  // messages.)
  if (!email.isConfigured()) {
    logger.warn?.('sequence_tick_email_not_configured');
    return { sent: 0, completed: 0, unsubscribed: 0, failed: 0, skipped: 'email_not_configured' };
  }

  const due = await pool.query(
    `SELECT e.id, e.org_id, e.user_id, e.sequence_id, e.contact_id, e.current_step,
            c.first_name, c.last_name, c.email AS contact_email,
            s.created_by AS sequence_created_by, s.name AS sequence_name
       FROM sequence_enrollments e
       JOIN sequences s ON s.id = e.sequence_id
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.status = 'active'
        AND e.next_send_at IS NOT NULL
        AND e.next_send_at <= NOW()
        AND s.is_active = TRUE
      ORDER BY e.next_send_at ASC
      LIMIT $1`,
    [maxPerRun]
  );

  const out = { sent: 0, completed: 0, unsubscribed: 0, failed: 0 };
  for (const row of due.rows) {
    try {
      const result = await processOneEnrollment(row);
      if (result === 'sent') out.sent++;
      else if (result === 'sent+completed') { out.sent++; out.completed++; }
      else if (result === 'unsubscribed') out.unsubscribed++;
    } catch (err) {
      out.failed++;
      logger.warn?.('sequence_enrollment_send_failed', { enrollmentId: row.id, error: err && err.message });
    }
  }
  if (due.rows.length > 0) {
    logger.info?.('sequence_tick_end', out);
  }
  return out;
}

async function processOneEnrollment(row) {
  // 1. Load the ordered step list; figure out which step is due.
  const stepsR = await pool.query(
    `SELECT id, step_order, delay_days, subject, body_template
       FROM sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC, id ASC`,
    [row.sequence_id]
  );
  const steps = stepsR.rows;
  const step = steps[row.current_step];

  // No step at this index (steps were edited/removed) → nothing left to send.
  if (!step) {
    await pool.query(
      `UPDATE sequence_enrollments SET status = 'completed', next_send_at = NULL
        WHERE id = $1 AND status = 'active'`,
      [row.id]
    );
    return 'completed-empty';
  }

  // Contact vanished or has no email — the enrollment can never deliver.
  const toEmail = (row.contact_email || '').trim();
  if (!toEmail) {
    await pool.query(
      `UPDATE sequence_enrollments SET status = 'stopped', next_send_at = NULL
        WHERE id = $1 AND status = 'active'`,
      [row.id]
    );
    logger.info?.('sequence_enrollment_stopped_no_email', { enrollmentId: row.id });
    return 'stopped-no-email';
  }

  // 2. SUPPRESSION FIRST. Same confirmed-opt-out gate POST /api/emails/send
  // uses, scoped to the enrollment's own org. A suppressed recipient is
  // never emailed; the enrollment flips to 'unsubscribed'.
  const unsub = await pool.query(
    `SELECT 1 FROM email_unsubscribes
      WHERE org_id IS NOT DISTINCT FROM $1
        AND LOWER(email) = LOWER($2)
        AND unsubscribed_at IS NOT NULL
      LIMIT 1`,
    [row.org_id || null, toEmail]
  );
  if (unsub.rows.length > 0) {
    await pool.query(
      `UPDATE sequence_enrollments SET status = 'unsubscribed', next_send_at = NULL
        WHERE id = $1 AND status = 'active'`,
      [row.id]
    );
    return 'unsubscribed';
  }

  // 3. ATOMIC ADVANCE (the double-send guard). Claim this exact step: the
  // WHERE status='active' AND current_step=<expected> predicate means a
  // concurrent tick that already advanced (or a user who just stopped the
  // enrollment) loses the claim and we skip without sending.
  const nextStep = steps[row.current_step + 1];
  const claim = await pool.query(
    `UPDATE sequence_enrollments
        SET current_step = current_step + 1,
            last_sent_at = NOW(),
            next_send_at = ${nextStep ? `NOW() + ($4 || ' days')::interval` : 'NULL'},
            status       = ${nextStep ? `'active'` : `'completed'`}
      WHERE id = $1 AND status = 'active' AND current_step = $2 AND sequence_id = $3
      RETURNING id`,
    nextStep
      ? [row.id, row.current_step, row.sequence_id, String(Number(nextStep.delay_days) || 0)]
      : [row.id, row.current_step, row.sequence_id]
  );
  if (claim.rows.length === 0) {
    // Lost the race — someone else sent (or the enrollment was stopped). Skip.
    return 'skipped-claim-lost';
  }

  // 4. Render + record + send. From here on a failure is logged (the step is
  // already claimed, so at worst this step is skipped — never doubled).
  const contact = { first_name: row.first_name, last_name: row.last_name };
  const subject = renderMergeFields(step.subject, contact);
  const bodyText = renderMergeFields(step.body_template, contact);

  // Unsubscribe token + email_sends row — identical bookkeeping to a one-off
  // send so the timeline, retention sweep, and opt-out flow all just work.
  const unsubToken = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO email_unsubscribes (org_id, email, contact_id, token)
     VALUES ($1, $2, $3, $4)`,
    [row.org_id || null, toEmail, row.contact_id, unsubToken]
  );
  // sequence_id + sequence_step_order (migration 143) make the dispatch
  // attributable for sequenceStats. Step ORDER, not id — the builder replaces
  // steps wholesale on edit, so ids churn while order is the stable coordinate.
  const sendIns = await pool.query(
    `INSERT INTO email_sends (org_id, sent_by, to_contact_id, to_email, subject, body, sequence_id, sequence_step_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [row.org_id || null, row.sequence_created_by || row.user_id || null, row.contact_id, toEmail, subject, bodyText,
     row.sequence_id, step.step_order]
  );
  const sendId = sendIns.rows[0].id;

  const apiBase = publicApiBase();
  const htmlBody = `${plainToHtml(bodyText)}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
<p style="font-size:11px;color:#9ca3af;">
  <a href="${apiBase}/api/emails/unsubscribe/${unsubToken}" style="color:#9ca3af;">Unsubscribe</a> from these messages.
</p>
<img src="${apiBase}/api/emails/track/${sendId}.gif" width="1" height="1" alt="" style="display:none;">`;

  try {
    const sent = await email.sendMail({
      to: toEmail,
      subject,
      html: htmlBody,
      text: bodyText,
    });
    if (sent.messageId) {
      await pool.query(
        `UPDATE email_sends SET provider_message_id = $1 WHERE id = $2`,
        [sent.messageId, sendId]
      );
    }
  } catch (sendErr) {
    // Transport failed post-claim: logged, step counts as consumed. Never
    // re-send automatically — repeating drip mail is worse than skipping.
    logger.warn?.('sequence_send_transport_failed', { enrollmentId: row.id, sendId, error: sendErr && sendErr.message });
  }

  // Fire-and-forget: the enrollment just sent its final step — tell the
  // sequence's owner. Best-effort; never affects the tick's outcome.
  if (!nextStep) {
    notificationDispatcher.notifySequenceCompleted(row.id)
      .catch((err) => logger.warn?.('notify_sequence_completed_failed', { enrollmentId: row.id, error: err && err.message }));
  }

  return nextStep ? 'sent' : 'sent+completed';
}

module.exports = {
  ENROLLMENT_STATUSES,
  normalizeSteps,
  listSequences,
  getSequence,
  createSequence,
  updateSequence,
  deleteSequence,
  enroll,
  listEnrollments,
  stop,
  sequenceStats,
  processDueEnrollments,
  DEFAULT_MAX_SENDS_PER_TICK,
};
