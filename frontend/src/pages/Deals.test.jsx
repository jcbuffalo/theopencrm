// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the ?dealId= deep-link fallback (usability review 2026-09-18, P1
// daily-selling-loop: "Deal deep-links fail silently" when the id isn't on
// the fetched board — e.g. a different pipeline, or "My deals" narrowing the
// list). The fix: fall back to GET /deals/:id and open the panel regardless;
// a genuine 404 surfaces as a banner instead of nothing happening.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: [] })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({ default: api, downloadBlob: vi.fn() }));

vi.mock('../AuthContext', () => ({ useAuth: () => defaultAuth }));

import Deals from './Deals';

// The board's own /deals fetch never includes deal 999 — it's parked on a
// different pipeline / hidden by "My deals" — so every spec here exercises
// the fallback path, not the happy "it was already on the board" path.
const BOARD_DEALS = [{ id: 1, title: 'On the board', stage: 'lead', amount: 100 }];

function mockGet(routes) {
  api.get.mockImplementation((url) => {
    for (const [match, data] of routes) {
      if (typeof match === 'string' ? url === match : match.test(url)) {
        return data instanceof Error ? Promise.reject(data) : Promise.resolve({ data });
      }
    }
    return Promise.resolve({ data: [] });
  });
}

function renderDeals(dealId) {
  return render(
    <MemoryRouter initialEntries={[`/deals?dealId=${dealId}`]}>
      <Deals />
    </MemoryRouter>
  );
}

describe('Deals — ?dealId= deep-link fallback', () => {
  beforeEach(() => { api.get.mockReset(); });
  afterEach(() => cleanup());

  it('fetches the deal directly and opens it when it is not on the loaded board', async () => {
    mockGet([
      ['/deals', BOARD_DEALS],
      ['/companies', []],
      ['/deals/999', { id: 999, title: 'Off-board deal', stage: 'lead', amount: 500 }],
    ]);
    renderDeals(999);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/deals/999'));
    await waitFor(() => expect(screen.getByText('Off-board deal')).toBeInTheDocument());
  });

  it('shows "Deal not found" instead of failing silently on a genuine 404', async () => {
    mockGet([
      ['/deals', BOARD_DEALS],
      ['/companies', []],
      ['/deals/999', Object.assign(new Error('Not found'), { response: { status: 404, data: { error: 'Not found' } } })],
    ]);
    renderDeals(999);
    await waitFor(() => expect(screen.getByText('Deal not found')).toBeInTheDocument());
    // No panel opened — the drawer never mounts on a real 404.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
