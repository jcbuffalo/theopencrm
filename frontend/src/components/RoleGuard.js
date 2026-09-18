// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

// Component to protect admin routes based on user role
export default function RoleGuard({ children, requiredRole = 'admin' }) {
  const [hasAccess, setHasAccess] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const checkAccess = async () => {
      try {
        const response = await api.get('/admin');
        const userRole = response.data.data.role;

        // Define role hierarchy
        const roleHierarchy = {
          'super_admin': 4,
          'admin': 3,
          'moderator': 2,
          'viewer': 1
        };

        const hasRequiredRole = roleHierarchy[userRole] >= roleHierarchy[requiredRole];
        setHasAccess(hasRequiredRole);

        if (!hasRequiredRole) {
          navigate('/dashboard');
        }
      } catch (error) {
        // Not authorized or not admin
        setHasAccess(false);
        navigate('/dashboard');
      }
    };

    checkAccess();
  }, [requiredRole, navigate]);

  if (hasAccess === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg">Access Denied</p>
          <p className="text-gray-600">You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return children;
}
