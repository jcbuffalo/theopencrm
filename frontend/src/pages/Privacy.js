// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';

const EFFECTIVE_DATE = 'May 1, 2026';
const LAST_UPDATED = 'July 6, 2026';

// PUBLIC PAGE — no auth required. Required by Google OAuth User Data Policy
// for any app that requests profile/email scopes from end users.

export default function Privacy() {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/" className="text-xl font-bold text-blue-600">The Open CRM</Link>
          <div className="flex gap-4 text-sm">
            <Link to="/" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Home</Link>
            <Link to="/terms" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Terms</Link>
            <Link to="/data-deletion" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Delete data</Link>
          </div>
        </div>
      </header>

      {/* [&_a]:* arbitrary-variant: every inline anchor inside the legal
          body gets inline-block + py-1 + align-middle so the touch area
          clears the audit's 32px floor without breaking text flow. Was the
          main source of remaining mobile tap-target findings on legal pages. */}
      <main id="main-content" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 prose prose-gray [&_a]:inline-block [&_a]:py-1 [&_a]:align-middle [&_a]:text-brand-blue-darker">
        <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
        <p className="text-sm text-gray-500">Effective date: {EFFECTIVE_DATE} · Last updated: {LAST_UPDATED}</p>

        <p className="mt-6 text-gray-700">
          This Privacy Policy describes how The Open CRM ("we", "our", "the Service") — operated by John Coles ("Operator") —
          collects, uses, discloses, and protects information in connection with your use of the application available at{' '}
          <a href="https://app.theopencrm.com" className="text-blue-600 hover:underline">app.theopencrm.com</a>.
        </p>

        <p className="text-gray-700">
          The Open CRM is a workflow management tool built primarily for B2B sales and operations teams. We take your
          privacy seriously and limit the data we collect to what is necessary to operate the Service.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">1. Information We Collect</h2>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">1.1 Account Information</h3>
        <p className="text-gray-700">When you create an account or sign in, we collect:</p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li><strong>Email address</strong> — used to identify and authenticate your account</li>
          <li><strong>Name</strong> — used for personalisation and to identify you to teammates</li>
          <li><strong>Password hash</strong> (email/password sign-in only) — stored using bcrypt; we never store passwords in plain text</li>
          <li><strong>Google profile information</strong> (Google sign-in only) — name, email address, and profile picture URL, obtained via your Google account when you choose Google Sign-In</li>
        </ul>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">1.2 Information You Provide</h3>
        <p className="text-gray-700">
          As part of using the Service, you may enter business data: customer and vendor company records, contacts,
          deals, quotes, purchase orders, shipment information, documents, and notes. You are responsible for the
          accuracy and lawful collection of this data.
        </p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">1.3 Operational Information</h3>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li><strong>IP address and user agent</strong> — for security, rate limiting, and audit logging</li>
          <li><strong>Log data</strong> — request paths, response codes, and response times, for diagnostics</li>
          <li><strong>Audit log</strong> — security-sensitive events (logins, vendor RFQ sends, document downloads) recorded with actor, IP, and request ID</li>
        </ul>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">1.4 Cookies and Similar Technologies</h3>
        <p className="text-gray-700">
          We use a small number of <strong>strictly-necessary cookies</strong> to operate the Service:
        </p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li>An <strong>httpOnly session cookie</strong> that keeps you signed in. It is not readable by JavaScript, is transmitted only to our servers over HTTPS, and is used solely to authenticate your requests.</li>
          <li>A <strong>CSRF-protection token cookie</strong> that your browser echoes back on state-changing requests to prevent cross-site request forgery.</li>
        </ul>
        <p className="text-gray-700">
          We also use your browser's <strong>localStorage</strong> for non-sensitive interface state only — your
          terms-acceptance confirmation and minimal UI preferences. We do not use third-party advertising or analytics
          cookies, and we do not track you across other websites.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">2. How We Use Information</h2>
        <p className="text-gray-700">We use the information we collect to:</p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li>Authenticate you and provide access to your account and your organization's data</li>
          <li>Provide the workflow features of the Service (deals, quotes, vendor RFQs, etc.)</li>
          <li>Send transactional email on your behalf (e.g., vendor RFQ emails you compose and send)</li>
          <li>Generate documents you request (e.g., branded customer-quote PDFs)</li>
          <li>Detect, prevent, and respond to security incidents and abuse</li>
          <li>Comply with applicable law and respond to lawful requests</li>
        </ul>
        <p className="text-gray-700">
          <strong>Email open tracking.</strong> Transactional emails you send through the Service (for example vendor
          RFQs) may include a 1×1 tracking pixel that records when the message is first opened, so the sender can see
          whether a recipient has viewed it. This records only an "opened" timestamp against that message; recipients
          whose email client blocks remote images are not tracked.
        </p>
        <p className="text-gray-700 font-semibold">
          We do not sell your personal information. We do not use your data to train machine-learning models, and our
          AI provider (Anthropic) does not train its models on the data we send under its commercial API terms.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">3. Google API Services User Data Policy</h2>
        <p className="text-gray-700">
          Our use of information received from Google APIs adheres to the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p className="text-gray-700">
          When you sign in with Google, we receive your Google profile basic information (name, email address, picture).
          We use this <strong>only</strong> to:
        </p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li>Verify your identity and create or look up your account</li>
          <li>Display your name and email in the application interface</li>
          <li>Show your profile picture as your avatar</li>
        </ul>
        <p className="text-gray-700">
          We do not transfer Google user data to third parties except as necessary to provide or improve user-facing
          features that are prominent in the user interface. We do not use Google user data for serving advertisements.
          We do not allow humans to read Google user data unless we have your affirmative consent, it is necessary for
          security, to comply with applicable law, or the data is aggregated and used for internal operations in a
          manner that does not identify any individual user.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">4. How We Share Information</h2>
        <p className="text-gray-700">We share information only as described below.</p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">4.1 Within Your Organization</h3>
        <p className="text-gray-700">
          Data you enter into the Service is visible to other members of your organization (workspace). Workspace
          owners can invite or remove members at any time.
        </p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">4.2 Service Providers (Sub-processors)</h3>
        <p className="text-gray-700">
          We host the Service on cloud infrastructure provided by third parties. These providers process data on our
          behalf solely to operate the Service:
        </p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li><strong>Google Cloud Platform</strong> — Cloud Run (compute), Cloud SQL (database), Cloud Storage (document storage), Cloud Logging (log retention). Region: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">us-central1</code> (United States).</li>
          <li><strong>Google Identity Platform</strong> — when you choose Google Sign-In, your authentication is handled by Google.</li>
          <li><strong>Anthropic, PBC</strong> — provides the Claude AI models behind the in-app assistant (the chat copilot, deal summaries, follow-up drafts, and plugin authoring). Only the specific content you invoke an AI action on is sent — typically the deal context you are already viewing; it is never bulk-fed. Under Anthropic's commercial API terms, your data is not used to train their models.</li>
          <li><strong>Stripe, Inc.</strong> — payment processing and subscription / AI-usage billing, used only if you purchase a paid plan. Stripe receives billing contact and payment details; we never store full card numbers.</li>
          <li><strong>Email provider</strong> (Gmail SMTP or SendGrid/Twilio, optional, operator-configured) — used only when you compose and send a vendor RFQ or contact-form message; the transport sees only the recipient address and the message body you authored.</li>
          <li><strong>Twilio</strong> — SMS delivery, used only if SMS notifications are enabled for your organization.</li>
          <li><strong>Intuit (QuickBooks Online)</strong> — accounting sync, only for organizations that explicitly connect a QuickBooks account.</li>
        </ul>
        <p className="text-gray-700">
          Optional integrations you choose to connect (e.g. Microsoft Teams or Zoom webhook receivers) process only the
          data you forward to them. Our authoritative, always-current subprocessor list — with the purpose, region, and
          data accessed for each — is published at{' '}
          <Link to="/legal/subprocessors" className="text-blue-600 hover:underline">theopencrm.com/legal/subprocessors</Link>.
        </p>
        <p className="text-gray-700">
          We do not share data with advertising networks, data brokers, or any other third parties for marketing
          purposes.
        </p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">4.3 Legal Requirements</h3>
        <p className="text-gray-700">
          We may disclose information if required by law, court order, or other lawful government request, or where
          disclosure is necessary to protect our rights, the rights of users, or the public.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">5. Data Storage, Security, and Retention</h2>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">5.1 Storage</h3>
        <p className="text-gray-700">
          Data is stored in Google Cloud SQL (PostgreSQL) and Google Cloud Storage in the <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">us-central1</code> region. All data is encrypted at rest using
          Google-managed encryption keys (AES-256). Data in transit between your browser and our servers is encrypted
          using TLS 1.2 or later.
        </p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">5.2 Security Practices</h3>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li>Passwords stored as bcrypt hashes only — we cannot recover your password</li>
          <li>Authentication via a signed JWT held in an httpOnly cookie (24-hour access token, with a refresh token for seamless re-authentication)</li>
          <li>HTTP security headers via <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">helmet</code> and HSTS</li>
          <li>Rate limiting to slow brute-force and abuse attempts</li>
          <li>Per-organization data isolation enforced on every API call</li>
          <li>Audit log of security-sensitive events</li>
          <li>Document downloads served via short-lived (15-minute) signed URLs</li>
        </ul>
        <p className="text-gray-700">
          No system is perfectly secure. If we become aware of a data breach affecting you, we will notify you as
          required by applicable law.
        </p>

        <h3 className="text-lg font-semibold text-gray-900 mt-4">5.3 Retention</h3>
        <p className="text-gray-700">
          We retain account data for as long as your account is active. Audit log entries are retained indefinitely
          for security and compliance purposes. You may request deletion of your account and associated data at any
          time (see section 7).
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">6. International Data Transfers</h2>
        <p className="text-gray-700">
          The Service is hosted in the United States. If you access the Service from outside the United States, your
          information will be transferred to and processed in the United States. By using the Service you consent to
          this transfer.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">7. Your Rights and Choices</h2>
        <p className="text-gray-700">You have the following rights with respect to your information:</p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li><strong>Access</strong> — request a copy of the personal information we hold about you</li>
          <li><strong>Correction</strong> — request correction of inaccurate information</li>
          <li><strong>Deletion</strong> — request deletion of your account and personal information (see below)</li>
          <li><strong>Portability</strong> — request export of your data in a machine-readable format (CSV)</li>
          <li><strong>Objection / Restriction</strong> — object to or restrict certain processing</li>
          <li><strong>Withdraw consent</strong> — for processing based on consent (e.g., revoking Google Sign-In access via your Google account settings)</li>
        </ul>
        <p className="text-gray-700">
          To exercise any of these rights, see our{' '}
          <Link to="/data-deletion" className="text-blue-600 hover:underline">Data Deletion</Link> page or email{' '}
          <a href="mailto:johnbcoles@gmail.com" className="text-blue-600 hover:underline">johnbcoles@gmail.com</a>.
          We will respond within 30 days.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">8. Children's Privacy</h2>
        <p className="text-gray-700">
          The Service is intended for business use by adults. We do not knowingly collect personal information from
          children under 16. If you believe we have collected information from a child, please contact us and we will
          delete it.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">9. Changes to This Policy</h2>
        <p className="text-gray-700">
          We may update this Privacy Policy from time to time. The "Last updated" date at the top reflects the most
          recent revision. Material changes will be communicated to active users via email or in-app notification
          before they take effect.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">10. Contact</h2>
        <p className="text-gray-700">
          Questions or requests about this Privacy Policy? Contact:
        </p>
        <p className="text-gray-700">
          John Coles<br />
          <a href="mailto:johnbcoles@gmail.com" className="text-blue-600 hover:underline">johnbcoles@gmail.com</a>
        </p>

        <hr className="my-12 border-gray-200" />

        <p className="text-xs text-gray-500">
          This document supplements but does not replace the{' '}
          <Link to="/terms" className="text-blue-600 hover:underline">Terms of Use</Link> and the LICENSE accompanying
          the Software, which contain additional disclaimers and limitations of liability.
        </p>
      </main>

      <footer className="border-t border-gray-200 mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 text-xs text-gray-500 flex justify-between flex-wrap gap-3">
          <span>© 2026 John Coles. All rights reserved.</span>
          <div className="flex gap-2 sm:gap-4 flex-wrap items-center">
            <Link to="/privacy"        className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Privacy</Link>
            <Link to="/terms"          className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Terms</Link>
            <Link to="/data-deletion"  className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Delete data</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
