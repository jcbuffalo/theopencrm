// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { auth as authApi, setCsrfToken } from './api';
import { setCurrentOrgPipeline, setCurrentOrgPipelines } from './stages';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // aiEnabled: tri-state. null = haven't probed yet (or signed out), true =
  // ANTHROPIC_API_KEY is set on the backend, false = it's not. Probed once
  // when the user signs in via GET /api/ai/status (cheap, cached check on
  // services/ai.js isConfigured()). Individual AI-using pages read this
  // instead of swallowing 503s on every render.
  const [aiEnabled, setAiEnabled] = useState(null);
  // aiBilling: the pay-as-you-go verdict from GET /ai/status ({ allowed,
  // status, code, action, message, trial_ends_at, can_manage, stripe_ready })
  // or null when unknown. Chat renders the "start your AI plan" card from
  // this BEFORE the user types, instead of surfacing a raw 402 afterwards.
  const [aiBilling, setAiBilling] = useState(null);

  // Session state lives entirely in the httpOnly auth cookie. On mount we
  // probe /auth/me — if it returns 200, the cookie is valid and we have a
  // session; if 401, we're signed out. No localStorage involved.
  const refreshUser = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      let u = r.data?.user;
      if (u) {
        // Per-org pipeline stages (migration 155). /auth/me carries the
        // effective pipeline as org_pipeline — and, since spec 201, EVERY
        // pipeline of the org as org_pipelines (keyed by deal_type, 'default'
        // = the main one). Against an older backend that omits the fields,
        // fall back to GET /api/pipelines, and to the profile default when
        // that fails too. Registered with stages.js BEFORE setUser so the
        // first render already uses the right stages.
        if (u.org_pipeline === undefined && u.org_id) {
          try {
            const p = await api.get('/pipelines');
            u = { ...u, org_pipeline: p.data || null };
          } catch {
            u = { ...u, org_pipeline: null };
          }
        }
        if (!u.org_pipelines && u.org_pipeline) u = { ...u, org_pipelines: { default: u.org_pipeline } };
        setCurrentOrgPipelines(u.org_pipelines || null);
        setUser(u);
        return u;
      }
      setCurrentOrgPipeline(null);
      setUser(null);
      return null;
    } catch (err) {
      // 401 is the only response that definitively means "no session" — only
      // then do we unset user. For transient failures (429 rate limit, 5xx,
      // network errors) we keep the prior user state in place: the cookie
      // probably still works; signing the user out on a backend hiccup is
      // worse than briefly trusting cached state. The next API call will
      // re-resolve. The api.js interceptor still bounces real 401s to /login.
      const status = err?.response?.status;
      if (status === 401) {
        setUser(null);
        return null;
      }
      // Transient: leave user as-is (could be null on first mount, which
      // routes to the spinner-or-public state, but won't kick an authed user
      // out mid-session).
      return null;
    }
  }, []);

  // Probe AI config status. Fires after a successful sign-in and silently
  // fails open (assume enabled) on any non-401 error — better to let the
  // user hit the inline 503-handler than to gate the UI on a hiccup.
  const refreshAiStatus = useCallback(async () => {
    try {
      const r = await api.get('/ai/status');
      setAiEnabled(!!r.data?.configured);
      setAiBilling(r.data?.billing || null);
    } catch {
      setAiBilling(null);
      // If the probe itself fails (e.g. backend down), default to "enabled"
      // so we don't hide AI features on a transient hiccup. The downstream
      // 503 handlers still catch the real missing-key case.
      setAiEnabled(true);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const u = await refreshUser();
      if (u) {
        await refreshAiStatus();
      } else {
        setAiEnabled(null);
      }
      setLoading(false);
    })();
  }, [refreshUser, refreshAiStatus]);

  const signIn = async () => {
    const u = await refreshUser();
    if (u) await refreshAiStatus();
  };

  // Re-fetch the org's effective pipeline (after an edit at /settings/pipeline
  // or a chat-applied propose_update_pipeline) without a full /auth/me round
  // trip. Updates both the stages.js registry and the user object so every
  // getStageConfig consumer re-renders with the new stages.
  const refreshPipeline = useCallback(async () => {
    try {
      const r = await api.get('/pipelines');
      const pipeline = r.data || null;
      // Spec 201: the GET response lists every pipeline of the org; fetch
      // the non-default ones too so the whole registry stays fresh (N is
      // tiny and this only runs after an edit).
      const map = { default: pipeline };
      const others = (pipeline?.pipelines || []).filter(p => p.deal_type !== 'default');
      for (const p of others) {
        try {
          const tr = await api.get('/pipelines', { params: { deal_type: p.deal_type } });
          if (tr.data) map[p.deal_type] = tr.data;
        } catch { /* keep the rest */ }
      }
      setCurrentOrgPipelines(map);
      setUser(prev => (prev ? { ...prev, org_pipeline: pipeline, org_pipelines: map } : prev));
      return pipeline;
    } catch {
      return null;
    }
  }, []);

  const signOut = async () => {
    try { await authApi.logout(); } catch { /* best-effort */ }
    setCsrfToken(null);
    setCurrentOrgPipeline(null);
    setUser(null);
    setAiEnabled(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn,
        signOut,
        refreshUser,
        refreshAiStatus,
        refreshPipeline,
        // The org's effective pipeline from /auth/me (services/pipelines.js
        // shape: { profile, is_custom, stages, phases, default_stage, ... }).
        // null when unknown — getStageConfig then renders the profile default.
        orgPipeline: user?.org_pipeline || null,
        // Every pipeline of the org keyed by deal_type (spec 201); the
        // 'default' entry mirrors orgPipeline. null against older backends.
        orgPipelines: user?.org_pipelines || null,
        aiEnabled,
        aiBilling,
        isAdmin: !!user?.is_admin,
        adminRole: user?.admin_role || null,
        orgProfile: user?.org_profile || 'generic',
        orgRole: user?.org_role || null,
        orgName: user?.org_name || null,
        orgBranding: user?.org_branding || {},
        orgTier: user?.org_tier || 'free',
        // Effective per-org feature-flag map from /auth/me (every known flag
        // resolved to a boolean). null when the backend predates the field —
        // consumers (Nav, CommandPalette) treat null as "everything on" so
        // nothing disappears against an older API.
        orgFeatures: user?.org_features || null,
        notificationPreferences: user?.notification_preferences || {},
        notificationEmail: user?.notification_email || null,
        notificationPhone: user?.notification_phone || null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
