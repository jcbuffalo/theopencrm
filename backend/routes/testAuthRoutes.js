// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

/**
 * Test Authentication Routes
 * Provides demo login for development/testing without Google OAuth setup
 * Only enabled when LOGIN_MODE=test or LOGIN_MODE=both
 *
 * ⚠️ SECURITY: Never use in production!
 */

const express = require('express');
const router = express.Router();
const { generateToken, AUTH_COOKIE_NAME, authCookieOptions } = require('../auth');
const pool = require('../db');

/**
 * Test Users - Pre-loaded for demo/development
 * These are created on demand from this fixture
 */
const TEST_USERS = [
  {
    id: 'test-user-1',
    email: 'demo@example.com',
    name: 'Demo User',
    password: 'DemoPass123!',
  },
  {
    id: 'test-user-2',
    email: 'test@example.com',
    name: 'Test Account',
    password: 'TestPass123!',
  },
  {
    id: 'test-user-3',
    email: 'admin@example.com',
    name: 'Admin Demo',
    password: 'AdminPass123!',
  },
];

/**
 * POST /auth/test-login
 * Demo login with test users
 *
 * Request body:
 * {
 *   "email": "demo@example.com",
 *   "password": "DemoPass123!"
 * }
 *
 * Response: Same format as Google OAuth
 */
router.post('/test-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'email and password are required',
      });
    }

    // Find test user
    const testUser = TEST_USERS.find(
      (u) => u.email === email && u.password === password
    );

    if (!testUser) {
      return res.status(401).json({
        success: false,
        error: 'Invalid test credentials. Use demo@example.com / DemoPass123!',
        availableUsers: TEST_USERS.map((u) => ({
          email: u.email,
          password: u.password,
          name: u.name,
        })),
      });
    }

    // Create or update test user in database
    let user;
    try {
      // Try to find existing test user in DB
      const result = await pool.query(
        'SELECT id, email, name FROM users WHERE email = $1',
        [testUser.email]
      );

      user = result.rows[0];

      if (!user) {
        // Create test user in DB if doesn't exist
        const createResult = await pool.query(
          `INSERT INTO users (email, name, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           RETURNING id, email, name`,
          [testUser.email, testUser.name, null] // No password hash for test users
        );
        user = createResult.rows[0];
        console.log(`✅ Created test user: ${testUser.email}`);
      }
    } catch (dbError) {
      console.error('⚠️  DB error during test login (non-fatal):', dbError.message);
      // If DB fails, use in-memory user (for demo mode)
      user = {
        id: testUser.id,
        email: testUser.email,
        name: testUser.name,
      };
    }

    // Issue session cookie + CSRF token (same pattern as real login).
    const token = generateToken(user.id);
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
    let csrfToken = null;
    try {
      if (typeof req.app.locals.generateCsrfToken === 'function') {
        csrfToken = req.app.locals.generateCsrfToken(req, res);
      }
    } catch { /* csrf middleware missing in test harness — ignore */ }

    res.json({
      success: true,
      message: 'Test login successful',
      isTestUser: true,
      csrfToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error('Test login error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Test login failed',
    });
  }
});

/**
 * GET /auth/test-users
 * Get list of available test users (for development UI)
 * Shows all test users and their credentials
 *
 * ⚠️ SECURITY: Only available in development mode
 */
router.get('/test-users', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error: 'Test users not available in production',
    });
  }

  res.json({
    success: true,
    testUsers: TEST_USERS.map((u) => ({
      email: u.email,
      password: u.password,
      name: u.name,
    })),
    note: 'These credentials are for development only. Never use real user data here.',
  });
});

module.exports = router;
