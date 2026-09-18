// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public legal-document endpoints. Serves the markdown files in /legal/ as
// raw text or JSON so the frontend can render them on /legal/* pages.
//
// GET  /api/legal              — index of available documents
// GET  /api/legal/:doc         — raw markdown body of one document
// GET  /api/legal/:doc?format=json — JSON envelope with markdown body
//
// All endpoints are public (no auth). Documents are user-facing legal
// terms and must be accessible without an account.

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Static catalog so we can serve metadata + enforce the safe filename list.
// Anything not in this map returns 404 — that prevents directory traversal
// via `/api/legal/../../etc/passwd` and similar.
const DOCS = {
  'terms':                  { file: 'TERMS_OF_SERVICE.md',           title: 'Terms of Service' },
  'privacy':                { file: 'PRIVACY_POLICY.md',             title: 'Privacy Policy' },
  'aup':                    { file: 'ACCEPTABLE_USE_POLICY.md',      title: 'Acceptable Use Policy' },
  'acceptable-use':         { file: 'ACCEPTABLE_USE_POLICY.md',      title: 'Acceptable Use Policy' },
  'breach':                 { file: 'BREACH_NOTIFICATION_POLICY.md', title: 'Security Incident & Breach Notification Policy' },
  'breach-notification':    { file: 'BREACH_NOTIFICATION_POLICY.md', title: 'Security Incident & Breach Notification Policy' },
  'dpa':                    { file: 'DATA_PROCESSING_AGREEMENT.md',  title: 'Data Processing Agreement (Template)' },
  'data-processing':        { file: 'DATA_PROCESSING_AGREEMENT.md',  title: 'Data Processing Agreement (Template)' },
  'dmca':                   { file: 'DMCA_POLICY.md',                title: 'DMCA Policy' },
  'cookies':                { file: 'COOKIE_POLICY.md',              title: 'Cookie Policy' },
  'cookie-policy':          { file: 'COOKIE_POLICY.md',              title: 'Cookie Policy' },
  'subprocessors':          { file: 'SUBPROCESSORS.md',              title: 'Subprocessors' },
};

// In production the safe-deploy.sh sync step copies the repo-root /legal
// directory into backend/legal so it's included in the Docker build
// context. In local dev, either run that sync manually or `cp -R legal
// backend/legal` once. The fallback to ../../legal handles the dev case
// when the file is run directly from a non-deployed checkout.
const PRIMARY_DIR  = path.join(__dirname, '..', 'legal');
const FALLBACK_DIR = path.join(__dirname, '..', '..', 'legal');
const LEGAL_DIR    = fs.existsSync(PRIMARY_DIR) ? PRIMARY_DIR : FALLBACK_DIR;

router.get('/', (req, res) => {
  // Public-facing summary + the existing AS-IS disclaimer + links.
  res.json({
    product: 'The Open CRM',
    notice: 'This software is provided "AS IS", without warranty of any kind, express or implied. Use at your own risk.',
    copyright: 'Copyright (c) 2026 John Coles. All rights reserved.',
    operator: 'John Coles, doing business as "The Open CRM" (DBA). Incorporation pending.',
    governingLaw: 'State of New York',
    contactEmail: 'johncolesassistant@gmail.com',
    documents: Object.entries(DOCS).reduce((acc, [slug, meta]) => {
      // Deduplicate aliases in the index
      if (!acc.find(d => d.file === meta.file)) {
        acc.push({
          slug,
          title: meta.title,
          file:  meta.file,
          url:   `/api/legal/${slug}`,
        });
      }
      return acc;
    }, []),
    note: 'All documents are currently DRAFT status pending counsel review. See legal/LEGAL_TODO.md in the source repository for the action items.',
  });
});

router.get('/:doc', (req, res) => {
  const meta = DOCS[String(req.params.doc).toLowerCase()];
  if (!meta) {
    return res.status(404).json({
      success: false,
      error: 'Unknown legal document',
      knownDocs: Object.keys(DOCS).filter((k, i, arr) => arr.indexOf(k) === i),
    });
  }

  const filePath = path.join(LEGAL_DIR, meta.file);
  // Belt-and-suspenders: ensure resolved path is still inside LEGAL_DIR.
  if (!filePath.startsWith(LEGAL_DIR)) {
    return res.status(400).json({ success: false, error: 'Invalid document path' });
  }

  let body;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to read document', detail: err.message });
  }

  const format = req.query.format;
  if (format === 'json') {
    return res.json({
      success: true,
      slug: req.params.doc,
      title: meta.title,
      markdown: body,
    });
  }

  // Default: raw markdown for the frontend to render with its own pipeline.
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300'); // 5 min cache; docs change rarely
  res.send(body);
});

module.exports = router;
