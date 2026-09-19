// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// ContactPanel — the contact record drawer (usability review 2026-09-18,
// Wave 2: "No contact record page"). Specs cover: the record loads from
// GET /contacts/:id and renders the hero; the CTA row honours the
// campaigns_enabled / ai_features_enabled flags; the enroll flow posts to
// POST /sequences/:id/enroll with just this contact; a 404 renders an
// error, not a blank drawer.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: [] })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({ default: api, downloadBlob: vi.fn(() => Promise.resolve()) }));

const auth = vi.hoisted(() => ({ current: null }));
vi.mock('../AuthContext', () => ({ useAuth: () => auth.current }));

import ContactPanel from './ContactPanel';

const CONTACT = {
  id: 42, first_name: 'Dana', last_name: 'Reyes', email: 'dana@bravo.example', phone: '+15555550123',
  job_title: 'VP Ops', company_id: 7, status: 'lead', owner_user_id: null, cadence_days: 30,
  last_touch_at: null, notes: 'Met at the trade show.', custom_fields: {}, tags: [],
  created_at: '2026-09-01T00:00:00Z',
};

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

function renderPanel(props = {}) {
  return render(
    <MemoryRouter>
      <ContactPanel contactId={42} companies={[{ id: 7, name: 'Bravo LLC' }]} onClose={vi.fn()} onChanged={vi.fn()} onEdit={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

describe('ContactPanel', () => {
  beforeEach(() => {
    api.get.mockReset(); api.post.mockReset();
    auth.current = { ...defaultAuth, orgFeatures: { campaigns_enabled: true, ai_features_enabled: true, customer_success_enabled: true } };
    mockGet([
      ['/contacts/42', CONTACT],
      ['/contacts/42/deals', [{ id: 9, title: 'Bravo renewal', stage: 'proposal', amount: 9000, deal_type: 'default' }]],
      ['/org', { members: [] }],
    ]);
  });
  afterEach(() => cleanup());

  it('loads the record and renders the hero + company + deals', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Dana Reyes')).toBeInTheDocument());
    // Company + email each appear in the hero AND the Details fact list.
    expect(screen.getAllByText('Bravo LLC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dana@bravo.example').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Bravo renewal')).toBeInTheDocument());
    // Full CTA row with every flag on.
    expect(screen.getByRole('button', { name: /log activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^email$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enroll in sequence/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask the copilot/i })).toBeInTheDocument();
  });

  it('hides Enroll + Ask the copilot when their modules are off', async () => {
    auth.current = { ...defaultAuth, orgFeatures: { campaigns_enabled: false, ai_features_enabled: false } };
    renderPanel();
    await waitFor(() => expect(screen.getByText('Dana Reyes')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /enroll in sequence/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ask the copilot/i })).toBeNull();
  });

  it('enrolls this one contact into the chosen sequence', async () => {
    mockGet([
      ['/contacts/42', CONTACT],
      ['/contacts/42/deals', []],
      ['/org', { members: [] }],
      ['/sequences', { email_configured: true, sequences: [
        { id: 3, name: 'Warm intro', is_active: true, step_count: 3, active_enrollments: 2 },
        { id: 4, name: 'Paused one', is_active: false, step_count: 2, active_enrollments: 0 },
      ] }],
    ]);
    api.post.mockResolvedValue({ data: { enrolled: 1, skipped: 0 } });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Dana Reyes')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /enroll in sequence/i }));
    // First active sequence is preselected; the confirm button names it.
    const confirm = await screen.findByRole('button', { name: /enroll in "warm intro"/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/sequences/3/enroll', { contact_ids: [42] }));
    await waitFor(() => expect(screen.getByText(/enrolled\. step 1/i)).toBeInTheDocument());
  });

  it('renders an error (not a blank drawer) on a 404', async () => {
    mockGet([
      ['/contacts/42', Object.assign(new Error('nf'), { response: { status: 404, data: { error: 'Contact not found' } } })],
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText('Contact not found.')).toBeInTheDocument());
  });
});
