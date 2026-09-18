// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Example unit tests for backend/auth.js using Node 18+ built-in test runner.
//
// Run: `npm test` from /backend.
//
// This file is the template — copy-paste it as the starting shape when adding
// tests for routes or services. We deliberately use Node's built-in `node:test`
// rather than Jest/Vitest so there's no extra dependency to install/maintain.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword } = require('../auth');

test('validatePassword rejects too-short passwords', () => {
  const r = validatePassword('Aa1!');
  assert.equal(r.ok, false);
  assert.match(r.error, /at least 10/);
});

test('validatePassword rejects passwords missing character classes', () => {
  // 12 chars, only lowercase
  const r = validatePassword('abcdefghijkl');
  assert.equal(r.ok, false);
  assert.match(r.error, /3 of/);
});

test('validatePassword rejects common-pattern passwords', () => {
  const r = validatePassword('Password123!');
  assert.equal(r.ok, false);
  assert.match(r.error, /commonly-guessed/);
});

test('validatePassword accepts a strong password', () => {
  const r = validatePassword('Tx7$mb-vQp9k!');
  assert.equal(r.ok, true);
});

test('validatePassword rejects non-strings', () => {
  const r = validatePassword(null);
  assert.equal(r.ok, false);
});

test('validatePassword caps at 200 chars', () => {
  const r = validatePassword('a'.repeat(201) + 'A1!');
  assert.equal(r.ok, false);
  assert.match(r.error, /200 characters/);
});
