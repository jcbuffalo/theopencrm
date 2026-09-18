// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Twilio SMS adapter. Mirrors the graceful-fallback pattern used by
// services/email.js: if any required env var is missing we log a
// console.info line describing what we *would* have sent and return
// 'skipped', so dev environments and unconfigured staging deploys keep
// working without throwing.
//
// USAGE:
//   const sms = require('./services/sms');
//   const outcome = await sms.sendSms('+15555550123', 'Hello from CRM');
//   // outcome ∈ {'sent', 'skipped', 'failed'}
//
// CONFIG (all three required to actually send):
//   TWILIO_ACCOUNT_SID   — starts with 'AC'
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER   — your purchased Twilio number, E.164 (e.g. +15555550100)
//
// Catches and logs all errors; never throws.

const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER  = process.env.TWILIO_FROM_NUMBER;

let cachedClient = null;
let cachedClientError = null;

function getClient() {
  if (cachedClient || cachedClientError) return cachedClient;
  try {
    // Lazy-require so a missing twilio package doesn't crash boot for
    // unconfigured environments. If TWILIO_* env vars are set but the SDK
    // isn't installed, we log once and degrade to skipped.
    const twilio = require('twilio');
    cachedClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (err) {
    cachedClientError = err;
    console.warn('[sms] twilio SDK not installed; install `twilio` to enable SMS sends. Degrading to skipped. Error:', err.message);
  }
  return cachedClient;
}

function isConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

/**
 * Send an SMS to a phone number.
 *
 * @param {string} toPhone — E.164 destination (+<country><number>). Falsy → skipped.
 * @param {string} body    — message text. Falsy → skipped.
 * @returns {Promise<'sent'|'skipped'|'failed'>}
 */
async function sendSms(toPhone, body) {
  if (!toPhone || !body) {
    console.info('[sms] graceful fallback — missing to/body, nothing to send');
    return 'skipped';
  }

  if (!isConfigured()) {
    console.info(`[sms] graceful fallback — Twilio not configured; would have sent to ${toPhone}`);
    return 'skipped';
  }

  const client = getClient();
  if (!client) {
    // SDK missing despite env vars being set.
    return 'skipped';
  }

  try {
    const msg = await client.messages.create({
      from: TWILIO_FROM_NUMBER,
      to:   toPhone,
      body: String(body).slice(0, 1600), // Twilio caps at 1600 chars across segments
    });
    console.info(`[sms] sent to ${toPhone}, sid=${msg.sid}`);
    return 'sent';
  } catch (err) {
    console.warn(`[sms] send to ${toPhone} failed:`, err.message || err);
    return 'failed';
  }
}

module.exports = {
  sendSms,
  isConfigured,
};
