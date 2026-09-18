// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the per-org Activity page (PR #13). Verifies admin gating, the
// four stat cards, feed rendering by kind, and "Load more" cursor pagination.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth, memberAuth, mockApi } from '../test-utils';

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

import AdminActivity from './AdminActivity';

// NOTE: the API wraps payloads in { success, data } — the component reads
// `r.data?.data`, so fixtures carry the double-nested envelope.
const SUMMARY_FIXTURE = {
  data: {
    data: {
    counts: {
      ai_calls: 42,
      plugin_runs: 7,
      drive_intels: 3,
      gmail_intels: 5,
      audit_events: 11,
      emails_sent: 4,
    },
    ai_cost_usd: 1.23,
    top_endpoint: '/ai/draft-email',
    plugin_failures: 2,
    },
  },
};

const FEED_PAGE_1 = {
  data: {
    data: {
    items: [
      { kind: 'audit_event', event: 'deal.update', actor_email: 'a@example.com', target_type: 'deal', target_id: 5, at: new Date().toISOString() },
      { kind: 'ai_call',     endpoint: '/ai/draft-email', user_email: 'b@example.com', model: 'claude-sonnet-4-5', tokens: 1234, cost_usd: 0.02, at: new Date().toISOString() },
      { kind: 'plugin_run',  plugin_name: 'Reminder Bot', plugin_id: 9, status: 'success', duration_ms: 320, ai_tokens: 0, at: new Date().toISOString() },
      { kind: 'drive_intel', deal_title: 'Acme deal', deal_id: 5, files_analyzed: 3, tokens: 4500, at: new Date().toISOString() },
      { kind: 'gmail_intel', deal_title: 'Acme deal', deal_id: 5, tokens: 1200, next_step: 'send follow-up', at: new Date().toISOString() },
      { kind: 'email_send',  subject: 'Hello', to: 'c@example.com', sender_email: 'me@example.com', opened: true, at: new Date().toISOString() },
    ],
    next_cursor: 'CURSOR_2',
    },
  },
};

const FEED_PAGE_2 = {
  data: {
    data: {
    items: [
      { kind: 'audit_event', event: 'task.create', actor_email: 'd@example.com', at: new Date().toISOString() },
    ],
    next_cursor: null,
    },
  },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminActivity />
    </MemoryRouter>
  );
}

describe('AdminActivity', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset && fn.mockReset());
    currentAuth = defaultAuth;
  });
  afterEach(() => cleanup());

  it('blocks non-org-admin users with an access banner', async () => {
    currentAuth = { ...memberAuth, isAdmin: false };
    renderPage();
    expect(screen.getByText(/Org admin access required/i)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('renders the four stat cards reflecting the summary endpoint', async () => {
    api.get
      .mockResolvedValueOnce(SUMMARY_FIXTURE) // /summary
      .mockResolvedValueOnce({ data: { data: { items: [], next_cursor: null } } });

    renderPage();
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    // Secondary counts row.
    expect(screen.getByText(/11 audit events/i)).toBeInTheDocument();
    expect(screen.getByText(/4 emails sent/i)).toBeInTheDocument();
  });

  it('renders one feed row per kind with the kind-specific icon', async () => {
    api.get
      .mockResolvedValueOnce(SUMMARY_FIXTURE)
      .mockResolvedValueOnce(FEED_PAGE_1);

    renderPage();
    await waitFor(() => expect(screen.getByText('deal.update')).toBeInTheDocument());

    expect(screen.getByText('/ai/draft-email')).toBeInTheDocument();
    expect(screen.getByText('Reminder Bot')).toBeInTheDocument();
    // Drive + Gmail intel rows share the deal title — match the icon (📁 / 📧
    // are rendered as text inside an aria-hidden div).
    expect(screen.getAllByText(/Acme deal/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
  });

  it('Load more uses next_cursor to fetch the next page and appends items', async () => {
    api.get
      .mockResolvedValueOnce(SUMMARY_FIXTURE)
      .mockResolvedValueOnce(FEED_PAGE_1)
      .mockResolvedValueOnce(FEED_PAGE_2);

    renderPage();
    await waitFor(() => expect(screen.getByText('deal.update')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
    await waitFor(() => expect(screen.getByText('task.create')).toBeInTheDocument());

    // 3rd call carries the cursor query param.
    const lastCall = api.get.mock.calls[api.get.mock.calls.length - 1][0];
    expect(lastCall).toContain('cursor=CURSOR_2');
  });

  it('shows the empty state when feed.items is empty', async () => {
    api.get
      .mockResolvedValueOnce({ data: { data: { counts: {}, ai_cost_usd: 0, plugin_failures: 0 } } })
      .mockResolvedValueOnce({ data: { data: { items: [], next_cursor: null } } });

    renderPage();
    await waitFor(() => expect(screen.getByText(/Nothing has happened/i)).toBeInTheDocument());
  });

  it('surfaces an error banner if the feed call fails', async () => {
    api.get
      .mockResolvedValueOnce(SUMMARY_FIXTURE)
      .mockRejectedValueOnce({ response: { data: { error: 'feed down' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText('feed down')).toBeInTheDocument());
  });
});
