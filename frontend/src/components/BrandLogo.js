// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// "The Open CRM" lockup — interlocking C mark + wordmark.
// Use the `compact` prop in tight contexts (favicon-sized standalone mark).

export default function BrandLogo({ size = 28, showWordmark = true, className = '' }) {
  const stroke = Math.max(4, Math.round(size * 0.22));
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="ocBlueG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor="#2076CD" />
            <stop offset="100%" stopColor="#1B5FAD" />
          </linearGradient>
          <linearGradient id="ocMintG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor="#80CE99" />
            <stop offset="100%" stopColor="#5DB97D" />
          </linearGradient>
        </defs>
        <path d="M 38 14 A 18 18 0 1 0 38 50" stroke="url(#ocBlueG)" strokeWidth={stroke} strokeLinecap="round" fill="none" />
        <path d="M 26 14 A 18 18 0 1 1 26 50" stroke="url(#ocMintG)" strokeWidth={stroke} strokeLinecap="round" fill="none" />
      </svg>
      {showWordmark && (
        <span className="font-bold tracking-tight text-gray-900" style={{ fontSize: Math.round(size * 0.6) }}>
          THE OPEN <span className="text-brand-blue">CRM</span>
        </span>
      )}
    </span>
  );
}
