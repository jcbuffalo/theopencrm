# Terms of Service — The Open CRM

**Effective date:** 2026-09-14
**Status:** DRAFT — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

These Terms of Service ("Terms") govern your use of The Open CRM (the
"Service"), operated by John Coles doing business as "The Open CRM"
("we," "our"). By accessing or using the Service, you agree to these
Terms. If you do not agree, do not use the Service.

## 1. The Service

The Open CRM is a multi-tenant customer-relationship-management
platform. It provides tools for managing companies, contacts, deals,
quotes, purchase orders, invoices, and related workflows. Specific
features may vary by your subscription tier and the modules enabled
for your organization.

## 2. Account

- You must provide accurate registration information.
- You are responsible for safeguarding your account credentials.
- You are responsible for all activity that occurs under your account.
- One person may not maintain multiple accounts without our consent.
- You must be at least 18 years old (or the age of majority in your
  jurisdiction) to use the Service.

## 3. Acceptable use

You agree to comply with our [Acceptable Use Policy](./ACCEPTABLE_USE_POLICY.md).
Violations may result in suspension or termination without refund.

## 4. Your content

- You retain all rights to data you submit to the Service ("Your
  Content"). We claim no ownership.
- You grant us a limited license to host, process, display, and back up
  Your Content solely to operate the Service for you.
- You represent that you have the right to submit Your Content and that
  it does not violate any law or third-party right.
- You are responsible for the accuracy, legality, and appropriateness
  of Your Content.

## 5. Fees

If your subscription tier requires a fee:

- Fees are billed in advance and non-refundable except where required
  by law.
- We may change fees with at least 30 days' notice.
- If your account becomes past due, we may suspend or terminate it.

(Free tiers, if any, are governed by the specific tier's terms.)

### 5a. AI usage fees (pay-as-you-go)

Some AI features are billed by usage rather than by subscription:

- AI usage is metered per organization. Where AI billing applies to your
  organization, usage beyond any included allowance is charged at the
  usage rates shown on the pricing page or in your billing settings at
  the time of use.
- Metered AI charges are billed in arrears (typically monthly) through
  our payment processor and are non-refundable once the underlying AI
  processing has been performed, except where required by law.
- You can monitor usage on your Usage page. We may notify you and/or
  require payment method confirmation when usage crosses stated
  thresholds, and we may suspend AI features (not your data access) if
  AI charges become past due.
- If your organization supplies its own AI provider API key, usage under
  that key is billed to you directly by that provider under that
  provider's terms, and our metered AI fees do not apply to that usage.
- Free-tier AI allowances may be changed prospectively; we will not
  retroactively charge for usage that was free when incurred.
- AI usage routed through the Open CRM AI Gateway from a self-hosted
  instance is billed to the workspace that minted the gateway key, at the
  AI pay-as-you-go rates.

## 6. Confidentiality

Each party will protect the other's confidential information with at
least the same degree of care it uses to protect its own. Confidential
information includes Your Content, our non-public technical and
business information, and the existence and terms of any negotiated
agreement.

## 7. Service availability

We strive for high availability but do not guarantee uninterrupted
service. We may take the Service offline for maintenance, security
patching, or in response to attacks or legal process. We will provide
reasonable notice where practical.

## 8. Warranty disclaimer

**THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY
OF ANY KIND, EXPRESS OR IMPLIED. WE DISCLAIM ALL WARRANTIES, INCLUDING
WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, RELIABILITY, SECURITY,
AVAILABILITY, OR ABSENCE OF ERRORS OR DEFECTS.**

**THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE SERVICE IS
WITH YOU.**

(These service-level terms govern your use of the hosted Service. The
Service's source code is licensed separately under the GNU AGPL v3.0
([LICENSE](../LICENSE)), whose sections 15–16 carry the equivalent
no-warranty and liability terms for the code itself.)

## 9. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:**

- **IN NO EVENT WILL JOHN COLES, THE OPEN CRM, OR ANY OF ITS
  CONTRIBUTORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
  CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES**, including without
  limitation:
  - Lost profits, revenue, goodwill, or business opportunity
  - Loss, corruption, or unauthorized access to data
  - Service interruption or unavailability
  - Damages from third-party services or integrations
  - Damages from User-supplied data or configuration

- **OUR AGGREGATE LIABILITY FOR ALL CLAIMS ARISING FROM OR RELATED TO
  THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF:**
  - The total amount you have paid us in the 12 months preceding the
    event giving rise to the claim, or
  - One hundred U.S. dollars (US$100.00)

- **THIS LIMITATION APPLIES EVEN IF WE HAVE BEEN ADVISED OF THE
  POSSIBILITY OF SUCH DAMAGES**, and applies to claims in contract,
  tort (including negligence), strict liability, or any other legal
  theory.

Some jurisdictions do not allow the exclusion or limitation of liability
for consequential or incidental damages, in which case the limitations
above apply to the maximum extent permitted by law.

## 10. Indemnification

You will defend, indemnify, and hold harmless John Coles, The Open CRM,
and any contributors from and against any third-party claims, damages,
losses, costs, or expenses (including reasonable attorneys' fees)
arising out of or related to:

- Your use of the Service
- Your Content
- Your violation of these Terms or any law
- Your violation of any third-party right

## 11. Termination

- You may terminate your account at any time via the in-app account
  deletion flow.
- We may suspend or terminate your account for material violation of
  these Terms, for fraud, for legal process, or upon written notice
  with reasonable cause.
- Upon termination, your access ends immediately. Your Content will
  be deleted per our Privacy Policy retention schedule.

## 12. Governing law and dispute resolution

These Terms are governed by the laws of the State of New York, without
regard to its conflict-of-law principles. Any dispute will be resolved
in the state or federal courts located in New York County, New York,
and you consent to the jurisdiction and venue of those courts.

You and we each waive the right to a jury trial.

(Some operators prefer mandatory arbitration with a class-action
waiver; this draft uses court litigation. Counsel review should
confirm.)

## 13. Your operational responsibilities

You are solely responsible for how you deploy, configure, and use the
Service, including:

1. **Your data.** Validating, backing up, and securing the data you
   enter into or generate with the Service — including customer and
   vendor records, pricing, quotes, purchase orders, shipping and
   financial documents.
2. **Access & credentials.** Configuring access controls,
   authentication, secrets, and (for self-hosted deployments)
   environment variables appropriately for your environment.
3. **Document accuracy.** Verifying the accuracy and legal sufficiency
   of any document the Service generates (quotes, invoices, purchase
   orders, shipping documents, and the like) **before** you transmit it
   to a third party.
4. **Legal compliance.** Complying with all laws, regulations, and
   contractual obligations that govern your use — including data
   protection, privacy, export control, financial reporting, and any
   industry-specific rules.
5. **Third-party services.** Your own selection of, contracts with, and
   reliance on the third-party services the Service integrates with or
   depends on (for example Google Cloud Platform, PostgreSQL, npm
   package dependencies, email providers, payment processors, and
   accounting integrations). We are not responsible for their
   availability, acts, or omissions.
6. **Testing changes.** For self-hosted or customized deployments,
   independently testing any changes before relying on them in
   production.

## 14. No professional advice

The Service is a productivity and workflow tool. Its output — including
anything produced by the AI copilot — does **not** constitute legal,
financial, accounting, tax, or other professional advice. You must
consult a qualified professional for advice specific to your situation,
and you are responsible for reviewing AI-generated content before acting
on or sending it.

## 15. Changes to these Terms

We may modify these Terms from time to time. Material changes will be
notified at least 30 days before they take effect, via the in-app
banner or email. Continued use of the Service after the effective date
constitutes acceptance.

## 16. Miscellaneous

- **Entire agreement.** These Terms (with the documents they
  reference) are the entire agreement between you and us regarding the
  Service.
- **Severability.** If any provision is held unenforceable, the
  remainder remains in effect.
- **No waiver.** Our failure to enforce any right is not a waiver.
- **Assignment.** You may not assign these Terms without our consent.
  We may assign them to a successor entity.
- **Notices.** Notices to us go to johncolesassistant@gmail.com.
  Notices to you go to the email address on your account.

## 17. Contact

**Email:** johncolesassistant@gmail.com
**Operator:** John Coles, doing business as "The Open CRM"
