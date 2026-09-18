// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Design-system smoke test (wave 2). Renders a sample of the migrated pages
// with a stubbed API + auth and asserts the two invariants every page now
// shares: exactly one <h1> (from PageHeader) and no emoji glyphs in the
// chrome. Emoji is allowed only in user content, and the mocked API returns
// no records, so any pictograph found here is chrome.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const emptyList = () => Promise.resolve({ data: [] });
const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: [] })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));

vi.mock('../api', () => ({
  default: api,
  api,
  downloadBlob: vi.fn(),
  LIFECYCLE_STAGES: ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'],
  playbooks: {
    list: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
    remove: vi.fn(() => Promise.resolve({})),
  },
  cases: {
    list: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../AuthContext', () => ({ useAuth: () => defaultAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Notifications from './Notifications';
import Activities from './Activities';
import Forecast from './Forecast';
import Products from './Products';
import Issues from './Issues';
import Appreciation from './Appreciation';
import Plugins from './Plugins';
import Surveys from './Surveys';
import Playbooks from './Playbooks';
import PitchReadiness from './PitchReadiness';

const PAGES = [
  ['Notifications', Notifications],
  ['Activities', Activities],
  ['Forecast', Forecast],
  ['Products', Products],
  ['Issues', Issues],
  ['Appreciation', Appreciation],
  ['Plugins', Plugins],
  ['Surveys', Surveys],
  ['Playbooks', Playbooks],
  ['PitchReadiness', PitchReadiness],
];

// Extended_Pictographic covers the emoji blocks and the legacy dingbats
// (✅ ⚠️ 🚀 …) but not typographic marks like — … → ✓.
const EMOJI = /\p{Extended_Pictographic}/u;

describe('design-system smoke', () => {
  afterEach(() => cleanup());

  it.each(PAGES)('%s renders one h1 and no emoji in chrome', async (_name, Page) => {
    api.get.mockImplementation(emptyList);
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
    // Let any data-loading effects settle before scanning the DOM.
    await waitFor(() => expect(api.get).toHaveBeenCalled(), { timeout: 200 }).catch(() => {});
    expect(document.body.textContent).not.toMatch(EMOJI);
  });
});
