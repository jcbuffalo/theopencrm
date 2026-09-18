// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useAdmin } from '../context/AdminContext';
import AdminNav from '../components/AdminNav';
import DataTable from '../components/DataTable';
import { Alert, Button, Container, PageHeader, Spinner, StatusBadge } from '../components/ui';

export default function AdminUsers() {
  const { users, loading, error, notification, fetchUsers, updateUser, deleteUser } = useAdmin();
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [pagination, setPagination] = useState(null);

  useEffect(() => {
    loadUsers(page);
  }, [page]);

  const loadUsers = async (pageNum) => {
    const result = await fetchUsers(pageNum);
    if (result) {
      setPagination(result.pagination);
    }
  };

  const handleEdit = (user) => {
    setEditingId(user.id);
    setEditData({ name: user.name, plan: user.plan });
  };

  const handleSave = async (userId) => {
    await updateUser(userId, editData);
    setEditingId(null);
    loadUsers(page);
  };

  const handleDelete = async (userId) => {
    if (window.confirm('Are you sure you want to delete this user?')) {
      await deleteUser(userId);
      loadUsers(page);
    }
  };

  if (loading && users.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <AdminNav />
        <Container size="wide">
          <Spinner size="lg" label="Loading users…" />
        </Container>
      </div>
    );
  }

  // Inline cell editors stay as compact native controls — the primitives'
  // 32px minimum would double the row height.
  const cellControl = 'px-2 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/20';

  const columns = [
    { key: 'email', label: 'Email' },
    {
      key: 'name',
      label: 'Name',
      render: (user) => editingId === user.id ? (
        <input
          type="text"
          value={editData.name}
          onChange={(e) => setEditData({ ...editData, name: e.target.value })}
          aria-label="Name"
          className={cellControl}
        />
      ) : (
        user.name || 'N/A'
      ),
    },
    {
      key: 'plan',
      label: 'Plan',
      render: (user) => editingId === user.id ? (
        <select
          value={editData.plan}
          onChange={(e) => setEditData({ ...editData, plan: e.target.value })}
          aria-label="Plan"
          className={cellControl}
        >
          <option value="free">Free</option>
          <option value="premium">Premium</option>
        </select>
      ) : (
        <StatusBadge tone={user.plan === 'premium' ? 'info' : 'neutral'} label={<span className="capitalize">{user.plan}</span>} />
      ),
    },
    {
      key: 'created_at',
      label: 'Created',
      render: (user) => new Date(user.created_at).toLocaleDateString(),
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (user) => (
        <div className="inline-flex items-center gap-3">
          {editingId === user.id ? (
            <>
              <button type="button" onClick={() => handleSave(user.id)} className="text-sm font-medium text-success-700 hover:underline">Save</button>
              <button type="button" onClick={() => setEditingId(null)} className="text-sm font-medium text-gray-600 hover:underline">Cancel</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => handleEdit(user)} className="text-sm font-medium text-brand-blue hover:underline">Edit</button>
              <button type="button" onClick={() => handleDelete(user.id)} className="text-sm font-medium text-danger-600 hover:underline">Delete</button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />

      <Container size="wide">
        <PageHeader
          title="Users"
          subtitle={`Total users: ${pagination?.total || 0}`}
        />

        <div className="space-y-6">
          {notification && (
            <Alert tone={notification.type === 'success' ? 'success' : 'danger'}>
              {notification.message}
            </Alert>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          <DataTable
            columns={columns}
            data={users}
            loading={loading && users.length === 0}
            emptyState={{ icon: 'users', title: 'No users yet', message: 'Users appear here once they sign up.' }}
          />

          {pagination && (
            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-600">
                Page {pagination.page} of {pagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="chevron-left"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  iconRight="chevron-right"
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
