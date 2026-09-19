// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org outbound sender identity — the From: display name and Reply-To
// every customer-facing email (one-off composer sends, sequence steps) goes
// out with. Set by an org owner/admin on Settings → Workspace; stored on
// organizations.branding.email = { senderName, replyTo } (migration 055's
// JSONB — a name + an address need no encryption, and reusing the branding
// blob means no new migration and PUT /api/org's merge semantics apply).
//
// Resolution (getSenderIdentity):
//   fromName : branding.email.senderName → branding.displayName → org name
//   replyTo  : branding.email.replyTo    → (caller-supplied fallback, e.g.
//              the sending user's own address for one-off sends) → none
//
// The envelope From ADDRESS is always the platform transport's (SMTP_FROM /
// GMAIL_USER) — only the display name is per-org. That's the same posture
// every hosted mailer takes: the name is yours, the sending domain is ours.

const pool = require('../db');

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;

// Strip characters that could break or forge a header: CR/LF, angle
// brackets (would inject an address), quotes (we quote the name ourselves).
function cleanName(v) {
  if (v == null) return null;
  const s = String(v).replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_NAME) : null;
}

// Validate a { sender_name, reply_to } payload. Returns { value } (each
// field null when cleared) or { error } (400 body text). Absent keys are
// left undefined so the route can leave them alone.
function normalizeInput(body) {
  const out = {};
  const b = body || {};
  if ('sender_name' in b) {
    if (b.sender_name != null && typeof b.sender_name !== 'string') return { error: 'sender_name must be a string or null' };
    const cleaned = cleanName(b.sender_name);
    if (b.sender_name && String(b.sender_name).trim() && !cleaned) return { error: 'sender_name contains only characters that cannot appear in a From: name' };
    out.sender_name = cleaned;
  }
  if ('reply_to' in b) {
    if (b.reply_to != null && typeof b.reply_to !== 'string') return { error: 'reply_to must be an email address or null' };
    const t = b.reply_to == null ? '' : b.reply_to.trim();
    if (t && (t.length > 254 || !EMAIL_RX.test(t) || /[\r\n<>,;]/.test(t))) return { error: 'reply_to must be a valid email address' };
    out.reply_to = t ? t.toLowerCase() : null;
  }
  if (!('sender_name' in out) && !('reply_to' in out)) return { error: 'Provide sender_name and/or reply_to' };
  return { value: out };
}

// Pure resolver from an organizations row ({ name, branding }) — used by the
// sequence worker, whose due-scan already joins the org columns, so no extra
// query per step. Tolerates a missing / malformed row.
function resolveFromOrg(org, { fallbackReplyTo = null } = {}) {
  const orgName = (org && org.name) || null;
  const branding = (org && org.branding && typeof org.branding === 'object') ? org.branding : {};
  const stored = (branding.email && typeof branding.email === 'object') ? branding.email : {};
  const senderName = cleanName(stored.senderName) || null;
  const replyTo = typeof stored.replyTo === 'string' && EMAIL_RX.test(stored.replyTo.trim()) ? stored.replyTo.trim() : null;
  return {
    org_name: orgName,
    sender_name: senderName,
    reply_to: replyTo,
    // What actually goes on the wire.
    fromName: senderName || cleanName(branding.displayName) || orgName || null,
    fromNameIsCustom: !!senderName,
    replyTo: replyTo || fallbackReplyTo || null,
  };
}

// Read the stored (raw) identity + the effective values for an org.
// Never throws: an unknown org or a DB error yields platform defaults.
async function getSenderIdentity(orgId, opts = {}) {
  let org = null;
  if (orgId) {
    try {
      const r = await pool.query(`SELECT name, branding FROM organizations WHERE id = $1`, [orgId]);
      org = (r && r.rows && r.rows[0]) || null;
    } catch { /* platform defaults */ }
  }
  return resolveFromOrg(org, opts);
}

// Persist { sender_name?, reply_to? } for an org (merge into branding.email).
// Returns the refreshed identity.
async function saveSenderIdentity(orgId, value) {
  const cur = await pool.query(`SELECT branding FROM organizations WHERE id = $1`, [orgId]);
  if (cur.rows.length === 0) return null;
  const branding = (cur.rows[0].branding && typeof cur.rows[0].branding === 'object') ? cur.rows[0].branding : {};
  const email = { ...((branding.email && typeof branding.email === 'object') ? branding.email : {}) };
  if ('sender_name' in value) { if (value.sender_name) email.senderName = value.sender_name; else delete email.senderName; }
  if ('reply_to' in value) { if (value.reply_to) email.replyTo = value.reply_to; else delete email.replyTo; }
  await pool.query(
    `UPDATE organizations
        SET branding = COALESCE(branding, '{}'::jsonb) || jsonb_build_object('email', $2::jsonb),
            updated_at = NOW()
      WHERE id = $1`,
    [orgId, JSON.stringify(email)]
  );
  return getSenderIdentity(orgId);
}

module.exports = { getSenderIdentity, resolveFromOrg, saveSenderIdentity, normalizeInput, cleanName, EMAIL_RX };
