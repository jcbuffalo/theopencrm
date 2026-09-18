// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Response Formatter Middleware
// Standardized response format across all routes

/**
 * Send successful response
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {string} message - Status message
 * @param {number} statusCode - HTTP status code
 */
function sendSuccess(res, data, message = 'Success', statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    message,
    data
  });
}

/**
 * Send error response
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code
 * @param {Object} extras - Additional data to include
 */
function sendError(res, message, statusCode = 400, extras = {}) {
  res.status(statusCode).json({
    success: false,
    message,
    ...extras
  });
}

/**
 * Send paginated response
 * @param {Object} res - Express response object
 * @param {Array} data - Response data array
 * @param {Object} pagination - Pagination metadata { offset, limit, total, hasMore }
 * @param {string} message - Status message
 * @param {number} statusCode - HTTP status code
 */
function sendPaginated(res, data, pagination, message = 'Success', statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    message,
    data,
    pagination
  });
}

/**
 * Middleware to attach response helpers to res object
 * Usage: app.use(responseFormatterMiddleware())
 * Then in routes: res.sendSuccess(data, 'Created', 201)
 */
function responseFormatterMiddleware() {
  return (req, res, next) => {
    res.sendSuccess = (data, message = 'Success', statusCode = 200) => {
      sendSuccess(res, data, message, statusCode);
    };

    res.sendError = (message, statusCode = 400, extras = {}) => {
      sendError(res, message, statusCode, extras);
    };

    res.sendPaginated = (data, pagination, message = 'Success', statusCode = 200) => {
      sendPaginated(res, data, pagination, message, statusCode);
    };

    next();
  };
}

/**
 * Error handler middleware
 * Catches errors and formats them consistently
 * Usage: app.use(errorHandler())
 */
function errorHandler() {
  return (err, req, res, next) => {
    console.error('Error:', err);

    // If response already sent, pass to default handler
    if (res.headersSent) {
      return next(err);
    }

    // AppError (custom errors with statusCode)
    if (err.isOperational) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        name: err.name
      });
    }

    // PostgreSQL unique violation
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'This resource already exists',
        name: 'ConflictError'
      });
    }

    // PostgreSQL foreign key violation
    if (err.code === '23503') {
      return res.status(422).json({
        success: false,
        message: 'Cannot delete this resource due to dependencies',
        name: 'UnprocessableEntityError'
      });
    }

    // PostgreSQL syntax error
    if (err.code && err.code.startsWith('42')) {
      console.error('Database syntax error:', err);
      return res.status(500).json({
        success: false,
        message: 'Database error',
        name: 'DatabaseError'
      });
    }

    // Default error
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  };
}

module.exports = {
  sendSuccess,
  sendError,
  sendPaginated,
  responseFormatterMiddleware,
  errorHandler
};
