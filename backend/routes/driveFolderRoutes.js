// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — folder-link + sync routes.
//
// Mount paths (set by index.js / integrator):
//   /api/deals/:id/drive-folder   → this.router    (deal-scoped folder link + sync)
//   /api/drive/folders            → this.searchRouter (folder-picker search)
//
// All routes:
//   - auth required (authMiddleware)
//   - require the `drive_intel_enabled` feature flag
//   - org-scoped via qs(req)
//   - return 503 with a clear message when GOOGLE_DRIVE_CLIENT_ID is unset,
//     mirroring services/email.js's graceful-degradation pattern.
//
// Rate limiting:
//   - The `/sync` endpoint is wrapped in a per-org-IP limiter (10 / 15min)
//     as required by the spec.
//
// Audit events emitted here:
//   DRIVE_FOLDER_LINKED, DRIVE_FOLDER_UNLINKED, DRIVE_SYNCED, DRIVE_SYNC_FAILED.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const { requireFeature } = require('../middleware/featureGate');
const pool   = require('../db');
const drive  = require('../services/drive');
const driveSync = require('../services/driveSync');
const audit  = require('../services/audit');

// Two routers — one mounted at /api/deals/:id/drive-folder (the
// integrator can use express.Router({ mergeParams: true }) when nesting),
// one mounted at /api/drive/folders for the picker search.
const router       = express.Router({ mergeParams: true });
const searchRouter = express.Router();

router.use(authMiddleware);
router.use(requireFeature('drive_intel_enabled'));
searchRouter.use(authMiddleware);
searchRouter.use(requireFeature('drive_intel_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// 503 with a stable shape when the operator hasn't wired the OAuth client.
function notConfigured(res) {
  return res.status(503).json({
    configured: false,
    error: 'Google Drive integration is not configured on this backend. ' +
           'Set GOOGLE_DRIVE_CLIENT_ID + GOOGLE_DRIVE_CLIENT_SECRET to enable.',
  });
}

// Rate limiter for /sync — keyed on (org_id, ip) so a single deal can't be
// hammered across rotating IPs from one org, and the cap is org-wide not
// per-user. 10/15min matches the spec.
const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const ip = ipKeyGenerator(req, res);
    const scope = req.orgId ? `org:${req.orgId}` : `user:${req.userId || 'anon'}`;
    return `drive-sync:${scope}:${ip}`;
  },
  message: { error: 'Too many Drive sync requests. Try again in 15 minutes.', code: 'DRIVE_SYNC_RATE_LIMIT' },
});

/**
 * Verify the deal exists in the caller's org. Returns the deal id (numeric)
 * or null if not found.
 */
async function loadDealId(req) {
  const [sf, sv] = qs(req);
  const dealId = Number(req.params.id);
  if (!Number.isFinite(dealId)) return null;
  const r = await pool.query(
    `SELECT id FROM deals WHERE id = $1 AND ${sf} = $2`,
    [dealId, sv]
  );
  return r.rows[0]?.id || null;
}

// ============================================================================
// /api/deals/:id/drive-folder
// ============================================================================

// GET — link + last sync status. 404 if no link exists for this deal.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const r = await pool.query(
      `SELECT id, deal_id, drive_folder_id, folder_name, folder_url,
              last_sync_at, last_sync_status, last_sync_error,
              files_synced_count, created_at, updated_at
         FROM deal_drive_folders
        WHERE deal_id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No Drive folder linked to this deal' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST — link a folder.
router.post('/', async (req, res) => {
  try {
    if (!(await drive.isConfigured())) return notConfigured(res);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const { drive_folder_id, folder_name } = req.body || {};
    if (!drive_folder_id || typeof drive_folder_id !== 'string') {
      return res.status(400).json({ error: 'drive_folder_id is required' });
    }

    // Verify we can actually read the folder via Google. Catches "wrong
    // org connected" / "no longer shared" / "deleted folder" before we
    // persist a useless row.
    let meta;
    try {
      meta = await drive.getFileMeta(req.orgId, drive_folder_id);
    } catch (err) {
      const code = err.code || 'DRIVE_LOOKUP_FAILED';
      if (code === 'DRIVE_NOT_CONNECTED' || code === 'DRIVE_CONNECTION_INACTIVE') {
        return res.status(409).json({ error: err.message, code });
      }
      return res.status(400).json({ error: `Could not verify Drive folder: ${err.message}` });
    }
    if (meta.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: 'Selected item is not a folder' });
    }

    const resolvedName = String(folder_name || meta.name || 'Untitled folder').slice(0, 500);
    const folder_url = `https://drive.google.com/drive/folders/${drive_folder_id}`;

    // Upsert by (deal_id) so re-linking to a different folder replaces.
    // Phase-1 contract is 1:1 — DB has UNIQUE(deal_id).
    const ins = await pool.query(
      `INSERT INTO deal_drive_folders (org_id, deal_id, drive_folder_id, folder_name, folder_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (deal_id) DO UPDATE
         SET drive_folder_id = EXCLUDED.drive_folder_id,
             folder_name     = EXCLUDED.folder_name,
             folder_url      = EXCLUDED.folder_url,
             updated_at      = NOW()
       RETURNING *`,
      [req.orgId || null, dealId, drive_folder_id, resolvedName, folder_url]
    );
    const row = ins.rows[0];

    audit.fromReq(req, {
      event: audit.EVENTS.DRIVE_FOLDER_LINKED,
      targetType: 'deal',
      targetId:   dealId,
      meta: { deal_id: dealId, drive_folder_id, folder_name: resolvedName },
    });

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — unlink + cascade drive_files (via FK ON DELETE CASCADE).
router.delete('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const existing = await pool.query(
      `SELECT id, drive_folder_id FROM deal_drive_folders
        WHERE deal_id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'No Drive folder linked to this deal' });
    }

    await pool.query(
      `DELETE FROM deal_drive_folders WHERE id = $1`,
      [existing.rows[0].id]
    );
    audit.fromReq(req, {
      event: audit.EVENTS.DRIVE_FOLDER_UNLINKED,
      targetType: 'deal',
      targetId: dealId,
      meta: { deal_id: dealId, drive_folder_id: existing.rows[0].drive_folder_id },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /sync — trigger a synchronous sync. MVP has no job queue.
router.post('/sync', syncLimiter, async (req, res) => {
  try {
    if (!(await drive.isConfigured())) return notConfigured(res);
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const linkRes = await pool.query(
      `SELECT id FROM deal_drive_folders WHERE deal_id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (linkRes.rows.length === 0) {
      return res.status(404).json({ error: 'No Drive folder linked to this deal' });
    }
    const folderLinkId = linkRes.rows[0].id;

    try {
      const result = await driveSync.sync({
        orgId: req.orgId,
        dealId,
        folderLinkId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.DRIVE_SYNCED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          folder_link_id: folderLinkId,
          synced:  result.synced,
          skipped: result.skipped,
          errors:  result.errors.length,
          removed: result.removed,
        },
      });
      res.json({
        synced:  result.synced,
        skipped: result.skipped,
        errors:  result.errors,
        removed: result.removed,
      });
    } catch (err) {
      audit.fromReq(req, {
        event: audit.EVENTS.DRIVE_SYNC_FAILED,
        targetType: 'deal',
        targetId: dealId,
        meta: { deal_id: dealId, folder_link_id: folderLinkId, error: err.message },
        success: false,
      });
      const code = err.code || 'DRIVE_SYNC_FAILED';
      const status = code === 'DRIVE_NOT_CONNECTED' || code === 'DRIVE_CONNECTION_INACTIVE'
        ? 409
        : code === 'DRIVE_TOKEN_REVOKED'
          ? 401
          : 500;
      res.status(status).json({ error: err.message, code });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /files — file metadata for the linked folder.
router.get('/files', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const linkRes = await pool.query(
      `SELECT id FROM deal_drive_folders WHERE deal_id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (linkRes.rows.length === 0) {
      return res.status(404).json({ error: 'No Drive folder linked to this deal' });
    }
    const folderLinkId = linkRes.rows[0].id;

    const files = await pool.query(
      `SELECT id, drive_file_id, name, mime_type, size_bytes,
              drive_modified_at, extraction_status, extraction_error,
              created_at, updated_at
         FROM drive_files
        WHERE folder_link_id = $1 AND ${sf} = $2
        ORDER BY drive_modified_at DESC NULLS LAST, id DESC`,
      [folderLinkId, sv]
    );
    res.json(files.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// /api/drive/folders/search — folder picker (mounted at /api/drive/folders)
// ============================================================================

searchRouter.get('/search', async (req, res) => {
  try {
    if (!(await drive.isConfigured())) return notConfigured(res);
    const q = String(req.query.q || '').trim();
    try {
      const folders = await drive.searchFolders(req.orgId, q);
      // Trim to the shape the picker UI cares about.
      const out = folders.map(f => ({
        id:           f.id,
        name:         f.name,
        modifiedTime: f.modifiedTime,
        webViewLink:  f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
      }));
      res.json({ folders: out });
    } catch (err) {
      const code = err.code || 'DRIVE_SEARCH_FAILED';
      const status = code === 'DRIVE_NOT_CONNECTED' || code === 'DRIVE_CONNECTION_INACTIVE'
        ? 409
        : code === 'DRIVE_TOKEN_REVOKED'
          ? 401
          : 500;
      res.status(status).json({ error: err.message, code });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.searchRouter = searchRouter;
