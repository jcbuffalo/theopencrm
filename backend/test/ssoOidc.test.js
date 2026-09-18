// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Enterprise SSO — id_token verification tests. THIS is the security-critical
// suite: the whole login path trusts services/ssoOidc.verifyIdToken to reject
// anything an attacker could forge or replay.
//
// We generate a throwaway RSA keypair locally, publish the public half as a
// JWKS, and sign id_tokens with the private half — a faithful stand-in for a
// real IdP with NO network. Each test flips exactly one thing (iss, aud, exp,
// nonce, signature, alg) and asserts reject; the control asserts accept.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const oidc = require('../services/ssoOidc');

// --- fake IdP keypair + JWKS ------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const JWKS = { keys: [jwk] };

// A DIFFERENT keypair — used to forge a signature the real JWKS can't verify.
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPem = other.privateKey.export({ type: 'pkcs8', format: 'pem' });

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-abc';
const NONCE = 'nonce-xyz-123';

// Build a signed id_token. `claims` overrides payload; `opts` overrides signer.
function makeToken(claims = {}, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    nonce: NONCE,
    email: 'user@acme.com',
    sub: 'subject-1',
    iat: now,
    exp: now + 300,
    ...claims,
  };
  const pem = opts.pem || privatePem;
  const signOpts = { algorithm: opts.alg || 'RS256', noTimestamp: true };
  // opts.kid === null → omit the kid header entirely; else default to KID.
  if (opts.kid !== null) signOpts.keyid = opts.kid || KID;
  return jwt.sign(payload, pem, signOpts);
}

const baseOpts = () => ({ jwks: JWKS, issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE });

describe('ssoOidc.verifyIdToken — ACCEPT', () => {
  test('accepts a fully valid id_token and returns the claims', () => {
    const token = makeToken();
    const payload = oidc.verifyIdToken(token, baseOpts());
    expect(payload.email).toBe('user@acme.com');
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(CLIENT_ID);
  });

  test('accepts when aud is an array containing the client_id', () => {
    const token = makeToken({ aud: ['someone-else', CLIENT_ID] });
    const payload = oidc.verifyIdToken(token, baseOpts());
    expect(payload.sub).toBe('subject-1');
  });
});

describe('ssoOidc.verifyIdToken — REJECT', () => {
  test('rejects a wrong issuer (iss mismatch)', () => {
    const token = makeToken({ iss: 'https://evil.example.com' });
    expect(() => oidc.verifyIdToken(token, baseOpts())).toThrow(oidc.SsoError);
  });

  test('rejects a wrong audience (aud != client_id)', () => {
    const token = makeToken({ aud: 'a-different-client' });
    expect(() => oidc.verifyIdToken(token, baseOpts())).toThrow(/verification failed/i);
  });

  test('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ iat: now - 4000, exp: now - 3600 });
    expect(() => oidc.verifyIdToken(token, baseOpts())).toThrow(oidc.SsoError);
  });

  test('rejects a bad nonce (replay / different transaction)', () => {
    const token = makeToken({ nonce: 'some-other-nonce' });
    let err;
    try { oidc.verifyIdToken(token, baseOpts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_NONCE_MISMATCH');
  });

  test('rejects a token whose signature does not match the JWKS key', () => {
    // Signed by `other` but still claims kid=KID, so pickJwk finds the real
    // public key and the signature check fails.
    const token = makeToken({}, { pem: otherPem });
    let err;
    try { oidc.verifyIdToken(token, baseOpts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_ID_TOKEN_INVALID');
  });

  test('rejects an HMAC (HS256) token — alg-confusion defense', () => {
    // Attacker signs with HS256 using a guessed/known secret. verifyIdToken
    // must refuse because HS* is not in ALLOWED_ALGS.
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { iss: ISSUER, aud: CLIENT_ID, nonce: NONCE, email: 'user@acme.com', iat: now, exp: now + 300 },
      'a-shared-secret',
      { algorithm: 'HS256', keyid: KID, noTimestamp: true }
    );
    let err;
    try { oidc.verifyIdToken(token, baseOpts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_ALG_NOT_ALLOWED');
  });

  test('rejects alg:none (unsigned) token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { iss: ISSUER, aud: CLIENT_ID, nonce: NONCE, email: 'user@acme.com', iat: now, exp: now + 300 },
      '',
      { algorithm: 'none', noTimestamp: true }
    );
    expect(() => oidc.verifyIdToken(token, baseOpts())).toThrow(oidc.SsoError);
  });

  test('rejects when the token references a kid not present in the JWKS', () => {
    const token = makeToken({}, { kid: 'unknown-kid' });
    let err;
    try { oidc.verifyIdToken(token, baseOpts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_NO_SIGNING_KEY');
  });

  test('rejects when the caller has no stored nonce (fail closed)', () => {
    const token = makeToken();
    expect(() => oidc.verifyIdToken(token, { ...baseOpts(), nonce: undefined })).toThrow(/nonce/i);
  });

  test('rejects a token with no email claim', () => {
    const token = makeToken({ email: undefined });
    let err;
    try { oidc.verifyIdToken(token, baseOpts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_NO_EMAIL');
  });
});

describe('ssoOidc.enforceDomain', () => {
  test('accepts an email whose domain matches allowed_domain (case-insensitive)', () => {
    expect(oidc.enforceDomain('Alice@Acme.com', 'acme.com')).toBe('alice@acme.com');
  });

  test('rejects an email from a different domain even if the token was valid', () => {
    let err;
    try { oidc.enforceDomain('mallory@evil.com', 'acme.com'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(oidc.SsoError);
    expect(err.code).toBe('SSO_DOMAIN_NOT_ALLOWED');
  });

  test('rejects when the connection has no allowed_domain configured', () => {
    expect(() => oidc.enforceDomain('anyone@acme.com', '')).toThrow(/allowed_domain/i);
  });
});
