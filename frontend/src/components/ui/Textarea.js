// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useId } from 'react';
import Field, { controlClasses, describedBy } from './Field';

// Textarea — multi-line control with the Input frame. Defaults to 3 rows and
// vertical-only resize so it can't break a form's column width.
//
//   <Textarea label="Notes" rows={4} value={v} onChange={...} />

export default function Textarea({
  id: idProp,
  label,
  hint,
  error,
  required,
  rows = 3,
  className = '',
  wrapperClassName = '',
  ...rest
}) {
  const autoId = useId();
  const id = idProp || `textarea-${autoId}`;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <textarea
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy(id, { hint, error })}
        className={controlClasses({ error: !!error, className: `resize-y leading-relaxed ${className}` })}
        {...rest}
      />
    </Field>
  );
}
