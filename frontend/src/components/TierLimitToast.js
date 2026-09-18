// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Non-blocking upgrade nudge shown when a write hits a plan cap (402
// TIER_LIMIT_EXCEEDED). Renders through the shared Toast primitive so it
// looks like every other floating notice.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Toast } from './ui';

export default function TierLimitToast({ info, onDismiss }) {
  const navigate = useNavigate();
  if (!info) return null;

  const metric = info.details?.metric;
  const title = metric === 'seats' ? 'Seat limit reached' : 'Plan limit reached';

  return (
    <Toast
      tone="info"
      icon="trending-up"
      title={title}
      onDismiss={onDismiss}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onDismiss}>Dismiss</Button>
          <Button size="sm" onClick={() => { onDismiss(); navigate('/settings#billing'); }}>
            See upgrade options
          </Button>
        </>
      }
    >
      {info.error || 'You have reached a limit of your current plan. Upgrade to keep going.'}
    </Toast>
  );
}
