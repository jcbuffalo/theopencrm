// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Terms bar — server-side acceptance (sell-readiness fix 7).
//
// Contract:
//   • no local cache + server says not accepted  → bar shows
//   • no local cache + server says accepted      → bar stays hidden, cache set
//   • local cache present                        → bar hidden, acceptance
//     version-keyed cache; a stale version re-prompts (no silent backfill)
//   • clicking "I agree"                         → POSTs to the server and
//     caches locally

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the API client — TermsModal only uses api.get / api.post.
vi.mock('../api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../api';
import TermsModal, { TERMS_VERSION } from './TermsModal';

const VERSION_KEY = 'theopencrm.terms.accepted_version';

function renderBar() {
  return render(
    <MemoryRouter>
      <TermsModal />
    </MemoryRouter>
  );
}

describe('TermsModal (terms bar)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    api.get.mockReset();
    api.post.mockReset();
    api.post.mockResolvedValue({ data: { success: true, accepted: true } });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the bar when the server says the user has not accepted', async () => {
    api.get.mockResolvedValue({ data: { success: true, accepted: false, version: '2026-05-01' } });
    renderBar();
    await waitFor(() => {
      expect(screen.getByText(/I agree/i)).toBeInTheDocument();
    });
    expect(api.get).toHaveBeenCalledWith('/me/accept-terms');
  });

  it('stays hidden and caches the VERSION locally when the server says already accepted', async () => {
    api.get.mockResolvedValue({ data: { success: true, accepted: true, version: TERMS_VERSION } });
    renderBar();
    await waitFor(() => {
      expect(localStorage.getItem(VERSION_KEY)).toBe(TERMS_VERSION);
    });
    expect(screen.queryByText(/I agree/i)).not.toBeInTheDocument();
  });

  it('honours the version-keyed localStorage fast-path with no backfill POST', async () => {
    localStorage.setItem(VERSION_KEY, TERMS_VERSION);
    renderBar();
    expect(screen.queryByText(/I agree/i)).not.toBeInTheDocument();
    // No GET needed when the local cache already answers, and no backfill
    // POST — silent acceptance of an unseen version is exactly the bug the
    // version-keyed cache removed.
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a STALE cached version (pre-bump boolean era) falls through to the server and re-prompts', async () => {
    localStorage.setItem('theopencrm.terms.accepted.v1', 'true'); // legacy boolean key
    localStorage.setItem(VERSION_KEY, '2026-05-01');              // old version
    api.get.mockResolvedValue({ data: { success: true, accepted: false, version: TERMS_VERSION } });
    renderBar();
    await waitFor(() => {
      expect(screen.getByText(/I agree/i)).toBeInTheDocument();
    });
    expect(api.get).toHaveBeenCalledWith('/me/accept-terms');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('records acceptance on the server when "I agree" is clicked', async () => {
    api.get.mockResolvedValue({ data: { success: true, accepted: false, version: '2026-05-01' } });
    renderBar();
    const btn = await screen.findByRole('button', { name: /I agree/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/me/accept-terms');
    });
    expect(localStorage.getItem(VERSION_KEY)).toBe(TERMS_VERSION);
    expect(screen.queryByText(/I agree/i)).not.toBeInTheDocument();
  });
});
