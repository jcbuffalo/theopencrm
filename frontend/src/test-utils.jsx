// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Shared helpers for the frontend test harness.
//
// Three exports:
//   - `defaultAuth`: a minimal auth-context shape that matches what the real
//     AuthContext.Provider exposes. Specs spread this and override only the
//     fields they care about (role, orgProfile, etc.).
//   - `renderWithProviders`: wraps `ui` in a MemoryRouter (only). Components
//     that consume `useAuth` are expected to vi.mock('./AuthContext', ...) in
//     their own spec file. That keeps render() pure: no /auth/me network
//     side-effect from the real AuthProvider, no global state leak across
//     tests.
//   - `mockApi`: a factory that returns a vi-mocked stand-in for the axios
//     client at frontend/src/api.js. Specs call `vi.mock('../api', ...)` at
//     module top-level and pass mockApi() (or a customized object) as the
//     module's default export.

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { vi } from 'vitest';

// The shape mirrors AuthContext.Provider's `value` object in src/AuthContext.js.
// Keep it in sync when fields are added there.
export const defaultAuth = {
  user: {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'super_admin',
    is_super_admin: true,
    org_role: 'admin',
    is_admin: true,
    org_id: 100,
    org_name: 'Test Org',
    org_profile: 'generic',
  },
  loading: false,
  signIn: vi.fn(),
  signOut: vi.fn(),
  refreshUser: vi.fn(),
  refreshAiStatus: vi.fn(),
  aiEnabled: true,
  isAdmin: true,
  adminRole: 'super_admin',
  orgProfile: 'generic',
  orgName: 'Test Org',
  orgBranding: { displayName: 'Test Org' },
  orgTier: 'pro',
  notificationPreferences: {},
  notificationEmail: 'test@example.com',
  notificationPhone: null,
};

// Convenience presets for specs that need to flip a single dimension of the
// auth context (e.g. a member vs an admin).
export const memberAuth = {
  ...defaultAuth,
  user: { ...defaultAuth.user, role: 'member', is_super_admin: false, org_role: 'member', is_admin: false },
  isAdmin: false,
  adminRole: null,
};

export const zangAuth = {
  ...defaultAuth,
  user: { ...defaultAuth.user, org_profile: 'zang' },
  orgProfile: 'zang',
};

export function renderWithProviders(ui, options = {}) {
  const { route = '/' } = options;
  const Wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[route]}>
      {children}
    </MemoryRouter>
  );
  return render(ui, { wrapper: Wrapper });
}

// `mockApi` returns an object shaped like the default-export axios client in
// src/api.js — every HTTP verb is a vi.fn() that resolves to `{ data: {} }`
// by default. Specs override per-test with `mockApi.get.mockResolvedValueOnce(...)`.
export function mockApi() {
  return {
    get:    vi.fn(() => Promise.resolve({ data: {} })),
    post:   vi.fn(() => Promise.resolve({ data: {} })),
    patch:  vi.fn(() => Promise.resolve({ data: {} })),
    put:    vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  };
}
