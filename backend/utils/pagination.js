// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Pagination Helper
// Reusable pagination utilities for all routes

/**
 * Parse pagination parameters from request query
 * @param {Object} req - Express request object
 * @returns {Object} { offset, limit }
 */
function parsePagination(req) {
  const { offset = 0, limit = 20 } = req.query;
  return {
    offset: Math.max(0, parseInt(offset)),
    limit: Math.min(100, Math.max(1, parseInt(limit)))
  };
}

/**
 * Build pagination metadata for response
 * @param {number} offset - Current offset
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {Object} Pagination metadata
 */
function buildPaginationMeta(offset, limit, total) {
  return {
    offset,
    limit,
    total,
    hasMore: offset + limit < total
  };
}

/**
 * Count rows matching WHERE clause
 * @param {Object} pool - Database connection pool
 * @param {string} table - Table name
 * @param {string} whereClause - WHERE condition (e.g., 'user_id = $1')
 * @param {Array} params - Query parameters
 * @returns {Promise<number>} Row count
 */
async function countRows(pool, table, whereClause, params) {
  const result = await pool.query(
    `SELECT COUNT(*) as total FROM ${table} WHERE ${whereClause}`,
    params
  );
  return parseInt(result.rows[0].total);
}

module.exports = {
  parsePagination,
  buildPaginationMeta,
  countRows
};
