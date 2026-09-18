// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Tone-based status pill. The codebase had three near-identical implementations:
//   • AdminAiBilling.js StatusBadge (active/comped/trial/past_due/halted/unconfigured)
//   • Activities.js + Tasks.js inline span with bg-blue-100 text-blue-800 etc.
//   • Pillar D friendly_status pills (success/warning/error)
//
// This component centralises the *visual* vocabulary — caller maps the
// domain status (e.g. "halted", "expired", "draft") to one of the tones and
// passes the human label. Keeps the colour palette in one place so a future
// theme tweak is one file, not seven.
//
//   <StatusBadge tone="success" label="Active" />
//   <StatusBadge tone="warning" label="Overdue" size="md" />
//
// Tones map to the semantic palette (tailwind.config.cjs) + WCAG-passing tints:
//   neutral  — gray (the default; for ambiguous / informational states)
//   info     — brand-blue (for in-progress / pending)
//   success  — emerald-800 on emerald-100
//   warning  — amber-800   on amber-100
//   error    — red-800     on red-100   (alias: danger)
//   accent   — purple (recurring / special — use sparingly)

const TONE_CLASSES = {
  neutral: 'bg-gray-100 text-gray-800 ring-gray-300/60',
  info: 'bg-info-100 text-info-800 ring-info-300/60',
  success: 'bg-success-100 text-success-800 ring-success-300/60',
  warning: 'bg-warning-100 text-warning-800 ring-warning-300/60',
  error: 'bg-danger-100 text-danger-800 ring-danger-300/60',
  accent: 'bg-purple-100 text-purple-800 ring-purple-300/60',
};
TONE_CLASSES.danger = TONE_CLASSES.error;

export default function StatusBadge({ tone = 'neutral', label, size = 'sm', className = '', children, ...rest }) {
  const toneCls = TONE_CLASSES[tone] || TONE_CLASSES.neutral;
  // Size scale matches Button so badge + button on the same row line up.
  const sizeCls = size === 'md'
    ? 'px-2.5 py-1 text-xs'
    : 'px-2 py-0.5 text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium rounded-full ring-1 ring-inset whitespace-nowrap ${toneCls} ${sizeCls} ${className}`}
      {...rest}
    >
      {label ?? children}
    </span>
  );
}
