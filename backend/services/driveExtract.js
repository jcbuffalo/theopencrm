// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — mime → plain text extraction.
//
// Each Drive download is routed through this module to produce the text
// we hand to Claude. Routing:
//
//   application/pdf                                        → pdf-parse
//   application/vnd.openxmlformats-officedocument...wordprocessingml.document → mammoth.extractRawText
//   application/msword                                     → mammoth (best-effort)
//   text/html, application/xhtml+xml                       → html-to-text
//   text/*                                                 → buffer.toString('utf8')
//   pre-exported Google Doc (already text)                 → pass through
//   anything else                                          → { status: 'skipped' }
//
// EXTRACT CONTRACT:
//   { status: 'done',    text, error: null }
//   { status: 'skipped', text: null, error: 'unsupported_mime' | 'file_too_large' }
//   { status: 'failed',  text: null, error: '<message>' }
//
// The orchestrator (driveSync.js) decides what to do with each result;
// this module does not log per-file decisions itself — driveSync emits a
// single summary row.

const logger = require('./logger');

// Lazy-loaded extractors so this file is importable even if the optional
// deps aren't installed (test environments stubbing the pipeline can
// skip the heavy parser deps). We never throw at import time — mirrors
// services/email.js and services/storage.js.
let _pdfParse, _mammoth, _htmlToText;
function pdfParseLib() {
  if (_pdfParse !== undefined) return _pdfParse;
  try { _pdfParse = require('pdf-parse'); } catch { _pdfParse = null; }
  return _pdfParse;
}
function mammothLib() {
  if (_mammoth !== undefined) return _mammoth;
  try { _mammoth = require('mammoth'); } catch { _mammoth = null; }
  return _mammoth;
}
function htmlToTextLib() {
  if (_htmlToText !== undefined) return _htmlToText;
  try { _htmlToText = require('html-to-text'); } catch { _htmlToText = null; }
  return _htmlToText;
}

function done(text) {
  return { status: 'done', text: String(text || '').trim(), error: null };
}
function skipped(reason) {
  return { status: 'skipped', text: null, error: reason };
}
function failed(message) {
  return { status: 'failed', text: null, error: message };
}

/**
 * Extract text from a single downloaded file payload.
 *
 * @param {object} download — the object returned by drive.downloadFileText:
 *   - { mimeType, buffer?, text?, isGoogleExport? }
 *     • Google Doc-family files arrive already exported as text/plain
 *       (buffer omitted, text present).
 *     • Everything else arrives as buffer + the original mimeType.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - skip extraction if the buffer exceeds
 *                                   this (caller already checks at the
 *                                   download seam, but we double-check
 *                                   so a code-path bypass doesn't blow
 *                                   memory).
 * @returns {Promise<{status, text, error}>}
 */
async function extractText(download, opts = {}) {
  if (!download || typeof download !== 'object') return failed('no_download');

  // Google-doc text export already came back as plaintext.
  if (download.isGoogleExport && typeof download.text === 'string') {
    return done(download.text);
  }

  const maxBytes = Number(opts.maxBytes) || 10 * 1024 * 1024;
  const buf = download.buffer;
  if (!buf) return skipped('no_bytes');
  if (buf.length > maxBytes) return skipped('file_too_large');

  const mime = String(download.mimeType || '').toLowerCase();

  try {
    // PDF
    if (mime === 'application/pdf') {
      const lib = pdfParseLib();
      if (!lib) return failed('pdf_parser_missing');
      const result = await lib(buf);
      return done(result.text || '');
    }

    // DOCX
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const lib = mammothLib();
      if (!lib) return failed('docx_parser_missing');
      const result = await lib.extractRawText({ buffer: buf });
      return done(result.value || '');
    }

    // Legacy .doc — try mammoth (best-effort; it sometimes works on simple docs).
    if (mime === 'application/msword') {
      const lib = mammothLib();
      if (!lib) return failed('docx_parser_missing');
      try {
        const result = await lib.extractRawText({ buffer: buf });
        return done(result.value || '');
      } catch {
        return skipped('legacy_doc_unsupported');
      }
    }

    // HTML
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const lib = htmlToTextLib();
      const html = buf.toString('utf8');
      if (!lib) {
        // Crude fallback: strip tags. Keeps the pipeline working even when
        // html-to-text isn't installed (e.g. test runtime).
        return done(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
      }
      const text = lib.convert(html, { wordwrap: false });
      return done(text);
    }

    // Anything text/* — JSON, CSV, TXT, markdown, etc.
    if (mime.startsWith('text/')) {
      return done(buf.toString('utf8'));
    }

    return skipped('unsupported_mime');
  } catch (err) {
    logger.warn('drive_extract_failed', { mime, error: err.message });
    return failed(err.message || 'extract_error');
  }
}

module.exports = {
  extractText,
};
