// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Skeleton — pulsing placeholder bars for content whose shape is known
// (a table, a card body, a list). Keeps the layout from jumping when data
// lands, which reads calmer than a centred spinner.
//
//   <Skeleton lines={4} />
//   <Skeleton lines={1} className="h-8 w-40" />   (a single custom-sized bar)
//
// Decorative only: announce loading with role="status" on the container
// that swaps it out, not here.

export default function Skeleton({ lines = 3, className = '', barClassName = 'h-4' }) {
  return (
    <div className={`animate-pulse space-y-2.5 ${className}`} aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`rounded bg-gray-200 ${barClassName}`}
          style={{ width: lines > 1 && i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}
