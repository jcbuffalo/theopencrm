// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Global React error boundary. Two jobs:
//   1. A render crash anywhere in the tree shows a friendly reload card
//      instead of React 18's unmount-to-blank-page behavior.
//   2. The crash is reported (message + stack + componentStack + path + UA)
//      to POST /api/client-errors, which relays it into GCP Error Reporting
//      under serviceContext { service: 'synccrm-frontend' }.
//
// The reporter (src/clientErrorReporter.js) is fire-and-forget, deduped, and
// can never throw — a failed report never worsens the crash. Class component
// because error boundaries have no hooks equivalent.
//
// Mounted in App.js around the entire authenticated + public tree (inside
// AuthProvider, outside Router) so a crash in ANY page or nav chrome is
// caught. Deliberately NOT around AuthProvider itself — if auth bootstrap
// throws, the boundary's own useAuth-free UI below still renders fine.

import React from 'react';
import reportClientError from '../clientErrorReporter';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Never let reporting throw — reportClientError guarantees it, but the
    // boundary is the last line of defense, so belt-and-suspenders here too.
    try {
      reportClientError(error, info);
    } catch {
      /* swallowed */
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    // Plain Tailwind + one inline SVG — no ui-kit imports, so the fallback
    // can't be taken down by whatever broke the tree.
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 shadow-card p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-warning-50 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-warning-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-600 mb-6">
            This page hit an unexpected error. It has been reported automatically —
            reloading usually fixes it.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:bg-primary-700"
            >
              Reload page
            </button>
            <a
              href="/"
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Go home
            </a>
          </div>
        </div>
      </div>
    );
  }
}
