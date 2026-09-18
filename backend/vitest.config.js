// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vitest config for the backend test suite.
//
// Why vitest (not jest, not node:test):
//   • Built-in vi.mock() for module-level mocking (we mock ../db so tests
//     don't need a real PostgreSQL). node:test's mocking story is too rough.
//   • Same "no extra config" feel as jest but ~3× faster cold-start and no
//     babel/swc transform pipeline to maintain.
//   • Native ESM + CJS interop — our codebase is CommonJS and vitest handles
//     that without `transform` config.
//
// SCOPE: tests live under backend/test/ (vitest convention) and the legacy
// node:test files under backend/tests/ are NOT picked up here (they run
// under `npm run test:legacy`). We deliberately keep the legacy suite
// runnable for parity with the prior CI shape until the migration settles.

const { defineConfig } = require('vitest/config');
const path = require('path');

module.exports = defineConfig({
  test: {
    root: __dirname,
    // Globbing: pick up everything in test/ and ignore the legacy node:test
    // dir (tests/) so we don't double-run.
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**', 'tests/**', 'migrations/**', 'legal/**'],
    environment: 'node',
    // Env vars (JWT_SECRET, COOKIE_SECRET, etc.) are seeded here before any
    // test module's top-level require runs. See test/setup.js header for
    // why it has to be a setupFiles entry (not a beforeAll in each test).
    setupFiles: ['./test/setup.js'],
    // Tests must not touch the real DB. If a test imports db.js without
    // mocking it, the pool constructor still runs — but no query goes out
    // because every code path under test mocks pool.query / pool.connect.
    //
    // globals: true exposes describe/test/expect/vi/beforeEach as implicit
    // module-scoped variables. Vitest 2 requires either `globals: true` OR
    // `import { vi } from 'vitest'` — `require('vitest')` is not supported
    // because vitest.mocks-API does some pre-import bookkeeping that only
    // works with ESM. Our codebase is CommonJS, so globals it is.
    globals: true,
    // Vitest defaults to running test files in parallel workers. Several of
    // our tests mock module-level state (the pool, the AI service); cross-
    // worker isolation is what makes that safe.
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // We're aiming for ~50% coverage of the NEW surface (chat tools,
      // plugin runner/SDK, notification dispatcher, validators). Legacy
      // routes, vendor SDKs, and migrations are explicitly excluded so the
      // coverage number reflects what we actually test.
      include: [
        'services/notificationDispatcher.js',
        'services/pluginSdk.js',
        'services/pluginRunner.js',
        'schemas/me.js',
        'middleware/validate.js',
        'routes/_bulkOps.js',
      ],
      exclude: [
        'migrations/**',
        'node_modules/**',
        'tests/**',
        'test/**',
        'legal/**',
        'scripts/**',
      ],
    },
    // Most tests run in a few hundred ms. Bumping the per-test timeout to
    // 10s gives the rare integration-style test (e.g. ai-chat tool loop)
    // headroom without masking real hangs.
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
