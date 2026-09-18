// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Browser crash-report receiver (POST /api/client-errors) + CSP-violation
// receiver (POST /api/client-errors/csp).
//
// PURPOSE — frontend error visibility in GCP Error Reporting. The React
// ErrorBoundary (frontend/src/components/ErrorBoundary.js) POSTs
// { message, stack, componentStack, path, ua } here; we relog it through
// services/logger at severity ERROR with serviceContext
// { service: 'synccrm-frontend' }, which Cloud Logging → Error Reporting
// auto-ingests and groups. NO database table — logs only, by design.
//
// PROPERTIES (mirrors the other public receivers):
//   - Auth-OPTIONAL: a broken session is often why the page crashed, so the
//     report must land either way. When a valid session cookie IS present we
//     annotate userId for triage, nothing more.
//   - CSRF-exempt (listed in index.js csrfIgnoredRoutes): it grants nothing
//     to the caller and must work from a half-broken page.
//   - Strictly rate-limited: clientErrorLimiter, 10/15min/IP (mounted in
//     index.js at the /api/client-errors mount point).
//   - NEVER throws / never 500s: the reporter must not create a second error
//     for the crashing page to trip over. Garbage input is logged as far as
//     it can be salvaged and always answered 204.
//
// The /csp sibling receives Content-Security-Policy `report-uri` posts from
// frontend/server.js's policy. Browsers send those with content-type
// application/csp-report (or application/reports+json), which the global
// express.json parser skips — so this router mounts its own permissive JSON
// parser. Violations are logged at WARN (they're misconfig/extension noise
// signals, not crashes) as event 'csp_violation'.

const express = require('express');
const { optionalAuth } = require('../auth');
const logger = require('../services/logger');

const router = express.Router();

// Truncation bounds — keep a hostile client from stuffing megabytes into the
// log pipeline. Stack + componentStack at 4KB each per the spec.
const MAX_MESSAGE = 1000;
const MAX_STACK = 4096;
const MAX_PATH = 300;
const MAX_UA = 300;

function clip(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, max);
  return s.length > 0 ? s : null;
}

// POST /api/client-errors — browser crash report.
router.post('/', optionalAuth, (req, res) => {
  try {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const message = clip(b.message, MAX_MESSAGE) || 'client_error (no message)';
    const stack = clip(b.stack, MAX_STACK);
    const componentStack = clip(b.componentStack, MAX_STACK);
    const path = clip(b.path, MAX_PATH);
    const ua = clip(b.ua, MAX_UA);

    const log = req.log || logger;
    log.error(`client_error: ${message}`, {
      // serviceContext override → Error Reporting groups these under the
      // frontend service, separate from backend faults.
      serviceContext: { service: 'synccrm-frontend' },
      // logger.emit appends `stack` to the message so Error Reporting can
      // parse the browser stack frames for grouping.
      stack: stack || undefined,
      componentStack: componentStack || undefined,
      clientPath: path,
      ua,
      userId: req.userId || null,
      ip: req.ip,
    });
  } catch {
    // Deliberately swallowed — see PROPERTIES above.
  }
  res.status(204).end();
});

// POST /api/client-errors/csp — CSP violation reports (report-uri).
// Route-scoped parser: accept any content type as JSON (browsers use
// application/csp-report), small limit, and tolerate unparseable bodies.
const cspParser = express.json({ type: () => true, limit: '16kb' });
router.post('/csp', (req, res) => {
  cspParser(req, res, (parseErr) => {
    try {
      // Report shape: { "csp-report": { "violated-directive", "blocked-uri",
      // "document-uri", "source-file", "line-number", ... } }
      const report = (!parseErr && req.body && typeof req.body === 'object')
        ? (req.body['csp-report'] || req.body)
        : {};
      logger.warn('csp_violation', {
        serviceContext: { service: 'synccrm-frontend' },
        violatedDirective: clip(report['violated-directive'] || report['effective-directive'], 200),
        blockedUri: clip(report['blocked-uri'], 300),
        documentUri: clip(report['document-uri'], 300),
        sourceFile: clip(report['source-file'], 300),
        lineNumber: Number(report['line-number']) || null,
        ip: req.ip,
      });
    } catch {
      // Never let the reporter throw.
    }
    res.status(204).end();
  });
});

module.exports = router;
