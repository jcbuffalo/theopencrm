// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unified admin-notification service.
//
// Sends event-driven emails to super admins (and other admins who opt in).
// Each event type respects per-admin preferences + a throttle window so we
// don't spam on brute-force or repeated form submissions.
//
// USAGE:
//   const adminNotify = require('../services/adminNotify');
//   await adminNotify.send({
//     event: 'signup',                         // see EVENT_DEFAULTS keys
//     subject: 'New signup: alice@example.com',
//     html: '<p>...</p>',
//     text: 'alice@example.com just signed up.',
//     throttleKey: 'signup:alice@example.com', // optional; suppresses duplicates
//     meta: { userId: 42 },                    // logged + included in audit
//   });
//
// THROTTLING: per-pod in-memory Map of throttleKey → lastSentAt. Same key fired
// within the admin's throttle_minutes window is suppressed (logged + audited
// but no email). Acceptable for our scale; flag a Redis-backed throttle if we
// ever run > ~5 pods per service.

const pool = require('../db');
const email = require('./email');
const logger = require('./logger');
const audit = require('./audit');
const { seedEmails } = require('./bootstrapAdmin');

// Defaults applied when an admin's preferences don't explicitly set the event.
// Keep this list short; it's the canonical event catalog.
const EVENT_DEFAULTS = {
  access_request_submitted: true,   // someone hit "Request access"
  signup:                   true,   // someone successfully completed registration
  login_failed_threshold:   true,   // 5+ failed logins on an email/IP within 15m
  login_success_new_ip:     false,  // existing user signed in from a new IP
  weekly_digest:            false,  // (future) Sunday-night summary
};

const throttleCache = new Map(); // key → epoch ms last sent
const THROTTLE_TTL_MS = 24 * 60 * 60 * 1000; // entries older than 24h get pruned

function pruneThrottleCache() {
  const cutoff = Date.now() - THROTTLE_TTL_MS;
  for (const [k, v] of throttleCache) {
    if (v < cutoff) throttleCache.delete(k);
  }
}

/**
 * @typedef {Object} NotifyOptions
 * @property {string} event - one of EVENT_DEFAULTS keys (callers may pass new
 *                            events; they default to opt-in if no admin pref)
 * @property {string} subject
 * @property {string} [html]
 * @property {string} [text]
 * @property {string} [throttleKey] - if set, suppresses duplicates within an
 *                                     admin's throttle_minutes window
 * @property {object} [meta]
 */

/**
 * @param {NotifyOptions} opts
 * @returns {Promise<{ok: true, sentTo: string[], throttled: string[], skipped: string[]}>}
 */
async function send(opts) {
  const { event, subject, html, text, throttleKey, meta } = opts;
  if (!event || !subject || (!html && !text)) {
    throw new Error('adminNotify.send requires {event, subject, html|text}');
  }

  const sentTo = [];
  const throttled = [];
  const skipped = [];

  try {
    pruneThrottleCache();

    // Pull every super_admin (and opted-in admin) with their email + prefs.
    const r = await pool.query(
      `SELECT u.id, u.email, au.role, au.notification_preferences
         FROM admin_users au
         JOIN users u ON au.user_id = u.id
        WHERE au.role IN ('super_admin', 'admin')`
    );

    // If no admins are configured yet (fresh deploy), fall back to seed emails.
    const recipients = r.rows.length > 0
      ? r.rows.map(row => ({
          email: (row.notification_preferences?.email) || row.email,
          prefs: row.notification_preferences || {},
          role:  row.role,
        }))
      : seedEmails().map(em => ({ email: em, prefs: {}, role: 'super_admin' }));

    for (const recipient of recipients) {
      const eventEnabled = recipient.prefs?.events?.[event] ?? EVENT_DEFAULTS[event] ?? false;
      if (!eventEnabled) {
        skipped.push(recipient.email);
        continue;
      }

      // Throttle key is per-recipient so different admins all get their own copy.
      if (throttleKey) {
        const tkey = `${recipient.email}|${event}|${throttleKey}`;
        const last = throttleCache.get(tkey);
        const windowMs = (recipient.prefs?.throttle_minutes ?? 30) * 60 * 1000;
        if (last && (Date.now() - last) < windowMs) {
          throttled.push(recipient.email);
          continue;
        }
        throttleCache.set(tkey, Date.now());
      }

      try {
        await email.sendMail({
          to: recipient.email,
          subject,
          html,
          text,
        });
        sentTo.push(recipient.email);
      } catch (err) {
        // Per-recipient failure must not block other recipients.
        logger.warn('admin_notify_recipient_failed', {
          recipient: recipient.email, event, error: err.message,
        });
      }
    }

    // Audit the dispatch — useful for forensic review later.
    try {
      await audit.record({
        event: `admin_notify.${event}`,
        meta: { subject, sentTo, throttled, skipped, ...(meta || {}) },
      });
    } catch { /* audit failures are non-fatal */ }

    return { ok: true, sentTo, throttled, skipped };
  } catch (err) {
    logger.warn('admin_notify_failed', { event, error: err.message });
    return { ok: false, error: err.message, sentTo, throttled, skipped };
  }
}

/**
 * Check if there have been N+ failed logins for an email or IP in the last
 * window minutes. Used to gate the login_failed_threshold notification so we
 * fire exactly once when crossing the threshold.
 *
 * Returns true only when the *current* failure pushes the count to == threshold
 * (so we don't fire on every subsequent fail past threshold).
 */
async function shouldFireFailedLoginThreshold({ email: failEmail, ip, threshold = 5, windowMinutes = 15 }) {
  if (!failEmail && !ip) return false;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM audit_log
        WHERE event = 'auth.login.failed'
          AND created_at > NOW() - INTERVAL '${Number(windowMinutes)} minutes'
          AND (
              (meta->>'email') = $1
              OR ip = $2
          )`,
      [failEmail || '', ip || '']
    );
    return r.rows[0]?.c === threshold;
  } catch {
    return false;
  }
}

module.exports = {
  send,
  shouldFireFailedLoginThreshold,
  EVENT_DEFAULTS,
};
