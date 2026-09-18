// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useId } from 'react';
import Field, { controlClasses, describedBy } from './Field';
import Icon from './Icon';

// Select — native <select> with the same frame as Input and a consistent
// chevron (the browser's default arrow differs per OS).
//
//   <Select label="Status" value={v} onChange={...} options={[{ value: 'open', label: 'Open' }]} />
//   <Select aria-label="Filter by type" size="sm"><option value="">Any type</option>…</Select>
//
// `options` is a convenience — an array of { value, label } or plain strings.
// Children win when both are given.

export default function Select({
  id: idProp,
  label,
  hint,
  error,
  required,
  size = 'md',
  options,
  className = '',
  wrapperClassName = '',
  children,
  ...rest
}) {
  const autoId = useId();
  const id = idProp || `select-${autoId}`;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <div className="relative">
        <select
          id={id}
          required={required}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          className={controlClasses({
            size,
            error: !!error,
            className: `appearance-none pr-8 cursor-pointer ${className}`,
          })}
          {...rest}
        >
          {children || (options || []).map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return <option key={String(opt.value)} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-gray-400">
          <Icon name="chevron-down" size={size === 'sm' ? 14 : 16} />
        </span>
      </div>
    </Field>
  );
}
