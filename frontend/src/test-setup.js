// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vitest global setup. Imported once per test file via vite.config.js → test.setupFiles.
//
// Pulls in @testing-library/jest-dom so every spec can assert with the
// `toBeInTheDocument`, `toHaveClass`, `toHaveAttribute`, etc. matchers
// without re-importing per file. Vitest also exposes `vi`, `describe`,
// `it`, `expect` as globals thanks to test.globals=true.

import '@testing-library/jest-dom/vitest';

// Provide a default no-op matchMedia stub (jsdom doesn't ship one). A few
// components probe `window.matchMedia` for prefers-reduced-motion etc.; the
// stub keeps render() from throwing when those are encountered.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
