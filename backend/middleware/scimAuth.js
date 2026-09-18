// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SCIM 2.0 bearer-token authentication middleware.
//
// DELIBERATELY SEPARATE from backend/auth.js authMiddleware and from
// middleware/apiKeyAuth.js:
//   * authMiddleware reads the httpOnly `authToken` cookie + verifies a JWT.
//   * apiKeyAuth reads a `tocrm_...` developer key.
//   * scimAuth reads a `scim_...` bearer from Authorization: Bearer ONLY,
//     hashes it, and looks it up in scim_tokens. It never touches verifyToken(),
//     cookies, the users-status flow, or CSRF (SCIM is token-auth, no cookies).
//
// FAILS CLOSED. A missing / malformed / unknown / revoked token → 401. A DB
// error during lookup → 401 (never fail-open on an auth decision). On success
// it sets ONLY the org scope the token is bound to:
//   req.orgId       — the token's org (provisioning is confined to this org)
//   req.scimTokenId — the row id (for last_used bookkeeping / audit)
// It intentionally does NOT set req.userId or grant any admin role — a SCIM
// token can provision users but is not itself a user session.
//
// Errors follow the SCIM error schema (urn:ietf:params:scim:api:messages:2.0:Error).

const scimTokens = require('../services/scimTokens');

function scimError(res, status, detail, scimType) {
  const body = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return res.status(status).type('application/scim+json').json(body);
}

async function scimAuth(req, res, next) {
  const token = scimTokens.extractTokenFromRequest(req);
  if (!token) {
    return scimError(res, 401, 'SCIM bearer token required (Authorization: Bearer scim_...).');
  }

  let row;
  try {
    row = await scimTokens.findActiveByPlaintext(token);
  } catch (err) {
    if (req.log) req.log.error('scim_token_lookup_failed', { error: err });
    // Fail CLOSED — an unverifiable token must never be trusted.
    return scimError(res, 401, 'Could not verify SCIM token.');
  }

  if (!row) {
    return scimError(res, 401, 'Invalid or revoked SCIM token.');
  }

  req.orgId = row.org_id;
  req.scimTokenId = row.id;

  // Fire-and-forget usage bump.
  scimTokens.touchLastUsed(row.id);

  next();
}

module.exports = { scimAuth, scimError };
