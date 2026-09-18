// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Spinner — the one loading indicator (replaces 53 spinners in 6 variants).
//
//   <Spinner />                          inline, 24px
//   <Spinner size="lg" label="Loading companies…" />   centred block with caption
//
// Sizes: sm (16px) · md (24px, default) · lg (40px). Prefer <Skeleton> for
// tables and cards where the shape of the content is known.

const SIZES = { sm: 'h-4 w-4 border-2', md: 'h-6 w-6 border-2', lg: 'h-10 w-10 border-[3px]' };

export default function Spinner({ size = 'md', label, className = '' }) {
  const ring = (
    <span
      className={`inline-block animate-spin rounded-full border-gray-200 border-t-brand-blue ${SIZES[size] || SIZES.md}`}
      aria-hidden="true"
    />
  );
  if (!label) {
    return <span role="status" aria-label="Loading" className={className}>{ring}</span>;
  }
  return (
    <div role="status" className={`flex flex-col items-center justify-center gap-3 py-12 text-center ${className}`}>
      {ring}
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}
