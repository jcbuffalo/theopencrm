// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// API-key authentication middleware — the developer-platform auth path.
//
// This is DELIBERATELY SEPARATE from backend/auth.js authMiddleware:
//   * authMiddleware reads the httpOnly `authToken` cookie and verifies a JWT.
//     Its `Authorization: Bearer` fallback was removed on 2026-06-30 and is NOT
//     re-added here.
//   * apiKeyAuth reads a `tocrm_...` token from `Authorization: Bearer` OR the
//     `X-API-Key` header, hashes it, and looks it up in api_keys. It never
//     touches verifyToken(), cookies, or the users-status re-check flow.
//
// On success it populates the SAME request fields the rest of the stack reads
// so org-scoped route handlers (qs(req)) work unchanged:
//   req.orgId   — the key's org (may be null for a personal-workspace key)
//   req.userId  — the key's created_by, so qs(req)'s user_id fallback resolves
//   req.orgRole — always 'member' for key auth (keys never get admin powers)
//   req.apiKey  — { id, name, scopes, key_prefix } for downstream scope checks
//
// Unknown / revoked / malformed keys get 401. Absence of any key also 401 (this
// middleware is the sole auth on the surfaces it guards).

const apiKeys = require('../services/apiKeys');

async function apiKeyAuth(req, res, next) {
  const token = apiKeys.extractKeyFromRequest(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'API key required. Send it as `Authorization: Bearer tocrm_...` or `X-API-Key: tocrm_...`.',
      code: 'API_KEY_MISSING',
    });
  }

  let row;
  try {
    row = await apiKeys.findActiveByPlaintext(token);
  } catch (err) {
    // A DB hiccup during key lookup fails CLOSED — unlike the JWT path's
    // fail-open org-context branch, an API key that can't be verified must not
    // be trusted.
    if (req.log) req.log.error('api_key_lookup_failed', { error: err });
    return res.status(401).json({ success: false, error: 'Could not verify API key', code: 'API_KEY_UNVERIFIABLE' });
  }

  if (!row) {
    return res.status(401).json({ success: false, error: 'Invalid or revoked API key', code: 'API_KEY_INVALID' });
  }

  req.orgId  = row.org_id ?? null;
  req.userId = row.created_by ?? null;
  req.orgRole = 'member';
  req.apiKey = {
    id: row.id,
    name: row.name,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    key_prefix: row.key_prefix,
  };

  // Fire-and-forget usage bump — do not await, do not let it block the request.
  apiKeys.touchLastUsed(row.id);

  next();
}

// Optional per-route scope guard. API keys default to the 'read' scope; a route
// that mutates could require('write'). Kept tiny and composable.
function requireScope(scope) {
  return function scopeGate(req, res, next) {
    const scopes = req.apiKey?.scopes || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({
        success: false,
        error: `This API key is missing the required "${scope}" scope.`,
        code: 'API_KEY_SCOPE_MISSING',
      });
    }
    next();
  };
}

module.exports = { apiKeyAuth, requireScope };
