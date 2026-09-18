// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Query Builder
// Fluent builder for constructing dynamic SQL WHERE clauses

/**
 * QueryBuilder for constructing WHERE clauses dynamically
 * Usage:
 *   const qb = new QueryBuilder('family_id = $1', [familyId])
 *     .where('status', 'pending')
 *     .where('priority', priority)
 *     .whereIn('room_id', roomIds);
 *   const { where, params } = qb.build();
 *   pool.query(`SELECT * FROM tasks WHERE ${where}`, params);
 */
class QueryBuilder {
  constructor(baseCondition = '', baseParams = []) {
    this.conditions = baseCondition ? [baseCondition] : [];
    this.params = baseParams ? [...baseParams] : [];
  }

  /**
   * Add a WHERE condition
   * @param {string} column - Column name (e.g., 'status')
   * @param {*} value - Value to match
   * @param {string} operator - SQL operator (default '=')
   * @returns {QueryBuilder} this for chaining
   */
  where(column, value, operator = '=') {
    if (value !== undefined && value !== null && value !== '') {
      this.conditions.push(`${column} ${operator} $${this.params.length + 1}`);
      this.params.push(value);
    }
    return this;
  }

  /**
   * Add a WHERE IN condition
   * @param {string} column - Column name
   * @param {Array} values - Array of values
   * @returns {QueryBuilder} this for chaining
   */
  whereIn(column, values) {
    if (values && values.length > 0) {
      const placeholders = values.map(() => `$${this.params.length + 1}`).join(',');
      this.conditions.push(`${column} IN (${placeholders})`);
      this.params.push(...values);
    }
    return this;
  }

  /**
   * Add a LIKE condition for search/filtering
   * @param {string} column - Column name
   * @param {string} value - Search value
   * @returns {QueryBuilder} this for chaining
   */
  whereLike(column, value) {
    if (value) {
      this.conditions.push(`${column} ILIKE $${this.params.length + 1}`);
      this.params.push(`%${value}%`);
    }
    return this;
  }

  /**
   * Add a date range condition
   * @param {string} column - Column name
   * @param {string} afterDate - Start date (ISO string)
   * @param {string} beforeDate - End date (ISO string)
   * @returns {QueryBuilder} this for chaining
   */
  whereDateBetween(column, afterDate, beforeDate) {
    if (afterDate) {
      this.conditions.push(`${column} >= $${this.params.length + 1}`);
      this.params.push(afterDate);
    }
    if (beforeDate) {
      this.conditions.push(`${column} <= $${this.params.length + 1}`);
      this.params.push(beforeDate);
    }
    return this;
  }

  /**
   * Build the query
   * @returns {Object} { where: string, params: Array }
   */
  build() {
    return {
      where: this.conditions.join(' AND ') || '1=1',
      params: this.params
    };
  }

  /**
   * Get just the WHERE conditions as a string
   * @returns {string} WHERE clause without 'WHERE' keyword
   */
  getWhereString() {
    return this.conditions.join(' AND ') || '1=1';
  }

  /**
   * Get parameters for query
   * @returns {Array} Parameters
   */
  getParams() {
    return this.params;
  }
}

module.exports = QueryBuilder;
