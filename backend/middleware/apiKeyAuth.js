// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// API-key authentication (migration 108; write surface 2026-09-22, spec 206).
//
// Two ways in, one resolver:
//   * apiKeyAuth        — key REQUIRED (the /api/v1 façade). 401 without one.
//   * resolveApiKey     — used by auth.js authMiddleware as a fallback: when a
//                         request carries `Authorization: Bearer tocrm_…` (or
//                         `X-API-Key`) and no session cookie, the key
//                         authenticates it on the SAME org-scoped routes the
//                         browser uses. That is what makes "drive the CRM from
//                         another CLI" possible without duplicating handlers.
//
// The resolver populates exactly what the cookie path populates so qs(req),
// requireOrgAdmin, requireFeature and the AI billing gate all work unchanged:
//   req.userId  — the key's creator (writes are attributed to them)
//   req.orgId   — the key's org
//   req.orgRole — the CREATOR's current org_role (an admin's key can do admin things)
//   req.apiKey  — { id, name, scopes, key_prefix }
//
// Guardrails applied here, before any handler runs:
//   * scope: a key minted with only 'read' may GET/HEAD/OPTIONS; anything else
//     needs 'write' (403 API_KEY_SCOPE).
//   * denylist: account/security/billing/admin/OAuth surfaces are never
//     reachable with a key, whatever its scope (403 API_KEY_FORBIDDEN_ROUTE).
//     Keys are for running the CRM, not for administering the account.
//   * creator must still be an active user; a revoked key or one whose
//     creator was suspended fails closed (401).
// A DB hiccup during lookup fails CLOSED (401), never open.

const apiKeys = require('../services/apiKeys');

// Path prefixes (after the /api or /api/v1 root) a key may never touch.
const DENY_PREFIXES = [
  '/auth', '/security', '/me', '/admin', '/billing', '/keys', '/org', '/team', '/invites',
  '/gateway', '/sso', '/platform-integrations', '/drive', '/gmail', '/calendar', '/outlook', '/msgraph',
  '/access-requests', '/contact', '/request-access', '/legal', '/portal', '/webhooks',
];

function isDeniedPath(reqPath) {
  const raw = String(reqPath || '');
  // The key's own identity endpoint is the one /me a key may call.
  if (raw === '/api/v1/me' || raw === '/api/v1/me/') return false;
  const p = raw.replace(/^\/api\/v1(?=\/|$)/, '').replace(/^\/api(?=\/|$)/, '');
  // /webhooks-out (outbound subscriptions) is allowed; /webhooks (inbound
  // receivers) is not — the startsWith check below must not conflate them.
  if (p === '/webhooks-out' || p.startsWith('/webhooks-out/')) return false;
  return DENY_PREFIXES.some((d) => p === d || p.startsWith(`${d}/`));
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns { ok: true } after populating req, or { ok: false, status, body }.
async function resolveApiKey(req) {
  const token = apiKeys.extractKeyFromRequest(req);
  if (!token) {
    return { ok: false, status: 401, body: { success: false, error: 'API key required. Send it as `Authorization: Bearer tocrm_...` or `X-API-Key: tocrm_...`.', code: 'API_KEY_MISSING' } };
  }
  let row;
  try {
    row = await apiKeys.findActiveByPlaintext(token);
  } catch (err) {
    if (req.log) req.log.error('api_key_lookup_failed', { error: err });
    return { ok: false, status: 401, body: { success: false, error: 'Could not verify API key', code: 'API_KEY_UNVERIFIABLE' } };
  }
  if (!row) return { ok: false, status: 401, body: { success: false, error: 'Invalid or revoked API key', code: 'API_KEY_INVALID' } };
  if (row.created_by && row.creator_status && row.creator_status !== 'active') {
    return { ok: false, status: 401, body: { success: false, error: 'The user who created this API key is no longer active', code: 'API_KEY_CREATOR_INACTIVE' } };
  }
  if (isDeniedPath(req.originalUrl ? req.originalUrl.split('?')[0] : req.path)) {
    return { ok: false, status: 403, body: { success: false, error: 'This surface is not available to API keys. Use a signed-in session.', code: 'API_KEY_FORBIDDEN_ROUTE' } };
  }
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  if (!READ_METHODS.has(req.method) && !scopes.includes('write')) {
    return { ok: false, status: 403, body: { success: false, error: "This API key is read-only. Create one with the 'write' scope in Settings → Developer.", code: 'API_KEY_SCOPE' } };
  }

  req.orgId = row.org_id ?? null;
  req.userId = row.created_by ?? null;
  req.orgRole = row.creator_org_role || 'member';
  req.authSource = 'api_key';
  req.apiKey = { id: row.id, name: row.name, scopes, key_prefix: row.key_prefix };
  apiKeys.touchLastUsed(row.id); // fire-and-forget
  return { ok: true };
}

async function apiKeyAuth(req, res, next) {
  const out = await resolveApiKey(req);
  if (!out.ok) return res.status(out.status).json(out.body);
  next();
}

// Optional per-route scope guard, composable on top of apiKeyAuth.
function requireScope(scope) {
  return function scopeGate(req, res, next) {
    const scopes = req.apiKey?.scopes || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({ success: false, error: `API key lacks the '${scope}' scope`, code: 'API_KEY_SCOPE' });
    }
    next();
  };
}

// True when the request carries a tocrm_ key at all (used by the CSRF
// exemption: a custom Authorization / X-API-Key header cannot be sent
// cross-site without a CORS preflight, so double-submit CSRF does not apply).
function hasApiKey(req) {
  return !!apiKeys.extractKeyFromRequest(req);
}

module.exports = { apiKeyAuth, resolveApiKey, requireScope, hasApiKey, isDeniedPath, DENY_PREFIXES };
