// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for user-defined automation rules (/api/automation-rules).
//
// A rule is { name, trigger, conditions, action, enabled }. `trigger` and
// `action.type` are small closed enums; `conditions` / `action` payloads are
// validated per-trigger / per-action in a superRefine so the evaluator in
// services/automation.js can trust the shapes it reads.
//
// Kept deliberately small + safe: the evaluator only understands these
// triggers/actions, and anything outside the enum is rejected at the API
// boundary (and ignored as a no-op if it somehow reaches the engine).

const { z } = require('zod');

// Source-of-truth enums — the routes, the evaluator, and the frontend form all
// derive from these. Keep in sync with services/automation.js evaluateUserRule().
const TRIGGERS = ['deal_stage_is', 'deal_idle_days', 'task_overdue', 'custom_date_offset'];
const ACTIONS  = ['create_task', 'notify', 'set_hot_flag', 'create_task_and_notify'];

// Actions that only make sense against a deal target (deal_* triggers).
const DEAL_ONLY_ACTIONS = ['set_hot_flag'];
const DEAL_TRIGGERS = ['deal_stage_is', 'deal_idle_days'];

// custom_date_offset (CMN_REQUIREMENTS.md §1.3): "N days before/after a date
// custom field on an entity, create a task and/or notify the record owner."
// conditions = { entity, field_name, offset_days } where field_name must be a
// type='date' org_field_definitions row for that entity — that DB-dependent
// check lives in routes/automationRuleRoutes.js (and is re-applied by the
// evaluator's scan JOIN), not here.
const DATE_RULE_ENTITIES = ['deals', 'companies', 'contacts'];
const MAX_OFFSET_DAYS = 3650;
// create_task_and_notify ("both") is scoped to the date rule for now — the
// legacy triggers keep their original single-action semantics.
const DATE_RULE_ONLY_ACTIONS = ['create_task_and_notify'];

const conditionsSchema = z
  .union([z.record(z.string(), z.unknown()), z.null(), z.undefined()])
  .transform(v => (v == null ? {} : v));

const actionSchema = z
  .object({ type: z.enum(ACTIONS) })
  .passthrough();

function applyTriggerRefinements(val, ctx) {
  const conditions = val.conditions || {};

  if (val.trigger === 'deal_stage_is') {
    const stage = conditions.stage;
    if (typeof stage !== 'string' || stage.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'stage'], message: 'deal_stage_is requires conditions.stage (non-empty string)' });
    }
  }

  if (val.trigger === 'deal_idle_days') {
    const days = Number(conditions.days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'days'], message: 'deal_idle_days requires conditions.days to be a number between 1 and 3650' });
    }
  }

  // task_overdue takes no conditions — nothing to validate.

  if (val.trigger === 'custom_date_offset') {
    if (!DATE_RULE_ENTITIES.includes(conditions.entity)) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'entity'], message: `custom_date_offset requires conditions.entity to be one of: ${DATE_RULE_ENTITIES.join(', ')}` });
    }
    const fieldName = conditions.field_name;
    if (typeof fieldName !== 'string' || fieldName.trim() === '' || fieldName.length > 60) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'field_name'], message: 'custom_date_offset requires conditions.field_name (the name of a date custom field, ≤60 chars)' });
    }
    const offset = Number(conditions.offset_days);
    if (!Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'offset_days'], message: `custom_date_offset requires conditions.offset_days to be an integer between -${MAX_OFFSET_DAYS} and ${MAX_OFFSET_DAYS} (negative = before the date)` });
    }
  }

  // Action / trigger compatibility.
  if (val.action && DEAL_ONLY_ACTIONS.includes(val.action.type) && !DEAL_TRIGGERS.includes(val.trigger)) {
    ctx.addIssue({ code: 'custom', path: ['action', 'type'], message: `action "${val.action.type}" can only be used with a deal trigger (${DEAL_TRIGGERS.join(', ')})` });
  }
  if (val.action && DATE_RULE_ONLY_ACTIONS.includes(val.action.type) && val.trigger !== 'custom_date_offset') {
    ctx.addIssue({ code: 'custom', path: ['action', 'type'], message: `action "${val.action.type}" can only be used with the custom_date_offset trigger` });
  }

  // Task-creating actions require a title (it doubles as the template for the
  // date rule — {name}, {date} and {field} placeholders are substituted).
  if (val.action && (val.action.type === 'create_task' || val.action.type === 'create_task_and_notify')) {
    const title = val.action.title;
    if (typeof title !== 'string' || title.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['action', 'title'], message: `${val.action.type} requires action.title (non-empty string)` });
    }
  }
}

const createSchema = z
  .object({
    name: z.string().trim().min(1, 'name required').max(200),
    trigger: z.enum(TRIGGERS),
    conditions: conditionsSchema,
    action: actionSchema,
    enabled: z.boolean().optional().default(true),
  })
  .superRefine(applyTriggerRefinements);

// Full-replace update — same shape as create. The `enabled` flag is included so
// a PUT can also flip it; the dedicated toggle route exists for the UI switch.
const updateSchema = createSchema;

const toggleSchema = z.object({ enabled: z.boolean() });

module.exports = {
  TRIGGERS,
  ACTIONS,
  DEAL_ONLY_ACTIONS,
  DEAL_TRIGGERS,
  DATE_RULE_ENTITIES,
  DATE_RULE_ONLY_ACTIONS,
  MAX_OFFSET_DAYS,
  createSchema,
  updateSchema,
  toggleSchema,
};
