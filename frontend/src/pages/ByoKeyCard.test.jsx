// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// ByoKeyCard (pages/Usage.js) — the "use your own Anthropic key" panel.
//
// Contract under test: owners/admins can save + remove a key and see last4 +
// validation state in plain English; the key is never rendered back; members
// get a one-line note with no form; a failed save shows the backend's reason.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const get = vi.fn();
const set = vi.fn();
const clear = vi.fn();
vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  orgAiKey: { get: (...a) => get(...a), set: (...a) => set(...a), clear: (...a) => clear(...a) },
}));

import { ByoKeyCard } from './Usage';

const KEY = 'sk-ant-api03-' + 'Q'.repeat(40) + 'ab12';
const none = { configured: false, last4: null, last_validated_at: null, last_error: null, billing_mode: 'platform', can_manage: true };
const stored = { configured: true, last4: 'ab12', last_validated_at: '2026-08-27T12:00:00Z', last_error: null, billing_mode: 'byo_key', can_manage: true };

beforeEach(() => {
  cleanup();
  get.mockReset();
  set.mockReset();
  clear.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ByoKeyCard', () => {
  it('admin with no key sees the explainer + form, saves, and sees last4 + validated', async () => {
    get.mockResolvedValue(none);
    set.mockResolvedValue(stored);
    render(<ByoKeyCard isAdmin />);

    expect(await screen.findByText(/use your own anthropic key/i)).toBeTruthy();
    expect(screen.getByText(/anthropic bills you/i)).toBeTruthy();

    const input = screen.getByLabelText(/anthropic api key/i);
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(set).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText(/…ab12/)).toBeTruthy();
    expect(screen.getByText(/validated \u2713/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/now use your key/i);
    // The key itself is never rendered back.
    expect(document.body.textContent).not.toContain(KEY);
    expect(input.value).toBe('');
  });

  it('a rejected key shows the backend reason and keeps the form', async () => {
    get.mockResolvedValue(none);
    set.mockRejectedValue({ response: { data: { error: 'Anthropic rejected this key. Anthropic returned HTTP 401', code: 'KEY_REJECTED' } } });
    render(<ByoKeyCard isAdmin />);
    const input = await screen.findByLabelText(/anthropic api key/i);
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/rejected this key/i);
    expect(screen.getByRole('button', { name: /save key/i })).toBeTruthy();
  });

  it('admin with a stored key can remove it and drops back to pay-as-you-go', async () => {
    get.mockResolvedValue(stored);
    clear.mockResolvedValue({ ...none, removed: true });
    render(<ByoKeyCard isAdmin />);
    expect(await screen.findByText(/…ab12/)).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect((await screen.findByRole('status')).textContent).toMatch(/back on pay-as-you-go/i);
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('a stored-but-unvalidated key surfaces last_error instead of a checkmark', async () => {
    get.mockResolvedValue({ ...stored, last_validated_at: null, last_error: 'Could not reach Anthropic: ECONNRESET' });
    render(<ByoKeyCard isAdmin />);
    expect(await screen.findByText(/not yet validated/i)).toBeTruthy();
    expect(screen.queryByText(/validated ✓/)).toBeNull();
  });

  it('members see a one-line note and no form', async () => {
    get.mockResolvedValue({ ...stored, can_manage: false });
    render(<ByoKeyCard isAdmin={false} />);
    expect(await screen.findByText(/its own anthropic key/i)).toBeTruthy();
    expect(screen.queryByLabelText(/anthropic api key/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when the status probe fails (personal workspace)', async () => {
    get.mockRejectedValue({ response: { status: 400, data: { code: 'ORG_REQUIRED' } } });
    const { container } = render(<ByoKeyCard isAdmin />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
