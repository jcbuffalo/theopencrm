// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// React.lazy wrapper with chunk-load retry + one-shot hard reload.
//
// WHY: after a deploy, an open tab still references the OLD chunk filenames
// from its cached app shell (`index-OLDHASH.js` etc.) but the server now serves
// `index-NEWHASH.js`. The first lazy navigation throws an unrecoverable error:
//   - Vite wording:    "Failed to fetch dynamically imported module"
//   - webpack wording: "Loading chunk N failed"
//   - generic name:    "ChunkLoadError"
// Without this shim the user sees a blank screen and React surfaces the error
// up to the boundary (or nowhere). With it: we try once more (covers transient
// network blips that happen to look like chunk errors), and if that also
// fails, we force a single full reload so the browser re-fetches index.html
// and picks up the new chunk hashes. The reload is gated by sessionStorage so
// we never reload-loop a user whose connection is genuinely broken.

import { lazy } from 'react';

const RELOAD_KEY = 'lazyWithRetry.reloaded';

function isChunkLoadError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  const msg = String(err.message || err);
  return /Loading chunk [\w-]+ failed/i.test(msg)
    || /Failed to fetch dynamically imported module/i.test(msg)
    || /Importing a module script failed/i.test(msg); // Safari wording
}

export default function lazyWithRetry(factory) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;
      // One transparent retry — covers transient network blips that look the same.
      try {
        return await factory();
      } catch (err2) {
        if (!isChunkLoadError(err2)) throw err2;
        // Still failing → this is almost certainly a stale-shell-after-deploy
        // situation. Force ONE reload to fetch the fresh index.html + chunk
        // manifest. Guarded by sessionStorage so we never reload-loop.
        if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
          if (!sessionStorage.getItem(RELOAD_KEY)) {
            sessionStorage.setItem(RELOAD_KEY, '1');
            window.location.reload();
            // Return a never-resolving promise so Suspense keeps showing the
            // fallback while the page tears down for reload — avoids a flash
            // of error UI between the reload call and the actual navigation.
            return new Promise(() => {});
          }
        }
        // Already reloaded once and still failing → rethrow so an ErrorBoundary
        // (or React's default) can surface something to the user.
        throw err2;
      }
    }
  });
}
