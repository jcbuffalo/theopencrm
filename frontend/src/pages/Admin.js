// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /admin — the admin hub. One card per admin page that actually exists as a
// route in App.js (the previous dashboard linked to /admin/security,
// /admin/compliance and /admin/accessibility, none of which exist, and six
// real pages had no inbound link at all). Super-admin-only pages are shown
// to every admin with a badge — the destination gates itself — so the hub
// never lies about what is installed.

import React, { useEffect } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import AdminNav from '../components/AdminNav';
import RoleGuard from '../components/RoleGuard';
import { AdminProvider, useAdmin } from '../context/AdminContext';
import { useAuth } from '../AuthContext';
import { ADMIN_PAGES } from '../components/nav/navConfig';
import AdminUsers from './AdminUsers';
import { Button, Card, Container, PageHeader, StatusBadge } from '../components/ui';

function PageCard({ page, locked }) {
  return (
    <Link
      to={page.to}
      className={`group block bg-white border border-gray-200 rounded p-4 shadow-card hover:border-brand-blue transition ${locked ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 group-hover:text-brand-blue">{page.label}</h3>
        {page.superAdmin && <StatusBadge tone="accent" label="Super-admin" />}
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">{page.description}</p>
    </Link>
  );
}

function AdminHub() {
  const { admin, fetchAdminUser } = useAdmin();
  const { user, adminRole, orgName } = useAuth();
  const isSuperAdmin = adminRole === 'super_admin';

  useEffect(() => { fetchAdminUser(); }, [fetchAdminUser]);

  const orgPages = ADMIN_PAGES.filter((p) => !p.superAdmin);
  const platformPages = ADMIN_PAGES.filter((p) => p.superAdmin);
  const role = admin?.role || adminRole;

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />
      <Container size="wide">
        <PageHeader
          title="Admin"
          subtitle={
            <>
              {orgName ? `${orgName} · ` : ''}signed in as {user?.email}
              {role && <StatusBadge tone="info" label={role} className="ml-2 align-middle" />}
            </>
          }
          primaryAction={<Button as={Link} to="/admin/pitch-readiness" variant="secondary" icon="trending-up">System health</Button>}
        />

        <div className="space-y-6">
          <Card title="Organization" subtitle="Manage this workspace.">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {orgPages.map((p) => <PageCard key={p.key} page={p} />)}
            </div>
          </Card>

          <Card
            title="Platform"
            subtitle={!isSuperAdmin ? 'Platform pages are for The Open CRM staff; they show an access notice for org admins.' : 'Cross-org controls for The Open CRM staff.'}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {platformPages.map((p) => <PageCard key={p.key} page={p} locked={!isSuperAdmin} />)}
            </div>
          </Card>
        </div>
      </Container>
    </div>
  );
}

export default function Admin() {
  return (
    <RoleGuard requiredRole="admin">
      <AdminProvider>
        <Routes>
          <Route path="/" element={<AdminHub />} />
          <Route path="/users" element={<AdminUsers />} />
          {/* Every other /admin/* page is mounted directly in App.js. */}
        </Routes>
      </AdminProvider>
    </RoleGuard>
  );
}
