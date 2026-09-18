// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Pure-function unit spec for the plugin-run status helpers. These power the
// runs viewer's status pills, badge tones, duration column, and trigger
// label — anything that touches a run row reads through here.

import { describe, it, expect } from 'vitest';
import {
  friendlyStatus,
  statusTone,
  TONE_CLASSES,
  formatDuration,
  triggerLabel,
} from './pluginRunStatus';

describe('friendlyStatus', () => {
  it('maps success and ok to "Worked"', () => {
    expect(friendlyStatus('success')).toBe('Worked');
    expect(friendlyStatus('ok')).toBe('Worked');
  });

  it('maps failure-shaped statuses to a "Didn\'t finish" phrase', () => {
    expect(friendlyStatus('failed')).toMatch(/Didn't finish/);
    expect(friendlyStatus('error')).toMatch(/Didn't finish/);
  });

  it('maps every budget_exceeded variant to a single "safety limit" phrase', () => {
    expect(friendlyStatus('budget_exceeded')).toMatch(/safety limit/);
    expect(friendlyStatus('query_budget_exceeded')).toMatch(/safety limit/);
    expect(friendlyStatus('task_budget_exceeded')).toMatch(/safety limit/);
  });

  it('returns a sensible default for unknown statuses', () => {
    expect(friendlyStatus('something_new')).toBe('Status: something_new');
    expect(friendlyStatus(null)).toBe('Status: unknown');
  });
});

describe('statusTone', () => {
  it('maps success-ish to good', () => {
    expect(statusTone('success')).toBe('good');
    expect(statusTone('ok')).toBe('good');
  });

  it('maps budget / timeout / memory to warn', () => {
    expect(statusTone('budget_exceeded')).toBe('warn');
    expect(statusTone('timeout')).toBe('warn');
    expect(statusTone('memory_exceeded')).toBe('warn');
  });

  it('maps hard-failure shapes to bad', () => {
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('error')).toBe('bad');
    expect(statusTone('sandbox_unavailable')).toBe('bad');
  });

  it('falls back to neutral for unknowns and null', () => {
    expect(statusTone('mystery')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });
});

describe('TONE_CLASSES', () => {
  it('exposes a class string for each tone bucket', () => {
    ['good', 'warn', 'bad', 'neutral'].forEach(tone => {
      expect(TONE_CLASSES[tone]).toMatch(/text-/);
      expect(TONE_CLASSES[tone]).toMatch(/border-/);
    });
  });
});

describe('formatDuration', () => {
  it('returns ms for under-1000ms values', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('returns seconds with one decimal for >= 1000ms', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2345)).toBe('2.3s');
  });

  it('returns a placeholder for null / non-finite', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('triggerLabel', () => {
  it('returns Chat for kind=chat or kind=manual+source=copilot', () => {
    expect(triggerLabel('chat')).toBe('Chat');
    expect(triggerLabel('manual', 'copilot')).toBe('Chat');
  });

  it('returns Schedule for cron / schedule kinds', () => {
    expect(triggerLabel('schedule')).toBe('Schedule');
    expect(triggerLabel('cron')).toBe('Schedule');
  });

  it('returns Manual for kind=manual without a copilot source, and for unset', () => {
    expect(triggerLabel('manual')).toBe('Manual');
    expect(triggerLabel(null)).toBe('Manual');
    expect(triggerLabel(undefined)).toBe('Manual');
  });

  it('Title-cases unknown kinds', () => {
    expect(triggerLabel('webhook')).toBe('Webhook');
  });
});
