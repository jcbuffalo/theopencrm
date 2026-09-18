// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';

export default function PendingApproval() {
  const location = useLocation();
  const message = location.state?.message
    || 'Your account is awaiting admin approval. You will receive an email when access is granted.';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link to="/"><BrandLogo size={28} /></Link>
        </div>
      </header>
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">⏳</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Awaiting approval</h1>
          <p className="text-gray-600 mb-6">{message}</p>
          <div className="flex flex-col gap-2">
            <Link to="/login" className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium">
              Try sign-in again
            </Link>
            <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">Return home</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
