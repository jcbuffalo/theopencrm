// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin routes - Complete admin API for user management, roles, and system management

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../auth');
const { adminMiddleware, permissionMiddleware, roleMiddleware } = require('../middleware/adminAuth');
const { logAuditEvent, getAuditLogs, exportAuditLogsCSV } = require('../middleware/auditLog');
const { runAllSecurityChecks, getSecurityStatus, getLatestSecurityChecks } = require('../middleware/securityValidator');
const email = require('../services/email');
const { provisionOrg, ProvisionError } = require('../services/orgProvisioner');

// ============================================================================
// ADMIN DASHBOARD - Overview
// ============================================================================

router.get('/', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const [usersResult, securityResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total FROM users`),
      getSecurityStatus()
    ]);

    const totalUsers = parseInt(usersResult.rows[0].total);
    const securityStatus = securityResult || { total: 0, passed: 0, failed: 0 };

    res.json({
      success: true,
      data: {
        totalUsers,
        security: {
          criticalIssues: securityStatus.critical_issues || 0,
          passedChecks: securityStatus.passed || 0,
          failedChecks: securityStatus.failed || 0
        },
        role: req.adminRole,
        lastChecked: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// USER MANAGEMENT - List all users
// ============================================================================

router.get('/users', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, email, plan } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT id, email, name, plan, created_at FROM users WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (email) {
      query += ` AND email ILIKE $${paramCount}`;
      params.push(`%${email}%`);
      paramCount++;
    }

    if (plan) {
      query += ` AND plan = $${paramCount}`;
      params.push(plan);
      paramCount++;
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM users WHERE 1=1${email ? ` AND email ILIKE $1` : ''}${plan ? ` AND plan = $${email ? 2 : 1}` : ''}`,
      params.slice(0, paramCount - 1)
    );

    // Get paginated results
    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// USER MANAGEMENT - Get user details
// ============================================================================

router.get('/users/:id', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, email, name, plan, provider, created_at, updated_at FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// USER MANAGEMENT - Update user
// ============================================================================

router.put('/users/:id', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, plan } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    // Get current user data for audit log
    const currentUser = await pool.query(
      `SELECT name, plan FROM users WHERE id = $1`,
      [id]
    );

    if (currentUser.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const before = currentUser.rows[0];

    // Update user
    const result = await pool.query(
      `UPDATE users SET name = $1, plan = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [name.trim(), plan || 'free', id]
    );

    // Log audit event
    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'user_updated',
      resourceType: 'user',
      resourceId: parseInt(id),
      changes: { before, after: { name: result.rows[0].name, plan: result.rows[0].plan } },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// USER MANAGEMENT - Delete user
// ============================================================================

router.delete('/users/:id', authMiddleware, adminMiddleware, permissionMiddleware('manage_users'), async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get user before deletion for audit
    const user = await pool.query(
      `SELECT id, email, name FROM users WHERE id = $1`,
      [id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // GUARD: refuse to delete a user who owns an organization. owner_user_id
    // cascades into the entire tenant (every org-scoped row), so a single
    // mis-click here would erase a paying customer's workspace. Ownership must
    // be transferred first. The DB-level FK (migration 097, ON DELETE RESTRICT)
    // is the structural backstop; this returns a clean 409 instead of a 500.
    const owned = await pool.query(
      `SELECT id, name FROM organizations WHERE owner_user_id = $1`,
      [id]
    );
    if (owned.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete a user who owns ${owned.rows.length} organization(s). Transfer ownership first.`,
        organizations: owned.rows,
      });
    }

    // Delete user (cascade will delete records owned solely by this user_id)
    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    // Log audit event
    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'user_deleted',
      resourceType: 'user',
      resourceId: parseInt(id),
      changes: { user: user.rows[0] },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ADMIN ROLE MANAGEMENT - List admin users
// ============================================================================

router.get('/admins', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        au.id,
        au.user_id,
        au.role,
        au.permissions,
        au.created_at,
        u.email,
        u.name
      FROM admin_users au
      JOIN users u ON u.id = au.user_id
      ORDER BY au.created_at DESC
    `);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ADMIN ROLE MANAGEMENT - Make user admin
// ============================================================================

router.post('/admins', authMiddleware, adminMiddleware, permissionMiddleware('manage_admins'), async (req, res, next) => {
  try {
    const { user_id, role = 'admin' } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    // Verify user exists
    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Create admin user
    const result = await pool.query(
      `INSERT INTO admin_users (user_id, role) VALUES ($1, $2) RETURNING *`,
      [user_id, role]
    );

    // Log audit event
    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'admin_created',
      resourceType: 'admin_user',
      resourceId: result.rows[0].id,
      changes: { role, user_id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      // Unique constraint violation - user already admin
      return res.status(400).json({ success: false, message: 'User is already an admin' });
    }
    next(error);
  }
});

// ============================================================================
// ADMIN ROLE MANAGEMENT - Update admin role
// ============================================================================

router.put('/admins/:id', authMiddleware, adminMiddleware, permissionMiddleware('manage_admins'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['super_admin', 'admin', 'moderator', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }

    const result = await pool.query(
      `UPDATE admin_users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Admin user not found' });
    }

    // Log audit event
    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'admin_role_changed',
      resourceType: 'admin_user',
      resourceId: parseInt(id),
      changes: { role },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ADMIN ROLE MANAGEMENT - Remove admin status
// ============================================================================

router.delete('/admins/:id', authMiddleware, adminMiddleware, permissionMiddleware('manage_admins'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM admin_users WHERE id = $1 RETURNING user_id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Admin user not found' });
    }

    // Log audit event
    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'admin_removed',
      resourceType: 'admin_user',
      resourceId: parseInt(id),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: 'Admin status removed' });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// AUDIT LOGS - View audit trail
// ============================================================================

router.get('/audit-logs', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, action, userId } = req.query;
    const offset = (page - 1) * limit;

    const logs = await getAuditLogs({
      limit: parseInt(limit),
      offset: offset,
      action,
      userId: userId ? parseInt(userId) : null
    });

    res.json({
      success: true,
      data: logs.data,
      pagination: {
        page: logs.page,
        limit: logs.limit,
        total: logs.total,
        totalPages: Math.ceil(logs.total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// AUDIT LOGS - Export as CSV
// ============================================================================

router.get('/audit-logs/export/csv', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const csv = await exportAuditLogsCSV();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SECURITY - Run security checks
// ============================================================================

router.post('/security/run-checks', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const result = await runAllSecurityChecks();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// AI BILLING — manual / backfill push (super-admin only)
// ============================================================================
// Fires the same monthly Stripe-meter push the cron runs. Safe to run any time:
// the durable ai_billing_posts ledger (migration 152) skips orgs already posted
// for the period, so this can't double-bill. This is the ONLY way to backfill a
// month the cron missed (or that failed for some orgs) without waiting for the
// 1st — the audit flagged that no such path existed. Dry-run until
// STRIPE_AI_BILLING_ENABLED=true, so calling it before activation is harmless.
router.post('/ai-billing/push', authMiddleware, adminMiddleware, roleMiddleware('super_admin'), async (req, res, next) => {
  try {
    const aiBilling = require('../services/aiBilling');
    const result = await aiBilling.pushMonthlyUsageToStripe();
    res.json({ success: true, enabled: aiBilling.isEnabled(), data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SECURITY - Get security status
// ============================================================================

router.get('/security/status', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const status = await getSecurityStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SECURITY - Get latest security checks
// ============================================================================

router.get('/security/checks', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const checks = await getLatestSecurityChecks(parseInt(limit));
    res.json({ success: true, data: checks });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ACCESS REQUESTS — pending users awaiting admin review
// ============================================================================
//
// LIABILITY: Approval is at the operator's sole discretion. The operator is
// responsible for verifying that approving a given request is consistent with
// applicable laws and contractual obligations.

router.get('/access-requests', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { status = 'pending_approval' } = req.query;
    const result = await pool.query(
      `SELECT id, email, name, status, request_company, request_reason, requested_at, created_at,
              approved_at, approved_by, rejected_reason
       FROM users
       WHERE status = $1
       ORDER BY requested_at DESC NULLS LAST, created_at DESC`,
      [status]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/access-requests/:id/approve', authMiddleware, adminMiddleware, permissionMiddleware('approve_access'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const target = await pool.query(`SELECT id, email, name, status FROM users WHERE id = $1`, [id]);
    if (target.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.rows[0].status === 'active') {
      return res.status(400).json({ success: false, message: 'User is already active' });
    }

    const updated = await pool.query(
      `UPDATE users SET status = 'active', approved_at = NOW(), approved_by = $1, rejected_reason = NULL, updated_at = NOW()
       WHERE id = $2 RETURNING id, email, name, status, approved_at`,
      [req.userId, id]
    );

    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'access_approved',
      resourceType: 'user',
      resourceId: parseInt(id, 10),
      changes: { from: target.rows[0].status, to: 'active' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Best-effort approval email — non-blocking. Product name + login URL
    // come from the deployment (self-hosters aren't "The Open CRM" at
    // app.theopencrm.com), falling back to our hosted defaults.
    if (email.isConfigured()) {
      const productName = process.env.PRODUCT_NAME || 'The Open CRM';
      const loginBase = String(process.env.FRONTEND_URL || 'https://app.theopencrm.com')
        .split(',')[0].trim().replace(/\/+$/, '');
      const loginUrl = `${loginBase}/login`;
      email.sendMail({
        to: target.rows[0].email,
        subject: `Your ${productName} access has been approved`,
        html: `
          <p>Hi ${target.rows[0].name || ''},</p>
          <p>Your access request has been approved. You can now sign in to ${productName} at
          <a href="${loginUrl}">${loginUrl}</a>.</p>
          <p>Welcome aboard.</p>
        `,
      }).catch(() => { /* best-effort */ });
    }

    res.json({ success: true, data: updated.rows[0] });
  } catch (error) { next(error); }
});

router.post('/access-requests/:id/reject', authMiddleware, adminMiddleware, permissionMiddleware('approve_access'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const target = await pool.query(`SELECT id, email, name, status FROM users WHERE id = $1`, [id]);
    if (target.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const updated = await pool.query(
      `UPDATE users SET status = 'rejected', rejected_reason = $1, approved_by = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, email, name, status`,
      [reason || null, req.userId, id]
    );

    await logAuditEvent({
      userId: req.userId,
      adminId: req.adminId,
      action: 'access_rejected',
      resourceType: 'user',
      resourceId: parseInt(id, 10),
      changes: { from: target.rows[0].status, to: 'rejected', reason: reason || null },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, data: updated.rows[0] });
  } catch (error) { next(error); }
});

router.post('/users/:id/suspend', authMiddleware, adminMiddleware, permissionMiddleware('manage_users'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const updated = await pool.query(
      `UPDATE users SET status = 'suspended', rejected_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, email, name, status`,
      [reason || null, id]
    );
    if (updated.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    await logAuditEvent({
      userId: req.userId, adminId: req.adminId,
      action: 'user_suspended', resourceType: 'user', resourceId: parseInt(id, 10),
      changes: { reason: reason || null },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) { next(error); }
});

router.post('/users/:id/reactivate', authMiddleware, adminMiddleware, permissionMiddleware('manage_users'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await pool.query(
      `UPDATE users SET status = 'active', rejected_reason = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING id, email, name, status`,
      [id]
    );
    if (updated.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    await logAuditEvent({
      userId: req.userId, adminId: req.adminId,
      action: 'user_reactivated', resourceType: 'user', resourceId: parseInt(id, 10),
      changes: { to: 'active' },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) { next(error); }
});

// ============================================================================
// ORGANIZATIONS — list + change profile (white-labeling)
// ============================================================================

const VALID_PROFILES = ['generic', 'zang', 'jcp'];

router.get('/organizations', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.profile, o.owner_user_id, o.created_at,
              owner.email AS owner_email, owner.name AS owner_name,
              (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS member_count
       FROM organizations o
       LEFT JOIN users owner ON owner.id = o.owner_user_id
       ORDER BY o.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

router.put('/organizations/:id/profile', authMiddleware, adminMiddleware, permissionMiddleware('manage_users'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { profile } = req.body || {};
    if (!VALID_PROFILES.includes(profile)) {
      return res.status(400).json({ success: false, message: `profile must be one of: ${VALID_PROFILES.join(', ')}` });
    }
    const updated = await pool.query(
      `UPDATE organizations SET profile = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, profile`,
      [profile, id]
    );
    if (updated.rows.length === 0) return res.status(404).json({ success: false, message: 'Organization not found' });

    await logAuditEvent({
      userId: req.userId, adminId: req.adminId,
      action: 'org_profile_changed', resourceType: 'organization', resourceId: parseInt(id, 10),
      changes: { profile },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) { next(error); }
});

// ============================================================================
// ORGANIZATIONS — provision a brand-new (or rename existing) customer org
// ============================================================================
//
// Wraps the same code path as the CLI script `backend/scripts/provision-org.js`
// — both call into `backend/services/orgProvisioner.js`. This endpoint lets a
// super-admin onboard the first customer from their browser session without
// having to spin up a Cloud SQL proxy and run a Node script. Single source of
// truth keeps the two surfaces from drifting.
//
// AUTHORIZATION
//   authMiddleware     — valid JWT cookie
//   adminMiddleware    — caller is in admin_users
//   roleMiddleware('super_admin') — strictly super_admin; not delegable
//
//   Provisioning touches global state (org rename, owner reassignment) and so
//   intentionally sits above any per-org permission. Non-super-admins get a
//   403 with no information about whether the target org exists.
//
// BODY (see backend/services/orgProvisioner.js for the canonical shape)
//   {
//     name, profile, adminEmail, mode,
//     branding?: { displayName, primaryColor, logoUrl, labels: {...} },
//     featureFlags?: { plugins_enabled: true, drive_intel_enabled: true, ... },
//     seedDemo?: bool,
//     dryRun?: bool
//   }
//
// RESPONSE 200
//   { ok: true, action: 'rename'|'create', orgId, userEmail, summary }
//
// ERRORS
//   400 validation (bad input, unknown feature flag)
//   404 admin user not found / not active
//   409 org-name collision (mode=create-new but name already in use)
//   422 business-rule fail (e.g. mode=rename-existing but user has no org)
//   500 transaction failed and rolled back

function statusForProvisionError(code) {
  switch (code) {
    case 'validation':           return 400;
    case 'unknown_feature_flag': return 400;
    case 'user_not_found':       return 404;
    case 'user_not_active':      return 404;
    case 'no_existing_org':      return 422;
    case 'org_name_collision':   return 409;
    case 'tx_failed':            return 500;
    default:                     return 500;
  }
}

router.post('/provision-org', authMiddleware, adminMiddleware, roleMiddleware('super_admin'), async (req, res, next) => {
  try {
    const {
      name,
      profile,
      adminEmail,
      mode,
      branding,
      featureFlags,
      seedDemo,
      dryRun,
    } = req.body || {};

    const result = await provisionOrg({
      name,
      profile,
      adminEmail,
      mode,
      branding,
      featureFlags,
      seedDemo,
      dryRun,
      actorUserId: req.userId,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ProvisionError) {
      return res.status(statusForProvisionError(err.code)).json({
        ok: false,
        error: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    next(err);
  }
});

// ============================================================================
// SYSTEM HEALTH
// ============================================================================

router.get('/system/health', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    // Test database connection
    const dbTest = await pool.query('SELECT NOW()');

    res.json({
      success: true,
      data: {
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Service unhealthy',
      error: error.message
    });
  }
});

module.exports = router;
