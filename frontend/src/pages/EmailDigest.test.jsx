// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec 204 — consolidated notification email + one-click actions:
//   - Settings → Notifications "Email delivery" card saves mode/hour + the
//     browser timezone and can send the digest on demand;
//   - /act/:token applies the action via POST (never on the GET) and renders
//     done / already-used / expired / invalid.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../api', () => ({ default: api, api, POST_LOGIN_REDIRECT_KEY: 'ocrm_post_login_redirect', downloadBlob: vi.fn() }));
const refreshUser = vi.fn(() => Promise.resolve());
let currentAuth = { ...defaultAuth, refreshUser };
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Settings from './Settings';
import EmailAction from './EmailAction';

const TOKEN = 'a'.repeat(64);

describe('Settings → Notifications → Email delivery', () => {
  beforeEach(() => {
    api.get.mockReset(); api.post.mockReset(); api.put.mockReset();
    api.get.mockResolvedValue({ data: [] });
    api.put.mockResolvedValue({ data: { success: true } });
    refreshUser.mockClear();
    currentAuth = { ...defaultAuth, refreshUser, user: { ...defaultAuth.user, notification_preferences: { task_overdue: { email: true } } } };
  });
  afterEach(() => cleanup());

  function renderTab() {
    return render(
      <MemoryRouter initialEntries={['/settings#notifications']}>
        <Settings />
      </MemoryRouter>
    );
  }

  it('defaults to daily at 7, saves a mode change with the browser timezone, and an hour change', async () => {
    renderTab();
    const daily = await screen.findByRole('radio', { name: /one email a day/i });
    expect(daily).toBeChecked();
    expect(screen.getByLabelText(/send at/i)).toHaveValue('7');

    fireEvent.click(screen.getByRole('radio', { name: /as it happens/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/me/notification-preferences');
    expect(body.email_delivery.mode).toBe('instant');
    expect(typeof body.email_delivery.tz).toBe('string');
    expect(refreshUser).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: /one email a day/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText(/send at/i), { target: { value: '18' } });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
    expect(api.put.mock.calls[2][1].email_delivery).toMatchObject({ mode: 'daily', hour: 18 });
  });

  it('reflects a stored preference and "send now" reports the result', async () => {
    currentAuth = { ...currentAuth, user: { ...currentAuth.user, notification_preferences: { task_overdue: { email: true }, email_delivery: { mode: 'batched', hour: 9, tz: 'Europe/Berlin' } } } };
    api.post.mockResolvedValueOnce({ data: { success: true, sent: true, items: 4, subject: 'Your day, Mon, Sep 21 — 4 tasks' } });
    renderTab();
    expect(await screen.findByRole('radio', { name: /grouped every 15 minutes/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /send me today's digest now/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/me/notification-digest/send-now'));
    expect(await screen.findByText(/Sent "Your day, Mon, Sep 21 — 4 tasks"/)).toBeInTheDocument();

    api.post.mockResolvedValueOnce({ data: { success: true, sent: false, reason: 'empty' } });
    fireEvent.click(screen.getByRole('button', { name: /send me today's digest now/i }));
    expect(await screen.findByText(/Nothing to send right now/)).toBeInTheDocument();
  });
});

describe('/act/:token', () => {
  beforeEach(() => { api.post.mockReset(); api.get.mockReset(); });
  afterEach(() => cleanup());

  function renderAct(token = TOKEN) {
    return render(
      <MemoryRouter initialEntries={[`/act/${token}`]}>
        <Routes>
          <Route path="/act/:token" element={<EmailAction />} />
          <Route path="/tasks" element={<div data-testid="tasks-page">tasks</div>} />
          <Route path="/today" element={<div data-testid="today-page">today</div>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('POSTs the apply on load (never a GET) and shows the outcome with an open-record link', async () => {
    api.post.mockResolvedValueOnce({ data: { ok: true, action: 'task.complete', entity_type: 'task', entity_id: 12, message: '"Call Dana" marked done.' } });
    renderAct();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/email-actions/${TOKEN}/apply`));
    expect(api.get).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { level: 1, name: 'Done' })).toBeInTheDocument();
    expect(screen.getByText('"Call Dana" marked done.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open in the app/i }));
    expect(await screen.findByTestId('tasks-page')).toBeInTheDocument();
  });

  it('renders already-used (410 used), expired (410), and invalid (404) states without retrying', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 410, data: { ok: false, used: true, message: 'This link was already used.' } } });
    renderAct();
    expect(await screen.findByRole('heading', { level: 1, name: /already done/i })).toBeInTheDocument();
    cleanup();

    api.post.mockRejectedValueOnce({ response: { status: 410, data: { ok: false, expired: true } } });
    renderAct();
    expect(await screen.findByRole('heading', { level: 1, name: /expired/i })).toBeInTheDocument();
    cleanup();

    api.post.mockRejectedValueOnce({ response: { status: 404, data: { ok: false, message: 'This link is not valid.' } } });
    renderAct();
    expect(await screen.findByRole('heading', { level: 1, name: /will not work/i })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(3);
  });

  it('does not even call the API for a malformed token', async () => {
    renderAct('not-a-token');
    expect(await screen.findByRole('heading', { level: 1, name: /will not work/i })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
