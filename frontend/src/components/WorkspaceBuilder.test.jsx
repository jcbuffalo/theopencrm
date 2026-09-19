// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// WorkspaceBuilder (spec 203, Phase 1) — the contract that matters:
//   • compose → one POST /onboarding/plan (template + text merged), NO writes
//   • review shows every proposal, checkboxes default on, member sees the
//     "owner/admin applies" note and no Build button
//   • Build applies ONLY the checked proposals, in order, through
//     /ai/actions/apply; a failure is shown inline and does not stop the rest;
//     refreshPipeline fires once a pipeline proposal lands
//   • 402 from the planner renders the billing hand-off, not a raw error

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api', () => ({ default: api }));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));

import WorkspaceBuilder from './WorkspaceBuilder';

const TEMPLATES = [
  { id: 'saas', name: 'SaaS / software', tagline: 'Trials, demos, renewals.' },
  { id: 'agency', name: 'Agency', tagline: 'Briefs, pitches, retainers.' },
];

function proposal(kind, label, summary, fields = {}) {
  return { kind, label, summary, detail: null, why: '', proposal: { entity: kind === 'pipeline' ? 'pipeline' : 'custom_field', op: kind === 'pipeline' ? 'update' : 'create', fields, summary } };
}

const PLAN = {
  narrative: 'A five-stage pipeline with the two fields you track.',
  pipeline_name: 'Sales',
  proposals: [
    proposal('pipeline', 'Sales', 'Update pipeline stages: Lead -> Demo -> Quote -> Won -> Lost', { stages: [{ id: 'lead', label: 'Lead' }] }),
    proposal('field', 'Seat count', 'Add number field "Seat count" (seat_count) to deals', { entity: 'deals', name: 'seat_count', type: 'number' }),
    proposal('automation', 'Nudge', 'When a deal is idle 14 days, create task "Follow up"', {}),
    proposal('view', 'Hot deals', 'Save a shared deals view "Hot deals" filtered by hot=true', {}),
  ],
  skipped: [{ kind: 'field', label: 'Amount', reason: 'already exists' }],
  notes: [],
};

function renderBuilder(props = {}) {
  return render(<MemoryRouter><WorkspaceBuilder {...props} /></MemoryRouter>);
}

async function draftWith(text) {
  fireEvent.change(screen.getByTestId('builder-description'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /Draft my CRM/i }));
  await waitFor(() => expect(screen.getByTestId('plan-narrative')).toBeInTheDocument());
}

describe('WorkspaceBuilder', () => {
  const SAVED = [{ id: 9, org_id: null, is_platform: true, name: 'Rep firm starter', tagline: 'RFQ to PO', stages: ['RFQ', 'Quote', 'PO', 'Lost'], field_labels: ['RFQ Number'], automation_count: 1, view_count: 1, use_count: 4 }];

  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockImplementation((path) => {
      if (path === '/onboarding/templates') return Promise.resolve({ data: { templates: TEMPLATES } });
      if (path === '/workspace-templates') return Promise.resolve({ data: { templates: SAVED } });
      return Promise.resolve({ data: {} });
    });
    currentAuth = { ...defaultAuth, orgRole: 'owner', refreshPipeline: vi.fn().mockResolvedValue(null) };
  });
  afterEach(() => cleanup());

  it('drafts a plan from text + a selected template with one planner call and no writes', async () => {
    api.post.mockResolvedValueOnce({ data: { ok: true, can_apply: true, plan: PLAN } });
    renderBuilder();
    await waitFor(() => expect(screen.getByTestId('template-chips')).toBeInTheDocument());

    // Too short → button disabled.
    fireEvent.change(screen.getByTestId('builder-description'), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: /Draft my CRM/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /SaaS \/ software/i }));
    expect(screen.getByRole('button', { name: /SaaS \/ software/i })).toHaveAttribute('aria-pressed', 'true');
    await draftWith('We also sell through resellers.');

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/onboarding/plan', { description: 'We also sell through resellers.', template_id: 'saas' });
    expect(screen.getByText(/five-stage pipeline/)).toBeInTheDocument();

    // Every proposal is listed, grouped, checked by default.
    const groups = screen.getByTestId('plan-groups');
    expect(within(groups).getByText('Pipeline')).toBeInTheDocument();
    expect(within(groups).getByText('Fields')).toBeInTheDocument();
    expect(within(groups).getByText('Automations')).toBeInTheDocument();
    expect(within(groups).getByText('Saved views')).toBeInTheDocument();
    for (let i = 0; i < 4; i++) expect(screen.getByTestId(`proposal-check-${i}`)).toBeChecked();
    expect(screen.getByTestId('build-button')).toHaveTextContent('Build my CRM (4)');
    // Skipped items are disclosed, not hidden.
    expect(screen.getByText(/1 thing I left out/)).toBeInTheDocument();
  });

  it('applies only checked proposals, in order, through /ai/actions/apply; a failure is inline and non-fatal; refreshPipeline fires', async () => {
    api.post
      .mockResolvedValueOnce({ data: { ok: true, can_apply: true, plan: PLAN } })      // plan
      .mockResolvedValueOnce({ data: { ok: true, result: {}, open_path: '/settings/pipeline', open_label: 'Open pipeline settings' } }) // pipeline
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'A "seat_count" field already exists' } } })   // field fails
      .mockResolvedValueOnce({ data: { ok: true, applied: {} } });                          // view
    const onDone = vi.fn();
    renderBuilder({ onDone });
    await draftWith('We sell software subscriptions to mid-market companies.');

    // Uncheck the automation (index 2).
    fireEvent.click(screen.getByTestId('proposal-check-2'));
    expect(screen.getByTestId('build-button')).toHaveTextContent('Build my CRM (3)');
    fireEvent.click(screen.getByTestId('build-button'));

    await waitFor(() => expect(screen.getByText(/Built 2 of 3/)).toBeInTheDocument());
    const applyCalls = api.post.mock.calls.filter((c) => c[0] === '/ai/actions/apply');
    expect(applyCalls.map((c) => c[1].proposal.summary)).toEqual([
      PLAN.proposals[0].summary,
      PLAN.proposals[1].summary,
      PLAN.proposals[3].summary,
    ]);
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open pipeline settings/i })).toBeInTheDocument();
    expect(currentAuth.refreshPipeline).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ built: 2, failed: 1 });
    expect(screen.getByRole('link', { name: /Open your deal board/i })).toHaveAttribute('href', '/deals');
  });

  it('a member sees the plan but no Build button, with the owner/admin note', async () => {
    currentAuth = { ...defaultAuth, orgRole: 'member', user: { ...defaultAuth.user, org_role: 'member' }, refreshPipeline: vi.fn() };
    api.post.mockResolvedValueOnce({ data: { ok: true, can_apply: false, plan: PLAN } });
    renderBuilder();
    expect(screen.getByText(/an owner or admin applies it/i)).toBeInTheDocument();
    await draftWith('We are a recruiting agency placing engineers.');
    expect(screen.getByText(/Only an owner or admin can apply this/)).toBeInTheDocument();
    expect(screen.getByTestId('build-button')).toBeDisabled();
  });

  it('402 from the planner becomes the billing hand-off, and the user can retry', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 402, data: { code: 'AI_BILLING_REQUIRED' } } });
    renderBuilder();
    fireEvent.change(screen.getByTestId('builder-description'), { target: { value: 'We sell widgets to hardware stores.' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft my CRM/i }));
    await waitFor(() => expect(screen.getByText(/AI needs to be switched on first/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Open Plan & Billing/i })).toHaveAttribute('href', '/settings#billing');
    // Back in compose; the text survives so a retry is one click.
    expect(screen.getByTestId('builder-description')).toHaveValue('We sell widgets to hardware stores.');
    expect(screen.getByRole('button', { name: /Draft my CRM/i })).not.toBeDisabled();
  });

  it('saved-template mode: deterministic plan via /workspace-templates/:id/plan, no textarea, no /onboarding call', async () => {
    api.post.mockResolvedValueOnce({ data: { ok: true, can_apply: true, template: { id: 9, name: 'Rep firm starter' }, plan: { ...PLAN, narrative: 'Start from "Rep firm starter".' } } });
    renderBuilder({ initialTemplate: { kind: 'saved', id: 9 } });
    await waitFor(() => expect(screen.getByTestId('saved-template-mode')).toBeInTheDocument());
    expect(screen.getByText('Rep firm starter')).toBeInTheDocument();
    expect(screen.queryByTestId('builder-description')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show me the plan/i }));
    await waitFor(() => expect(screen.getByTestId('plan-narrative')).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/workspace-templates/9/plan', {});
    expect(screen.getByText(/From "Rep firm starter"/)).toBeInTheDocument();
    expect(screen.getByTestId('build-button')).toHaveTextContent('Build my CRM (4)');
  });

  it('a saved-template chip on the compose screen switches into saved mode; "Describe my business instead" switches back', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByTestId('saved-template-chips')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Rep firm starter/i }));
    expect(screen.getByTestId('saved-template-mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Describe my business instead/i }));
    expect(screen.getByTestId('builder-description')).toBeInTheDocument();
  });

  it('an empty plan (not-a-business reply) asks for more instead of offering to build nothing', async () => {
    api.post.mockResolvedValueOnce({ data: { ok: true, can_apply: true, plan: { narrative: 'Tell me how you find and close customers.', proposals: [], skipped: [], notes: [] } } });
    renderBuilder();
    await draftWith('asdf asdf asdf asdf');
    expect(screen.getByText(/I need a little more/)).toBeInTheDocument();
    expect(screen.queryByTestId('build-button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start over/i }));
    expect(screen.getByTestId('builder-description')).toBeInTheDocument();
  });
});
