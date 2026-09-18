// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Portal service (migration 141).
//
// Token model: a portal token is a 192-bit random hex credential that grants
// an EXTERNAL viewer read-only access to EXACTLY ONE company's whitelisted
// data within one tenant. Everything here is built around two invariants:
//
//   1. STRICT SINGLE-COMPANY SCOPING — every read helper takes the resolved
//      token row and filters by BOTH the tenant scope (org_id, with the
//      user_id fallback personal workspaces use everywhere else) AND the
//      token's company_id. There is no code path that accepts a caller-
//      supplied company or org id on the public surface.
//
//   2. FIELD WHITELISTS — SELECT lists are explicit. Internal-only columns
//      (deal notes/description, AI health/win-probability/risk columns,
//      company notes/revenue, document notes, owner ids) never appear in a
//      portal query, so they cannot leak even if a response serializer
//      changes later.
//
// resolveToken() is the single trust boundary: format-gate → active + not
// expired → org's portal_enabled flag re-checked per token (the public mount
// can't use requireFeature — there is no session, and the gate fails open
// without one; see the surveys mount comment in index.js). Every failure mode
// returns null so the routes 404 generically — no oracle distinguishing
// unknown / revoked / expired / flag-off.

const crypto = require('crypto');
const path = require('path');
const pool = require('../db');
const featureFlags = require('./featureFlags');
const storage = require('./storage');

// Quick-reject malformed tokens before touching the DB. Same format gate the
// lead-form and survey public surfaces use: wide enough to stay a format
// check, not a second secret.
function validTokenFormat(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

// Tenant scope for a resolved token row — mirrors qs(req).
function tokenScope(t) {
  return t.org_id ? ['org_id', t.org_id] : ['user_id', t.user_id];
}

/**
 * Mint a new portal token for one company.
 *
 * @param {{userId:number, orgId:?number}} scope   the CALLER's tenancy (from req)
 * @param {number} companyId                        must already be validated in-scope by the route
 * @param {{contactId:?number, label:?string, expiresAt:?string, createdBy:?number}} opts
 * @returns the inserted row
 */
async function mintToken(scope, companyId, { contactId = null, label = null, expiresAt = null, createdBy = null } = {}) {
  // 192-bit random hex — treated as a credential: unguessable, never derived
  // from ids. Same shape as lead_forms.public_token / survey response tokens.
  const token = crypto.randomBytes(24).toString('hex');
  const result = await pool.query(
    `INSERT INTO portal_tokens (user_id, org_id, company_id, contact_id, token, label, expires_at, created_by, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
    [scope.userId, scope.orgId || null, companyId, contactId, token, label, expiresAt, createdBy || scope.userId]
  );
  return result.rows[0];
}

/**
 * Resolve a public token → the token row ({ org_id, user_id, company_id, … })
 * or null. Null on: malformed, unknown, revoked (is_active=false), expired,
 * org-less (no kill switch could apply — treated as disabled), or the owning
 * org has portal_enabled off. Callers 404 generically on null.
 *
 * Side effect (the ONLY public-surface mutation): stamps last_accessed_at,
 * best-effort — a failed stamp never blocks the read.
 */
async function resolveToken(token) {
  if (!validTokenFormat(token)) return null;
  const result = await pool.query(
    `SELECT id, user_id, org_id, company_id, contact_id, is_active, expires_at
       FROM portal_tokens
      WHERE token = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  // The portal is an org/account feature. Org-less (user_id-scoped) tokens
  // have no org whose portal_enabled flag could ever turn them off — they
  // would serve forever with no kill switch — so they are treated as disabled
  // outright (same generic 404 upstream). Minting without an org is rejected
  // at the route; this covers any legacy rows.
  if (!row.org_id) return null;
  // Org turned the module off → the public surface disappears too.
  const enabled = await featureFlags.hasFeature(row.org_id, 'portal_enabled');
  if (!enabled) return null;
  // Best-effort access stamp — never fails the read.
  await pool.query(
    `UPDATE portal_tokens SET last_accessed_at = NOW() WHERE id = $1`,
    [row.id]
  ).catch(() => {});
  return row;
}

/**
 * Overview: company profile basics + rollup counts + quotes/invoices when the
 * tenant has them. WHITELISTED fields only — no notes, no revenue, no owner,
 * no health scores. Quotes/invoices reads are tolerant (try/catch → []) so a
 * tenant without those modules/tables still gets a working overview.
 */
async function getOverview(t) {
  const [sf, sv] = tokenScope(t);

  const companyRes = await pool.query(
    `SELECT name, industry, website, location FROM companies
      WHERE id = $2 AND ${sf} = $1`,
    [sv, t.company_id]
  );
  const company = companyRes.rows[0] || null;
  if (!company) return null; // company deleted or re-scoped since mint → treat as gone

  const dealCounts = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE stage NOT ILIKE '%closed%' AND stage NOT ILIKE '%won%' AND stage NOT ILIKE '%lost%')::int AS open
       FROM deals WHERE company_id = $2 AND ${sf} = $1`,
    [sv, t.company_id]
  );

  // Customer quotes (Zang quotes module) — safe subset. Tolerant tail.
  // portal_response* (migration 149) is the customer's OWN prior response —
  // fine to echo back; internal notes/revisions stay excluded.
  let quotes = [];
  try {
    const r = await pool.query(
      `SELECT id, title, status, total_amount, valid_until, created_at,
              portal_response, portal_response_at
         FROM quotes WHERE customer_id = $2 AND ${sf} = $1
        ORDER BY created_at DESC LIMIT 50`,
      [sv, t.company_id]
    );
    quotes = r.rows;
  } catch (_) { /* module absent for this tenant — omit */ }

  // v2 invoices — org-scoped only (the table has no user_id column). Tolerant.
  let invoices = [];
  if (t.org_id) {
    try {
      const r = await pool.query(
        `SELECT invoice_number, status, total_amount, due_date, paid_at, created_at
           FROM invoices WHERE customer_id = $2 AND org_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [t.org_id, t.company_id]
      );
      invoices = r.rows;
    } catch (_) { /* phase2 tables absent — omit */ }
  }

  return {
    company, // { name, industry, website, location } — nothing else
    deals: dealCounts.rows[0] || { total: 0, open: 0 },
    quotes,
    invoices,
  };
}

/**
 * Deals visible to the portal: name/stage/value/dates ONLY. Explicitly NOT
 * selected: description, notes, ai_health_score, ai_win_probability,
 * ai_risk_factors, tags — internal-only.
 */
async function getDeals(t) {
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `SELECT id, title, stage, amount, expected_close_date, closed_date, created_at
       FROM deals WHERE company_id = $2 AND ${sf} = $1
      ORDER BY created_at DESC LIMIT 200`,
    [sv, t.company_id]
  );
  return result.rows;
}

// The single scoping predicate for portal-visible documents: attached to the
// token's company directly, or to one of THAT company's deals. Written once so
// list and download cannot drift apart.
const PORTAL_DOC_SCOPE = (sf) => `
      d.${sf} = $1
      AND (
        (d.related_type = 'company' AND d.related_id = $2)
        OR (d.related_type = 'deal' AND d.related_id IN
             (SELECT id FROM deals WHERE ${sf} = $1 AND company_id = $2))
      )`;

/**
 * Documents attached to this company (or its deals). Whitelist: no notes, no
 * uploader identity, no storage paths.
 */
async function getDocuments(t) {
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `SELECT d.id, d.filename, d.doc_type, d.size, d.mime_type, d.created_at
       FROM documents d
      WHERE ${PORTAL_DOC_SCOPE(sf)}
      ORDER BY d.created_at DESC LIMIT 200`,
    [sv, t.company_id]
  );
  return result.rows;
}

/**
 * Fetch ONE document for download — same predicate as the list, so a document
 * id belonging to another company/org resolves to nothing (generic 404).
 * Returns { filename, mime_type, content, gcs_object_path } or null.
 */
async function getDocumentForDownload(t, docId) {
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `SELECT d.filename, d.mime_type, d.content, d.gcs_object_path
       FROM documents d
      WHERE d.id = $3 AND ${PORTAL_DOC_SCOPE(sf)}`,
    [sv, t.company_id, docId]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Portal case submission (migration 148) — the ONE public write beyond the
// last_accessed_at stamp. Same invariants as the reads: tenancy comes ONLY
// from the resolved token row (no caller-supplied org/company id is ever
// read), and everything client-supplied is length-capped, tag-stripped text
// or an allowlisted enum.
// ---------------------------------------------------------------------------

const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent']; // mirrors schemas/cases.js

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 5000;

// Defense-in-depth text scrub for anonymous input: coerce to string, strip
// HTML tags (portal text must never render as markup anywhere downstream),
// drop control characters (keep \n and \t for readable descriptions), trim,
// hard length cap. React escapes on render anyway — this keeps the STORED
// value inert for any non-React consumer (emails, exports, plugins).
function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/</g, '')  // drop any lone '<' an unclosed tag leaves
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Create a support case from a portal submission. Scoping comes ONLY from the
 * resolved token row `t` — org_id, user_id (tenant attribution, same fallback
 * the reads use), company_id, and contact_id (when the link was minted for a
 * specific contact) are all threaded from the token; the body contributes
 * nothing but sanitized text + an allowlisted priority.
 *
 * Returns { case_id } or { error } (validation only — DB errors throw and the
 * route 500s generically).
 */
async function submitCase(t, body = {}) {
  const subject = sanitizeText(body.subject, SUBJECT_MAX);
  // Accept `message` as an alias — it's what the portal form naturally calls it.
  const description = sanitizeText(body.description !== undefined ? body.description : body.message, DESCRIPTION_MAX);
  if (!subject) return { error: 'A brief subject is required' };
  const priority = CASE_PRIORITIES.includes(body.priority) ? body.priority : 'normal';
  const result = await pool.query(
    `INSERT INTO cases (user_id, org_id, company_id, contact_id, subject, description, status, priority, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 'portal') RETURNING id`,
    [t.user_id, t.org_id, t.company_id, t.contact_id || null, subject, description || null, priority]
  );
  return { case_id: result.rows[0].id };
}

/**
 * The token company's OWN portal-submitted cases, so a portal user can see
 * the status of tickets they filed. Double-filtered: tenant scope + company
 * + source='portal' — internal (app-created) cases for the same company are
 * NOT visible here. Whitelist: subject/status/priority/timestamps only — no
 * description echo-back needed, and never internal fields (owner_user_id,
 * sla_due_at, notes).
 */
async function getCases(t) {
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `SELECT id, subject, status, priority, created_at, updated_at
       FROM cases
      WHERE ${sf} = $1 AND company_id = $2 AND source = 'portal'
      ORDER BY created_at DESC LIMIT 100`,
    [sv, t.company_id]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Portal quote response (migration 149) — approve / request changes. Same
// invariants as case submission: tenancy comes ONLY from the token row, the
// body contributes an allowlisted action + sanitized note, and the internal
// `status` lifecycle is NEVER touched from the public surface (the team is
// notified and transitions status in-app, confirm-first).
// ---------------------------------------------------------------------------

const QUOTE_RESPONSES = ['approved', 'changes_requested'];
const RESPONSE_NOTE_MAX = 2000;

/**
 * Record a customer's response to a quote shared in their portal.
 * The quote must belong to the token's company AND tenant (scoped UPDATE —
 * a foreign quote id resolves to nothing → caller 404s generically).
 * Latest response wins; each response re-stamps portal_response_at.
 *
 * Returns { quote_id, portal_response } | { error } (validation) | null
 * (quote not found in scope).
 */
async function respondToQuote(t, quoteId, body = {}) {
  // Guard the id shape ourselves: a non-numeric path segment must be a
  // generic 404, not a pg type-cast 500.
  const qid = Number(quoteId);
  if (!Number.isInteger(qid) || qid <= 0) return null;
  const action = body.action;
  if (!QUOTE_RESPONSES.includes(action)) {
    return { error: 'action must be "approved" or "changes_requested"' };
  }
  const note = sanitizeText(body.note, RESPONSE_NOTE_MAX) || null;
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `UPDATE quotes
        SET portal_response = $3, portal_response_note = $4, portal_response_at = NOW()
      WHERE id = $5 AND customer_id = $2 AND ${sf} = $1
      RETURNING id, portal_response`,
    [sv, t.company_id, action, note, qid]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { quote_id: row.id, portal_response: row.portal_response };
}

// ---------------------------------------------------------------------------
// Portal message thread (migration 150) — the CS-10 "comments" slice.
// A dedicated customer-visible table (NOT record_comments — see the 150
// migration header for why the boundary is structural). Same invariants as
// the other portal writes: tenancy only from the token row, sanitized text,
// author_type pinned server-side.
// ---------------------------------------------------------------------------

const MESSAGE_MAX = 3000;

/**
 * The token company's message thread, oldest-first (chat order). Whitelist:
 * team messages carry the member's display name so the customer sees who
 * replied; customer messages carry no identity beyond the label.
 */
async function getMessages(t) {
  const [sf, sv] = tokenScope(t);
  const result = await pool.query(
    `SELECT pm.id, pm.author_type, pm.body, pm.created_at,
            CASE WHEN pm.author_type = 'team' THEN u.name END AS author_name
       FROM portal_messages pm
       LEFT JOIN users u ON u.id = pm.author_user_id
      WHERE pm.${sf} = $1 AND pm.company_id = $2
      ORDER BY pm.created_at ASC, pm.id ASC
      LIMIT 500`,
    [sv, t.company_id]
  );
  return result.rows;
}

/**
 * Append a CUSTOMER message to the thread (public surface). author_type is
 * pinned 'customer' in SQL; author_user_id stays NULL. Returns the inserted
 * whitelisted row or { error } on validation failure.
 */
async function postMessage(t, body = {}) {
  const text = sanitizeText(body.body !== undefined ? body.body : body.message, MESSAGE_MAX);
  if (!text) return { error: 'A message is required' };
  const result = await pool.query(
    `INSERT INTO portal_messages (user_id, org_id, company_id, author_type, body)
     VALUES ($1, $2, $3, 'customer', $4)
     RETURNING id, author_type, body, created_at`,
    [t.user_id, t.org_id, t.company_id, text]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Portal document upload (migration 151) — the last CS-10 slice, and the most
// sensitive public write: unauthenticated file intake. Beyond the shared
// invariants (tenancy from the token only, strict write limiter), uploads add:
//
//   • EXTENSION + MIME ALLOWLIST — documents only. HTML/SVG/XML and anything
//     executable are refused: a stored markup file served back to an internal
//     user (the legacy DB-blob download path streams inline in-app) would be
//     a stored-XSS vector on the API origin.
//   • SIZE CAP — 10MB (multer enforces on the stream; PORTAL_UPLOAD_MAX_BYTES
//     is exported so the route and service can't drift).
//   • PER-COMPANY QUOTA — a hostile link-holder cannot fill the bucket.
//   • FILENAME SANITIZATION — basename only, control chars stripped, capped.
//   • uploaded_by NULL + source='portal' — external origin is explicit.
// ---------------------------------------------------------------------------

const PORTAL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const PORTAL_UPLOAD_QUOTA = 25;                   // portal-uploaded docs per company

// Allowlisted document types: extension → the MIME prefixes we accept for it.
// Both the extension AND the declared MIME must pass (defense-in-depth; the
// declared MIME is client-controlled, the extension drives how a later
// download is interpreted).
const PORTAL_UPLOAD_TYPES = {
  '.pdf':  ['application/pdf'],
  '.png':  ['image/png'],
  '.jpg':  ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.gif':  ['image/gif'],
  '.webp': ['image/webp'],
  '.txt':  ['text/plain'],
  '.csv':  ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.doc':  ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls':  ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt':  ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

function sanitizeFilename(name) {
  // Treat BOTH separators as path boundaries regardless of host OS:
  // path.basename only strips backslashes on Windows, so a Windows-style
  // traversal name ('..\\..\\boot.ini') uploaded to a Linux server kept its
  // dot-dot segments (underscored, so never traversable — but ugly, and the
  // behavior differed by platform; CI runs Linux, dev runs Windows).
  const lastSegment = String(name || '').split(/[\\/]/).pop();
  const base = path.basename(lastSegment);
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned || null;
}

/**
 * Validate + store a portal-uploaded file for the token's company.
 * `file` is the multer memory-storage object ({ originalname, buffer,
 * mimetype, size }). Returns the whitelisted inserted row, { error, status? }
 * on validation/quota failure. Mirrors the internal route's GCS-with-DB-blob
 * fallback so dev environments without a bucket still work.
 */
async function acceptDocument(t, file) {
  if (!file || !file.buffer || !file.size) return { error: 'A file is required' };
  if (file.size > PORTAL_UPLOAD_MAX_BYTES) {
    return { error: 'File is too large (10MB max)' };
  }

  const filename = sanitizeFilename(file.originalname);
  if (!filename) return { error: 'A valid filename is required' };
  const ext = path.extname(filename).toLowerCase();
  const allowedMimes = PORTAL_UPLOAD_TYPES[ext];
  const declaredMime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
  if (!allowedMimes || !allowedMimes.includes(declaredMime)) {
    return { error: 'File type not supported. Allowed: PDF, images, Office documents, TXT, CSV.' };
  }

  const [sf, sv] = tokenScope(t);

  // Per-company quota over portal-sourced rows only — internal uploads never
  // count against the customer, and vice versa.
  const quota = await pool.query(
    `SELECT COUNT(*)::int AS n FROM documents
      WHERE ${sf} = $1 AND related_type = 'company' AND related_id = $2 AND source = 'portal'`,
    [sv, t.company_id]
  );
  if (quota.rows[0].n >= PORTAL_UPLOAD_QUOTA) {
    return { error: 'Upload limit reached for this portal. Ask your account team to remove old files.', status: 409 };
  }

  let gcsObjectPath = null;
  let gcsBucket = null;
  try {
    const uploaded = await storage.uploadBuffer({
      orgId: t.org_id || t.user_id,
      relatedType: 'company',
      relatedId: t.company_id,
      filename,
      buffer: file.buffer,
      mimeType: declaredMime,
    });
    gcsObjectPath = uploaded.objectPath;
    gcsBucket = uploaded.bucket;
  } catch (err) {
    // GCS unavailable → DB-blob fallback, same 5MB bound as the internal route.
    if (file.size > 5 * 1024 * 1024) {
      return { error: 'Storage is temporarily unavailable — please try a smaller file or retry later.', status: 503 };
    }
  }

  const result = await pool.query(
    `INSERT INTO documents
       (user_id, org_id, related_type, related_id, doc_type, filename, content, size, mime_type, uploaded_by, gcs_object_path, gcs_bucket, source)
     VALUES ($1, $2, 'company', $3, 'other', $4, $5, $6, $7, NULL, $8, $9, 'portal')
     RETURNING id, filename, doc_type, size, mime_type, created_at`,
    [
      t.user_id, t.org_id, t.company_id, filename,
      gcsObjectPath ? null : file.buffer,
      file.size, declaredMime,
      gcsObjectPath, gcsBucket,
    ]
  );
  return result.rows[0];
}

module.exports = {
  validTokenFormat,
  mintToken,
  resolveToken,
  getOverview,
  getDeals,
  getDocuments,
  getDocumentForDownload,
  submitCase,
  getCases,
  respondToQuote,
  getMessages,
  postMessage,
  acceptDocument,
  sanitizeText,
  sanitizeFilename,
  CASE_PRIORITIES,
  QUOTE_RESPONSES,
  MESSAGE_MAX,
  PORTAL_UPLOAD_MAX_BYTES,
  PORTAL_UPLOAD_QUOTA,
  PORTAL_UPLOAD_TYPES,
};
