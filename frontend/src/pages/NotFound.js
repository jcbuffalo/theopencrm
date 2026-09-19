// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';
import { openCommandPalette } from '../components/Nav';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">404</h1>
        <p className="text-xl text-gray-600 mb-8">Page not found</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/"
            className="inline-block px-6 py-3 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg transition"
          >
            Go back home
          </Link>
          <button
            type="button"
            onClick={openCommandPalette}
            className="inline-flex items-center gap-2 px-6 py-3 border border-gray-300 hover:border-gray-400 bg-white text-gray-700 rounded-lg transition"
          >
            Search
            <kbd className="text-[10px] uppercase tracking-wider text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
