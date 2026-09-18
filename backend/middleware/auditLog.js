// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Audit logging middleware
// Automatically logs admin actions, user modifications, and sensitive operations

const pool = require('../db');

// ============================================================================
// Log an audit event
// ============================================================================

async function logAuditEvent({
  userId,
  adminId,
  action,
  resourceType,
  resourceId,
  changes = null,
  ipAddress = null,
  userAgent = null,
  status = 'success',
  details = null
}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
       (user_id, admin_id, action, resource_type, resource_id, changes, ip_address, user_agent, status, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId || null,
        adminId || null,
        action,
        resourceType,
        resourceId || null,
        changes ? JSON.stringify(changes) : null,
        ipAddress,
        userAgent,
        status,
        details
      ]
    );
  } catch (error) {
    // Log but don't fail if audit logging fails
    console.error('Failed to log audit event:', error);
  }
}

// ============================================================================
// Middleware to automatically audit admin route changes
// ============================================================================

function auditLogMiddleware(req, res, next) {
  // Store original end function
  const originalEnd = res.end;

  // Capture request details
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const startTime = Date.now();

  // Hook into response to log after completion
  res.end = function(...args) {
    try {
      const duration = Date.now() - startTime;
      const status = res.statusCode < 400 ? 'success' : 'failed';

      // Only log if user is authenticated
      if (req.userId && req.method !== 'GET') {
        // Extract action from route
        const action = `${req.method} ${req.path}`;

        // Try to determine resource from body or params
        const resourceId = req.params.id || req.body?.id || null;
        const resourceType = extractResourceType(req.path);

        logAuditEvent({
          userId: req.userId,
          adminId: req.adminId || null,
          action,
          resourceType,
          resourceId,
          changes: req.body || null,
          ipAddress,
          userAgent,
          status,
          details: `Completed in ${duration}ms`
        }).catch(err => console.error('Audit log error:', err));
      }
    } catch (error) {
      console.error('Audit middleware error:', error);
    }

    // Call original end
    originalEnd.apply(res, args);
  };

  next();
}

// ============================================================================
// Extract resource type from request path
// ============================================================================

function extractResourceType(path) {
  if (path.includes('/admin/users')) return 'user';
  if (path.includes('/admin/admins')) return 'admin_user';
  if (path.includes('/admin/audit-logs')) return 'audit_log';
  if (path.includes('/security')) return 'security_check';
  if (path.includes('/accessibility')) return 'accessibility_audit';
  if (path.includes('/compliance')) return 'compliance_check';
  return 'unknown';
}

// ============================================================================
// Get audit logs with filtering and pagination
// ============================================================================

async function getAuditLogs({
  limit = 20,
  offset = 0,
  action = null,
  userId = null,
  resourceType = null,
  startDate = null,
  endDate = null
} = {}) {
  try {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let paramCount = 1;

    // Add filters
    if (action) {
      query += ` AND action ILIKE $${paramCount}`;
      params.push(`%${action}%`);
      paramCount++;
    }

    if (userId) {
      query += ` AND user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (resourceType) {
      query += ` AND resource_type = $${paramCount}`;
      params.push(resourceType);
      paramCount++;
    }

    if (startDate) {
      query += ` AND created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM audit_logs WHERE 1=1` +
      (action ? ` AND action ILIKE $1` : '') +
      (userId ? ` AND user_id = $${action ? 2 : 1}` : '') +
      (resourceType ? ` AND resource_type = $${action ? (userId ? 3 : 2) : (userId ? 2 : 1)}` : ''),
      params.slice(0, paramCount - 1 - (limit > 0 ? 2 : 0))
    );

    // Get paginated results
    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    return {
      data: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
      page: Math.floor(offset / limit) + 1
    };
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    throw error;
  }
}

// ============================================================================
// Export to CSV
// ============================================================================

async function exportAuditLogsCSV({
  action = null,
  userId = null,
  resourceType = null,
  startDate = null,
  endDate = null
} = {}) {
  try {
    const logs = await getAuditLogs({
      limit: 100000, // No limit for export
      offset: 0,
      action,
      userId,
      resourceType,
      startDate,
      endDate
    });

    if (logs.data.length === 0) {
      return '';
    }

    // Create CSV header
    const headers = ['ID', 'User ID', 'Admin ID', 'Action', 'Resource Type', 'Resource ID', 'Status', 'IP Address', 'Created At'];
    const rows = [headers.join(',')];

    // Add data rows
    logs.data.forEach(log => {
      rows.push([
        log.id,
        log.user_id || '',
        log.admin_id || '',
        `"${log.action}"`,
        log.resource_type,
        log.resource_id || '',
        log.status,
        log.ip_address || '',
        log.created_at
      ].join(','));
    });

    return rows.join('\n');
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    throw error;
  }
}

module.exports = {
  logAuditEvent,
  auditLogMiddleware,
  getAuditLogs,
  exportAuditLogsCSV,
  extractResourceType
};
