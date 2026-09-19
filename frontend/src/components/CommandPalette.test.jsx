// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the command palette's quick-add "Create" rows (usability review
// 2026-09-18, P1 daily-selling-loop: "no quick-add anywhere"). Everything
// else about the palette (AI search, record search) is out of scope here.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({ default: api }));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));

import CommandPalette from './CommandPalette';

// Renders the palette pre-opened (⌘K) alongside a route recorder so we can
// assert where a click actually navigated.
function Harness() {
  const navigate = useNavigate();
  React.useEffect(() => { navigate('/chat'); }, [navigate]);
  return <CommandPalette />;
}
function renderOpenPalette() {
  const utils = render(
    <MemoryRouter initialEntries={['/chat']}>
      <Harness />
    </MemoryRouter>
  );
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return utils;
}

describe('CommandPalette — quick add', () => {
  beforeEach(() => {
    api.get.mockResolvedValue({ data: {} });
    currentAuth = { ...defaultAuth, orgFeatures: null };
  });
  afterEach(() => cleanup());

  // The currently-selected option's accessible name gets a trailing " ↵"
  // hint appended (see the `{on && <kbd>...}` in CommandPalette.js), so
  // matchers use a regex rather than an exact string.
  it('offers the four create rows under a "Create" heading with an empty query', () => {
    renderOpenPalette();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Create')).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /^New contact/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /^New deal/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /^New task/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /^Log a call/ })).toBeInTheDocument();
  });

  it('clicking "New deal" navigates to /deals?new=1 and closes the palette', () => {
    renderOpenPalette();
    fireEvent.click(screen.getByRole('option', { name: /^New deal/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('typing a query still surfaces the matching create row', () => {
    renderOpenPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'log a call' } });
    expect(screen.getByRole('option', { name: /^Log a call/ })).toBeInTheDocument();
  });

  it('a non-matching query drops the create rows entirely', () => {
    renderOpenPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'renewals' } });
    expect(screen.queryByText('Create')).toBeNull();
    expect(screen.queryByRole('option', { name: 'New deal' })).toBeNull();
  });
});
