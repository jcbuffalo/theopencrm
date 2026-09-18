// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Enterprise SSO — OpenID Connect (OIDC) authorization-code flow primitives.
//
// This module is the SECURITY-CRITICAL core of the SSO login path. It owns:
//   - OIDC discovery (.well-known/openid-configuration) + JWKS fetching
//   - building the IdP authorize URL (with state + nonce)
//   - exchanging the authorization code for tokens at the token endpoint
//   - **rigorously verifying the returned id_token** (verifyIdToken)
//   - enforcing the org's allowed email domain (enforceDomain)
//
// DESIGN FOR TESTABILITY
//   The pure verification logic (verifyIdToken / enforceDomain / buildAuthorizeUrl)
//   takes everything it needs as arguments — no network, no DB, no clock it
//   can't be told about. The network functions (fetchDiscovery / fetchJwks /
//   exchangeCode) are thin wrappers around global fetch so a test can stub them
//   or, better, call verifyIdToken directly with a locally-generated RSA keypair.
//
// NEVER TRUST AN UNVERIFIED ASSERTION. A mismatched iss / aud / exp / nonce /
// signature, an unexpected signing alg, or a domain mismatch MUST throw an
// SsoError and reject the login. The route layer maps SsoError → a redirect to
// the login page with a generic error; it never mints a session on failure.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Asymmetric algorithms we accept for the id_token signature. Deliberately
// RS* only:
//   - `none` (unsigned) is rejected — an attacker could otherwise forge any
//     claim set.
//   - HMAC (HS256/384/512) is rejected to close the classic "alg confusion"
//     attack, where an attacker signs a token with HS256 using the RSA PUBLIC
//     key (which is, well, public) as the HMAC secret. Because we only ever
//     verify against a public key pulled from the IdP's JWKS and only permit
//     RS*, jsonwebtoken will refuse an HS* token outright.
// ES*/PS* are omitted for now; add them here (and they'll flow through
// crypto.createPublicKey) if a customer IdP needs them.
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512'];

// Clock-skew tolerance for exp/iat/nbf, in seconds. Matches the 30s TOTP
// window's spirit — small enough to bound replay, large enough to survive
// modest clock drift between us and the IdP.
const CLOCK_TOLERANCE_SEC = 60;

// Scopes we request. openid is mandatory; email + profile give us the claims
// we map onto the user row.
const DEFAULT_SCOPE = 'openid email profile';

class SsoError extends Error {
  constructor(message, code = 'SSO_ERROR') {
    super(message);
    this.name = 'SsoError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(u) {
  return typeof u === 'string' ? u.replace(/\/+$/, '') : u;
}

// Cryptographically-random opaque value for state / nonce. 32 bytes → 43 url-
// safe chars. state defends the redirect against CSRF; nonce binds the
// id_token to this specific login transaction (replay defense).
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Extract the registrable domain from an email address, lower-cased. Returns
// null for anything that isn't a plausible single-@ address.
function domainOfEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Network: OIDC discovery + JWKS + token exchange
// ---------------------------------------------------------------------------

// GET <issuer>/.well-known/openid-configuration. Returns the parsed document
// (authorization_endpoint, token_endpoint, jwks_uri, ...). Throws SsoError on
// any transport / parse failure.
async function fetchDiscovery(issuer) {
  const url = `${stripTrailingSlash(issuer)}/.well-known/openid-configuration`;
  let resp;
  try {
    resp = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new SsoError(`OIDC discovery request failed: ${e.message}`, 'SSO_DISCOVERY_FAILED');
  }
  if (!resp.ok) {
    throw new SsoError(`OIDC discovery returned HTTP ${resp.status}`, 'SSO_DISCOVERY_FAILED');
  }
  const doc = await resp.json();
  // Defense-in-depth: the discovery doc's issuer MUST equal the configured
  // issuer (OIDC Discovery §4.3). A mismatch means we're being pointed at a
  // rogue metadata document.
  if (stripTrailingSlash(doc.issuer) !== stripTrailingSlash(issuer)) {
    throw new SsoError('OIDC discovery issuer mismatch', 'SSO_DISCOVERY_ISSUER_MISMATCH');
  }
  return doc;
}

// GET the JWKS document from jwks_uri. Returns { keys: [...] }.
async function fetchJwks(jwksUri) {
  let resp;
  try {
    resp = await fetch(jwksUri, { redirect: 'error', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new SsoError(`JWKS request failed: ${e.message}`, 'SSO_JWKS_FAILED');
  }
  if (!resp.ok) {
    throw new SsoError(`JWKS endpoint returned HTTP ${resp.status}`, 'SSO_JWKS_FAILED');
  }
  const doc = await resp.json();
  if (!doc || !Array.isArray(doc.keys)) {
    throw new SsoError('JWKS document has no keys array', 'SSO_JWKS_MALFORMED');
  }
  return doc;
}

// Exchange the authorization code for tokens at the token endpoint. Uses
// client_secret_post (secret in the body) — the most widely-supported client
// auth method. Returns the parsed token response ({ id_token, access_token, ... }).
async function exchangeCode({ tokenEndpoint, code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  let resp;
  try {
    resp = await fetch(tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new SsoError(`Token exchange request failed: ${e.message}`, 'SSO_TOKEN_EXCHANGE_FAILED');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const desc = data.error_description || data.error || `HTTP ${resp.status}`;
    throw new SsoError(`Token exchange rejected by IdP: ${desc}`, 'SSO_TOKEN_EXCHANGE_REJECTED');
  }
  if (!data.id_token) {
    throw new SsoError('Token response contained no id_token', 'SSO_NO_ID_TOKEN');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, state, nonce, scope }) {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope || DEFAULT_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  // Force the account chooser rather than silently reusing an SSO session the
  // browser already has — matters when a device is shared.
  u.searchParams.set('response_mode', 'query');
  return u.toString();
}

// ---------------------------------------------------------------------------
// JWKS key selection + id_token verification (THE security-critical part)
// ---------------------------------------------------------------------------

// Pick the JWK that signed a token, by `kid`. Falls back to the sole RSA key
// when the token omits a kid and the JWKS has exactly one RSA key (common with
// small IdPs). Returns null if no unambiguous match — the caller rejects.
function pickJwk(jwks, kid, alg) {
  const keys = (jwks && Array.isArray(jwks.keys)) ? jwks.keys : [];
  if (kid) {
    const byKid = keys.find((k) => k.kid === kid);
    return byKid || null; // a token naming a kid we don't have is a hard reject
  }
  const rsa = keys.filter((k) => k.kty === 'RSA' && (!k.alg || k.alg === alg));
  return rsa.length === 1 ? rsa[0] : null;
}

/**
 * Verify an OIDC id_token. This is the gate that everything else trusts.
 *
 * Enforced checks (ALL must pass or it throws SsoError):
 *   1. Signing alg is one of ALLOWED_ALGS (RS256/384/512) — rejects `none`
 *      and closes HS/RS alg-confusion.
 *   2. Signature verifies against the matching JWKS public key.
 *   3. `iss` (issuer) exactly equals the configured issuer.
 *   4. `aud` (audience) contains the configured client_id.
 *   5. `exp` (not expired) / `iat`/`nbf` within CLOCK_TOLERANCE_SEC.
 *   6. `nonce` exactly equals the per-transaction nonce we generated at /start.
 *   7. An `email` claim is present (we key users on it).
 *
 * @param {string} idToken
 * @param {object} opts
 * @param {object} opts.jwks     - the JWKS document ({ keys: [...] })
 * @param {string} opts.issuer   - configured issuer to match `iss`
 * @param {string} opts.clientId - configured client_id to match `aud`
 * @param {string} opts.nonce    - per-transaction nonce to match
 * @param {number} [opts.clockTolerance] - override skew tolerance (seconds)
 * @returns {object} the verified payload
 */
function verifyIdToken(idToken, { jwks, issuer, clientId, nonce, clockTolerance = CLOCK_TOLERANCE_SEC } = {}) {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new SsoError('Missing id_token', 'SSO_ID_TOKEN_MISSING');
  }
  if (!issuer || !clientId) {
    throw new SsoError('verifyIdToken requires issuer and clientId', 'SSO_CONFIG_MISSING');
  }
  if (!nonce) {
    // No stored nonce = we can't prove this token belongs to a login WE
    // started. Fail closed rather than skip the check.
    throw new SsoError('Missing transaction nonce', 'SSO_NONCE_MISSING');
  }

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header) {
    throw new SsoError('Malformed id_token', 'SSO_ID_TOKEN_MALFORMED');
  }

  const alg = decoded.header.alg;
  if (!ALLOWED_ALGS.includes(alg)) {
    // Rejects alg:none and any HMAC alg — see ALLOWED_ALGS note.
    throw new SsoError(`Unsupported id_token alg: ${alg}`, 'SSO_ALG_NOT_ALLOWED');
  }

  const jwk = pickJwk(jwks, decoded.header.kid, alg);
  if (!jwk) {
    throw new SsoError('No matching JWKS key for id_token', 'SSO_NO_SIGNING_KEY');
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (e) {
    throw new SsoError(`JWKS key is not a usable public key: ${e.message}`, 'SSO_BAD_SIGNING_KEY');
  }

  let payload;
  try {
    payload = jwt.verify(idToken, publicKey, {
      // Pin the allow-list, NOT the token's self-declared alg. jsonwebtoken
      // will reject any token whose alg isn't in this list (defense against
      // alg substitution). Because publicKey is an RSA key, an HS* token can't
      // be validated against it, and `none` is not in the list.
      algorithms: ALLOWED_ALGS,
      audience: clientId,          // check #4 — `aud` must contain client_id
      issuer,                      // check #3 — `iss` must equal issuer
      clockTolerance,              // check #5 — exp/iat/nbf skew tolerance
    });
  } catch (e) {
    // jsonwebtoken throws TokenExpiredError / JsonWebTokenError (bad sig, wrong
    // iss/aud) — all collapse to a single generic reject so we never leak which
    // check failed to an attacker.
    throw new SsoError(`id_token verification failed: ${e.message}`, 'SSO_ID_TOKEN_INVALID');
  }

  // check #6 — nonce binding. Constant-time compare to avoid a timing oracle.
  const a = Buffer.from(String(payload.nonce || ''));
  const b = Buffer.from(String(nonce));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new SsoError('id_token nonce mismatch', 'SSO_NONCE_MISMATCH');
  }

  // check #7 — we key users on email.
  if (!payload.email || typeof payload.email !== 'string') {
    throw new SsoError('id_token has no email claim', 'SSO_NO_EMAIL');
  }

  return payload;
}

/**
 * Enforce the org's allowed email domain against a verified email. Case-
 * insensitive exact match on the registrable domain. Throws SsoError on
 * mismatch — a verified token for user@evil.com must NOT sign into an org that
 * only permits acme.com.
 *
 * @param {string} email          - the verified email from the id_token
 * @param {string} allowedDomain  - the org's configured allowed_domain
 * @returns {string} the lower-cased email (safe to use downstream)
 */
function enforceDomain(email, allowedDomain) {
  if (!allowedDomain || typeof allowedDomain !== 'string') {
    // A connection with no allowed_domain is a misconfiguration; refuse rather
    // than accept ANY domain.
    throw new SsoError('SSO connection has no allowed_domain configured', 'SSO_NO_ALLOWED_DOMAIN');
  }
  const dom = domainOfEmail(email);
  if (!dom) {
    throw new SsoError('id_token email is not a valid address', 'SSO_BAD_EMAIL');
  }
  if (dom !== allowedDomain.trim().toLowerCase()) {
    throw new SsoError('SSO email domain not allowed for this organization', 'SSO_DOMAIN_NOT_ALLOWED');
  }
  return String(email).trim().toLowerCase();
}

module.exports = {
  SsoError,
  ALLOWED_ALGS,
  CLOCK_TOLERANCE_SEC,
  DEFAULT_SCOPE,
  randomToken,
  domainOfEmail,
  stripTrailingSlash,
  fetchDiscovery,
  fetchJwks,
  exchangeCode,
  buildAuthorizeUrl,
  pickJwk,
  verifyIdToken,
  enforceDomain,
};
