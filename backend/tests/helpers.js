// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Test Helpers
// Fixtures and utilities for testing

const pool = require('../db');
const { generateToken } = require('../auth');

class TestHelper {
  /**
   * Create a test user
   * @param {Object} data - User data { first_name, last_name, email, password_hash }
   * @returns {Promise<number>} User ID
   */
  static async createTestUser(data = {}) {
    const {
      first_name = 'Test',
      last_name = 'User',
      email = `test-${Date.now()}@example.com`,
      password_hash = 'hashed_password'
    } = data;

    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [first_name, last_name, email, password_hash]
    );

    return result.rows[0].id;
  }

  /**
   * Create a test family and add user to it
   * @param {number} userId - User ID
   * @param {string} role - User role (admin, member, child)
   * @returns {Promise<Object>} { family_id, family_member_id }
   */
  static async createTestFamily(userId, role = 'admin') {
    // Assume family_id 1 exists or create
    const familyId = 1;

    const result = await pool.query(
      `INSERT INTO family_members (user_id, family_id, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, familyId, role]
    );

    return {
      family_id: familyId,
      family_member_id: result.rows[0].id
    };
  }

  /**
   * Generate JWT auth token for user
   * @param {number} userId - User ID
   * @returns {string} JWT token
   */
  static generateAuthToken(userId) {
    return generateToken(userId);
  }

  /**
   * Create test resource (generic)
   * @param {string} table - Table name
   * @param {Object} data - Data to insert
   * @returns {Promise<Object>} Inserted row
   */
  static async createTestResource(table, data) {
    const columns = Object.keys(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
    const values = Object.values(data);

    const result = await pool.query(
      `INSERT INTO ${table} (${columns.join(',')})
       VALUES (${placeholders})
       RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Cleanup - delete test user and related data
   * @param {number} userId - User ID to delete
   */
  static async cleanup(userId) {
    await pool.query('DELETE FROM family_members WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  /**
   * Cleanup - delete test resource
   * @param {string} table - Table name
   * @param {number} id - Resource ID
   */
  static async cleanupResource(table, id) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }

  /**
   * Assert that response is successful
   * @param {Object} response - API response object
   * @throws {Error} If not successful
   */
  static assertSuccess(response) {
    if (!response.success) {
      throw new Error(`Expected success, got: ${response.message}`);
    }
  }

  /**
   * Assert that response has error
   * @param {Object} response - API response object
   * @param {string} expectedMessage - Expected error message (optional)
   * @throws {Error} If successful
   */
  static assertError(response, expectedMessage = null) {
    if (response.success) {
      throw new Error('Expected error, but request was successful');
    }
    if (expectedMessage && !response.message.includes(expectedMessage)) {
      throw new Error(`Expected message to include "${expectedMessage}", got: "${response.message}"`);
    }
  }
}

module.exports = TestHelper;
