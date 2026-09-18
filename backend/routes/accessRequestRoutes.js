// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public-facing "Request Access" endpoint. Anyone can submit one; the result
// lands as a pending_approval user that an admin can later approve or reject.
//
// LIABILITY: The requestor is responsible for the accuracy of any information
// they provide. Approval is at the sole discretion of the operator. See the
// project LICENSE for the full disclaimer.

const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const pool = require('../db');
const audit = require('../services/audit');
const email = require('../services/email');
const { validatePassword } = require('../auth');
const { initialStatusFor, ensureSuperAdmin, isSeedAdmin, seedEmails, isOpenSignup } = require('../services/bootstrapAdmin');
const { validateBody } = require('../middleware/validate');
const { createSchema } = require('../schemas/accessRequests');
const { publicFormLimiter } = require('../middleware/rateLimits');

/**
 * POST /api/request-access  — public, no auth required
 *
 * Body: { name, email, password, company?, reason? }
 *
 * Always returns 202 with `pending: true` and a generic message — the same
 * response is returned for new requests, duplicate-email retries, and seed-admin
 * pre-registrations, so the endpoint cannot be used to enumerate existing
 * accounts.
 */
router.post('/', publicFormLimiter, validateBody(createSchema), async (req, res) => {
  try {
    const { name, email: rawEmail, password, company, reason } = req.body;
    // zod has already enforced: name/email/password present (and email regex
    // matched + length capped). Strength policy still runs below — that's the
    // bigger gate (validatePassword from auth.js).

    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) {
      return res.status(400).json({ success: false, error: pwCheck.error });
    }

    const normalizedEmail = String(rawEmail).trim().toLowerCase();
    // With OPEN_SIGNUP the account activates immediately, so the response says
    // "sign in now" — and the SAME response is used for the existing-account
    // branch below, so the two cases stay indistinguishable (no enumeration).
    const genericResponse = isOpenSignup()
      ? {
          success: true,
          pending: false,
          active: true,
          message: 'Your account is ready — you can sign in now.',
        }
      : {
          success: true,
          pending: true,
          message: 'Your access request has been submitted. An admin will review it; you will receive an email when access is granted.',
        };

    // Existing account: don't leak whether it exists. Just return the generic
    // pending-style response.
    const existing = await pool.query('SELECT id, status FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      audit.fromReq(req, {
        event: 'access_request.duplicate',
        targetType: 'user',
        targetId: existing.rows[0].id,
        meta: { email: normalizedEmail, existingStatus: existing.rows[0].status },
      });
      return res.status(202).json(genericResponse);
    }

    const passwordHash = await bcryptjs.hash(password, await bcryptjs.genSalt(10));
    const status = initialStatusFor(normalizedEmail);

    const insert = await pool.query(
      `INSERT INTO users (email, name, password_hash, status, request_company, request_reason, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
       RETURNING id, email, name, status`,
      [normalizedEmail, String(name).trim(), passwordHash, status, company || null, reason || null]
    );
    const newUser = insert.rows[0];

    // Personal workspace org so the user has somewhere to land if/when approved.
    // limits_tier='free' arms the tier caps for new self-serve orgs.
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, owner_user_id, limits_tier) VALUES ($1, $2, 'free') RETURNING id`,
      [`${newUser.name || newUser.email}'s Workspace`, newUser.id]
    );
    if (orgResult.rows[0]) {
      await pool.query('UPDATE users SET org_id = $1, org_role = $2 WHERE id = $3', [orgResult.rows[0].id, 'owner', newUser.id]);
    }

    // Seed admins skip approval — bootstrap their admin row so the first sign-in works.
    if (isSeedAdmin(normalizedEmail)) {
      await ensureSuperAdmin(newUser.id, normalizedEmail);
    }

    audit.fromReq(req, {
      event: 'access_request.submitted',
      actorUserId: newUser.id,
      targetType: 'user',
      targetId: newUser.id,
      meta: { email: normalizedEmail, company: company || null, status },
    });

    // Best-effort admin notification — never blocks the response.
    notifyAdminsOfNewRequest({ user: newUser, company, reason }).catch(err => {
      if (req.log) req.log.warn('admin_notify_failed', { error: err.message });
    });

    res.status(202).json(genericResponse);
  } catch (error) {
    if (req.log) req.log.error('access_request_failed', { error });
    res.status(500).json({ success: false, error: 'Failed to submit request', requestId: req.requestId });
  }
});

async function notifyAdminsOfNewRequest({ user, company, reason }) {
  if (!email.isConfigured()) return;
  const seedAdminAddresses = seedEmails();
  const productName = process.env.PRODUCT_NAME || 'The Open CRM';
  const subject = `[${productName}] Access request from ${user.name} (${user.email})`;
  const html = `
    <p>A new access request has been submitted.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
      <tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Name</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${user.name}</td></tr>
      <tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Email</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${user.email}</td></tr>
      ${company ? `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Company</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${company}</td></tr>` : ''}
      ${reason ? `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Reason</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${String(reason).replace(/</g, '&lt;')}</td></tr>` : ''}
    </table>
    <p>Review and approve/reject in the admin dashboard:<br>
    <a href="https://app.theopencrm.com/admin/access-requests">https://app.theopencrm.com/admin/access-requests</a></p>
  `;
  for (const to of seedAdminAddresses) {
    try {
      await email.sendMail({ to, subject, html });
      console.log('access_request_notify_sent', { to });
    } catch (err) {
      // Per-recipient failure must not block the other recipients, but a
      // silent swallow made transport problems invisible in the logs.
      console.warn('access_request_notify_failed', { to, error: err && err.message });
    }
  }
}

module.exports = router;
