// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// HaveIBeenPwned password-breach lookup (k-anonymity API).
//
// We never send a plaintext password — or even a full hash — to the HIBP
// service. The k-anonymity protocol works like this:
//
//   1. SHA-1 the plaintext locally.
//   2. Send only the first 5 hex chars of that hash to
//      GET https://api.pwnedpasswords.com/range/{prefix}
//   3. The response is a list of "SUFFIX:COUNT" lines covering every breached
//      hash that shares the 5-char prefix (typically ~500 lines).
//   4. We look for the rest of our hash in that list and return the count.
//
// Privacy: the HIBP operator only ever learns the 5-char prefix, which is
// shared by ~tens of thousands of distinct passwords — they cannot determine
// the user's actual password from that. No API key is required for the public
// k-anonymity endpoint.
//
// Failure mode: if HIBP is slow, unreachable, returns garbage, or anything
// else goes wrong, we return 0 (== "not known to be breached") and let
// sign-in proceed. Blocking auth on a third-party breach lookup outage
// would be a bigger availability problem than the marginal security gain.
//
// Gating: set HIBP_ENABLED=true in the runtime environment to turn this on.
// Without it, the function short-circuits to 0 — keeps offline/sandbox
// and unit tests deterministic and HTTP-free.

const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 3000;

/**
 * Look up a plaintext password in the HIBP breach corpus.
 *
 * @param {string} plaintext - the raw password to check.
 * @returns {Promise<number>} - how many times the password appears in the
 *   breach corpus. 0 means "not seen in any known breach" (or HIBP was
 *   unreachable / disabled — see notes above).
 */
async function checkPasswordPwned(plaintext) {
  if (process.env.HIBP_ENABLED !== 'true') {
    return 0;
  }
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return 0;
  }

  try {
    const sha1 = crypto.createHash('sha1').update(plaintext, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await axios.get(`${HIBP_RANGE_URL}${prefix}`, {
      timeout: HIBP_TIMEOUT_MS,
      // The Add-Padding header tells HIBP to pad the response with bogus
      // entries so a network observer can't infer the hit/miss state from
      // the response size. Cheap defense-in-depth.
      headers: { 'Add-Padding': 'true', 'User-Agent': 'theopencrm-hibp-check' },
      responseType: 'text',
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const body = typeof res.data === 'string' ? res.data : String(res.data || '');
    // Each line looks like "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:42" — split by
    // any newline variant, then look for our suffix (case-insensitive).
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const lineSuffix = line.slice(0, idx).trim();
      if (lineSuffix.toUpperCase() === suffix) {
        const count = parseInt(line.slice(idx + 1).trim(), 10);
        return Number.isFinite(count) && count > 0 ? count : 0;
      }
    }
    return 0;
  } catch (err) {
    // Don't propagate — log and treat as "not pwned" so a HIBP outage can't
    // wedge sign-in / password change. See header comment.
    if (logger && typeof logger.warn === 'function') {
      logger.warn('hibp_check_failed', { error: err.message });
    }
    return 0;
  }
}

module.exports = { checkPasswordPwned };
