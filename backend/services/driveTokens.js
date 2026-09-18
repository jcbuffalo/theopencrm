// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AES-256-GCM encrypt/decrypt of Google Drive refresh tokens.
//
// WHY: Google refresh tokens DO NOT rotate on use — once issued, they remain
// valid until the user revokes them. Storing them in plaintext means any
// read-access to the DB (a backup, a leaked dump, a misconfigured replica)
// hands an attacker long-lived Drive access for every customer org. So:
// every refresh_token sits in `org_drive_connections` as a three-column tuple
// (ciphertext, iv, tag) encrypted with a server-held key.
//
// KEY MANAGEMENT
//   DRIVE_TOKEN_ENCRYPTION_KEY is the 32-byte AES key, supplied via env as
//   base64. Generate one with:  openssl rand -base64 32
//   The key never leaves the running process; rotating it requires
//   re-encrypting every row (Phase 2 concern — we'd add a key_id column
//   and a dual-decrypt path).
//
// PER-TOKEN IV
//   Every encryption generates a fresh random 12-byte nonce. AES-GCM mandates
//   nonce uniqueness per key — reusing a (key, nonce) pair leaks plaintext
//   XORs and can recover the auth key. 12 bytes is the standard GCM nonce
//   size; randomBytes is good enough at our throughput (we encrypt on
//   OAuth callback, not on the hot path).
//
// AUTH TAG
//   16-byte GCM auth tag stored separately. Decryption with a mismatched tag
//   throws (treated as tamper / wrong key) — callers MUST propagate the
//   error to the user as "reconnect Drive", not silently swallow.
//
// GRACEFUL DEGRADATION
//   isConfigured() returns false when the env key is missing or malformed;
//   the route layer surfaces a 503 with a reconnect-Drive message instead
//   of throwing on every request. Mirrors services/email.js's pattern.

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_LEN = 12;     // GCM standard
const TAG_LEN = 16;    // GCM auth tag length
const KEY_LEN = 32;    // AES-256 = 32-byte key

let cachedKey = null;
let cachedKeyError = null;

/**
 * Decode the base64-encoded encryption key into a 32-byte Buffer. Cached
 * after first successful decode. Returns null + sets cachedKeyError if the
 * env var is missing or malformed — callers should check isConfigured()
 * first rather than catching here.
 */
function loadKey() {
  if (cachedKey) return cachedKey;
  if (cachedKeyError) return null;
  const raw = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    cachedKeyError = 'DRIVE_TOKEN_ENCRYPTION_KEY is not set';
    return null;
  }
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (err) {
    cachedKeyError = `DRIVE_TOKEN_ENCRYPTION_KEY is not valid base64: ${err.message}`;
    return null;
  }
  if (buf.length !== KEY_LEN) {
    cachedKeyError = `DRIVE_TOKEN_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${buf.length}); generate with: openssl rand -base64 32`;
    return null;
  }
  cachedKey = buf;
  return cachedKey;
}

function isConfigured() {
  return loadKey() !== null;
}

function configError() {
  // Force the cache decision once so cachedKeyError is populated if applicable.
  loadKey();
  return cachedKeyError;
}

/**
 * Encrypt a plaintext string (utf8). Returns { ciphertext, iv, tag } as
 * three Buffer instances — caller writes them into the three bytea columns
 * verbatim. Throws if isConfigured() === false (the routes guard before
 * calling, so reaching here on a misconfigured deploy is a bug).
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('driveTokens.encrypt: plaintext must be a non-empty string');
  }
  const key = loadKey();
  if (!key) {
    throw new Error(`driveTokens.encrypt: ${cachedKeyError}`);
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    // Defensive — Node's GCM always emits 16, but if a future Node release
    // changes the default we want a hard fail rather than silent truncation.
    throw new Error(`driveTokens.encrypt: unexpected auth tag length ${tag.length}`);
  }
  return { ciphertext, iv, tag };
}

/**
 * Decrypt the three-buffer tuple back to the original utf8 string. Throws
 * on tamper / wrong-key (Node raises "Unsupported state or unable to
 * authenticate data" inside .final()) — callers must surface that as
 * "reconnect Drive" to the user.
 */
function decrypt({ ciphertext, iv, tag }) {
  const key = loadKey();
  if (!key) {
    throw new Error(`driveTokens.decrypt: ${cachedKeyError}`);
  }
  if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(iv) || !Buffer.isBuffer(tag)) {
    throw new Error('driveTokens.decrypt: ciphertext, iv, and tag must all be Buffers');
  }
  if (iv.length !== IV_LEN) {
    throw new Error(`driveTokens.decrypt: iv must be ${IV_LEN} bytes (got ${iv.length})`);
  }
  if (tag.length !== TAG_LEN) {
    throw new Error(`driveTokens.decrypt: tag must be ${TAG_LEN} bytes (got ${tag.length})`);
  }
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Test-only: reset the cached key so a test can swap DRIVE_TOKEN_ENCRYPTION_KEY
// mid-suite. Not part of the public production surface.
function _resetForTests() {
  cachedKey = null;
  cachedKeyError = null;
}

module.exports = {
  encrypt,
  decrypt,
  isConfigured,
  configError,
  _resetForTests,
};
