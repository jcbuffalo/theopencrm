// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/plugins.
//
// `run` body is the most exercised endpoint — caps total payload at 64KB by
// stringifying inside a refine() (matches MAX_INPUT_PAYLOAD_BYTES in
// pluginRoutes.js). The route still re-applies that limit as defense-in-depth
// and emits a structured 413 with the PLUGIN_INPUT_TOO_LARGE code.

const { z } = require('zod');

const MAX_INPUT_PAYLOAD_BYTES = 64 * 1024;

const optStr = (max) => z.union([z.string().max(max), z.null(), z.undefined()]).optional();
const opaqueJson = z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]).optional();

const createSchema = z.object({
  name: z.string().trim().min(1, 'name required').max(120),
  description: optStr(2000),
  spec_json: opaqueJson,
  source_code: optStr(200000), // 200KB plugin source ceiling — way over any realistic plugin
  source_kind: optStr(40),
  trigger_event: optStr(80),
  trigger_filter_json: opaqueJson,
}).passthrough();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: optStr(2000),
  spec_json: opaqueJson,
  source_code: optStr(200000),
  status: optStr(40),
  trigger_event: optStr(80),
  trigger_filter_json: opaqueJson,
}).passthrough();

// POST /:id/run — { input?: any }. The 64KB cap is checked via refine so
// callers get a single, clear 400 (the route handler still emits a 413 with
// PLUGIN_INPUT_TOO_LARGE for the legacy contract).
const runSchema = z.object({
  input: z.unknown().optional(),
}).passthrough().refine(
  (obj) => {
    if (obj.input === undefined || obj.input === null) return true;
    try {
      const s = JSON.stringify(obj.input);
      return !s || s.length <= MAX_INPUT_PAYLOAD_BYTES;
    } catch {
      return false;
    }
  },
  { message: `Input payload too large. Max ${MAX_INPUT_PAYLOAD_BYTES} bytes.`, path: ['input'] }
);

// POST /:id/apply — apply a preview run's confirm-first write proposals.
// Body is just { runId } — the fields to write are loaded server-side from the
// run's stored proposed_actions, never supplied by the client (tamper-proofing).
const applySchema = z.object({
  runId: z.union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n > 0, 'runId must be a positive integer'),
}).passthrough();

// POST /from-prompt — natural-language description Claude turns into a spec.
// `description` is the user prompt (10..2000 chars; sub-10 prompts produce
// hallucinated junk so we reject early). `name` is an optional override the
// user can supply to avoid the (org_id, name) UNIQUE collision when the
// AI-picked name clashes with an existing plugin.
const fromPromptSchema = z.object({
  description: z.string().trim()
    .min(10, 'description must be at least 10 characters')
    .max(2000, 'description must be 2000 characters or fewer'),
  name: z.string().trim().min(1).max(120).optional(),
}).passthrough();

module.exports = { createSchema, updateSchema, runSchema, applySchema, fromPromptSchema, MAX_INPUT_PAYLOAD_BYTES };
