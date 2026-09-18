// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod shape gates for /api/pipelines (per-org editable stages, migration 155).
// These only check the request SHAPE; the real rules (unique slugs, won +
// lost required, label length, stage cap, deal moves) live in
// services/pipelines.validateStages / savePipeline so the chat tool and the
// route share one validator.

const { z } = require('zod');

const stageShape = z.object({
  id:          z.string().trim().max(40).optional(),
  label:       z.string().max(200),
  desc:        z.union([z.string().max(500), z.null()]).optional(),
  tone:        z.union([z.string().max(20), z.null()]).optional(),
  phase:       z.union([z.string().max(20), z.null()]).optional(),
  is_won:      z.boolean().optional(),
  is_lost:     z.boolean().optional(),
  probability: z.union([z.number(), z.string(), z.null()]).optional(),
}).passthrough();

const moveDealsTo = z.union([
  z.string().trim().min(1).max(40),
  z.record(z.string().trim().min(1).max(40)),
  z.null(),
  z.undefined(),
]).optional();

// Which pipeline (spec 201): a deal-type slug, or omitted for the default.
// The real slug rules (lowercase, reserved 'default') live in
// services/pipelines.normalizeDealType.
const dealType = z.union([z.string().trim().max(40), z.null(), z.undefined()]).optional();

const updateSchema = z.object({
  stages:      z.array(stageShape).max(60),
  moveDealsTo: moveDealsTo,
  name:        z.union([z.string().trim().max(255), z.null()]).optional(),
  deal_type:   dealType,
}).passthrough();

const resetSchema = z.object({
  moveDealsTo: moveDealsTo,
  deal_type:   dealType,
}).passthrough();

const deleteSchema = z.object({
  moveDealsTo: moveDealsTo,
  deal_type:   dealType,
  retype_to:   dealType,
}).passthrough();

module.exports = { updateSchema, resetSchema, deleteSchema };
