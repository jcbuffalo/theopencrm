// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const multer = require('multer');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const storage = require('../services/storage');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const { createSchema } = require('../schemas/documents');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — GCS handles size now
});

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { related_type, related_id, doc_type } = req.query;
    let query = `
      SELECT d.id, d.related_type, d.related_id, d.doc_type, d.filename, d.url, d.size, d.mime_type, d.notes, d.uploaded_by, d.created_at,
             d.gcs_object_path, d.gcs_bucket, d.source,
             u.email AS uploaded_by_email
      FROM documents d
      LEFT JOIN users u ON d.uploaded_by = u.id
      WHERE d.${sf} = $1
    `;
    const params = [sv];
    if (related_type) { query += ` AND d.related_type = $${params.length + 1}`; params.push(related_type); }
    if (related_id)   { query += ` AND d.related_id = $${params.length + 1}`;   params.push(related_id); }
    if (doc_type)     { query += ` AND d.doc_type = $${params.length + 1}`;     params.push(doc_type); }
    query += ' ORDER BY d.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Document list error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

/**
 * Returns a short-lived signed URL for documents stored in GCS, or streams the
 * blob inline for legacy DB-stored rows. Auth is enforced before either path.
 */
router.get('/:id/download', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT filename, mime_type, content, gcs_object_path FROM documents WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const doc = result.rows[0];

    // Prefer GCS — return a redirect to a signed URL
    if (doc.gcs_object_path) {
      try {
        const url = await storage.getSignedDownloadUrl(doc.gcs_object_path, {
          expiresInSeconds: 900,
          filename: doc.filename,
        });
        audit.fromReq(req, { event: audit.EVENTS.DOCUMENT_DOWNLOAD, targetType: 'document', targetId: Number(req.params.id), meta: { transport: 'gcs_signed_url' } });
        return res.redirect(302, url);
      } catch (err) {
        if (req.log) req.log.error('gcs_signed_url_failed', { error: err });
        return res.status(500).json({ error: 'Failed to generate download URL', requestId: req.requestId });
      }
    }

    // Legacy DB blob fallback
    if (!doc.content) return res.status(404).json({ error: 'No content stored for this document' });
    audit.fromReq(req, { event: audit.EVENTS.DOCUMENT_DOWNLOAD, targetType: 'document', targetId: Number(req.params.id), meta: { transport: 'db_blob' } });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.filename || 'file').replace(/"/g, '')}"`);
    res.send(Buffer.from(doc.content));
  } catch (error) {
    console.error('Document download error:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

/**
 * Returns a signed URL JSON payload (without redirect) — useful when the client
 * wants to embed the link or open in a new tab without forwarding auth headers.
 */
router.get('/:id/signed-url', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT filename, gcs_object_path FROM documents WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const doc = result.rows[0];
    if (!doc.gcs_object_path) return res.status(400).json({ error: 'Document is not stored in object storage' });

    const url = await storage.getSignedDownloadUrl(doc.gcs_object_path, {
      expiresInSeconds: 900,
      filename: doc.filename,
    });
    res.json({ url, expires_in_seconds: 900 });
  } catch (error) {
    console.error('Signed URL error:', error);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

router.post('/', upload.single('file'), validateBody(createSchema), async (req, res) => {
  try {
    const { related_type, related_id, doc_type, notes, url } = req.body;
    const file = req.file;
    // filename can come from either the uploaded file (multer) or the body.
    // Defense-in-depth: still requires at least one. validateBody has trimmed
    // body.filename and coerced empty to null.
    const filename = file ? file.originalname : (req.body.filename || null);
    if (!filename) return res.status(400).json({ error: 'filename or file required' });

    let gcsObjectPath = null;
    let gcsBucket = null;

    if (file) {
      try {
        const uploaded = await storage.uploadBuffer({
          orgId: req.orgId || req.userId,
          relatedType: related_type || 'misc',
          relatedId: related_id || 0,
          filename,
          buffer: file.buffer,
          mimeType: file.mimetype,
        });
        gcsObjectPath = uploaded.objectPath;
        gcsBucket = uploaded.bucket;
      } catch (err) {
        // If GCS upload fails (e.g. bucket access denied locally), fall back to DB blob
        // for files under 5MB so the API stays usable in dev.
        if (file.size <= 5 * 1024 * 1024) {
          console.warn('GCS upload failed, falling back to DB blob:', err.message);
        } else {
          console.error('GCS upload failed (file too large for fallback):', err.message);
          return res.status(500).json({ error: 'Storage backend unavailable' });
        }
      }
    }

    const result = await pool.query(
      `INSERT INTO documents
         (user_id, org_id, related_type, related_id, doc_type, filename, url, content, size, mime_type, notes, uploaded_by, gcs_object_path, gcs_bucket)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, related_type, related_id, doc_type, filename, url, size, mime_type, notes, gcs_object_path, gcs_bucket, created_at`,
      [
        req.userId, req.orgId || null,
        related_type || null, related_id || null, doc_type || 'other',
        filename, url || null,
        // Only keep DB blob when GCS upload didn't succeed
        (!gcsObjectPath && file && file.size <= 5 * 1024 * 1024) ? file.buffer : null,
        file ? file.size : null,
        file ? file.mimetype : null,
        notes || null,
        req.userId,
        gcsObjectPath,
        gcsBucket,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Document upload error:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    // Look up object path before deleting
    const lookup = await pool.query(`SELECT gcs_object_path FROM documents WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (lookup.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

    const gcsPath = lookup.rows[0].gcs_object_path;
    if (gcsPath) {
      try { await storage.deleteObject(gcsPath); } catch (err) { console.warn('GCS delete failed (continuing):', err.message); }
    }
    await pool.query(`DELETE FROM documents WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    res.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Document delete error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

module.exports = router;
