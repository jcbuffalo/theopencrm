// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Calendar refresh-token encryption shim.
//
// Identical API to services/driveTokens.js / services/gmailTokens.js. This file
// exists as a forward seam: routes/services that want to talk about "the
// Calendar token store" can import calendarTokens, and a future refactor that
// introduces a per-integration master key can rename this file without touching
// any callers.
//
// WHY REUSE THE SAME MASTER KEY:
//   DRIVE_TOKEN_ENCRYPTION_KEY is already the master key for everything stored
//   in platform_integrations.secret_ciphertext (Drive/Gmail client_secrets
//   today; Calendar's later) AND for the Gmail refresh tokens. Giving Calendar
//   refresh tokens a SEPARATE key would triple the rotation surface without a
//   measurable blast-radius reduction — an attacker who can read any one key
//   has already cleared the "compromise the running process" bar. See
//   services/gmailTokens.js for the full rationale.
//
// If we ever want isolation between token pools, this file is the seam: swap the
// re-export for an independent implementation reading a CALENDAR_TOKEN_
// ENCRYPTION_KEY, write a migration to re-encrypt existing rows, and no consumer
// code needs to change.

module.exports = require('./driveTokens');
