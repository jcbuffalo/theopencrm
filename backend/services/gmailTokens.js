// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail refresh-token encryption shim.
//
// Identical API to services/driveTokens.js. This file exists as a forward
// seam: routes/services that want to talk about "the Gmail token store"
// can import gmailTokens, and a future refactor that introduces a
// per-integration master key can rename this file without touching any
// callers.
//
// WHY REUSE THE SAME MASTER KEY:
//   DRIVE_TOKEN_ENCRYPTION_KEY is already the master key for everything
//   stored in platform_integrations.secret_ciphertext (Drive client_secret
//   today; Gmail/Stripe/Teams/Zoom client_secrets later). If Gmail refresh
//   tokens used a SEPARATE key, we'd be doubling the rotation surface — a
//   key-rotation playbook would need to re-encrypt two pools of data with
//   tightly-coordinated cutovers, and the operator-facing config burden
//   would grow without buying us any meaningful blast-radius reduction
//   (an attacker who can read either key has already cleared the
//   "compromise the running process" bar).
//
// If we ever decide we DO want isolation between Drive and Gmail token
// pools (e.g. so a Gmail-scope-only deployment doesn't need the Drive
// key), this file is the seam: swap the re-export for an independent
// implementation that reads GMAIL_TOKEN_ENCRYPTION_KEY, write a migration
// to re-encrypt existing rows, and no consumer code needs to change.

module.exports = require('./driveTokens');
