// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vitest setup file — runs once per worker before any test imports.
//
// We set the JWT / cookie / CSRF secrets here so auth.js and any module
// reading them at require-time finds non-empty values. The values are
// fixed strings (not random) so tokens minted by one test are verifiable
// by another within the same worker; vitest's worker isolation prevents
// cross-test pollution.
//
// Why not put this in vitest.config.js → setupFiles? Because setupFiles
// runs AFTER module-level requires in test files have started resolving,
// and several modules (auth.js, services/ai.js) read env vars at the
// module-load level. Setting them here, hoisted by vitest before the
// first user `require`, side-steps that ordering issue.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET        = process.env.JWT_SECRET        || 'test-jwt-secret-DO-NOT-USE-IN-PROD';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.JWT_2FA_SECRET    = process.env.JWT_2FA_SECRET    || 'test-2fa-secret';
process.env.COOKIE_SECRET     = process.env.COOKIE_SECRET     || 'test-cookie-secret';
process.env.CSRF_SECRET       = process.env.CSRF_SECRET       || 'test-csrf-secret';
process.env.FRONTEND_URL      = process.env.FRONTEND_URL      || 'http://localhost:3000';

// Stub DB connection vars so db.js's startup `SELECT NOW()` doesn't spew
// errors during test boot (the call still fails — we mock it — but the
// connection-string error message is just noise in test output).
process.env.DB_USER     = process.env.DB_USER     || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.DB_NAME     = process.env.DB_NAME     || 'test';
