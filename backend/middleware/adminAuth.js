// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin authentication and role-based access control middleware
// Provides adminMiddleware and permissionMiddleware for protecting admin routes

const pool = require('../db');

// ============================================================================
// Admin Middleware - Verify user has admin role
// ============================================================================

async function adminMiddleware(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Check if user has admin_users record
    const result = await pool.query(
      `SELECT id, role, permissions FROM admin_users WHERE user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }

    const adminUser = result.rows[0];

    // Verify role is not 'viewer' (viewer is read-only)
    const validRoles = ['super_admin', 'admin', 'moderator'];
    if (!validRoles.includes(adminUser.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }

    // Attach admin info to request
    req.adminId = adminUser.id;
    req.adminRole = adminUser.role;
    req.adminPermissions = adminUser.permissions || [];

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ============================================================================
// Permission Middleware - Verify user has specific permissions
// ============================================================================

function permissionMiddleware(...requiredPermissions) {
  return async (req, res, next) => {
    try {
      // Super admin bypasses all permission checks
      if (req.adminRole === 'super_admin') {
        return next();
      }

      // Check if user has all required permissions
      const userPermissions = req.adminPermissions || [];
      const hasAllPermissions = requiredPermissions.every(permission =>
        userPermissions.includes(permission)
      );

      if (!hasAllPermissions) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions',
          required: requiredPermissions,
          missing: requiredPermissions.filter(p => !userPermissions.includes(p))
        });
      }

      next();
    } catch (error) {
      console.error('Permission middleware error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  };
}

// ============================================================================
// Role Middleware - Verify user has specific role
// ============================================================================

function roleMiddleware(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.adminRole)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: allowedRoles,
        current: req.adminRole
      });
    }

    next();
  };
}

// ============================================================================
// Get user's admin details
// ============================================================================

async function getAdminUser(userId) {
  const result = await pool.query(
    `SELECT id, user_id, role, permissions FROM admin_users WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

// ============================================================================
// Check if user is super admin
// ============================================================================

async function isSuperAdmin(userId) {
  const admin = await getAdminUser(userId);
  return !!admin && admin.role === 'super_admin';
}

// ============================================================================
// Check if user has permission
// ============================================================================

async function hasPermission(userId, permission) {
  const admin = await getAdminUser(userId);
  if (!admin) return false;

  // Super admin has all permissions
  if (admin.role === 'super_admin') return true;

  // Check specific permission array
  return (admin.permissions || []).includes(permission);
}

// ============================================================================
// Org-admin middleware — the SELF-SERVICE gate.
//
// Distinct from adminMiddleware (platform admin_users). An org OWNER or ADMIN
// (users.org_role, populated on req.orgRole by authMiddleware) manages their
// own workspace: modules, branding, automations, templates. Platform
// super-admins pass too (cross-org support). Members get 403; org-less users
// (personal workspace, no org_id) get 400 because there is no org to manage.
//
// Sets req.isSuperAdmin (boolean) so downstream handlers can make the
// "own org only vs. any org" and "org-scope vs. platform-scope" distinctions.
// ============================================================================

const ORG_ADMIN_ROLES = new Set(['owner', 'admin']);

async function requireOrgAdmin(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    // Resolve super-admin lazily; an org owner never needs the admin_users
    // lookup on the happy path.
    if (ORG_ADMIN_ROLES.has(req.orgRole)) {
      req.isOrgAdmin = true;
      if (typeof req.isSuperAdmin !== 'boolean') req.isSuperAdmin = await isSuperAdmin(req.userId);
      return next();
    }
    const superAdmin = await isSuperAdmin(req.userId);
    if (superAdmin) {
      req.isOrgAdmin = true;
      req.isSuperAdmin = true;
      return next();
    }
    req.isSuperAdmin = false;
    if (!req.orgId) {
      return res.status(400).json({ success: false, error: 'Org context required' });
    }
    return res.status(403).json({ success: false, error: 'Org owner or admin role required' });
  } catch (error) {
    console.error('requireOrgAdmin error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  adminMiddleware,
  permissionMiddleware,
  roleMiddleware,
  requireOrgAdmin,
  getAdminUser,
  isSuperAdmin,
  hasPermission
};
