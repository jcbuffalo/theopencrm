// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import useDialog from './useDialog';
import Icon from './Icon';

// Modal — centred dialog. Replaces the 34 ad-hoc `fixed inset-0` overlays.
//
//   <Modal open={open} onClose={close} title="New task" size="md"
//          footer={<><Button variant="secondary" onClick={close}>Cancel</Button>
//                   <Button type="submit" form="task-form">Create</Button></>}>
//     <form id="task-form" onSubmit={...}>…</form>
//   </Modal>
//
// Behaviour (via useDialog): Escape closes, backdrop click closes (unless
// closeOnBackdrop={false}), Tab is trapped, body scroll locks, focus returns
// to the opener. Renders into document.body through a portal so it can't be
// clipped by an ancestor's overflow/transform.
//
// Sizes: sm (max-w-sm) · md (max-w-lg, default) · lg (max-w-2xl) · xl (max-w-4xl).

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export default function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  initialFocusRef,
  closeOnBackdrop = true,
  className = '',
  bodyClassName = '',
}) {
  const panelRef = useDialog({ open, onClose, initialFocusRef });
  const titleId = useId();
  if (!open) return null;

  const node = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4 sm:p-6"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
      data-testid="modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Dialog'}
        tabIndex={-1}
        className={`flex w-full ${SIZES[size] || SIZES.md} max-h-[90vh] flex-col rounded-lg bg-white shadow-overlay outline-none ${className}`}
      >
        {(title || onClose) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-lg font-semibold text-gray-900 leading-6">{title}</h2>}
              {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 -mt-1 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <Icon name="x" size={18} />
              </button>
            )}
          </div>
        )}
        <div className={`flex-1 overflow-y-auto px-6 py-5 ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-gray-100 bg-gray-50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
