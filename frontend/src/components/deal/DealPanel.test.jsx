// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the restructured deal drawer: hero renders the essentials, tabs
// switch, the Workflow tab is profile/flag-aware, no emoji glyphs leak into
// the chrome, and a stage change still hits PUT /deals/:id.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth, zangAuth } from '../../test-utils';

// vi.mock factories are hoisted above every import, so the mock client and
// fixture must be hoisted too.
const { api, DEAL } = vi.hoisted(() => {
  const DEAL = {
    id: 1,
    title: 'Acme rollout',
    stage: 'qualified',
    amount: 12000,
    customer_id: 5,
    contact_id: null,
    expected_close_date: '2026-09-30',
    phase: 'pipeline',
  };
  const api = {
    get: vi.fn((url) => {
      if (url === '/deals/1') return Promise.resolve({ data: { ...DEAL } });
      if (url === '/org') return Promise.resolve({ data: { members: [] } });
      if (url.startsWith('/deals/1/line-items')) return Promise.resolve({ data: { line_items: [] } });
      if (url.startsWith('/custom-fields')) return Promise.resolve({ data: [] });
      if (url.startsWith('/webhooks/meetings')) return Promise.resolve({ data: { meetings: [] } });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn((url, body) => Promise.resolve({ data: { ...DEAL, ...body } })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  };
  return { api, DEAL };
});

vi.mock('../../api', () => ({
  default: api,
  downloadBlob: vi.fn(() => Promise.resolve()),
  drive: {},
  gmailThreads: {},
  dealCalendar: { list: vi.fn(() => Promise.resolve({ events: [] })), create: vi.fn() },
  dealOutlookIntel: { get: vi.fn(() => Promise.resolve({ connected: false })) },
}));

let currentAuth = defaultAuth;
vi.mock('../../AuthContext', () => ({
  useAuth: () => currentAuth,
}));

import DealPanel from '../DealPanel';

const COMPANIES = [{ id: 5, name: 'Acme Corp', type: 'customer' }, { id: 6, name: 'Bolt Supply', type: 'vendor' }];

function renderPanel(props = {}) {
  return render(
    <MemoryRouter>
      <DealPanel dealId={1} companies={COMPANIES} onClose={vi.fn()} onChanged={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

async function waitForHero() {
  await waitFor(() => expect(screen.getByText('Acme rollout')).toBeInTheDocument());
}

describe('DealPanel', () => {
  beforeEach(() => {
    // clearAllMocks would drop the routing implementation on api.get; only
    // reset call history so each spec asserts against its own calls.
    api.get.mockClear();
    api.put.mockClear();
    api.post.mockClear();
    api.delete.mockClear();
    currentAuth = { ...defaultAuth, orgFeatures: null };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the hero with title, stage and value', async () => {
    renderPanel();
    await waitForHero();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Stage badge + the stage picker both show the label.
    expect(screen.getAllByText('Qualified').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Change stage')).toHaveValue('qualified');
    // Value shows in the hero (and again in Details).
    expect(screen.getAllByText('$12,000').length).toBeGreaterThan(0);
    // Company shows in the drawer subtitle (and again in Details).
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    // Primary CTA row.
    expect(screen.getByRole('button', { name: /Log activity/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add task/ })).toBeInTheDocument();
  });

  it('switches tabs', async () => {
    renderPanel();
    await waitForHero();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Details')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No communication logged yet/)).toBeInTheDocument());
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
  });

  it('hides the Workflow tab for a generic profile when advanced panels and workflow modules are off', async () => {
    currentAuth = { ...defaultAuth, orgFeatures: { quotes_enabled: false, documents_enabled: false } };
    renderPanel();
    await waitForHero();
    expect(screen.queryByRole('tab', { name: 'Workflow' })).not.toBeInTheDocument();
    // Issues fall back onto the Overview tab so nothing is lost.
    expect(screen.getByRole('button', { name: /^Issues Blockers/ })).toBeInTheDocument();
  });

  it('shows the Workflow tab for a zang profile', async () => {
    currentAuth = { ...zangAuth, orgFeatures: null };
    api.get.mockImplementationOnce(() => Promise.resolve({ data: { ...DEAL, stage: 'TRIAGE', phase: 'pre_sale' } }));
    renderPanel();
    await waitForHero();
    const wf = screen.getByRole('tab', { name: 'Workflow' });
    fireEvent.click(wf);
    expect(wf).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Vendor RFQs')).toBeInTheDocument();
    expect(screen.getByText('Customer quotes')).toBeInTheDocument();
  });

  it('renders no emoji glyphs in the chrome', async () => {
    renderPanel();
    await waitForHero();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() => expect(screen.getByText(/No communication logged yet/)).toBeInTheDocument());
    const text = document.body.textContent;
    expect(text).not.toMatch(/[✨▼▶]/);
    // Broader sweep: no emoji presentation characters at all.
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/u);
  });

  it('changes stage through PUT /deals/:id like the old edit form', async () => {
    const onChanged = vi.fn();
    renderPanel({ onChanged });
    await waitForHero();
    fireEvent.change(screen.getByLabelText('Change stage'), { target: { value: 'proposal' } });
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/deals/1', expect.objectContaining({ stage: 'proposal' })));
    await waitFor(() => expect(screen.getByLabelText('Change stage')).toHaveValue('proposal'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a skeleton while loading and an alert on failure', async () => {
    api.get.mockImplementationOnce(() => Promise.reject({ response: { data: { error: 'Not found' } } }));
    renderPanel();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Couldn't load this deal")).toBeInTheDocument());
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Not found')).toBeInTheDocument();
  });
});
