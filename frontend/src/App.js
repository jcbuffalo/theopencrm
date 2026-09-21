// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getStageConfig } from './stages';
import TermsModal from './components/TermsModal';
import CookieBanner from './components/CookieBanner';
import TwoFactorNudge from './components/TwoFactorNudge';
import DemoBanner from './components/DemoBanner';
import CommandPalette from './components/CommandPalette';
import ErrorBoundary from './components/ErrorBoundary';
import PageviewBeacon from './components/PageviewBeacon';
import lazyWithRetry from './lazyWithRetry';

// Eager imports — first-paint critical routes that should NOT pay a chunk-fetch
// cost on the very first render. Login/Landing for logged-out, Chat for
// logged-in (`/` Chat-First front door), NotFound for the `*` wildcard.
import Login from './pages/Login';
import Landing from './pages/Landing';
import Chat from './pages/Chat';
import NotFound from './pages/NotFound';

// Lazy imports — every other route splits into its own chunk. The recharts-
// heavy Reports + Usage pages alone are ~100 KB gzipped that no longer ship on
// first paint. Wrapped in `lazyWithRetry` so a stale-shell-after-deploy
// triggers exactly one reload (see lazyWithRetry.js).
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const Companies = lazyWithRetry(() => import('./pages/Companies'));
const Contacts = lazyWithRetry(() => import('./pages/Contacts'));
const Duplicates = lazyWithRetry(() => import('./pages/Duplicates'));
const Deals = lazyWithRetry(() => import('./pages/Deals'));
const Leads = lazyWithRetry(() => import('./pages/Leads'));
const LeadForm = lazyWithRetry(() => import('./pages/LeadForm')); // public /f/:token capture page
const Surveys = lazyWithRetry(() => import('./pages/Surveys'));
const SurveyResponse = lazyWithRetry(() => import('./pages/SurveyResponse')); // public /s/:token response page
const CustomerPortal = lazyWithRetry(() => import('./pages/CustomerPortal')); // public /portal/:token read-only account view
const Activities = lazyWithRetry(() => import('./pages/Activities'));
const Tasks = lazyWithRetry(() => import('./pages/Tasks'));
const Admin = lazyWithRetry(() => import('./pages/Admin'));
const Checklist = lazyWithRetry(() => import('./pages/Checklist'));
const ImportWizard = lazyWithRetry(() => import('./pages/ImportWizard'));
const Team = lazyWithRetry(() => import('./pages/Team'));
const AcceptInvite = lazyWithRetry(() => import('./pages/AcceptInvite'));
const Quotes = lazyWithRetry(() => import('./pages/Quotes'));
const Products = lazyWithRetry(() => import('./pages/Products'));
const QuoteBuilder = lazyWithRetry(() => import('./pages/QuoteBuilder'));
const Issues = lazyWithRetry(() => import('./pages/Issues'));
const TechHandoff = lazyWithRetry(() => import('./pages/TechHandoff'));
const Privacy = lazyWithRetry(() => import('./pages/Privacy'));
const Terms = lazyWithRetry(() => import('./pages/Terms'));
const DataDeletion = lazyWithRetry(() => import('./pages/DataDeletion'));
const RequestAccess = lazyWithRetry(() => import('./pages/RequestAccess'));
const ForgotPassword = lazyWithRetry(() => import('./pages/ForgotPassword')); // public forgot-password (email → reset link)
const ResetPassword = lazyWithRetry(() => import('./pages/ResetPassword')); // public reset landing page (?token= from the email)
const PendingApproval = lazyWithRetry(() => import('./pages/PendingApproval'));
const AdminAccessRequests = lazyWithRetry(() => import('./pages/AdminAccessRequests'));
const AdminIntegrations = lazyWithRetry(() => import('./pages/AdminIntegrations'));
const SecuritySettings = lazyWithRetry(() => import('./pages/SecuritySettings'));
const Reports = lazyWithRetry(() => import('./pages/Reports'));
const ReportBuilder = lazyWithRetry(() => import('./pages/ReportBuilder'));
const Forecast = lazyWithRetry(() => import('./pages/Forecast'));
const ServiceContracts = lazyWithRetry(() => import('./pages/ServiceContracts'));
const Accounts = lazyWithRetry(() => import('./pages/Accounts'));
const AccountDetail = lazyWithRetry(() => import('./pages/AccountDetail'));
const Renewals = lazyWithRetry(() => import('./pages/Renewals'));
const Retention = lazyWithRetry(() => import('./pages/Retention'));
const LifecycleFunnel = lazyWithRetry(() => import('./pages/LifecycleFunnel'));
const Playbooks = lazyWithRetry(() => import('./pages/Playbooks'));
const Winback = lazyWithRetry(() => import('./pages/Winback'));
const Cases = lazyWithRetry(() => import('./pages/Cases'));
const MyDay = lazyWithRetry(() => import('./pages/MyDay'));
const Calendar = lazyWithRetry(() => import('./pages/Calendar'));
const Notifications = lazyWithRetry(() => import('./pages/Notifications'));
const Segments = lazyWithRetry(() => import('./pages/Segments'));
const PitchZang = lazyWithRetry(() => import('./pages/PitchZang'));
const PitchGeneric = lazyWithRetry(() => import('./pages/PitchGeneric'));
const LaunchPost = lazyWithRetry(() => import('./pages/LaunchPost')); // public open-source launch announcement
// Public marketing surfaces (spec 203, Phase 3): comparison pages, per-vertical
// pages, and the verify-email landing target. Routes are enumerated from the
// data files so a new comparison/vertical is one data entry + a PUBLIC_META row.
const Compare = lazyWithRetry(() => import('./pages/Compare'));
const Vertical = lazyWithRetry(() => import('./pages/Vertical'));
const VerifyEmail = lazyWithRetry(() => import('./pages/VerifyEmail'));
const EmailAction = lazyWithRetry(() => import('./pages/EmailAction'));
const PitchReadiness = lazyWithRetry(() => import('./pages/PitchReadiness'));
const Appreciation = lazyWithRetry(() => import('./pages/Appreciation'));
const AdminFeatureFlags = lazyWithRetry(() => import('./pages/AdminFeatureFlags'));
const AdminAutomation = lazyWithRetry(() => import('./pages/AdminAutomation'));
const AdminActivity = lazyWithRetry(() => import('./pages/AdminActivity'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const DeveloperSettings = lazyWithRetry(() => import('./pages/DeveloperSettings'));
const PipelineSettings = lazyWithRetry(() => import('./pages/PipelineSettings'));
const Setup = lazyWithRetry(() => import('./pages/Setup'));
const Templates = lazyWithRetry(() => import('./pages/Templates'));
const LegalDoc = lazyWithRetry(() => import('./pages/LegalDoc'));
const Usage = lazyWithRetry(() => import('./pages/Usage'));
const Plugins = lazyWithRetry(() => import('./pages/Plugins'));
const PluginNew = lazyWithRetry(() => import('./pages/PluginNew'));
const PluginLibrary = lazyWithRetry(() => import('./pages/PluginLibrary'));
const PluginDetail = lazyWithRetry(() => import('./pages/PluginDetail'));
const PluginRuns = lazyWithRetry(() => import('./pages/PluginRuns'));
const AdminBranding = lazyWithRetry(() => import('./pages/AdminBranding'));
const AdminAiModel = lazyWithRetry(() => import('./pages/AdminAiModel'));
const AdminSso = lazyWithRetry(() => import('./pages/AdminSso'));
const AdminPlatformIntegrations = lazyWithRetry(() => import('./pages/AdminPlatformIntegrations'));
const AdminProvisionOrg = lazyWithRetry(() => import('./pages/AdminProvisionOrg'));
const AdminAiBilling = lazyWithRetry(() => import('./pages/AdminAiBilling'));
const AdminTraffic = lazyWithRetry(() => import('./pages/AdminTraffic'));
const SsoHandoff = lazyWithRetry(() => import('./pages/SsoHandoff'));
const EmailTemplates = lazyWithRetry(() => import('./pages/EmailTemplates'));
const Sequences = lazyWithRetry(() => import('./pages/Sequences'));
const CustomFieldsAdmin = lazyWithRetry(() => import('./pages/CustomFieldsAdmin'));

// Suspense fallback shown while a lazy route's chunk is loading. Reuses the
// exact same spinner markup as the auth-loading state below so the transition
// between "checking session" and "loading a lazy route" is visually seamless
// — no jarring layout flash, no different colors. Tailwind classes resolve via
// the brand primary palette (#2076CD family).
function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
      </div>
    </div>
  );
}

function App() {
  const { user, loading } = useAuth();
  const isAuthenticated = !!user;
  // CS post-sale surfaces (Accounts 360 + Renewals) only mount for profiles
  // that run the account-management motion (zang/rin). See stages.js.
  const showAccountManagement = getStageConfig(user?.org_profile).showAccountManagement;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <Router>
      {/* Global crash guard: a render error anywhere below shows a friendly
          reload card and reports the crash to /api/client-errors (→ GCP Error
          Reporting). Inside <Router> so the fallback's links still work. */}
      <ErrorBoundary>
      {/* First-party pageview beacon — renders nothing; fires one normalized
          fire-and-forget POST /api/metrics/pageview per route change. */}
      <PageviewBeacon />
      {/* Terms bar owns its own visibility: localStorage fast-path, server
          (GET/POST /api/me/accept-terms) as the source of truth. Renders
          nothing once accepted. */}
      {isAuthenticated && <TermsModal />}
      {isAuthenticated && <DemoBanner />}
      {isAuthenticated && <TwoFactorNudge />}
      <CookieBanner />
      {/* Global cmd/ctrl+K palette. Renders nothing until the user opens it
          and bails out when there's no authenticated user — Differentiation
          Bet #3 (see COMPETITIVE_REVIEW.md). Kept OUTSIDE the Suspense
          boundary so the palette is available even while a lazy route loads. */}
      <CommandPalette />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Always available — public legal pages required for OAuth verification */}
          <Route path="/checklist" element={<Checklist />} />
          <Route path="/accept-invite/:token" element={<AcceptInvite />} />
          {/* Public lead-capture form — anonymous visitors land here from a
              shared link or an embed; must work with no session. */}
          <Route path="/f/:token" element={<LeadForm />} />
          {/* Public survey-response page — anonymous respondents land here from
              a shared or emailed link; must work with no session. */}
          <Route path="/s/:token" element={<SurveyResponse />} />
          {/* Public customer portal — an external contact lands here from a
              link their vendor shared; must work with no session. */}
          <Route path="/portal/:token" element={<CustomerPortal />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/data-deletion" element={<DataDeletion />} />
          <Route path="/request-access" element={<RequestAccess />} />
          {/* Public password-reset flow — must work with no session by
              definition (the visitor forgot their password). */}
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/pending" element={<PendingApproval />} />
          <Route path="/pitch" element={<PitchGeneric />} />
          <Route path="/launch" element={<LaunchPost />} />
          {/* Marketing surfaces (spec 203, Phase 3). Comparison slugs are
              explicit for SEO; data lives in marketing/comparisons.js and the
              slug prop must match an entry there. Vertical pages resolve
              :slug against marketing/verticals.js (one per builder template).
              Each route also needs a server.js PUBLIC_META row + sitemap entry. */}
          <Route path="/hubspot-alternative" element={<Compare slug="hubspot" />} />
          <Route path="/salesforce-alternative" element={<Compare slug="salesforce" />} />
          <Route path="/pipedrive-alternative" element={<Compare slug="pipedrive" />} />
          <Route path="/zoho-alternative" element={<Compare slug="zoho" />} />
          <Route path="/spreadsheet-crm" element={<Compare slug="spreadsheet" />} />
          <Route path="/custom-crm-alternative" element={<Compare slug="custom" />} />
          <Route path="/crm-for/:slug" element={<Vertical />} />
          {/* Landing target of the emailed verification link
              (services/emailVerification.js) — must work with no session. */}
          <Route path="/verify-email" element={<VerifyEmail />} />
          {/* Landing for the one-click buttons in notification / digest emails
              (spec 204). Session-less: the single-use token is the credential. */}
          <Route path="/act/:token" element={<EmailAction />} />
          {/* Generic legal-doc renderer — serves any /legal/:doc against /api/legal/:doc */}
          <Route path="/legal/:doc" element={<LegalDoc />} />
          <Route path="/sso/handoff" element={<SsoHandoff />} />

          {isAuthenticated ? (
            <>
              {/* Chat-First front door — authenticated logo links land here.
                  The old Dashboard is still reachable at /dashboard. */}
              <Route path="/" element={<Chat />} />
              <Route path="/chat" element={<Chat />} />
              {/* My Day — the personal work-queue. Available to every profile;
                  CS-dependent sections just render empty for orgs without the
                  customer-success module. Chat stays the front door at `/`. */}
              <Route path="/today" element={<MyDay />} />
              {/* Calendar — in-app meetings + merged agenda (meetings, due
                  tasks, webhook meeting logs). Core internal scheduling for
                  every profile — no external OAuth, unrelated to the gated
                  Google-Calendar sync. */}
              <Route path="/calendar" element={<Calendar />} />
              {/* Notification Center — the nav bell's "See all" target. Core
                  surface, available to every authenticated profile. */}
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/dashboard" element={<Dashboard />} />
              {/* Customer-specific pitch (references the Zang SOW). Auth-gated —
                  must not sit on a public route where the contract terms leak. */}
              <Route path="/pitch/zang" element={<PitchZang />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/contacts" element={<Contacts />} />
              {/* Contact record deep link — Contacts reads :id and opens the
                  ContactPanel drawer over the list (mirrors /deals?dealId=). */}
              <Route path="/contacts/:id" element={<Contacts />} />
              <Route path="/duplicates" element={<Duplicates />} />
              <Route path="/deals" element={<Deals />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/activities" element={<Activities />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/admin/*" element={<Admin />} />
              <Route path="/import" element={<ImportWizard />} />
              {/* Workspace builder (spec 203) — "describe how you sell". */}
              <Route path="/setup" element={<Setup />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/team" element={<Team />} />
              <Route path="/quotes" element={<Quotes />} />
              <Route path="/products" element={<Products />} />
              <Route path="/quote-builder" element={<QuoteBuilder />} />
              <Route path="/issues" element={<Issues />} />
              <Route path="/handoff" element={<TechHandoff />} />
              <Route path="/admin/access-requests" element={<AdminAccessRequests />} />
              <Route path="/admin/integrations" element={<AdminIntegrations />} />
              <Route path="/admin/pitch-readiness" element={<PitchReadiness />} />
              <Route path="/appreciation" element={<Appreciation />} />
              <Route path="/security" element={<SecuritySettings />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/reports/builder" element={<ReportBuilder />} />
              <Route path="/forecast" element={<Forecast />} />
              <Route path="/service-contracts" element={<ServiceContracts />} />
              {/* Email sequences (multi-step drip) — campaigns_enabled; the
                  page itself surfaces the gate/not-configured states. */}
              <Route path="/sequences" element={<Sequences />} />
              {/* Customer Success surfaces (CS-1 / CS-3) — only for profiles
                  running the post-sale account-management motion. */}
              {showAccountManagement && (
                <>
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/accounts/:id" element={<AccountDetail />} />
                  <Route path="/renewals" element={<Renewals />} />
                  <Route path="/retention" element={<Retention />} />
                  <Route path="/lifecycle-funnel" element={<LifecycleFunnel />} />
                  <Route path="/playbooks" element={<Playbooks />} />
                  <Route path="/winback" element={<Winback />} />
                  <Route path="/cases" element={<Cases />} />
                  <Route path="/surveys" element={<Surveys />} />
                  <Route path="/segments" element={<Segments />} />
                </>
              )}
              <Route path="/admin/feature-flags" element={<AdminFeatureFlags />} />
              {/* Org-admin only — the page renders its own access-denied state
                  for non-admins. User-defined automation rules. */}
              <Route path="/admin/automation" element={<AdminAutomation />} />
              {/* Per-org Activity — org-admin only. The page renders its own
                  access-denied state for members and queries the org-scoped
                  /api/admin/org-activity backend. */}
              <Route path="/admin/activity" element={<AdminActivity />} />
              <Route path="/admin/branding" element={<AdminBranding />} />
              <Route path="/admin/ai-model" element={<AdminAiModel />} />
              {/* Org-admin only — Enterprise SSO (OIDC) + SCIM config. The page
                  renders its own access-denied / feature-gated states. */}
              <Route path="/admin/sso" element={<AdminSso />} />
              {/* Super-admin only — page renders its own access-denied
                  state for non-super-admins. See PLATFORM_INTEGRATIONS_SPEC.md. */}
              <Route path="/admin/platform-integrations" element={<AdminPlatformIntegrations />} />
              {/* Super-admin only — onboards a new customer org via the
                  shared backend/services/orgProvisioner. Page gates itself
                  for non-super-admins. */}
              <Route path="/admin/provision-org" element={<AdminProvisionOrg />} />
              {/* Super-admin only — AI Pay-as-you-go billing console. Lists every
                  org's status + MTD usage; comp / start-trial cross-org actions. */}
              <Route path="/admin/ai-billing" element={<AdminAiBilling />} />
              {/* Super-admin only — first-party traffic analytics (page loads,
                  not unique visitors; see migration 165). Page gates itself. */}
              <Route path="/admin/traffic" element={<AdminTraffic />} />
              <Route path="/admin/email-templates" element={<EmailTemplates />} />
              {/* Claude-authored org customizations — Differentiation Bet #2. Owner/admin only. */}
              <Route path="/admin/customizations" element={<CustomFieldsAdmin />} />
              <Route path="/settings" element={<Settings />} />
              {/* Developer platform — API keys + outbound webhooks. Page gates
                  itself to org owner/admin (or a personal-workspace user). */}
              <Route path="/settings/developer" element={<DeveloperSettings />} />
              {/* Per-org editable pipeline stages (migration 155). Owner/admin
                  edit; members see it read-only. */}
              <Route path="/settings/pipeline" element={<PipelineSettings />} />
              {/* Legacy URL — keep working for old bookmarks. The Privacy & Data
                  section of /settings now hosts the export + delete-account flows
                  that used to live on /your-rights. */}
              <Route path="/your-rights" element={<Navigate to="/settings#privacy" replace />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/plugins" element={<Plugins />} />
              <Route path="/plugins/new" element={<PluginNew />} />
              <Route path="/plugins/library" element={<PluginLibrary />} />
              {/* /plugins/:id/runs MUST come before /plugins/:id so Router
                  matches the more specific path first. */}
              <Route path="/plugins/:id/runs" element={<PluginRuns />} />
              <Route path="/plugins/:id" element={<PluginDetail />} />
              {/* Authed users hitting /login (stale bookmark, etc.) get sent
                  home rather than the NotFound catch-all. */}
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFound />} />
            </>
          ) : (
            <>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </Router>
  );
}

export default App;
