// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Microsoft Graph refresh-token encryption shim.
//
// Identical API to services/driveTokens.js — the same seam pattern as
// services/gmailTokens.js and services/calendarTokens.js. Routes/services
// that want to talk about "the Microsoft token store" import msgraphTokens,
// and a future refactor that introduces a per-integration master key can
// rename this file without touching any callers.
//
// WHY REUSE THE SAME MASTER KEY:
//   DRIVE_TOKEN_ENCRYPTION_KEY is already the master key for everything
//   stored in platform_integrations.secret_ciphertext AND for the Drive /
//   Gmail / Calendar refresh-token pools. A separate Microsoft key would
//   double the rotation surface without a meaningful blast-radius
//   reduction (an attacker who can read either key has already cleared
//   the "compromise the running process" bar). See gmailTokens.js for the
//   long-form rationale.
//
// EXTRA MICROSOFT-SPECIFIC NOTE: unlike Google, Microsoft refresh tokens
// ROTATE on use — every refresh may return a replacement refresh token
// that must be re-encrypted and persisted (see msgraphClient.getAccessToken).
// The encryption seam is unchanged by that; it just gets called more often.

module.exports = require('./driveTokens');
