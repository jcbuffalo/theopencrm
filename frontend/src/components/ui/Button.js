// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Icon from './Icon';

// Standard CTA primitive. The codebase had ~200 button usages with at least
// 7 different style permutations of bg-blue-600 / bg-brand-blue / px-3 py-1.5
// vs px-4 py-2 vs py-3, with inconsistent disabled, hover, and focus rings.
// This component centralises the four legitimate variants so future call
// sites pick one of them instead of growing the drift further.
//
//   <Button icon="plus" onClick={...}>New company</Button>
//   <Button variant="secondary" size="sm" iconRight="chevron-down">More</Button>
//
// Variants:
//   primary    — the page's single "do the thing" CTA. Filled brand-blue.
//   secondary  — non-destructive alternates (Cancel, Back). Outline + tint hover.
//   ghost      — quiet inline action (toolbar buttons, table-row actions).
//   danger     — destructive (Delete, Halt). Filled red.
//
// Sizes:
//   sm  — dense toolbars / table-row actions. min-h 36px (comfortable phone tap target).
//   md  — default page CTA. min-h 40px.
//   lg  — primary CTA above the fold on the public surfaces. min-h 44px (Apple HIG).
//
// icon / iconRight — an Icon name (string) or any node, rendered at a size
// that matches the button size. `loading` swaps the leading slot for a spinner.
//
// Focus-visible: every variant exposes a 2px brand-blue ring at offset 2 via
// focus-visible:* (NOT focus:*) so keyboard users see the ring without it
// flashing on mouse click. The ring colour is fixed to the brand palette,
// not derived per-variant, so the visual language stays consistent.

const VARIANT_CLASSES = {
  primary:
    'bg-brand-blue hover:bg-brand-blue-dark text-white border border-transparent shadow-sm ' +
    'disabled:bg-brand-blue/60 disabled:cursor-not-allowed',
  secondary:
    'bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 hover:border-gray-400 shadow-sm ' +
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ghost:
    'bg-transparent hover:bg-gray-100 text-gray-700 border border-transparent ' +
    'disabled:opacity-50 disabled:cursor-not-allowed',
  danger:
    'bg-danger-600 hover:bg-danger-700 text-white border border-transparent shadow-sm ' +
    'disabled:bg-danger-300 disabled:cursor-not-allowed',
};

const SIZE_CLASSES = {
  sm: 'px-3 py-1.5 text-xs font-medium min-h-[36px] rounded-md',
  md: 'px-4 py-2 text-sm font-semibold min-h-[40px] rounded',
  lg: 'px-6 py-3 text-base font-semibold min-h-[44px] rounded',
};

const ICON_SIZE = { sm: 14, md: 16, lg: 18 };

const FOCUS_CLASSES =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2';

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 transition-colors select-none whitespace-nowrap';

function Slot({ icon, size }) {
  if (!icon) return null;
  return typeof icon === 'string' ? <Icon name={icon} size={ICON_SIZE[size] || 16} /> : icon;
}

export default function Button({
  as: Component = 'button',
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  fullWidth = false,
  loading = false,
  loadingLabel,
  icon,
  iconRight,
  disabled,
  children,
  ...rest
}) {
  const variantCls = VARIANT_CLASSES[variant] || VARIANT_CLASSES.primary;
  const sizeCls = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const widthCls = fullWidth ? 'w-full' : '';
  const props = Component === 'button' ? { type, disabled: disabled || loading } : {};

  return (
    <Component
      className={[BASE_CLASSES, FOCUS_CLASSES, variantCls, sizeCls, widthCls, className]
        .filter(Boolean)
        .join(' ')}
      aria-busy={loading || undefined}
      {...props}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
          aria-hidden="true"
        />
      ) : (
        <Slot icon={icon} size={size} />
      )}
      {loading ? (loadingLabel || children) : children}
      <Slot icon={iconRight} size={size} />
    </Component>
  );
}
