// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Attaches a per-request correlation ID and a child logger to req.
// All subsequent log lines from this request can be correlated by `requestId`.

const crypto = require('crypto');
const logger = require('../services/logger');

function requestContext(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  req.requestId = requestId;
  req.log = logger.child({ requestId });
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    req.log.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      userId: req.userId || null,
      orgId: req.orgId || null,
      ip: req.ip,
    });
  });

  next();
}

module.exports = requestContext;
