// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Auto-promotes a configured set of emails to super_admin the first time those
// users sign in or register. The bootstrap is idempotent — calling it on every
// auth flow is safe.
//
// Configure via SEED_ADMIN_EMAILS (comma-separated). Defaults to:
//   johncolesassistant@gmail.com, johnbcoles@gmail.com
//
// LIABILITY: Operators who deploy this Software are responsible for setting
// SEED_ADMIN_EMAILS to the appropriate value for their environment. Leaving the
// default in place will grant super-admin to those addresses if they ever
// register on your instance.

const pool = require('./../db');
const logger = require('./logger');

const DEFAULT_SEED_EMAILS = ['johncolesassistant@gmail.com', 'johnbcoles@gmail.com'];

function seedEmails() {
  const fromEnv = (process.env.SEED_ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_SEED_EMAILS.map(s => s.toLowerCase());
}

function isSeedAdmin(email) {
  if (!email) return false;
  return seedEmails().includes(String(email).trim().toLowerCase());
}

/**
 * Ensure the user has a super_admin row in admin_users. No-op if they already
 * have any admin_users row (we don't downgrade higher privileges, but we do
 * upgrade to super_admin if they currently sit at a lower role and they're a
 * seed email — operators expect the seed list to be authoritative).
 */
async function ensureSuperAdmin(userId, email) {
  if (!isSeedAdmin(email)) return false;
  try {
    const existing = await pool.query('SELECT id, role FROM admin_users WHERE user_id = $1', [userId]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO admin_users (user_id, role, permissions)
         VALUES ($1, 'super_admin', ARRAY['manage_users','manage_admins','view_audit_logs','approve_access']::TEXT[])`,
        [userId]
      );
      logger.notice('seed_admin_promoted', { userId, email });
      return true;
    }
    if (existing.rows[0].role !== 'super_admin') {
      await pool.query(
        `UPDATE admin_users SET role = 'super_admin', updated_at = NOW() WHERE user_id = $1`,
        [userId]
      );
      logger.notice('seed_admin_upgraded', { userId, email, previousRole: existing.rows[0].role });
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('seed_admin_failed', { userId, email, error: err.message });
    return false;
  }
}

/**
 * Whether this deployment lets anyone sign up and start using their own
 * workspace immediately (OPEN_SIGNUP=true), versus holding every non-seed
 * signup in pending_approval until a platform admin reviews it (the default —
 * unchanged from before the env toggle existed).
 */
function isOpenSignup() {
  const v = String(process.env.OPEN_SIGNUP || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Determine the initial status for a freshly-registering user. Seed admins
 * skip approval; with OPEN_SIGNUP=true everyone does; otherwise the user is
 * held in pending_approval until reviewed.
 */
function initialStatusFor(email) {
  if (isSeedAdmin(email)) return 'active';
  if (isOpenSignup()) return 'active';
  return 'pending_approval';
}

// Profile bootstrap: certain seed emails get specific workflow profiles applied
// to their personal workspace org. Idempotent — safe to call repeatedly.
const PROFILE_SEEDS = {
  'johnbcoles@gmail.com': 'zang',
  // johncolesassistant@gmail.com → defaults to 'generic' (no entry needed)
};

async function ensureOrgProfile(userId, emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const desired = PROFILE_SEEDS[email];
  if (!desired) return null;
  try {
    await pool.query(
      `UPDATE organizations SET profile = $1
       WHERE owner_user_id = $2 AND (profile IS NULL OR profile = 'generic')`,
      [desired, userId]
    );
    return desired;
  } catch (err) {
    logger.warn('seed_org_profile_failed', { userId, email, error: err.message });
    return null;
  }
}

module.exports = {
  isSeedAdmin,
  isOpenSignup,
  ensureSuperAdmin,
  initialStatusFor,
  seedEmails,
  ensureOrgProfile,
};
