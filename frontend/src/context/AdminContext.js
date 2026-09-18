// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { createContext, useState, useCallback } from 'react';
import api from '../api';

export const AdminContext = createContext();

export function AdminProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [users, setUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [securityStatus, setSecurityStatus] = useState(null);
  const [complianceStatus, setComplianceStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);

  // Fetch admin user details
  const fetchAdminUser = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get('/admin');
      setAdmin(response.data.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch users list
  const fetchUsers = useCallback(async (page = 1, limit = 20, filters = {}) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page,
        limit,
        ...filters
      });
      const response = await api.get(`/admin/users?${params}`);
      setUsers(response.data.data);
      setError(null);
      return response.data;
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  // Update user
  const updateUser = useCallback(async (userId, userData) => {
    try {
      setLoading(true);
      const response = await api.put(`/admin/users/${userId}`, userData);
      showNotification('User updated successfully', 'success');
      setError(null);
      return response.data.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Failed to update user';
      setError(message);
      showNotification(message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Delete user
  const deleteUser = useCallback(async (userId) => {
    try {
      setLoading(true);
      await api.delete(`/admin/users/${userId}`);
      showNotification('User deleted successfully', 'success');
      setError(null);
    } catch (err) {
      const message = err.response?.data?.message || 'Failed to delete user';
      setError(message);
      showNotification(message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch audit logs
  const fetchAuditLogs = useCallback(async (page = 1, filters = {}) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page, limit: 20, ...filters });
      const response = await api.get(`/admin/audit-logs?${params}`);
      setAuditLogs(response.data.data);
      setError(null);
      return response.data;
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, []);

  // Get security status
  const fetchSecurityStatus = useCallback(async () => {
    try {
      const response = await api.get('/admin/security/status');
      setSecurityStatus(response.data.data);
    } catch (err) {
      console.error('Failed to load security status');
    }
  }, []);

  // Run security checks
  const runSecurityChecks = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.post('/admin/security/run-checks');
      setSecurityStatus(response.data.data);
      showNotification('Security checks completed', 'success');
      return response.data.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Failed to run security checks';
      setError(message);
      showNotification(message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Get compliance status
  const fetchComplianceStatus = useCallback(async () => {
    try {
      const response = await api.get('/compliance/status');
      setComplianceStatus(response.data.data);
    } catch (err) {
      console.error('Failed to load compliance status');
    }
  }, []);

  // Show notification
  const showNotification = useCallback((message, type = 'info') => {
    setNotification({ message, type, id: Date.now() });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  const value = {
    admin,
    users,
    auditLogs,
    securityStatus,
    complianceStatus,
    loading,
    error,
    notification,
    fetchAdminUser,
    fetchUsers,
    updateUser,
    deleteUser,
    fetchAuditLogs,
    fetchSecurityStatus,
    runSecurityChecks,
    fetchComplianceStatus,
    showNotification
  };

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const context = React.useContext(AdminContext);
  if (!context) {
    throw new Error('useAdmin must be used within AdminProvider');
  }
  return context;
}
