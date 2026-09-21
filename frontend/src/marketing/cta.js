// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// "Build my CRM" intent — the marketing pages' primary CTA (spec 203, Phase 3).
//
// The promise on every comparison / vertical page is "describe how you sell
// and the CRM builds itself". That experience lives at /setup, so a visitor
// who clicks the CTA must land THERE after signup, not on the empty Chat
// home. Two carriers, because the signup path hops tabs:
//
//   1. POST_LOGIN_REDIRECT_KEY in sessionStorage — the existing contract that
//      pages/Login.js consumePendingRedirect() already honours. Covers the
//      same-tab path (open signup with no verification, or the user comes
//      back to the original tab to sign in).
//   2. SETUP_INTENT_KEY in localStorage — survives the verification-email hop
//      (the link opens a NEW tab, where sessionStorage is empty). Login.js
//      falls back to it, only ever for the /setup destination, and clears it.
//
// Both are best-effort: storage can throw in private mode, and the CTA must
// still navigate.

import { POST_LOGIN_REDIRECT_KEY } from '../api';

export const SETUP_PATH = '/setup';
export const SETUP_INTENT_KEY = 'ocrm_setup_intent';
export const SIGNUP_PATH = '/request-access';

export const GITHUB_URL = process.env.REACT_APP_GITHUB_URL || 'https://github.com/jcbuffalo/theopencrm';

// Only two shapes are ever honoured on the way back out: the bare /setup, or
// /setup pre-loaded with a platform template (`wt:<id>`, the same query the
// /templates gallery uses). Anything else in storage is ignored — the value
// is browser-writable, so it must never become an open redirect.
const SETUP_INTENT_RE = /^\/setup(\?template=wt:\d+)?$/;

export function setupPathForTemplate(templateId) {
  const id = Number(templateId);
  return Number.isInteger(id) && id > 0 ? `${SETUP_PATH}?template=wt:${id}` : SETUP_PATH;
}

// `templateId` (optional): a platform workspace template the visitor picked
// on a /crm-for page — /setup opens with that template's plan already
// drafted (no AI call) instead of the blank describe-your-business box.
export function rememberSetupIntent({ templateId } = {}) {
  const target = setupPathForTemplate(templateId);
  try {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, target);
  } catch {
    /* best-effort */
  }
  try {
    localStorage.setItem(SETUP_INTENT_KEY, target);
  } catch {
    /* best-effort */
  }
}

// Read-and-clear. Returns the /setup path (possibly with a template) when a
// marketing CTA set the intent in this browser, else null. Login.js calls
// this AFTER the sessionStorage carriers, so a mid-session "come back here"
// target still wins. The legacy '1' marker (pre-template) still means /setup.
export function consumeSetupIntent() {
  try {
    const raw = localStorage.getItem(SETUP_INTENT_KEY);
    if (raw) {
      localStorage.removeItem(SETUP_INTENT_KEY);
      if (raw === '1') return SETUP_PATH;
      if (SETUP_INTENT_RE.test(raw)) return raw;
    }
  } catch {
    /* best-effort */
  }
  return null;
}
