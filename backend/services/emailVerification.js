// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email-verification + welcome mail — shared by the signup handler
// (routes/accessRequestRoutes.js) and the unauthenticated resend endpoint
// (routes/authRoutes.js POST /auth/resend-verification), so the token-minting
// + mail shape can never drift between the two call sites.
//
// BUG THIS FIXES (2026-09-18 usability review, P0): password signup never
// minted `email_verification_token` or sent mail. With
// EMAIL_VERIFICATION_REQUIRED=true (prod), that stranded every new password
// signup — the first login always came back EMAIL_NOT_VERIFIED with no email
// in their inbox to click. The signup handler now calls sendVerificationEmail
// right after the INSERT.
//
// Both functions are BEST-EFFORT from the caller's point of view: they catch
// their own send errors and return { sent: false, error } rather than
// throwing, so a transport hiccup during signup never turns a 202 into a 500.
// (mintVerificationToken's DB write is NOT swallowed — a token that fails to
// persist is a real problem the caller should see.)

const crypto = require('crypto');
const pool = require('../db');
const email = require('./email');
const logger = require('./logger');

const VERIFICATION_TTL = '24 hours';

function productName() {
  return process.env.PRODUCT_NAME || 'The Open CRM';
}

// First configured origin — FRONTEND_URL may be a comma-separated list for
// multi-origin CORS (see services/envValidation.js); links only ever need one.
function frontendUrl() {
  const raw = process.env.FRONTEND_URL || 'https://app.theopencrm.com';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Mint a fresh 24h verification token for the user and persist it. Throws on
 * a real DB error — the caller decides how to handle that (signup treats it
 * as best-effort; resend-verification already success-shapes its response).
 */
async function mintVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `UPDATE users
        SET email_verification_token = $1,
            email_verification_expires = NOW() + INTERVAL '${VERIFICATION_TTL}',
            updated_at = NOW()
      WHERE id = $2`,
    [token, userId]
  );
  return token;
}

function verifyUrlFor(token) {
  return `${frontendUrl()}/verify-email?token=${token}`;
}

/**
 * Mint + send the verification email for a freshly-created (or re-requesting)
 * user. Best-effort on the SEND — the token is always minted/persisted first,
 * so a resend or the /verify-email link keeps working even if this particular
 * send fails or the deployment has no email transport configured yet.
 *
 * `userRow` needs at least { id, email, name }.
 * Returns { sent: boolean, token, error? }.
 */
async function sendVerificationEmail(userRow) {
  const token = await mintVerificationToken(userRow.id);
  const verifyUrl = verifyUrlFor(token);
  if (!email.isConfigured()) {
    logger.info('verification_email_not_configured', { userId: userRow.id });
    return { sent: false, token };
  }
  try {
    await email.sendMail({
      to: userRow.email,
      subject: `Verify your email — ${productName()}`,
      html: `<p>Hi ${userRow.name || ''},</p>
             <p>Click the link below to confirm your email so you can sign in:</p>
             <p><a href="${verifyUrl}">${verifyUrl}</a></p>
             <p>This link expires in 24 hours. If you didn't request this, ignore the message.</p>`,
      text: `Verify your email: ${verifyUrl}`,
    });
    return { sent: true, token };
  } catch (err) {
    logger.warn('verification_email_send_failed', { userId: userRow.id, error: err.message });
    return { sent: false, token, error: err.message };
  }
}

/**
 * Short, human welcome email — plain voice, no listicle. `pendingApproval`
 * changes the sign-in line since a held account can't sign in yet. Best-
 * effort: never throws, always resolves { sent, error? }.
 */
async function sendWelcomeEmail(userRow, { pendingApproval = false } = {}) {
  if (!email.isConfigured()) return { sent: false };
  const product = productName();
  const firstName = String(userRow.name || '').trim().split(/\s+/)[0] || 'there';
  const signInUrl = `${frontendUrl()}/login`;

  const paragraphs = pendingApproval
    ? [
        `Hi ${firstName},`,
        `Thanks for signing up for ${product}. Your request is in — an admin will review it and you'll get an email the moment you're approved.`,
        `Just reply to this email if you have any questions.`,
      ]
    : [
        `Hi ${firstName},`,
        `Welcome to ${product} — your workspace is ready.`,
        `Sign in here: ${signInUrl}`,
        `Just reply to this email if you get stuck — a real person reads these.`,
      ];

  try {
    await email.sendMail({
      to: userRow.email,
      subject: `Welcome to ${product}`,
      text: paragraphs.join('\n\n'),
      html: paragraphs.map((p) => `<p>${p.replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join('\n'),
    });
    return { sent: true };
  } catch (err) {
    logger.warn('welcome_email_send_failed', { userId: userRow.id, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = {
  mintVerificationToken,
  verifyUrlFor,
  sendVerificationEmail,
  sendWelcomeEmail,
};
