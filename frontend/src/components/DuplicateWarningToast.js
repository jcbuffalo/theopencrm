// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Soft "possible duplicate" notice raised after a 201 that carries
// warning.possibleDuplicates. The record IS saved; this just offers the
// review-and-merge path. Renders through the shared Toast primitive.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Toast } from './ui';

export default function DuplicateWarningToast({ warning, entityType, onDismiss }) {
  const navigate = useNavigate();
  const dups = warning?.possibleDuplicates;
  if (!dups || dups.length === 0) return null;

  return (
    <Toast
      tone="warning"
      title="Possible duplicate"
      onDismiss={onDismiss}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onDismiss}>Dismiss</Button>
          <Button size="sm" onClick={() => { onDismiss(); navigate(`/duplicates?type=${entityType}`); }}>
            Review &amp; merge
          </Button>
        </>
      }
    >
      <p>
        Saved — but {dups.length === 1
          ? 'it looks similar to an existing record'
          : `${dups.length} existing records look similar`}:
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs text-gray-800">
        {dups.slice(0, 3).map((d) => (
          <li key={d.id} className="truncate">
            {d.name}{d.email ? ` — ${d.email}` : d.website ? ` — ${d.website}` : ''}
          </li>
        ))}
        {dups.length > 3 && (
          <li className="text-gray-400">…and {dups.length - 3} more</li>
        )}
      </ul>
    </Toast>
  );
}
