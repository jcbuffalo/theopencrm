// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';

const EFFECTIVE_DATE = 'September 14, 2026';

// PUBLIC PAGE — no auth required. Required for Google OAuth verification.

export default function Terms() {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/" className="text-xl font-bold text-blue-600">The Open CRM</Link>
          <div className="flex gap-4 text-sm">
            <Link to="/" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Home</Link>
            <Link to="/privacy" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Privacy</Link>
            <Link to="/data-deletion" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Delete data</Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 prose prose-gray [&_a]:inline-block [&_a]:py-1 [&_a]:align-middle [&_a]:text-brand-blue-darker">
        <h1 className="text-3xl font-bold text-gray-900">Terms of Service</h1>
        <p className="text-sm text-gray-500">Effective date: {EFFECTIVE_DATE}</p>

        <p className="mt-6 text-gray-700">
          These Terms of Service ("Terms") govern your access to and use of the The Open CRM application (the "Service")
          operated by John Coles ("we", "our", "Operator"). By creating an account, signing in, or otherwise using the
          Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">1. Eligibility & Account</h2>
        <p className="text-gray-700">
          You must be at least 16 years old and able to form a binding contract under applicable law. You are
          responsible for keeping your credentials confidential and for all activity that occurs under your account.
          Notify us immediately if you suspect unauthorized use.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">2. Acceptable Use</h2>
        <p className="text-gray-700">You agree not to:</p>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          <li>Violate any law or third-party right in your use of the Service</li>
          <li>Upload malware, viruses, or other harmful code</li>
          <li>Attempt to gain unauthorized access to other accounts, organizations, or systems</li>
          <li>Reverse-engineer, decompile, or attempt to extract source code from the Service except as permitted by law</li>
          <li>Use the Service to send unsolicited bulk email (spam) or to harass third parties</li>
          <li>Use the Service to store, process, or transmit data in violation of applicable privacy or data-protection laws</li>
          <li>Resell, sublicense, or commercialize access to the Service without our prior written consent</li>
          <li>Circumvent rate limits, access controls, or security mechanisms</li>
        </ul>

        <h2 className="text-xl font-bold text-gray-900 mt-8">3. Your Content</h2>
        <p className="text-gray-700">
          You retain all rights to the data you enter into the Service ("Your Content"). By using the Service, you
          grant us a limited license to host, store, transmit, display, and process Your Content solely as necessary
          to operate the Service for you.
        </p>
        <p className="text-gray-700">
          You represent that you have all necessary rights and consents to upload Your Content and that doing so does
          not violate any law or third-party right (including but not limited to applicable privacy laws governing
          contact information you upload).
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">4. Privacy</h2>
        <p className="text-gray-700">
          Your use of the Service is also governed by our{' '}
          <Link to="/privacy" className="text-blue-600 hover:underline">Privacy Policy</Link>, which is incorporated
          into these Terms by reference.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">4a. Fees &amp; AI Usage Billing</h2>
        <p className="text-gray-700">
          Paid subscription tiers are billed in advance and are non-refundable except where required by law; we may
          change fees with at least 30 days' notice. Some AI features are additionally billed by usage: where AI
          billing applies to your organization, metered AI usage beyond any included allowance is charged at the
          rates shown on the pricing page or in your billing settings at the time of use, billed in arrears through
          our payment processor, and non-refundable once the underlying AI processing has been performed. You can
          monitor AI usage on your Usage page. If your organization supplies its own AI provider API key, that usage
          is billed directly by the provider under the provider's terms and our metered AI fees do not apply to it.
          If AI charges become past due we may suspend AI features (not your access to your data).
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">5. AS-IS — No Warranty</h2>
        <p className="text-gray-700 font-semibold uppercase">
          The Service and any output of the Service (including but not limited to generated quotes, purchase orders,
          shipping documents, and reports) are provided "as is" and "as available", without warranty of any kind,
          express or implied, including without limitation warranties of merchantability, fitness for a particular
          purpose, accuracy, non-infringement, security, availability, or absence of errors or defects.
        </p>
        <p className="text-gray-700">
          You assume the entire risk as to the quality and performance of the Service. You are solely responsible for
          verifying any output of the Service before relying on it for any business purpose.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">6. Limitation of Liability</h2>
        <p className="text-gray-700 font-semibold uppercase">
          To the fullest extent permitted by law, in no event shall John Coles, his heirs, assigns, contributors, or
          any party associated with the development of the Service be liable for any direct, indirect, incidental,
          special, consequential, exemplary, or punitive damages, including but not limited to loss of profits,
          revenue, goodwill, data, business opportunity, or business interruption — even if advised of the possibility
          of such damages.
        </p>
        <p className="text-gray-700">
          Where applicable law does not permit such limitation, our liability is limited to the maximum extent
          permitted, and in no event shall it exceed one hundred U.S. dollars (USD $100) in the aggregate for all
          claims of any kind.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">7. No Professional Advice</h2>
        <p className="text-gray-700">
          The Service is a productivity and workflow tool. Output of the Service does not constitute legal, financial,
          accounting, tax, or other professional advice. Consult qualified professionals before relying on Service
          output for material decisions.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">8. Third-Party Services</h2>
        <p className="text-gray-700">
          The Service may rely on or integrate with third-party services (including but not limited to Google Cloud
          Platform, PostgreSQL, npm package dependencies, email providers, and accounting integrations). We are not
          responsible for any outage, change, or failure caused by third-party providers.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">9. Indemnification</h2>
        <p className="text-gray-700">
          You agree to defend, indemnify, and hold harmless John Coles and any contributors from any third-party claim
          arising out of (a) your use of the Service, (b) Your Content, (c) your business practices, or (d) your
          violation of these Terms, of applicable law, or of any third-party right.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">10. Suspension & Termination</h2>
        <p className="text-gray-700">
          We may suspend or terminate your access to the Service at any time, with or without cause and with or
          without notice, including if we believe you have violated these Terms. You may close your account at any
          time via the{' '}
          <Link to="/data-deletion" className="text-blue-600 hover:underline">Data Deletion</Link> page or by
          contacting us.
        </p>
        <p className="text-gray-700">
          Sections that by their nature should survive termination — including warranties, liability limits,
          indemnification, and governing law — survive termination of these Terms.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">11. Changes to the Service or These Terms</h2>
        <p className="text-gray-700">
          We may modify the Service or these Terms at any time. Material changes to the Terms will be communicated
          via in-app notice or email at least 14 days before they take effect. Continued use of the Service after the
          effective date constitutes acceptance of the new Terms.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">12. Governing Law & Dispute Resolution</h2>
        <p className="text-gray-700">
          These Terms are governed by the laws of the State of New York, without regard to conflict-of-law principles.
          Disputes will first be addressed through good-faith negotiation between authorized representatives of the
          parties; if unresolved, the parties agree to attempt mediation before commencing litigation, except where
          urgent injunctive relief is necessary.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">13. Entire Agreement</h2>
        <p className="text-gray-700">
          These Terms, together with the Privacy Policy and the LICENSE accompanying the Software, constitute the
          entire agreement between you and us with respect to the Service and supersede any prior or contemporaneous
          discussions, proposals, or understandings on the same subject matter.
        </p>

        <h2 className="text-xl font-bold text-gray-900 mt-8">14. Contact</h2>
        <p className="text-gray-700">
          John Coles<br />
          <a href="mailto:johnbcoles@gmail.com" className="text-blue-600 hover:underline">johnbcoles@gmail.com</a>
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
