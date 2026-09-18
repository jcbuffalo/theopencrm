// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the boot-time env-validation safety net.
const test = require('node:test');
const assert = require('node:assert/strict');

// Helper: spawn a fresh require of validateEnv with a clean env so we don't
// pollute Node's module cache between test cases.
function freshValidator(env) {
  const original = { ...process.env };
  Object.keys(process.env).forEach(k => { delete process.env[k]; });
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../services/envValidation')];
  const mod = require('../services/envValidation');
  // restore env after import
  Object.keys(process.env).forEach(k => { delete process.env[k]; });
  Object.assign(process.env, original);
  return mod.validateEnv;
}

test('validateEnv passes in dev when required vars are missing (warns only)', () => {
  const validateEnv = freshValidator({});
  // We re-set NODE_ENV to dev for this test to ensure we don't crash.
  process.env.NODE_ENV = 'development';
  const report = validateEnv();
  assert.ok(report);
  assert.equal(report.environment, 'development');
});

test('validateEnv throws in production when JWT_SECRET is missing', () => {
  const validateEnv = freshValidator({});
  process.env.NODE_ENV = 'production';
  process.env.DB_USER = 'u';
  process.env.DB_PASSWORD = 'p';
  process.env.DB_NAME = 'd';
  process.env.INSTANCE_CONNECTION_NAME = 'a:b:c';
  process.env.FRONTEND_URL = 'https://x.test';
  // JWT_SECRET deliberately not set
  assert.throws(validateEnv, /JWT_SECRET/);
});

test('validateEnv throws in production when JWT_SECRET is the placeholder', () => {
  const validateEnv = freshValidator({});
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'your-secret-key';  // the dangerous default
  process.env.DB_USER = 'u';
  process.env.DB_PASSWORD = 'p';
  process.env.DB_NAME = 'd';
  process.env.INSTANCE_CONNECTION_NAME = 'a:b:c';
  process.env.FRONTEND_URL = 'https://x.test';
  assert.throws(validateEnv, /JWT_SECRET/);
});

test('validateEnv passes in production with all required vars set', () => {
  const validateEnv = freshValidator({});
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'a-real-strong-secret-not-the-placeholder';
  process.env.COOKIE_SECRET = 'a-real-cookie-secret';
  process.env.CSRF_SECRET = 'a-real-csrf-secret';
  process.env.JWT_2FA_SECRET = 'a-real-2fa-secret';
  process.env.DB_USER = 'u';
  process.env.DB_PASSWORD = 'p';
  process.env.DB_NAME = 'd';
  process.env.INSTANCE_CONNECTION_NAME = 'a:b:c';
  process.env.FRONTEND_URL = 'https://x.test';
  const report = validateEnv();
  assert.equal(report.required.JWT_SECRET, true);
  assert.equal(report.required.COOKIE_SECRET, true);
  assert.equal(report.required.CSRF_SECRET, true);
  assert.equal(report.required.JWT_2FA_SECRET, true);
  assert.equal(report.required.DB_USER, true);
});

test('validateEnv throws in production when COOKIE_SECRET is missing', () => {
  const validateEnv = freshValidator({});
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'a-real-strong-secret';
  process.env.CSRF_SECRET = 'csrf';
  process.env.JWT_2FA_SECRET = '2fa';
  process.env.DB_USER = 'u';
  process.env.DB_PASSWORD = 'p';
  process.env.DB_NAME = 'd';
  process.env.INSTANCE_CONNECTION_NAME = 'a:b:c';
  process.env.FRONTEND_URL = 'https://x.test';
  // freshValidator restored the parent env, which may still contain
  // COOKIE_SECRET from a prior test. Explicitly remove it so we exercise
  // the "missing var" path.
  delete process.env.COOKIE_SECRET;
  assert.throws(validateEnv, /COOKIE_SECRET/);
});
