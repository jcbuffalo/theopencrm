// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — PROCUREMENT entries. See ./index.js for the authoring
// contract.

module.exports = [
  // --------------------------------------------------------------------------
  // EXISTING ENTRY — do not modify (moved verbatim from pluginLibrary.js).
  // --------------------------------------------------------------------------
  {
    slug: 'vendor-price-validation-30d',
    name: '30-day vendor price validation',
    category: 'procurement',
    icon: '⏰',
    summary:
      'For deals in VENDOR_QUOTING longer than 30 days, create a task to re-confirm the vendor\'s pricing before sending to the customer. Catches stale quotes.',
    tags: ['procurement', 'staleness'],
    spec: {
      name: 'vendor-price-validation-30d',
      summary: 'After 30 days in VENDOR_QUOTING, create a task to re-validate the vendor\'s pricing.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { check_stage: 'VENDOR_QUOTING', stale_days: 30 },
      actions: [
        {
          kind: 'create_task',
          title_template: 'Re-validate vendor pricing for {deal.title}',
          due_in_days: 3,
        },
      ],
    },
  },
];
