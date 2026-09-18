// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useId } from 'react';
import Field, { controlClasses, describedBy } from './Field';
import Icon from './Icon';

// Input — text-like <input> with optional label / hint / error and a leading
// icon. Every native prop passes through (type, value, onChange, placeholder,
// autoFocus, required, …).
//
//   <Input label="Email" type="email" value={v} onChange={...} error={err} />
//   <Input leadingIcon="search" placeholder="Search companies…" aria-label="Search" />
//
// Sizes: md (default, 38px) · sm (32px, toolbars).

export default function Input({
  id: idProp,
  label,
  hint,
  error,
  required,
  size = 'md',
  leadingIcon,
  className = '',
  wrapperClassName = '',
  ...rest
}) {
  const autoId = useId();
  const id = idProp || `input-${autoId}`;
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <div className="relative">
        {leadingIcon && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
            <Icon name={leadingIcon} size={iconSize} />
          </span>
        )}
        <input
          id={id}
          required={required}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          className={controlClasses({
            size,
            error: !!error,
            className: `${leadingIcon ? (size === 'sm' ? 'pl-8' : 'pl-9') : ''} ${className}`,
          })}
          {...rest}
        />
      </div>
    </Field>
  );
}
