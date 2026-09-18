// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Portal (migration 141) — two routers in one file, mirroring the
// lead-form / survey pattern:
//
//   1. `router` — AUTHENTICATED token management, mounted at /api/portal
//      behind requireFeature('portal_enabled') (module flag, DEFAULT FALSE —
//      the whole feature ships inert). Org admins mint / list / revoke the
//      portal tokens for their own companies. Every query org-scopes via
//      qs(req).
//
//   2. `publicRouter` — the PUBLIC read surface, mounted at
//      /api/public/portal with NO auth. Threat model:
//        • per-IP rate limited (portalReadLimiter, mounted in index.js)
//        • CSRF-exempt (GET-only surface anyway, but the prefix is listed in
//          isCsrfExempt for forward-safety)
//        • tenancy resolved ONLY from the unguessable 192-bit token — no org
//          or company id ever appears in a request or response
//        • unknown / revoked / expired token and feature-flag-off all return
//          the SAME generic 404 (no existence oracle)
//        • READ-MOSTLY: beyond the best-effort last_accessed_at stamp inside
//          resolveToken(), the ONE public write is POST /:token/cases
//          (portal case submission, migration 148) — strictly rate-limited
//          (portalWriteLimiter), sanitized text + allowlisted enum only, and
//          every scoping value comes from the resolved token row
//        • every response is a WHITELISTED projection (services/portal.js) —
//          internal notes, AI scores, owner ids, storage paths never leave
//
// Document downloads reuse the same signed-URL machinery as the in-app
// /api/documents/:id/download route, but the lookup runs through the portal
// scoping predicate: a document id outside the token's company 404s.

const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { authMiddleware } = require('../auth');
const { portalWriteLimiter } = require('../middleware/rateLimits');
const notificationDispatcher = require('../services/notificationDispatcher');
const portal = require('../services/portal');
const storage = require('../services/storage');

// Portal upload intake (migration 151): memory storage like the internal
// documents route, but a 10MB cap (vs 50MB) and exactly one file per request.
const portalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: portal.PORTAL_UPLOAD_MAX_BYTES, files: 1 },
});

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// ---------------------------------------------------------------------------
// Authenticated token management — /api/portal (gated portal_enabled)
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(authMiddleware);

// Minting an externally-shareable credential (and reading token values back)
// is privileged — same owner/admin gate as segment bulk actions
// (segmentRoutes.js). Org members who aren't owner/admin get a 403 on EVERY
// token-management route. Users without an org are their own admin here
// (they can still list/revoke legacy rows), but minting additionally
// requires an org — see the POST /tokens guard below.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// ---- Portal message thread (migration 150) — MEMBER-level, mounted BEFORE
// the admin gate below: any org member can read and reply to a customer's
// portal thread; only credential management (tokens) is owner/admin-only.

// GET /messages?company_id=… — the thread for one in-scope company.
router.get('/messages', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const companyId = Number(req.query.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: 'company_id is required' });
    }
    const result = await pool.query(
      `SELECT pm.id, pm.author_type, pm.author_user_id, pm.body, pm.created_at,
              u.name AS author_name
         FROM portal_messages pm
         LEFT JOIN users u ON u.id = pm.author_user_id
        WHERE pm.${sf} = $1 AND pm.company_id = $2
        ORDER BY pm.created_at ASC, pm.id ASC
        LIMIT 500`,
      [sv, companyId]
    );
    res.json(result.rows);
  } catch (error) {
    if (req.log) req.log.error('portal_messages_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch portal messages' });
  }
});

// POST /messages { company_id, body } — team reply. The company must be
// in-scope (same guard as token minting); author_type pinned 'team'.
router.post('/messages', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const body = req.body || {};
    const companyId = Number(body.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: 'company_id is required' });
    }
    const companyRes = await pool.query(
      `SELECT id FROM companies WHERE id = $1 AND ${sf} = $2`,
      [companyId, sv]
    );
    if (companyRes.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const text = portal.sanitizeText(body.body, portal.MESSAGE_MAX);
    if (!text) return res.status(400).json({ error: 'A message is required' });
    const result = await pool.query(
      `INSERT INTO portal_messages (user_id, org_id, company_id, author_type, author_user_id, body)
       VALUES ($1, $2, $3, 'team', $4, $5)
       RETURNING id, author_type, author_user_id, body, created_at`,
      [req.userId, req.orgId || null, companyId, req.userId, text]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('portal_message_post_failed', { error });
    res.status(500).json({ error: 'Failed to post portal message' });
  }
});

router.use((req, res, next) => {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can manage portal links' });
  }
  next();
});

// GET /tokens?company_id=… — list this tenant's portal tokens (optionally for
// one company). Returns the token value: these are the org's OWN credentials,
// and the admin needs it to build the shareable link.
router.get('/tokens', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    let sql = `
      SELECT pt.id, pt.company_id, pt.contact_id, pt.token, pt.label, pt.is_active,
             pt.expires_at, pt.last_accessed_at, pt.created_by, pt.created_at,
             c.name AS company_name
        FROM portal_tokens pt
        LEFT JOIN companies c ON c.id = pt.company_id
       WHERE pt.${sf} = $1`;
    const params = [sv];
    if (req.query.company_id) {
      sql += ` AND pt.company_id = $2`;
      params.push(req.query.company_id);
    }
    sql += ` ORDER BY pt.created_at DESC`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (error) {
    if (req.log) req.log.error('portal_tokens_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch portal tokens' });
  }
});

// POST /tokens — mint a token for one in-scope company.
router.post('/tokens', async (req, res) => {
  try {
    // The portal is an org/account feature: org-less (user_id-scoped) tokens
    // would bypass the portal_enabled kill switch (feature flags are an org
    // concept), so minting without an org is rejected outright. resolveToken
    // enforces the same rule on the public surface for any legacy rows.
    if (!req.orgId) {
      return res.status(403).json({ error: 'The customer portal requires an organization' });
    }
    const [sf, sv] = qs(req);
    const body = req.body || {};
    const companyId = Number(body.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: 'company_id is required' });
    }

    // The company must be visible to the CALLER's tenancy — a cross-org
    // company id 404s here, so a token can never be minted pointing outside
    // the caller's own data.
    const companyRes = await pool.query(
      `SELECT id FROM companies WHERE id = $1 AND ${sf} = $2`,
      [companyId, sv]
    );
    if (companyRes.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Optional contact linkage — validated in-scope too; out-of-scope ids are
    // rejected rather than silently stored.
    let contactId = null;
    if (body.contact_id !== undefined && body.contact_id !== null) {
      const cid = Number(body.contact_id);
      if (!Number.isInteger(cid) || cid <= 0) {
        return res.status(400).json({ error: 'contact_id must be a positive integer' });
      }
      const contactRes = await pool.query(
        `SELECT id FROM contacts WHERE id = $1 AND ${sf} = $2`,
        [cid, sv]
      );
      if (contactRes.rows.length === 0) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      contactId = cid;
    }

    // Optional expiry — must parse and be in the future.
    let expiresAt = null;
    if (body.expires_at) {
      const d = new Date(body.expires_at);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'expires_at must be a future date' });
      }
      expiresAt = d.toISOString();
    }

    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 255) || null : null;

    const row = await portal.mintToken(
      { userId: req.userId, orgId: req.orgId || null },
      companyId,
      { contactId, label, expiresAt, createdBy: req.userId }
    );
    res.status(201).json(row);
  } catch (error) {
    if (req.log) req.log.error('portal_token_mint_failed', { error });
    res.status(500).json({ error: 'Failed to create portal token' });
  }
});

// POST /tokens/:id/revoke — soft revoke (keeps the row for auditability).
router.post('/tokens/:id/revoke', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `UPDATE portal_tokens SET is_active = FALSE WHERE id = $1 AND ${sf} = $2 RETURNING id, is_active`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Portal token not found' });
    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('portal_token_revoke_failed', { error });
    res.status(500).json({ error: 'Failed to revoke portal token' });
  }
});

// DELETE /tokens/:id — hard delete (e.g. minted by mistake).
router.delete('/tokens/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `DELETE FROM portal_tokens WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Portal token not found' });
    res.json({ message: 'Portal token deleted' });
  } catch (error) {
    if (req.log) req.log.error('portal_token_delete_failed', { error });
    res.status(500).json({ error: 'Failed to delete portal token' });
  }
});

// ---------------------------------------------------------------------------
// Public read surface — NO AUTH. See file header for the threat model.
// ---------------------------------------------------------------------------

const publicRouter = express.Router();

const GENERIC_404 = { error: 'Not found' };

// Small helper: resolve or 404. Every failure mode inside resolveToken
// (malformed / unknown / revoked / expired / flag-off) is the same null →
// the same 404 body — no oracle.
async function resolveOr404(req, res) {
  const t = await portal.resolveToken(req.params.token);
  if (!t) {
    res.status(404).json(GENERIC_404);
    return null;
  }
  return t;
}

// GET /:token/overview — company basics + rollups + quotes/invoices.
publicRouter.get('/:token/overview', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    const overview = await portal.getOverview(t);
    // Company vanished since mint → same generic 404 as a dead token.
    if (!overview) return res.status(404).json(GENERIC_404);
    res.json(overview);
  } catch (error) {
    if (req.log) req.log.error('portal_public_overview_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /:token/deals — whitelisted deal list for the token's company.
publicRouter.get('/:token/deals', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    res.json(await portal.getDeals(t));
  } catch (error) {
    if (req.log) req.log.error('portal_public_deals_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /:token/documents — whitelisted document list (company + its deals).
publicRouter.get('/:token/documents', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    res.json(await portal.getDocuments(t));
  } catch (error) {
    if (req.log) req.log.error('portal_public_documents_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /:token/documents/:id/download — 302 to a short-lived signed URL (GCS)
// or stream the legacy DB blob. The lookup runs the SAME company-scoped
// predicate as the list: a foreign document id is indistinguishable from a
// nonexistent one.
publicRouter.get('/:token/documents/:id/download', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    const doc = await portal.getDocumentForDownload(t, req.params.id);
    if (!doc) return res.status(404).json(GENERIC_404);

    if (doc.gcs_object_path) {
      try {
        const url = await storage.getSignedDownloadUrl(doc.gcs_object_path, {
          expiresInSeconds: 900,
          filename: doc.filename,
        });
        return res.redirect(302, url);
      } catch (err) {
        if (req.log) req.log.error('portal_signed_url_failed', { error: err });
        return res.status(500).json({ error: 'Failed to generate download URL' });
      }
    }

    // Legacy DB-blob fallback — same as the in-app download route.
    if (!doc.content) return res.status(404).json(GENERIC_404);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.filename || 'file').replace(/"/g, '')}"`);
    res.send(Buffer.from(doc.content));
  } catch (error) {
    if (req.log) req.log.error('portal_public_download_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /:token/cases — the token company's OWN portal-submitted cases
// (source='portal' only; internal cases for the same company never appear).
publicRouter.get('/:token/cases', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    res.json(await portal.getCases(t));
  } catch (error) {
    if (req.log) req.log.error('portal_public_cases_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/cases — portal case submission (migration 148), the one public
// write. Its own strict limiter stacks INSIDE the mount-level portalReadLimiter
// so reads never burn the write budget. The token resolves BEFORE the body is
// looked at; tenancy/company/contact all come from the token row.
publicRouter.post('/:token/cases', portalWriteLimiter, async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    const result = await portal.submitCase(t, req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    // Fire-and-forget: tell the account team (company owner, else the admin
    // who minted the link). A notification failure never breaks the submit.
    notificationDispatcher.notifyPortalCaseSubmitted(result.case_id)
      .catch((err) => { if (req.log) req.log.warn('notify_portal_case_submitted_failed', { error: err }); });
    res.status(201).json(result);
  } catch (error) {
    if (req.log) req.log.error('portal_public_case_submit_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/quotes/:id/respond — approve / request changes on a quote
// (portal v3, migration 149). Shares the strict write limiter with case
// submission. The internal status lifecycle is never touched from here; the
// response lands in dedicated portal_response* columns and the team is
// notified to act in-app.
publicRouter.post('/:token/quotes/:id/respond', portalWriteLimiter, async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    const result = await portal.respondToQuote(t, req.params.id, req.body || {});
    if (result === null) return res.status(404).json(GENERIC_404); // foreign/unknown quote id — no oracle
    if (result.error) return res.status(400).json({ error: result.error });
    notificationDispatcher.notifyPortalQuoteResponse(result.quote_id)
      .catch((err) => { if (req.log) req.log.warn('notify_portal_quote_response_failed', { error: err }); });
    res.json(result);
  } catch (error) {
    if (req.log) req.log.error('portal_public_quote_respond_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /:token/messages — the company's portal thread (migration 150),
// oldest-first; team replies carry the member's display name.
publicRouter.get('/:token/messages', async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    res.json(await portal.getMessages(t));
  } catch (error) {
    if (req.log) req.log.error('portal_public_messages_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/messages — customer sends a message (portal v4). Shares the
// strict write limiter; author_type pinned 'customer' server-side.
publicRouter.post('/:token/messages', portalWriteLimiter, async (req, res) => {
  try {
    const t = await resolveOr404(req, res);
    if (!t) return;
    const result = await portal.postMessage(t, req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    notificationDispatcher.notifyPortalMessageReceived(result.id)
      .catch((err) => { if (req.log) req.log.warn('notify_portal_message_received_failed', { error: err }); });
    res.status(201).json(result);
  } catch (error) {
    if (req.log) req.log.error('portal_public_message_post_failed', { error });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/documents — portal document upload (migration 151), the most
// sensitive public write. Middleware ORDER is deliberate:
//   1. portalWriteLimiter — cheap per-IP gate first
//   2. token resolution   — the token is in the URL, so a dead link is
//      rejected BEFORE multer buffers a single byte of multipart body
//   3. multer (10MB cap)  — LIMIT_FILE_SIZE surfaces as 400, not 500
//   4. allowlist/quota/storage — services/portal.acceptDocument
publicRouter.post(
  '/:token/documents',
  portalWriteLimiter,
  async (req, res, next) => {
    const t = await resolveOr404(req, res);
    if (!t) return;
    req.portalToken = t;
    next();
  },
  (req, res, next) => {
    portalUpload.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large (10MB max)'
          : 'Invalid upload';
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const result = await portal.acceptDocument(req.portalToken, req.file);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      notificationDispatcher.notifyPortalDocumentUploaded(result.id)
        .catch((err) => { if (req.log) req.log.warn('notify_portal_document_uploaded_failed', { error: err }); });
      res.status(201).json(result);
    } catch (error) {
      if (req.log) req.log.error('portal_public_document_upload_failed', { error });
      res.status(500).json({ error: 'Something went wrong' });
    }
  }
);

module.exports = router;
module.exports.publicRouter = publicRouter;
