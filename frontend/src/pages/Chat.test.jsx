// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the Chat front door's empty state and composer contract:
//   (a) an org with no deals/contacts gets the first-run surface, not the
//       generic starters;
//   (b) today-strip chips built from /my-day SEED the composer (stay on chat);
//   (c) the pay-as-you-go billing card still replaces the composer when the
//       /ai/status verdict is allowed=false;
//   (d) the markdown renderer handles numbered lists, links, and code;
//   (e) session restore pulls the latest recent session's messages;
//   (f) Enter sends, Shift+Enter does not.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: {} })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  // The SSE helper (api.streamChat / named export). Default per test: reject
  // before any event, which exercises the fallback to POST /ai/chat.
  streamChat: vi.fn(),
}));
vi.mock('../api', () => ({ default: api, streamChat: api.streamChat }));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Chat from './Chat';
import { renderMarkdown } from '../components/ChatMarkdown';

const EMPTY_MY_DAY = {
  tasksDue: [], renewals: [], atRiskAccounts: [], quietAccounts: [], dealsNeedingAttention: [],
  counts: { tasksDue: 0, renewals: 0, atRiskAccounts: 0, quietAccounts: 0, dealsNeedingAttention: 0, total: 0 },
};

// Route-by-URL mock for api.get. Unlisted URLs resolve to `{ data: {} }`.
function mockGets(table) {
  api.get.mockImplementation((url) => {
    for (const [prefix, value] of Object.entries(table)) {
      if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
        return typeof value === 'function' ? value(url) : Promise.resolve({ data: value });
      }
    }
    return Promise.resolve({ data: {} });
  });
}

function renderChat(route = '/chat') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Chat />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(() => Promise.resolve({ data: {} }));
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  api.streamChat.mockReset();
  api.streamChat.mockImplementation(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { firstEventSeen: false })));
  currentAuth = { ...defaultAuth, aiBilling: { allowed: true, status: 'active' }, orgRole: 'admin' };
});

// Streaming spec:
//   (g) the reply renders progressively — status line, then tokens, then the
//       final markdown from `done`;
//   (h) Stop aborts the stream and keeps what streamed;
//   (i) a stream that dies before its first event falls back to POST /ai/chat;
//   (j) a server ruling (429) is NOT retried and gets the blocking route's copy;
//   (k) /my-day `has_data` drives empty-org detection with no /deals or
//       /contacts fetch.
describe('Chat streaming', () => {
  const DATA_GETS = {
    '/my-day': { ...EMPTY_MY_DAY, has_data: { deals: 1, contacts: 0, companies: 0 } },
    '/ai/chat/sessions': { sessions: [] },
  };

  async function typeAndSend(text) {
    const box = await screen.findByLabelText('Message');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
  }

  it('renders the reply progressively: status line, then tokens, then the final markdown on done', async () => {
    mockGets(DATA_GETS);
    let emit; let finish;
    api.streamChat.mockImplementation((body, { onEvent }) => new Promise((resolve) => { emit = onEvent; finish = resolve; }));
    renderChat();
    await typeAndSend('what is overdue?');
    expect(api.streamChat.mock.calls[0][0]).toMatchObject({ message: 'what is overdue?' });
    expect(api.streamChat.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    // Before the first event: the generic waiting bubble, and Send became Stop.
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeInTheDocument();

    act(() => emit({ event: 'status', data: { tool: 'list_overdue_tasks', text: 'Looking at overdue tasks…' } }));
    expect(await screen.findByText('Looking at overdue tasks…')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-streaming')).toBeInTheDocument();

    act(() => {
      emit({ event: 'token', data: { text: 'You have ' } });
      emit({ event: 'token', data: { text: '**two** overdue tasks.' } });
    });
    await waitFor(() => expect(screen.getByTestId('assistant-streaming').textContent).toContain('You have two overdue tasks.'));
    expect(screen.queryByText('Looking at overdue tasks…')).not.toBeInTheDocument();

    act(() => finish({
      session_id: 's9',
      reply: 'You have **two** overdue tasks.',
      actions: [{ kind: 'ask', label: 'Which first?', prompt: 'Which one first?' }],
      explanation: 'Looked up: list overdue tasks.',
    }));
    expect(await screen.findByText('Which first?')).toBeInTheDocument();
    expect(screen.getByText('two').tagName).toBe('STRONG');
    expect(screen.getByText('Looked up: list overdue tasks.')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-streaming')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('Stop aborts the stream and keeps the partial text, marked as stopped', async () => {
    mockGets(DATA_GETS);
    let emit;
    api.streamChat.mockImplementation((body, { onEvent, signal }) => new Promise((resolve, reject) => {
      emit = onEvent;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    renderChat();
    await typeAndSend('hello');
    act(() => emit({ event: 'token', data: { text: 'Partial answer' } }));
    await screen.findByText('Partial answer');

    fireEvent.click(screen.getByRole('button', { name: /stop generating/i }));
    expect(await screen.findByText('Stopped.')).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-streaming')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('falls back to POST /ai/chat when the stream fails before its first event', async () => {
    mockGets(DATA_GETS);
    api.streamChat.mockRejectedValue(Object.assign(new Error('Failed to fetch'), { firstEventSeen: false }));
    api.post.mockResolvedValue({ data: { session_id: 's1', reply: 'Fallback reply', actions: [] } });
    renderChat();
    await typeAndSend('hello');
    expect(await screen.findByText('Fallback reply')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/ai/chat', expect.objectContaining({ message: 'hello' }), expect.anything());
  });

  it('does not fall back once the server has ruled (429 daily cap) — same copy as the blocking route', async () => {
    mockGets(DATA_GETS);
    const err = new Error('cap');
    err.response = { status: 429, data: { code: 'CHAT_DAILY_CAP', error: 'Daily chat cap reached' } };
    err.firstEventSeen = false;
    api.streamChat.mockRejectedValue(err);
    renderChat();
    await typeAndSend('hello');
    expect(await screen.findByText(/daily chat cap/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    // The optimistic user message is rolled back into the composer.
    expect(screen.getByLabelText('Message').value).toBe('hello');
  });

  it('uses /my-day has_data for empty-org detection instead of fetching /deals and /contacts', async () => {
    mockGets({ '/my-day': { ...EMPTY_MY_DAY, has_data: { deals: 0, contacts: 0, companies: 0 } }, '/ai/chat/sessions': { sessions: [] } });
    localStorage.setItem('theopencrm.welcome.v1.1.100', JSON.stringify({ dismissedAt: '2026-01-01T00:00:00Z', completed: {} }));
    renderChat();
    expect(await screen.findByTestId('first-run-starters')).toBeInTheDocument();
    const urls = api.get.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/deals');
    expect(urls).not.toContain('/contacts');
  });

  it('counts an org with only companies as having data', async () => {
    mockGets({ '/my-day': { ...EMPTY_MY_DAY, has_data: { deals: 0, contacts: 0, companies: 2 } }, '/ai/chat/sessions': { sessions: [] } });
    renderChat();
    expect(await screen.findByText('What should I focus on today?')).toBeInTheDocument();
    expect(screen.queryByTestId('first-run-starters')).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
});

describe('Chat empty state', () => {
  it('shows the first-run surface (not the generic starters) for an org with no deals or contacts', async () => {
    mockGets({ '/my-day': EMPTY_MY_DAY, '/deals': [], '/contacts': [], '/ai/chat/sessions': { sessions: [] } });
    renderChat();

    // WelcomeCard renders first; its tasks are chat prompts.
    await screen.findByText(/Add your first deal/i);
    expect(screen.getByText(/Load sample data to explore/i)).toBeInTheDocument();
    expect(screen.queryByText('What should I focus on today?')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-strip')).not.toBeInTheDocument();

    // Clicking a prompt task seeds the composer — no navigation, no send.
    fireEvent.click(screen.getByText(/Add your first deal/i));
    const box = screen.getByLabelText('Message');
    expect(box.value).toMatch(/add my first deal/i);
    expect(api.post).not.toHaveBeenCalled();

    // Dismissing the card swaps in the compact first-run starters.
    fireEvent.click(screen.getByLabelText(/Dismiss welcome card/i));
    const starters = await screen.findByTestId('first-run-starters');
    expect(within(starters).getByText('Import my contacts from a CSV')).toBeInTheDocument();
    expect(within(starters).getByText('What can you do?')).toBeInTheDocument();
    expect(within(starters).getByText('Load sample data so I can explore')).toBeInTheDocument();
  });

  it('hides the sample-data starter for members who cannot seed', async () => {
    currentAuth = { ...currentAuth, orgRole: 'member', user: { ...defaultAuth.user, org_role: 'member' } };
    localStorage.setItem('theopencrm.welcome.v1.1.100', JSON.stringify({ dismissedAt: '2026-01-01T00:00:00Z', completed: {} }));
    mockGets({ '/my-day': EMPTY_MY_DAY, '/deals': [], '/contacts': [], '/ai/chat/sessions': { sessions: [] } });
    renderChat();
    const starters = await screen.findByTestId('first-run-starters');
    expect(within(starters).queryByText(/Load sample data/i)).not.toBeInTheDocument();
    expect(within(starters).getByText('Add my first deal')).toBeInTheDocument();
  });

  it('renders today chips from /my-day and seeds the composer on click', async () => {
    mockGets({
      '/my-day': {
        ...EMPTY_MY_DAY,
        counts: { tasksDue: 3, renewals: 1, atRiskAccounts: 0, quietAccounts: 0, dealsNeedingAttention: 2, total: 6 },
      },
      '/deals': [{ id: 1, title: 'Acme' }],
      '/contacts': [],
      '/ai/chat/sessions': { sessions: [] },
    });
    renderChat();

    const strip = await screen.findByTestId('today-strip');
    expect(within(strip).getByText('tasks due today')).toBeInTheDocument();
    expect(within(strip).getByText('deals stalling')).toBeInTheDocument();
    expect(within(strip).getByText('renewal in 30 days')).toBeInTheDocument();
    expect(within(strip).queryByText(/at-risk/)).not.toBeInTheDocument();

    // Generic starters are present alongside the strip once the org has data.
    expect(screen.getByText('What should I focus on today?')).toBeInTheDocument();
    // No WelcomeCard for an org with data.
    expect(screen.queryByText(/Welcome to The Open CRM/)).not.toBeInTheDocument();

    fireEvent.click(within(strip).getByText('tasks due today'));
    const box = screen.getByLabelText('Message');
    expect(box.value).toBe('What tasks are due today, and which should I do first?');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps the Debug mode toggle out of the empty state and out of reach for non-admins', async () => {
    mockGets({ '/my-day': EMPTY_MY_DAY, '/deals': [{ id: 1 }], '/contacts': [], '/ai/chat/sessions': { sessions: [] } });
    currentAuth = { ...currentAuth, isAdmin: false };
    renderChat();
    await screen.findByText('What should I focus on today?');
    expect(screen.queryByText(/Debug mode/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Chat options'));
    expect(screen.getByText('New chat')).toBeInTheDocument();
    expect(screen.queryByText(/Debug mode/)).not.toBeInTheDocument();
  });
});

describe('Chat billing gate', () => {
  it('still renders the AI billing card and disables the composer when aiBilling.allowed is false', async () => {
    currentAuth = {
      ...currentAuth,
      aiBilling: {
        allowed: false,
        status: 'unconfigured',
        code: 'AI_BILLING_REQUIRED',
        action: 'start_billing',
        message: 'AI usage requires an active billing subscription.',
        can_manage: true,
        stripe_ready: true,
      },
    };
    mockGets({ '/my-day': EMPTY_MY_DAY, '/deals': [{ id: 1 }], '/contacts': [], '/ai/chat/sessions': { sessions: [] } });
    renderChat();
    expect(await screen.findByText('Turn on AI for your workspace')).toBeInTheDocument();
    const box = screen.getByPlaceholderText('Start the AI plan above to chat');
    expect(box).toBeDisabled();
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });
});

describe('Chat session restore + composer', () => {
  it('restores the most recent session on mount and can start a new chat', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockGets({
      '/my-day': EMPTY_MY_DAY,
      '/deals': [{ id: 1 }],
      '/contacts': [],
      '/ai/chat/sessions': (url) => {
        if (url.endsWith('/messages')) {
          return Promise.resolve({ data: { messages: [
            { id: 1, role: 'user', content: 'What is stalling?', actions: [], created_at: recent },
            { id: 2, role: 'assistant', content: 'Two deals look stuck.', actions: [{ kind: 'ask', label: 'Which first?', prompt: 'Which one should I work first?' }], created_at: recent },
          ] } });
        }
        return Promise.resolve({ data: { sessions: [
          { id: 'abc', started_at: recent, last_message_at: recent, message_count: 2, preview: 'What is stalling?' },
        ] } });
      },
    });
    renderChat();

    expect(await screen.findByText('Two deals look stuck.')).toBeInTheDocument();
    expect(screen.getByText('What is stalling?')).toBeInTheDocument();
    // Empty-state greeting is gone once a conversation is on screen.
    expect(screen.queryByText(/What’s on your plate/)).not.toBeInTheDocument();

    // An `ask` chip seeds the composer instead of navigating.
    fireEvent.click(screen.getByText('Which first?'));
    expect(screen.getByLabelText('Message').value).toBe('Which one should I work first?');

    // New chat clears the thread and brings the empty state back.
    fireEvent.click(screen.getByText('New chat'));
    expect(await screen.findByText(/What’s on your plate/)).toBeInTheDocument();
    expect(screen.queryByText('Two deals look stuck.')).not.toBeInTheDocument();
  });

  it('sends on Enter and posts the message; Shift+Enter does not send', async () => {
    mockGets({ '/my-day': EMPTY_MY_DAY, '/deals': [{ id: 1 }], '/contacts': [], '/ai/chat/sessions': { sessions: [] } });
    api.post.mockResolvedValue({ data: { session_id: 's1', reply: '**Done.**\n\n1. one\n2. two', actions: [] } });
    renderChat();
    const box = await screen.findByLabelText('Message');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/ai/chat', expect.objectContaining({ message: 'hello' }), expect.anything()));
    expect(await screen.findByText('Done.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('renderMarkdown', () => {
  function renderMd(text) {
    return render(<MemoryRouter><div data-testid="md">{renderMarkdown(text)}</div></MemoryRouter>);
  }

  it('renders numbered lists, links, inline code and fenced code', () => {
    renderMd([
      '## Next steps',
      '1. Call [Acme](https://acme.example/deal) about the `PO-123` order',
      '2. Log the *meeting*',
      '',
      '```sql',
      'SELECT 1;',
      '```',
      'See [deals](/deals) for more.',
    ].join('\n'));
    const root = screen.getByTestId('md');
    expect(root.querySelector('ol')).not.toBeNull();
    expect(root.querySelectorAll('ol > li')).toHaveLength(2);
    expect(root.querySelector('h4')?.textContent).toBe('Next steps');

    const ext = screen.getByText('Acme');
    expect(ext.tagName).toBe('A');
    expect(ext).toHaveAttribute('href', 'https://acme.example/deal');
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer');
    expect(ext).toHaveAttribute('target', '_blank');

    const internal = screen.getByText('deals');
    expect(internal.tagName).toBe('A');
    expect(internal).toHaveAttribute('href', '/deals');

    expect(screen.getByText('PO-123').tagName).toBe('CODE');
    expect(screen.getByText('meeting').tagName).toBe('EM');
    expect(root.querySelector('pre code')?.textContent).toBe('SELECT 1;');
  });

  it('renders simple tables and never emits raw HTML', () => {
    renderMd('| Deal | Amount |\n|---|---|\n| Acme | $10k |\n\n<script>alert(1)</script> **bold**');
    const root = screen.getByTestId('md');
    expect(root.querySelectorAll('table th')).toHaveLength(2);
    expect(root.querySelectorAll('table td')).toHaveLength(2);
    expect(root.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('drops unsafe link schemes but keeps the label', () => {
    renderMd('[click](javascript:alert%281%29)');
    const root = screen.getByTestId('md');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('click');
  });
});
