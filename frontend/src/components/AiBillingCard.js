// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Button from './ui/Button';

// The self-serve front door for AI pay-as-you-go.
//
// Renders the right next step for a billing verdict from GET /api/ai/status
// (or a 402 body from any /api/ai call):
//   • start_billing  → "Start AI pay-as-you-go" → Stripe Checkout → back here
//   • update_payment → Stripe customer portal
//   • contact_admin  → explain the halt; owners get a link to Usage & billing
//   • variant="trial" → a slim countdown strip while a trial is running
//
// Non-admins never see a dead button: they're told who can flip it on.
// If Stripe isn't wired on this deployment, the card says so in plain
// English instead of throwing the STRIPE_NOT_CONFIGURED code at the user.

const SUPPORT_EMAIL = 'johncolesassistant@gmail.com';

function daysLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86400000));
}

function useStartPlan(returnTo) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/billing/ai/start', { return_to: returnTo });
      if (r.data?.url) {
        window.location.href = r.data.url;
        return;
      }
      throw new Error('No checkout URL returned');
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'STRIPE_NOT_CONFIGURED' || code === 'STRIPE_PRICE_AI_USAGE_MISSING') {
        setError(`Billing isn't switched on for this deployment yet. Email ${SUPPORT_EMAIL} and we'll activate AI for you by hand.`);
      } else if (code === 'ADMIN_REQUIRED') {
        setError('Only a workspace owner or admin can start the AI plan.');
      } else {
        setError(err.response?.data?.error || err.message || 'Could not start checkout. Try again in a moment.');
      }
      setBusy(false);
    }
  };
  return { start, busy, error };
}

function useOpenPortal() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/billing/portal');
      if (r.data?.url) {
        window.location.href = r.data.url;
        return;
      }
      throw new Error('No portal URL returned');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not open the billing portal.');
      setBusy(false);
    }
  };
  return { open, busy, error };
}

export default function AiBillingCard({ billing, variant = 'block', returnTo = 'chat', className = '' }) {
  const plan = useStartPlan(returnTo);
  const portal = useOpenPortal();
  if (!billing) return null;

  const canManage = billing.can_manage !== false; // undefined (from a raw 402) → assume yes, backend re-checks
  const stripeReady = billing.stripe_ready !== false;

  // ---- Trial strip -------------------------------------------------------
  if (variant === 'trial') {
    const n = daysLeft(billing.trial_ends_at);
    if (n === null) return null;
    return (
      <div className={`flex items-center justify-between gap-3 flex-wrap rounded-lg border border-brand-blue/20 bg-brand-blue/5 px-3 py-2 text-xs text-gray-700 ${className}`}>
        <span>
          <span className="font-semibold text-brand-blue">AI trial</span>
          {' · '}{n === 0 ? 'ends today' : `${n} day${n === 1 ? '' : 's'} left`}
          <span className="text-gray-500"> · after that it's pay-as-you-go, only for what you use</span>
        </span>
        {canManage && stripeReady && (
          <button
            type="button"
            onClick={plan.start}
            disabled={plan.busy}
            className="text-brand-blue font-medium hover:underline disabled:opacity-60"
          >
            {plan.busy ? 'Opening checkout…' : 'Set up billing now →'}
          </button>
        )}
        {plan.error && <span className="w-full text-red-700">{plan.error}</span>}
      </div>
    );
  }

  // ---- Blocking card -----------------------------------------------------
  const action = billing.action || 'start_billing';
  const expired = billing.code === 'AI_BILLING_TRIAL_EXPIRED';

  let title;
  let body;
  let cta = null;
  let error = '';

  if (action === 'start_billing') {
    title = expired ? 'Your AI trial has ended' : 'Turn on AI for your workspace';
    body = expired
      ? 'Keep the copilot going with pay-as-you-go: no seats, no minimums, billed only for what you use. Everything else in the CRM keeps working either way.'
      : 'The copilot runs on pay-as-you-go: no seats, no minimums, billed only for what you actually use. Everything else in the CRM works without it.';
    if (canManage) {
      cta = stripeReady ? (
        <Button variant="primary" size="md" onClick={plan.start} disabled={plan.busy} loading={plan.busy}>
          {plan.busy ? 'Opening checkout…' : 'Start AI pay-as-you-go'}
        </Button>
      ) : (
        <p className="text-sm text-gray-700">
          Billing isn't switched on for this deployment yet. Email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand-blue underline">{SUPPORT_EMAIL}</a>
          {' '}and we'll activate AI for you by hand.
        </p>
      );
    } else {
      body = 'AI is pay-as-you-go and hasn\'t been switched on for this workspace yet. Ask your workspace owner or admin to start it: it takes about a minute from their Chat page.';
    }
    error = plan.error;
  } else if (action === 'update_payment') {
    title = 'Your AI payment needs attention';
    body = billing.message || 'The last AI payment didn\'t go through. Update your payment method to keep the copilot running.';
    if (canManage) {
      cta = (
        <Button variant="primary" size="md" onClick={portal.open} disabled={portal.busy} loading={portal.busy}>
          {portal.busy ? 'Opening…' : 'Update payment method'}
        </Button>
      );
    } else {
      body += ' Ask your workspace owner or admin to update it.';
    }
    error = portal.error;
  } else {
    title = 'AI is paused for this workspace';
    body = billing.message || 'AI usage is paused.';
    if (canManage) {
      cta = (
        <Link to="/usage" className="text-sm font-medium text-brand-blue hover:underline">
          Manage in Usage &amp; billing →
        </Link>
      );
    }
  }

  return (
    <div
      role="region"
      aria-label="AI billing"
      className={`rounded-xl border border-brand-blue/20 bg-gradient-to-br from-white to-brand-blue/5 p-5 shadow-sm ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-blue/10 text-brand-blue" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-1 text-sm text-gray-600">{body}</p>
          {(cta || action === 'start_billing') && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {cta}
              {action === 'start_billing' && (
                <Link to="/usage" className="text-xs text-gray-500 hover:text-gray-700 underline">
                  See rates &amp; usage
                </Link>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
