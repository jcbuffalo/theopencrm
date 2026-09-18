// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — sync orchestrator.
//
// One entry point: `sync({ orgId, dealId, folderLinkId })`. Steps:
//
//   1. Load the folder link row + verify it matches (orgId, dealId).
//   2. Mark the link as in_progress.
//   3. List every file in the Drive folder via drive.listFolderFiles.
//   4. Diff against existing drive_files rows for the link by
//      (drive_file_id) and decide which to re-fetch:
//        - new file (no existing row)            → download + extract + insert
//        - drive_modified_at advanced            → download + extract + update
//        - same drive_modified_at AND same hash  → skip (no work)
//   5. Apply DRIVE_MAX_FILE_SIZE_BYTES at the metadata level — files
//      whose Drive-reported size exceeds the cap get a row marked
//      extraction_status='skipped' / extraction_error='file_too_large'
//      so the UI shows why nothing was indexed.
//   6. Upsert every row by (drive_file_id, org_id) so re-running the
//      sync is idempotent.
//   7. After processing, delete drive_files rows for the link whose
//      drive_file_id is no longer present in Drive (file was deleted
//      out from under us).
//   8. Stamp deal_drive_folders.last_sync_* with the outcome.
//
// Returns { synced, skipped, errors, removed }.
//
// AUDIT: the calling route is responsible for emitting DRIVE_SYNCED /
// DRIVE_SYNC_FAILED. This function returns the counts for the route to
// stamp in audit meta.
//
// IDEMPOTENT: re-running with no folder changes yields synced:0,
// skipped:0 (since the same-hash branch elides the row touch entirely),
// errors:0.

const crypto = require('crypto');
const pool   = require('../db');
const logger = require('./logger');
const drive  = require('./drive');
const extract = require('./driveExtract');

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function maxFileSize() {
  const env = Number(process.env.DRIVE_MAX_FILE_SIZE_BYTES);
  return env > 0 ? env : DEFAULT_MAX_FILE_SIZE;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Decide which of the freshly-listed files need re-extraction based on
 * the current drive_files rows. Pure function — exported for tests.
 *
 * @param {array} listed   - [{ id, mimeType, size, modifiedTime, name }]
 * @param {array} existing - [{ drive_file_id, drive_modified_at, content_hash, extraction_status }]
 * @returns {{ toFetch: array, unchanged: array, existingMap: Map }}
 */
function diff(listed, existing) {
  const existingMap = new Map();
  for (const row of existing) existingMap.set(row.drive_file_id, row);

  const toFetch = [];
  const unchanged = [];
  for (const f of listed) {
    const prev = existingMap.get(f.id);
    if (!prev) {
      toFetch.push({ file: f, reason: 'new' });
      continue;
    }
    const prevMod = prev.drive_modified_at ? new Date(prev.drive_modified_at).getTime() : 0;
    const nextMod = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
    // If the previous extraction failed/skipped and the file hasn't
    // changed, leave it alone — re-extracting an unchanged file won't
    // produce a different result.
    if (prev.extraction_status === 'done' && nextMod <= prevMod) {
      unchanged.push(f);
      continue;
    }
    if (nextMod > prevMod) {
      toFetch.push({ file: f, reason: 'modified', existingRow: prev });
      continue;
    }
    // Same mod-time but previous was pending/failed — try once more.
    if (prev.extraction_status === 'pending') {
      toFetch.push({ file: f, reason: 'retry_pending', existingRow: prev });
      continue;
    }
    unchanged.push(f);
  }
  return { toFetch, unchanged, existingMap };
}

/**
 * Run a sync against a single linked folder.
 */
async function sync({ orgId, dealId, folderLinkId }) {
  if (!orgId || !dealId || !folderLinkId) {
    throw new Error('sync requires { orgId, dealId, folderLinkId }');
  }

  // 1. Load + verify the link row.
  const linkRes = await pool.query(
    `SELECT id, org_id, deal_id, drive_folder_id, folder_name
       FROM deal_drive_folders
      WHERE id = $1 AND org_id = $2 AND deal_id = $3`,
    [folderLinkId, orgId, dealId]
  );
  if (linkRes.rows.length === 0) {
    const err = new Error('Folder link not found for this deal/org');
    err.code = 'FOLDER_LINK_NOT_FOUND';
    throw err;
  }
  const link = linkRes.rows[0];

  // 2. Mark in_progress.
  await pool.query(
    `UPDATE deal_drive_folders
        SET last_sync_status = 'in_progress',
            last_sync_error  = NULL,
            updated_at       = NOW()
      WHERE id = $1`,
    [folderLinkId]
  );

  const sizeCap = maxFileSize();
  let synced = 0;
  let skipped = 0;
  const errors = [];

  try {
    // 3. List Drive folder.
    const listed = await drive.listFolderFiles(orgId, link.drive_folder_id);
    // Sort newest-first so token-budget truncation in intelSummary keeps
    // the most-recent context.
    listed.sort((a, b) => {
      const am = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
      const bm = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
      return bm - am;
    });

    // 4. Diff vs existing rows.
    const existingRes = await pool.query(
      `SELECT drive_file_id, drive_modified_at, content_hash, extraction_status
         FROM drive_files
        WHERE folder_link_id = $1 AND org_id = $2`,
      [folderLinkId, orgId]
    );
    const { toFetch, unchanged, existingMap } = diff(listed, existingRes.rows);

    // 5-6. Process each to-fetch file.
    for (const job of toFetch) {
      const f = job.file;
      const sizeBytes = Number(f.size || 0);

      // Size cap: skip without downloading.
      if (sizeBytes > 0 && sizeBytes > sizeCap) {
        await upsertFile({
          orgId, folderLinkId, file: f, sizeBytes,
          status: 'skipped', error: 'file_too_large',
          contentText: null, contentHash: null,
        });
        skipped++;
        logger.info('drive_sync_file_skipped', {
          orgId, folderLinkId, drive_file_id: f.id, name: f.name,
          mime: f.mimeType, size: sizeBytes, reason: 'file_too_large',
        });
        continue;
      }

      try {
        const dl = await drive.downloadFileText(orgId, f.id, f.mimeType);
        // Belt-and-braces: if Drive's size header lied (or was absent)
        // and the actual download is huge, skip rather than parse.
        if (dl.sizeBytes > sizeCap) {
          await upsertFile({
            orgId, folderLinkId, file: f, sizeBytes: dl.sizeBytes,
            status: 'skipped', error: 'file_too_large',
            contentText: null, contentHash: null,
          });
          skipped++;
          continue;
        }
        const result = await extract.extractText(dl, { maxBytes: sizeCap });
        if (result.status === 'done') {
          const hash = sha256(result.text);
          // No content change? Avoid an UPDATE write entirely.
          const prev = job.existingRow;
          if (prev && prev.content_hash && prev.content_hash === hash) {
            // Still bump drive_modified_at + name in case those changed.
            await pool.query(
              `UPDATE drive_files
                  SET name = $2,
                      mime_type = $3,
                      size_bytes = $4,
                      drive_modified_at = $5,
                      extraction_status = 'done',
                      extraction_error = NULL,
                      updated_at = NOW()
                WHERE folder_link_id = $1 AND drive_file_id = $6 AND org_id = $7`,
              [folderLinkId, f.name, f.mimeType, dl.sizeBytes,
               f.modifiedTime || null, f.id, orgId]
            );
            skipped++;
            continue;
          }
          await upsertFile({
            orgId, folderLinkId, file: f, sizeBytes: dl.sizeBytes,
            status: 'done', error: null,
            contentText: result.text, contentHash: hash,
          });
          synced++;
        } else if (result.status === 'skipped') {
          await upsertFile({
            orgId, folderLinkId, file: f, sizeBytes: dl.sizeBytes,
            status: 'skipped', error: result.error,
            contentText: null, contentHash: null,
          });
          skipped++;
        } else {
          await upsertFile({
            orgId, folderLinkId, file: f, sizeBytes: dl.sizeBytes,
            status: 'failed', error: result.error,
            contentText: null, contentHash: null,
          });
          errors.push({ drive_file_id: f.id, name: f.name, error: result.error });
        }
      } catch (err) {
        logger.warn('drive_sync_file_failed', {
          orgId, folderLinkId, drive_file_id: f.id, name: f.name,
          mime: f.mimeType, error: err.message,
        });
        await upsertFile({
          orgId, folderLinkId, file: f, sizeBytes,
          status: 'failed', error: err.message || 'download_failed',
          contentText: null, contentHash: null,
        }).catch(() => {});
        errors.push({ drive_file_id: f.id, name: f.name, error: err.message });
      }
    }

    // 7. Delete rows whose drive_file_id is no longer in the listing.
    const listedIds = new Set(listed.map(f => f.id));
    const toDelete = [];
    for (const id of existingMap.keys()) {
      if (!listedIds.has(id)) toDelete.push(id);
    }
    let removed = 0;
    if (toDelete.length > 0) {
      const del = await pool.query(
        `DELETE FROM drive_files
            WHERE folder_link_id = $1 AND org_id = $2
              AND drive_file_id = ANY($3::text[])`,
        [folderLinkId, orgId, toDelete]
      );
      removed = del.rowCount || 0;
    }

    // 8. Stamp last_sync_* + recompute count.
    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM drive_files
        WHERE folder_link_id = $1 AND extraction_status = 'done'`,
      [folderLinkId]
    );
    await pool.query(
      `UPDATE deal_drive_folders
          SET last_sync_at        = NOW(),
              last_sync_status    = $2,
              last_sync_error     = $3,
              files_synced_count  = $4,
              updated_at          = NOW()
        WHERE id = $1`,
      [
        folderLinkId,
        errors.length > 0 ? 'failed' : 'ok',
        errors.length > 0 ? `${errors.length} file(s) failed` : null,
        totalRes.rows[0]?.c || 0,
      ]
    );

    logger.info('drive_sync_complete', {
      orgId, folderLinkId, synced, skipped, removed,
      errors: errors.length, unchanged: unchanged.length,
    });
    return { synced, skipped, errors, removed };
  } catch (err) {
    await pool.query(
      `UPDATE deal_drive_folders
          SET last_sync_at     = NOW(),
              last_sync_status = 'failed',
              last_sync_error  = $2,
              updated_at       = NOW()
        WHERE id = $1`,
      [folderLinkId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

/**
 * Upsert one drive_files row keyed on (drive_file_id, org_id).
 */
async function upsertFile({ orgId, folderLinkId, file, sizeBytes, status, error, contentText, contentHash }) {
  await pool.query(
    `INSERT INTO drive_files
       (org_id, folder_link_id, drive_file_id, name, mime_type, size_bytes,
        drive_modified_at, content_text, content_hash,
        extraction_status, extraction_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (drive_file_id, org_id) DO UPDATE
       SET folder_link_id     = EXCLUDED.folder_link_id,
           name               = EXCLUDED.name,
           mime_type          = EXCLUDED.mime_type,
           size_bytes         = EXCLUDED.size_bytes,
           drive_modified_at  = EXCLUDED.drive_modified_at,
           content_text       = EXCLUDED.content_text,
           content_hash       = EXCLUDED.content_hash,
           extraction_status  = EXCLUDED.extraction_status,
           extraction_error   = EXCLUDED.extraction_error,
           updated_at         = NOW()`,
    [
      orgId,
      folderLinkId,
      file.id,
      file.name || '(unnamed)',
      file.mimeType || 'application/octet-stream',
      sizeBytes || null,
      file.modifiedTime || null,
      contentText,
      contentHash,
      status,
      error,
    ]
  );
}

module.exports = {
  sync,
  diff,
  sha256,
  maxFileSize,
};
