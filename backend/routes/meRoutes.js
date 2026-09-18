// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Data-subject self-service endpoints. Implements the rights surfaced in
// legal/PRIVACY_POLICY.md and legal/your-rights:
//
//   GET    /api/me/export           — JSON dump of everything tied to the
//                                      caller's user_id + their org
//   POST   /api/me/delete-account   — schedule account deletion (7-day grace
//                                      period; user receives a cancellation
//                                      link in email)
//   POST   /api/me/delete-account/cancel  — cancel a scheduled deletion
//   GET    /api/me/delete-account/status  — see if a deletion is scheduled
//
// All endpoints are auth-required (caller proves they are the user whose data
// is being touched). Cross-org / cross-user data is never returned —
// queries are bound to req.userId + req.orgId.

const express = require('express');
const bcryptjs = require('bcryptjs');
const { authMiddleware, validatePasswordAsync, hashPassword } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const adminNotify = require('../services/adminNotify');
const { changePasswordLimiter } = require('../middleware/rateLimits');
const { validateBody } = require('../middleware/validate');
const {
  updateProfileSchema,
  changePasswordSchema,
  updateNotificationPreferencesSchema,
} = require('../schemas/me');

const router = express.Router();
router.use(authMiddleware);

// Build the consistent user-row response shape used by the self-service
// endpoints below. Mirrors the /auth/me projection so the frontend can use
// either response interchangeably with refreshUser().
async function fetchUserRow(userId) {
  const r = await pool.query(
    `SELECT u.id, u.email, u.name, u.status, u.org_id, u.org_role,
            u.notification_preferences, u.notification_email, u.notification_phone,
            o.profile AS org_profile, o.name AS org_name, o.branding AS org_branding,
            o.tier AS org_tier,
            au.role AS admin_role, au.permissions AS admin_permissions
       FROM users u
       LEFT JOIN organizations o ON o.id = u.org_id
       LEFT JOIN admin_users au ON au.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  const u = r.rows[0];
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    org_id: u.org_id,
    org_role: u.org_role,
    org_profile: u.org_profile || 'generic',
    org_name: u.org_name,
    org_branding: u.org_branding || {},
    org_tier: u.org_tier || 'free',
    notification_preferences: u.notification_preferences || {},
    notification_email: u.notification_email || null,
    notification_phone: u.notification_phone || null,
    is_admin: !!u.admin_role,
    admin_role: u.admin_role,
    admin_permissions: u.admin_permissions || [],
  };
}

/**
 * PUT /api/me
 *
 * Update the caller's editable profile fields. Login email is still
 * out-of-scope (it's a stable identity field) but notification_email and
 * notification_phone are user-controlled contact handles for outbound
 * notifications and are editable here.
 *
 * Body: {
 *   name?:               string,        // trimmed, 1..120 chars
 *   notification_email?: string | null, // null clears; otherwise basic email check; <=254 chars
 *   notification_phone?: string | null, // null clears; otherwise normalised to +<digits>, <=32 chars
 * }
 *
 * At least one editable field must be present. Returns the refreshed user row.
 */
router.put('/', validateBody(updateProfileSchema), async (req, res) => {
  try {
    // zod has already trimmed / normalised / refined; req.body now contains
    // only the recognised fields with their final values (notification_phone
    // is already in '+<digits>' form, notification_email is trimmed-and-
    // validated, name is trimmed). At least one field is guaranteed present
    // by the schema's .refine().
    const body = req.body;
    const updates = []; // [{column, value}]
    const auditFields = [];

    for (const col of ['name', 'notification_email', 'notification_phone']) {
      if (col in body) {
        updates.push({ column: col, value: body[col] });
        auditFields.push(col);
      }
    }

    // Build the dynamic UPDATE — each column becomes its own SET clause so
    // each field can independently be set to null or a string.
    const setClauses = updates.map((u, i) => `${u.column} = $${i + 1}`);
    const values = updates.map(u => u.value);
    values.push(req.userId);
    await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    audit.fromReq(req, { event: audit.EVENTS.PROFILE_UPDATED, meta: { fields: auditFields } });

    const user = await fetchUserRow(req.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    if (req.log) req.log.error('me_update_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to update profile', requestId: req.requestId });
  }
});

/**
 * POST /api/me/change-password
 *
 * Change the caller's password. Verifies the current password with bcrypt,
 * enforces the registration-time password policy (validatePassword in
 * auth.js), and re-hashes via the shared hashPassword helper so the cost
 * factor stays consistent across the app (currently 12).
 *
 * Body: { currentPassword: string, newPassword: string }
 * Returns: { success: true } on success.
 *           401 on bad current password.
 *           400 on validation failure.
 */
router.post('/change-password', changePasswordLimiter, validateBody(changePasswordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    // zod has already enforced: both are strings, newPassword ≥10 chars,
    // currentPassword !== newPassword. Strength / reuse / HIBP still below.

    // The full new-password policy check (policy + recent-history + HIBP) runs
    // *after* current-password verification below — that way an attacker
    // probing weak passwords doesn't get free policy hints without first
    // proving they know the current password.

    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    const row = r.rows[0];
    if (!row || !row.password_hash) {
      // Google-OAuth-only users have no password_hash. We can't verify a
      // current password, so we refuse rather than letting them set one
      // without re-authentication.
      audit.fromReq(req, {
        event: audit.EVENTS.PASSWORD_CHANGE,
        success: false,
        meta: { reason: 'no_password_set' },
      });
      return res.status(400).json({
        success: false,
        error: 'This account does not have a password set. Sign in with Google or contact support.',
      });
    }

    const ok = await bcryptjs.compare(currentPassword, row.password_hash);
    if (!ok) {
      audit.fromReq(req, {
        event: audit.EVENTS.PASSWORD_CHANGE,
        success: false,
        meta: { reason: 'bad_current_password' },
      });
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    // Pull the last 5 hashes from history; prepend the current hash so the
    // user can't re-set what they just had. validatePasswordAsync runs the
    // sync policy first (fast-fail), then bcrypt-compares against each, then
    // optionally hits the HIBP k-anonymity API if HIBP_ENABLED.
    const histRes = await pool.query(
      `SELECT password_hash FROM user_password_history
        WHERE user_id = $1 ORDER BY set_at DESC LIMIT 5`,
      [req.userId]
    );
    const recentHashes = [row.password_hash, ...histRes.rows.map(h => h.password_hash)];
    const pw = await validatePasswordAsync(newPassword, { recentHashes });
    if (!pw.ok) {
      audit.fromReq(req, {
        event: audit.EVENTS.PASSWORD_CHANGE,
        success: false,
        meta: { reason: 'policy_or_reuse_or_hibp' },
      });
      return res.status(400).json({ success: false, error: pw.error });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, req.userId]
    );

    // Record the new hash so it can't be reused on the next change.
    await pool.query(
      `INSERT INTO user_password_history (user_id, password_hash) VALUES ($1, $2)`,
      [req.userId, newHash]
    );

    audit.fromReq(req, { event: audit.EVENTS.PASSWORD_CHANGE, success: true });

    res.json({ success: true });
  } catch (err) {
    if (req.log) req.log.error('me_change_password_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to change password', requestId: req.requestId });
  }
});

/**
 * PUT /api/me/notification-preferences
 *
 * Partial update of the per-channel notification matrix introduced in
 * migration 066. Each category (task_assigned, task_overdue, deal_activity,
 * weekly_summary) carries an object { email: bool, sms: bool }. Unspecified
 * categories — and unspecified channels within a category — keep their
 * previous values via top-level JSONB `||` merge, which is a *shallow* merge.
 * Because we want partial updates within a category to also preserve the
 * untouched channel, the handler fetches the current row, merges in JS, and
 * writes back the resulting category object.
 *
 * Body example (any subset is OK):
 *   {
 *     "task_assigned":  { "email": true,  "sms": false },
 *     "weekly_summary": { "email": false }
 *   }
 *
 * Returns: { success: true, user } with the refreshed user row.
 */
router.put('/notification-preferences', validateBody(updateNotificationPreferencesSchema), async (req, res) => {
  try {
    // zod has rejected unknown categories AND unknown channels (each
    // category schema is .strict()). req.body is { [category]: { email?,
    // sms? } } with only known keys.
    const patch = req.body;

    if (Object.keys(patch).length === 0) {
      // No known keys supplied — return current state rather than 400, so the
      // client can use this as a "ping/read" if needed.
      const user = await fetchUserRow(req.userId);
      return res.json({ success: true, user });
    }

    // Pull current prefs so we can preserve the untouched channel within any
    // category the caller partially updated.
    const existing = await pool.query(
      `SELECT notification_preferences FROM users WHERE id = $1`,
      [req.userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const current = existing.rows[0].notification_preferences || {};

    const merged = {};
    for (const cat of Object.keys(patch)) {
      const before = (typeof current[cat] === 'object' && current[cat]) ? current[cat] : {};
      merged[cat] = { ...before, ...patch[cat] };
    }

    await pool.query(
      `UPDATE users
          SET notification_preferences = notification_preferences || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(merged), req.userId]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.NOTIFICATION_PREFERENCES_UPDATED,
      meta: { categories: Object.keys(merged) },
    });

    const user = await fetchUserRow(req.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    if (req.log) req.log.error('me_notification_prefs_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to update notification preferences', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// GDPR export table registry (export_version 2, 2026-09-14 audit).
//
// The v1 export hand-listed 6 business tables and silently went stale as the
// schema grew (leads, cases, meetings, sequences, surveys, ... all missing).
// v2 is registry + information_schema driven: columns are resolved at first
// use (cached for the process) so a table that gains columns — or a
// deployment that hasn't run a migration yet — is handled automatically.
//
// scope:
//   'std' — business records: rows the caller owns (user_id) plus their
//           org's rows. Matches the v1 semantics for companies/deals/etc.
//   'own' — personal artifacts (notifications, chat, AI usage): ONLY the
//           caller's rows, even inside an org.
// Secret-ish columns (tokens, ciphertext, IVs) and BYTEA blobs (documents
// file content) are stripped by name/type.
// ---------------------------------------------------------------------------
const EXPORT_SECRET_COLUMN_RE = /(password|secret|token|ciphertext|_iv$|_tag$|api_key)/i;
const EXPORT_ROW_LIMIT = 50000;

const EXPORT_TABLES = [
  // v1 set
  { key: 'companies', table: 'companies' },
  { key: 'contacts', table: 'contacts' },
  { key: 'deals', table: 'deals' },
  { key: 'activities', table: 'activities' },
  { key: 'tasks', table: 'tasks' },
  { key: 'quotes', table: 'quotes' },
  // Sales / marketing
  { key: 'leads', table: 'leads' },
  { key: 'lead_forms', table: 'lead_forms' },
  { key: 'sequences', table: 'sequences' },
  { key: 'sequence_steps', table: 'sequence_steps' },
  { key: 'sequence_enrollments', table: 'sequence_enrollments' },
  { key: 'sales_quotes', table: 'sales_quotes' },
  { key: 'products', table: 'products' },
  { key: 'email_sends', table: 'email_sends' },
  { key: 'email_templates', table: 'email_templates' },
  { key: 'sms_messages', table: 'sms_messages' },
  // Customer success / post-sale
  { key: 'cases', table: 'cases' },
  { key: 'meetings', table: 'meetings' },
  { key: 'meeting_logs', table: 'meeting_logs' },
  { key: 'calendar_events', table: 'calendar_events' },
  { key: 'surveys', table: 'surveys' },
  { key: 'survey_responses', table: 'survey_responses' },
  { key: 'segments', table: 'segments' },
  { key: 'relationship_pulses', table: 'relationship_pulses' },
  { key: 'service_contracts', table: 'service_contracts' },
  { key: 'record_comments', table: 'record_comments' },
  // Zang workflow
  { key: 'issues', table: 'issues' },
  { key: 'vendor_quotes', table: 'vendor_quotes' },
  { key: 'submittals', table: 'submittals' },
  { key: 'change_orders', table: 'change_orders' },
  { key: 'documents', table: 'documents' }, // content BYTEA stripped by type
  // Deal intel (Gmail / Drive / Outlook)
  { key: 'deal_email_threads', table: 'deal_email_threads' },
  { key: 'email_thread_messages', table: 'email_thread_messages' },
  { key: 'deal_gmail_summaries', table: 'deal_gmail_summaries' },
  { key: 'deal_intel_summaries', table: 'deal_intel_summaries' },
  { key: 'deal_intel_suggestions', table: 'deal_intel_suggestions' },
  { key: 'drive_files', table: 'drive_files' },
  { key: 'outlook_messages', table: 'outlook_messages' },
  { key: 'outlook_calendar_events', table: 'outlook_calendar_events' },
  // Config the caller can see anyway
  { key: 'saved_views', table: 'saved_views' },
  { key: 'saved_filters', table: 'saved_filters' },
  { key: 'saved_reports', table: 'saved_reports' },
  { key: 'custom_fields', table: 'custom_fields' },
  { key: 'org_field_definitions', table: 'org_field_definitions' },
  { key: 'pipelines', table: 'pipelines' },
  // Personal artifacts — caller's own rows only
  { key: 'notifications', table: 'notifications', scope: 'own' },
  { key: 'ai_usage_events', table: 'ai_usage_events', scope: 'own' },
  { key: 'chat_sessions', table: 'chat_sessions', scope: 'own' },
  { key: 'terms_acceptances', table: 'terms_acceptances', scope: 'own' },
];

// table -> [{ name, type }] for every table above, or null when the table
// doesn't exist in this deployment. Built once per process.
let exportColumnCachePromise = null;
function exportColumnCache() {
  if (!exportColumnCachePromise) {
    exportColumnCachePromise = (async () => {
      const names = EXPORT_TABLES.map((t) => t.table);
      const r = await pool.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [names]
      );
      const byTable = {};
      for (const row of r.rows) {
        (byTable[row.table_name] = byTable[row.table_name] || []).push({ name: row.column_name, type: row.data_type });
      }
      return byTable;
    })().catch((err) => { exportColumnCachePromise = null; throw err; });
  }
  return exportColumnCachePromise;
}

async function exportTableRows(entry, userId, orgId, columnsByTable) {
  const cols = columnsByTable[entry.table];
  if (!cols || cols.length === 0) return null; // table not in this deployment
  const names = cols.map((c) => c.name);
  const selectable = cols
    .filter((c) => c.type !== 'bytea' && !EXPORT_SECRET_COLUMN_RE.test(c.name))
    .map((c) => `"${c.name}"`);
  if (selectable.length === 0) return null;

  const hasUser = names.includes('user_id');
  const hasOrg = names.includes('org_id');
  let where; let params;
  if (entry.scope === 'own') {
    if (!hasUser) return null;
    where = 'user_id = $1'; params = [userId];
  } else if (hasUser && hasOrg) {
    where = '(user_id = $1 OR (org_id = $2 AND $2::int IS NOT NULL))'; params = [userId, orgId];
  } else if (hasOrg) {
    if (!orgId) return { rows: [] };
    where = 'org_id = $1'; params = [orgId];
  } else if (hasUser) {
    where = 'user_id = $1'; params = [userId];
  } else {
    return null; // no tenant scoping column — not exportable per-user
  }
  const order = names.includes('created_at') ? 'ORDER BY created_at DESC' : '';
  const r = await pool.query(
    `SELECT ${selectable.join(', ')} FROM ${entry.table} WHERE ${where} ${order} LIMIT ${EXPORT_ROW_LIMIT}`,
    params
  );
  return r;
}

/**
 * GET /api/me/export
 *
 * Returns a JSON document containing every business record tied to the
 * caller's user_id, plus the org_id-scoped records they have access to. The
 * intent is GDPR/CCPA-style data portability — a user can take their data
 * out of the platform in a machine-readable format.
 *
 * Response shape: { user, organization, companies, contacts, deals, ... }.
 * Sensitive platform-internal fields (password hashes, encrypted tokens,
 * file blobs) are stripped before return; see EXPORT_TABLES above for the
 * module coverage.
 */
router.get('/export', async (req, res) => {
  try {
    const userId = req.userId;
    const orgId = req.orgId;

    const columnsByTable = await exportColumnCache();

    // Run all the queries in parallel — they're independent and the export
    // is read-only.
    const [userQ, orgQ, auditQ, chatMessagesQ, ...tableQs] = await Promise.all([
      pool.query(`SELECT id, email, name, status, org_id, org_role, created_at, updated_at
                    FROM users WHERE id = $1`, [userId]),
      orgId ? pool.query(`SELECT id, name, profile, branding, features, created_at, updated_at
                            FROM organizations WHERE id = $1`, [orgId]) : Promise.resolve({ rows: [] }),
      // The audit log entries where the caller is the actor — they own their
      // own action history. We do not include audit entries about other
      // users in the same org (that's an admin-export concern).
      pool.query(`SELECT id, event, target_type, target_id, ip, user_agent, meta, success, created_at
                    FROM audit_log WHERE actor_user_id = $1
                    ORDER BY created_at DESC LIMIT 5000`, [userId]),
      // Chat messages hang off sessions (no user_id of their own) — the
      // caller's own conversations are personal data.
      columnsByTable.chat_messages
        ? pool.query(`SELECT id, session_id, role, content, created_at
                        FROM chat_messages
                       WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = $1)
                       ORDER BY created_at DESC LIMIT ${EXPORT_ROW_LIMIT}`, [userId])
        : Promise.resolve(null),
      ...EXPORT_TABLES.map((entry) => exportTableRows(entry, userId, orgId, columnsByTable)),
    ]);

    let recordCount = userQ.rows.length + orgQ.rows.length + auditQ.rows.length;

    const payload = {
      export_generated_at: new Date().toISOString(),
      export_version: 2,
      notice: 'This export contains personal data tied to your account. Handle accordingly. The Open CRM operator does not retain a copy of this download.',
      user: userQ.rows[0] || null,
      organization: orgQ.rows[0] || null,
      audit_log_entries_as_actor: auditQ.rows,
    };
    EXPORT_TABLES.forEach((entry, i) => {
      const q = tableQs[i];
      if (!q) return; // table absent in this deployment / not user-scopable
      payload[entry.key] = q.rows;
      recordCount += q.rows.length;
    });
    if (chatMessagesQ) {
      payload.chat_messages = chatMessagesQ.rows;
      recordCount += chatMessagesQ.rows.length;
    }

    audit.fromReq(req, {
      event: 'me.export',
      actorUserId: userId,
      meta: { recordCount, exportVersion: 2 },
    });

    // The caller can request a download by setting Accept: application/octet-stream
    // or ?download=1. Otherwise we return as JSON for an in-browser viewer.
    if (req.query.download === '1' || req.headers.accept === 'application/octet-stream') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="theopencrm-export-${userId}-${Date.now()}.json"`);
    }
    res.json(payload);
  } catch (err) {
    if (req.log) req.log.error('me_export_failed', { error: err });
    res.status(500).json({ success: false, error: 'Export failed', requestId: req.requestId });
  }
});

/**
 * POST /api/me/delete-account
 *
 * Schedules the caller's account for deletion 7 days from now. The grace
 * period lets the user reverse the decision; if not cancelled, a background
 * job (Phase B, not yet wired) processes the deletion at the scheduled time.
 *
 * Idempotent: calling twice extends nothing — the existing scheduled
 * deletion is returned as-is.
 *
 * Body: { confirm: true, reason?: string }
 */
router.post('/delete-account', async (req, res) => {
  const { confirm, reason } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({
      success: false,
      error: 'Confirmation required. Send { "confirm": true } to schedule deletion.',
    });
  }

  try {
    const userId = req.userId;
    const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 days

    // Idempotency: if there's already a scheduled deletion that hasn't fired,
    // return it without changing anything.
    const existing = await pool.query(
      `SELECT id, scheduled_at, reason FROM account_deletions
        WHERE user_id = $1 AND status = 'scheduled'
        ORDER BY scheduled_at LIMIT 1`,
      [userId]
    );
    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        scheduled: true,
        scheduledAt: existing.rows[0].scheduled_at,
        message: 'Deletion already scheduled. Use POST /api/me/delete-account/cancel to abort.',
      });
    }

    await pool.query(
      `INSERT INTO account_deletions (user_id, requested_at, scheduled_at, status, reason)
       VALUES ($1, NOW(), $2, 'scheduled', $3)`,
      [userId, scheduledAt, reason || null]
    );

    // Also mark the user as 'pending_deletion' so subsequent logins surface a
    // warning + a cancel link.
    await pool.query(`UPDATE users SET status = 'pending_deletion' WHERE id = $1`, [userId]);

    audit.fromReq(req, {
      event: 'me.delete_account.scheduled',
      actorUserId: userId,
      meta: { scheduledAt, reason },
    });

    // Notify super admins so they can intervene if it looks like an attack.
    adminNotify.send({
      event: 'signup', // reuse channel for now; future: dedicated 'account_deletion_scheduled'
      subject: `[The Open CRM] Account deletion scheduled for user ${userId}`,
      html: `<p>User ID ${userId} has scheduled their account for deletion.</p>
             <ul>
               <li><b>Scheduled at:</b> ${scheduledAt.toISOString()}</li>
               <li><b>Reason:</b> ${reason ? String(reason).replace(/</g, '&lt;') : '(none provided)'}</li>
             </ul>`,
      text: `User ${userId} scheduled deletion for ${scheduledAt.toISOString()}.`,
      throttleKey: `delete_scheduled:${userId}`,
      meta: { userId },
    }).catch(() => {});

    res.json({
      success: true,
      scheduled: true,
      scheduledAt,
      message: 'Your account is scheduled for deletion in 7 days. Cancel anytime via POST /api/me/delete-account/cancel.',
    });
  } catch (err) {
    if (req.log) req.log.error('me_delete_scheduling_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to schedule deletion', requestId: req.requestId });
  }
});

router.post('/delete-account/cancel', async (req, res) => {
  try {
    const userId = req.userId;
    const r = await pool.query(
      `UPDATE account_deletions
          SET status = 'cancelled', cancelled_at = NOW()
        WHERE user_id = $1 AND status = 'scheduled'
        RETURNING id, scheduled_at`,
      [userId]
    );
    if (r.rows.length === 0) {
      return res.json({ success: true, cancelled: false, message: 'No pending deletion to cancel.' });
    }
    await pool.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending_deletion'`, [userId]);
    audit.fromReq(req, { event: 'me.delete_account.cancelled', actorUserId: userId, meta: { deletionId: r.rows[0].id } });
    res.json({ success: true, cancelled: true, message: 'Account deletion cancelled.' });
  } catch (err) {
    if (req.log) req.log.error('me_delete_cancel_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to cancel deletion' });
  }
});

router.get('/delete-account/status', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, requested_at, scheduled_at, cancelled_at, status, reason
         FROM account_deletions
        WHERE user_id = $1
        ORDER BY requested_at DESC LIMIT 1`,
      [req.userId]
    );
    res.json({ success: true, deletion: r.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch status' });
  }
});

// ---------------------------------------------------------------------------
// Terms-of-Service acceptance (migration 157). The server is the source of
// truth; the frontend keeps localStorage only as a fast-path cache.
//
// SINGLE CONSTANT for the current version — bump when the legal docs
// materially change and every user is re-prompted (unique per user+version).
// ---------------------------------------------------------------------------
// 2026-09-14: AI pay-as-you-go billing section added to the Terms (§4a public
// page / §5a legal/TERMS_OF_SERVICE.md) — every user re-accepts.
// KEEP IN SYNC with TERMS_VERSION in frontend/src/components/TermsModal.js.
const CURRENT_TERMS_VERSION = '2026-09-14';

// GET /api/me/accept-terms — has the caller accepted the CURRENT version?
router.get('/accept-terms', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT version, accepted_at FROM terms_acceptances
        WHERE user_id = $1 AND version = $2
        LIMIT 1`,
      [req.userId, CURRENT_TERMS_VERSION]
    );
    const row = r.rows[0] || null;
    res.json({
      success: true,
      version: CURRENT_TERMS_VERSION,
      accepted: !!row,
      accepted_at: row?.accepted_at || null,
    });
  } catch (err) {
    if (req.log) req.log.error('terms_status_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch terms acceptance' });
  }
});

// POST /api/me/accept-terms — record acceptance of the current version.
// Idempotent: re-accepting the same version is a no-op (first accepted_at wins).
router.post('/accept-terms', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO terms_acceptances (user_id, org_id, version)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, version) DO NOTHING`,
      [req.userId, req.orgId || null, CURRENT_TERMS_VERSION]
    );
    audit.fromReq(req, {
      event: 'terms.accepted',
      meta: { version: CURRENT_TERMS_VERSION },
    });
    res.json({ success: true, version: CURRENT_TERMS_VERSION, accepted: true });
  } catch (err) {
    if (req.log) req.log.error('terms_accept_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to record terms acceptance' });
  }
});

module.exports = router;
