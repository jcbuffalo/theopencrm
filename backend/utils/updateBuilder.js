// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Update Builder
// Fluent builder for constructing dynamic SQL UPDATE statements

/**
 * UpdateBuilder for building dynamic UPDATE queries
 * Usage:
 *   const ub = new UpdateBuilder()
 *     .set('title', title, v => v.trim().substring(0, 255))
 *     .set('priority', priority, v => Math.min(4, Math.max(1, v)))
 *     .set('status', status);
 *   const query = ub.build('tasks', 'id = $1 AND family_id = $2', [id, familyId]);
 *   const result = await pool.query(query.sql + ' RETURNING *', query.params);
 */
class UpdateBuilder {
  constructor() {
    this.fields = ['updated_at = NOW()'];
    this.params = [];
  }

  /**
   * Add a field to update
   * @param {string} column - Column name
   * @param {*} value - Value to set
   * @param {Function} sanitizer - Optional function to sanitize value
   * @returns {UpdateBuilder} this for chaining
   */
  set(column, value, sanitizer = x => x) {
    if (value !== undefined) {
      this.fields.push(`${column} = $${this.params.length + 1}`);
      this.params.push(sanitizer(value));
    }
    return this;
  }

  /**
   * Add a field with custom value (no sanitization)
   * @param {string} column - Column name
   * @param {*} value - Raw value
   * @returns {UpdateBuilder} this for chaining
   */
  setRaw(column, value) {
    if (value !== undefined) {
      this.fields.push(`${column} = $${this.params.length + 1}`);
      this.params.push(value);
    }
    return this;
  }

  /**
   * Build the UPDATE query
   * @param {string} table - Table name
   * @param {string} whereClause - WHERE condition
   * @param {Array} whereParams - WHERE parameters
   * @returns {Object|null} { sql, params } or null if no updates
   */
  build(table, whereClause, whereParams = []) {
    // Check if only updated_at is being set
    if (this.fields.length === 1) {
      return null;
    }

    const params = [...this.params, ...whereParams];
    const sql = `UPDATE ${table} SET ${this.fields.join(', ')} WHERE ${whereClause}`;

    return { sql, params };
  }

  /**
   * Check if there are any updates (besides updated_at)
   * @returns {boolean}
   */
  hasUpdates() {
    return this.fields.length > 1;
  }

  /**
   * Get the SET clause without UPDATE/WHERE
   * @returns {string} e.g., 'title = $1, status = $2, updated_at = NOW()'
   */
  getSetClause() {
    return this.fields.join(', ');
  }

  /**
   * Get the parameters
   * @returns {Array}
   */
  getParams() {
    return this.params;
  }
}

module.exports = UpdateBuilder;
