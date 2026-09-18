// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Container — the page body wrapper (renders <main> by default so every
// page gets a landmark). One width scale instead of 20 ad-hoc <main>s:
//
//   default — max-w-6xl  (forms, settings, most CRUD pages)
//   wide    — max-w-7xl  (dense list/table pages, dashboards)
//   narrow  — max-w-3xl  (single-column reading / account pages)
//   full    — no max width (boards that scroll horizontally)
//
//   <Container size="wide"><PageHeader … />…</Container>

const SIZES = { default: 'max-w-6xl', wide: 'max-w-7xl', narrow: 'max-w-3xl', full: 'max-w-none' };

export default function Container({ size = 'default', as: Tag = 'main', className = '', children, ...rest }) {
  return (
    <Tag className={`mx-auto w-full px-4 py-6 sm:px-6 ${SIZES[size] || SIZES.default} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
