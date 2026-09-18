// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the Plugin runs viewer (PR #17). Covers: status pill filter,
// row expansion + log rendering, hash-fragment auto-expand, empty-state CTA,
// and friendly_status pass-through from the backend payload.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth, mockApi } from '../test-utils';

// `mockApi()` can't be referenced inside a hoisted block (the import isn't
// initialized when hoisting runs), so build the same shape inline here.
const api = vi.hoisted(() => ({
  get:    vi.fn(() => Promise.resolve({ data: {} })),
  post:   vi.fn(() => Promise.resolve({ data: {} })),
  patch:  vi.fn(() => Promise.resolve({ data: {} })),
  put:    vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({
  default: api,
  auth: {},
  setCsrfToken: vi.fn(),
}));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({
  useAuth: () => currentAuth,
}));

vi.mock('../components/Nav', () => ({
  default: () => <nav data-testid="nav-stub" />,
}));

import PluginRuns from './PluginRuns';

const RUNS_FIXTURE = {
  data: {
    plugin: { name: 'Reminder Bot' },
    data: [
      {
        id: 101,
        plugin_id: 9,
        status: 'success',
        friendly_status: 'Worked',
        started_at: '2026-06-17T10:00:00Z',
        cpu_ms: 420,
        db_queries: 3,
        trigger_kind: 'chat',
        trigger_source: 'copilot',
        result_summary: 'Did the thing.',
        log_lines: ['line 1', 'line 2'],
        input_payload: { foo: 1 },
        output_payload: { bar: 2 },
      },
      {
        id: 102,
        plugin_id: 9,
        status: 'failed',
        friendly_status: "Didn't finish — there was an error",
        started_at: '2026-06-17T09:30:00Z',
        cpu_ms: 80,
        db_queries: 1,
        trigger_kind: 'schedule',
        error_message: 'TypeError: x is not a function',
        log_lines: [],
      },
    ],
  },
};

function renderPage({ route = '/plugins/9/runs' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/plugins/:id/runs" element={<PluginRuns />} />
      </Routes>
    </MemoryRouter>
  );
}

// Row-level assertions are scoped to the runs table (`within(table)`) because
// the status-pill filter buttons reuse the same friendly labels ("Worked",
// "Didn't finish") that RunStatusBadge renders inside rows.
describe('PluginRuns', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset && fn.mockReset());
    api.get.mockResolvedValue(RUNS_FIXTURE);
    currentAuth = defaultAuth;
  });
  afterEach(() => cleanup());

  it('renders the headline with the plugin name and a row per run', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Reminder Bot — last 24h/i)).toBeInTheDocument());
    // friendly_status values from the fixture — scoped to the table so the
    // "Worked" filter pill doesn't collide.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Worked')).toBeInTheDocument();
    expect(within(table).getByText(/Didn't finish — there was an error/i)).toBeInTheDocument();
  });

  it('highlights the active status pill and re-issues the request', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Reminder Bot — last 24h/i)).toBeInTheDocument());

    // Initial fetch uses status=all.
    const firstCall = api.get.mock.calls[0][0];
    expect(firstCall).toContain('status=all');

    // Click "Worked" → status=success.
    api.get.mockResolvedValueOnce(RUNS_FIXTURE);
    fireEvent.click(screen.getByRole('button', { name: 'Worked' }));
    await waitFor(() => {
      const last = api.get.mock.calls[api.get.mock.calls.length - 1][0];
      expect(last).toContain('status=success');
    });
  });

  it('expands a row when clicked, showing log lines and result summary', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getByText('Worked')).toBeInTheDocument());

    // First data row (id=101). Click it to expand.
    fireEvent.click(within(table).getByText('Worked').closest('tr'));

    expect(screen.getByText('Did the thing.')).toBeInTheDocument();
    expect(screen.getByText(/line 1/)).toBeInTheDocument();
    expect(screen.getByText(/line 2/)).toBeInTheDocument();
  });

  it('renders the "no log lines" fallback for the failed row when expanded', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getByText(/Didn't finish/i)).toBeInTheDocument());

    fireEvent.click(within(table).getByText(/Didn't finish/i).closest('tr'));
    expect(screen.getByText(/No log lines for this run/i)).toBeInTheDocument();
    expect(screen.getByText(/TypeError: x is not a function/)).toBeInTheDocument();
  });

  it('auto-expands the row referenced by the #run-<id> URL fragment', async () => {
    renderPage({ route: '/plugins/9/runs#run-102' });
    await waitFor(() => expect(screen.getByText(/TypeError: x is not a function/)).toBeInTheDocument());
    // The other row should NOT also auto-expand.
    expect(screen.queryByText('Did the thing.')).not.toBeInTheDocument();
  });

  it('renders the empty state with a "Go to chat" CTA when there are no runs', async () => {
    api.get.mockReset();
    api.get.mockResolvedValueOnce({ data: { plugin: { name: 'Empty Bot' }, data: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No runs yet/i)).toBeInTheDocument());
    const cta = screen.getByRole('button', { name: /Go to chat/i });
    expect(cta).toBeInTheDocument();
  });

  it('shows the feature-disabled banner on a 403 FEATURE_DISABLED response', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce({ response: { status: 403, data: { code: 'FEATURE_DISABLED' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Plugins are not enabled/i)).toBeInTheDocument());
  });

  it('shows the not-found state on a 404', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce({ response: { status: 404, data: {} } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/couldn't find that plugin/i)).toBeInTheDocument());
  });
});
