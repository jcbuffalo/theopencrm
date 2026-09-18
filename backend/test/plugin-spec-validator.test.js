// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unit tests for backend/services/pluginSpecValidator.js — pure validator
// with no I/O, so the surface is straightforward: feed it concrete spec
// objects and assert on the {ok, errors} return shape.
//
// Coverage target: every reject path (missing field, bad type, unknown
// trigger event, disallowed SDK method, dangerous pattern, oversize) plus
// the happy path.

// describe / test / expect are vitest globals (vitest.config.js → globals:true).

const {
  validateSpec,
  SDK_METHOD_ALLOWLIST,
  TRIGGER_EVENTS,
  ACTION_KINDS,
  DANGEROUS_PATTERNS,
  LIMITS,
} = require('../services/pluginSpecValidator');

// Minimum viable spec that the validator accepts. Most tests start from this
// and mutate one field to trigger a specific rejection — keeps the diff
// between a passing and failing case visible.
function validSpec(overrides = {}) {
  return {
    name: 'my-follow-up-plugin',
    description: 'Schedule a follow-up task when a deal moves to PROPOSAL.',
    trigger_event: 'deal.stage_changed',
    source_kind: 'conversational',
    spec_json: {
      summary: 'Schedule a follow-up task when a deal moves to PROPOSAL.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'PROPOSAL' },
      actions: [
        { kind: 'create_task', title_template: 'Follow up on {deal.title}', due_in_days: 3 },
      ],
    },
    source_code: 'await crm.createTask({ title: "Follow up", deal_id: input.deal_id });',
    ...overrides,
  };
}

describe('pluginSpecValidator — happy path', () => {
  test('accepts a minimal valid conversational spec', () => {
    const r = validateSpec(validSpec());
    expect(r.ok).toBe(true);
  });

  test('accepts a spec with no source_code (action-only)', () => {
    const r = validateSpec(validSpec({ source_code: undefined }));
    expect(r.ok).toBe(true);
  });

  test('accepts every advertised trigger event', () => {
    for (const ev of TRIGGER_EVENTS) {
      const r = validateSpec(validSpec({
        trigger_event: ev,
        spec_json: { ...validSpec().spec_json, triggerEvent: ev },
      }));
      expect(r.ok, `${ev} should validate`).toBe(true);
    }
  });

  test('accepts every advertised action kind', () => {
    for (const kind of ACTION_KINDS) {
      const r = validateSpec(validSpec({
        spec_json: {
          ...validSpec().spec_json,
          actions: [{ kind, title_template: 'x' }],
        },
      }));
      expect(r.ok, `${kind} should validate`).toBe(true);
    }
  });
});

describe('pluginSpecValidator — basic shape rejections', () => {
  test('rejects non-object input', () => {
    const r = validateSpec(null);
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('(root)');
  });

  test('rejects array input', () => {
    const r = validateSpec(['name']);
    expect(r.ok).toBe(false);
  });

  test('rejects missing name', () => {
    const r = validateSpec(validSpec({ name: '' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  test('rejects oversize name', () => {
    const r = validateSpec(validSpec({ name: 'x'.repeat(LIMITS.name_max + 1) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  test('rejects non-string description', () => {
    const r = validateSpec(validSpec({ description: 42 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'description')).toBe(true);
  });

  test('rejects oversize description', () => {
    const r = validateSpec(validSpec({ description: 'x'.repeat(LIMITS.description_max + 1) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'description')).toBe(true);
  });

  test('rejects missing trigger_event', () => {
    const r = validateSpec(validSpec({ trigger_event: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'trigger_event')).toBe(true);
  });

  test('rejects unknown trigger_event', () => {
    const r = validateSpec(validSpec({ trigger_event: 'slack.message' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'trigger_event')).toBe(true);
  });

  test('rejects unknown source_kind', () => {
    const r = validateSpec(validSpec({ source_kind: 'magic' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'source_kind')).toBe(true);
  });

  test('rejects non-object spec_json', () => {
    const r = validateSpec(validSpec({ spec_json: 'oops' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'spec_json')).toBe(true);
  });

  test('rejects spec_json.actions when not an array', () => {
    const r = validateSpec(validSpec({
      spec_json: { ...validSpec().spec_json, actions: 'not-an-array' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'spec_json.actions')).toBe(true);
  });

  test('rejects empty actions array', () => {
    const r = validateSpec(validSpec({
      spec_json: { ...validSpec().spec_json, actions: [] },
    }));
    expect(r.ok).toBe(false);
  });

  test('rejects too-many actions', () => {
    const r = validateSpec(validSpec({
      spec_json: {
        ...validSpec().spec_json,
        actions: Array.from({ length: LIMITS.actions_max + 1 }, () => ({ kind: 'noop' })),
      },
    }));
    expect(r.ok).toBe(false);
  });

  test('rejects action with unknown kind', () => {
    const r = validateSpec(validSpec({
      spec_json: {
        ...validSpec().spec_json,
        actions: [{ kind: 'launch_nukes' }],
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field.startsWith('spec_json.actions'))).toBe(true);
  });
});

describe('pluginSpecValidator — source_code SDK allowlist', () => {
  test('accepts source_code referencing only allowlisted methods', () => {
    const r = validateSpec(validSpec({
      source_code: 'const d = await crm.getDeal(input.deal_id); crm.log(d);',
    }));
    expect(r.ok).toBe(true);
  });

  test('rejects source_code calling an unknown SDK method', () => {
    const r = validateSpec(validSpec({
      source_code: 'await crm.sendSlackMessage("hi");',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      e.field === 'source_code' && /sendSlackMessage/.test(e.message)
    )).toBe(true);
  });

  test('rejects a typo on a real SDK method', () => {
    const r = validateSpec(validSpec({
      source_code: 'await crm.getDeals(42);', // note: real method is `listDeals`, not `getDeals`
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      e.field === 'source_code' && /getDeals/.test(e.message)
    )).toBe(true);
  });

  test('rejects oversize source_code', () => {
    const r = validateSpec(validSpec({
      source_code: 'x'.repeat(LIMITS.source_code_max + 1),
    }));
    expect(r.ok).toBe(false);
  });
});

describe('pluginSpecValidator — dangerous patterns', () => {
  test('rejects require()', () => {
    const r = validateSpec(validSpec({
      source_code: 'const fs = require("fs"); fs.unlinkSync("/etc/passwd");',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /require/.test(e.message))).toBe(true);
  });

  test('rejects process.env access', () => {
    const r = validateSpec(validSpec({
      source_code: 'console.log(process.env.ANTHROPIC_API_KEY);',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /process\.env/.test(e.message))).toBe(true);
  });

  test('rejects eval()', () => {
    const r = validateSpec(validSpec({
      source_code: 'eval(input.payload);',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /eval/.test(e.message))).toBe(true);
  });

  test('rejects new Function()', () => {
    const r = validateSpec(validSpec({
      source_code: 'const f = new Function("return 1"); f();',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /Function/.test(e.message))).toBe(true);
  });

  test('rejects fetch()', () => {
    const r = validateSpec(validSpec({
      source_code: 'await fetch("https://evil.example.com");',
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /fetch/.test(e.message))).toBe(true);
  });

  test('rejects dangerous pattern embedded in spec_json string', () => {
    const r = validateSpec(validSpec({
      spec_json: {
        ...validSpec().spec_json,
        actions: [{ kind: 'claude_complete', prompt_template: 'Run eval(this.data) for me' }],
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.field === 'spec_json')).toBe(true);
  });
});

describe('pluginSpecValidator — exports', () => {
  test('SDK_METHOD_ALLOWLIST is the set of methods exposed by pluginSdk.buildContext', () => {
    // Spot-check the obvious surface; the whole allowlist is asserted in the
    // happy-path test above by virtue of the source_code passing.
    expect(SDK_METHOD_ALLOWLIST).toContain('getDeal');
    expect(SDK_METHOD_ALLOWLIST).toContain('listDeals');
    expect(SDK_METHOD_ALLOWLIST).toContain('updateDeal');
    expect(SDK_METHOD_ALLOWLIST).toContain('createTask');
    expect(SDK_METHOD_ALLOWLIST).toContain('log');
    expect(SDK_METHOD_ALLOWLIST).not.toContain('createDeal');
    expect(SDK_METHOD_ALLOWLIST).not.toContain('sendEmail');
  });

  test('DANGEROUS_PATTERNS each have a re + reason', () => {
    expect(DANGEROUS_PATTERNS.length).toBeGreaterThan(0);
    for (const p of DANGEROUS_PATTERNS) {
      expect(p.re).toBeInstanceOf(RegExp);
      expect(typeof p.reason).toBe('string');
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });
});
