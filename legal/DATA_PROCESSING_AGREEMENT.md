# Data Processing Agreement (Template) — The Open CRM

**Effective date:** 2026-05-12
**Status:** DRAFT TEMPLATE — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

This Data Processing Agreement ("DPA") template is offered to
customers of The Open CRM who, in connection with their use of the
Service, act as a data controller and require a written DPA with us
as the data processor.

If you are a small-business customer storing your own company's CRM
data, you typically do not need a DPA — the [Privacy Policy](./PRIVACY_POLICY.md)
and [Terms of Service](./TERMS_OF_SERVICE.md) govern. If your business
processes personal data of third parties (e.g., your customers' end
users) on the Service, this DPA describes the data processor obligations
we accept.

> **Note for adoption:** this template is a reasonable starting point
> for SMB customer DPAs. Enterprise customers will typically propose
> their own DPA; their version normally controls when signed by both
> parties. Counsel review is required before counter-signing any DPA.

## 1. Definitions

Capitalized terms used but not defined here have the meaning in the
[Terms of Service](./TERMS_OF_SERVICE.md). The following definitions
apply to this DPA:

- **Customer / Data Controller:** the account holder entering into
  this DPA. You.
- **Processor:** John Coles doing business as "The Open CRM," referred
  to as "we" / "our."
- **Personal Data:** information about identified or identifiable
  individuals that Customer submits to or causes to be processed by
  the Service.
- **Data Subjects:** the individuals to whom Personal Data relates.
- **Sub-processor:** any third party we engage to process Personal
  Data on Customer's behalf.

## 2. Scope and roles

- Customer is the **data controller** with respect to Personal Data
  it submits to the Service.
- We act as **data processor**, processing Personal Data only on
  Customer's documented instructions.
- This DPA does not transfer ownership of Personal Data; Customer
  retains all rights.

## 3. Our obligations

We will:

- Process Personal Data only on Customer's documented instructions
  (which include the Service's normal operation per the Terms of
  Service).
- Implement and maintain appropriate technical and organizational
  measures to protect Personal Data, including but not limited to:
  - Encryption in transit (TLS 1.2+) and at rest (managed by
    underlying cloud provider).
  - Access controls (role-based, audit-logged).
  - Append-only audit logging at the database level.
  - Per-route rate limiting on credential endpoints.
  - Quarterly dependency vulnerability scans.
- Ensure personnel with access to Personal Data are bound by
  confidentiality obligations.
- Notify Customer of any confirmed breach affecting Customer's
  Personal Data per the timelines in our
  [Breach Notification Policy](./BREACH_NOTIFICATION_POLICY.md).
- Assist Customer in responding to Data Subject requests (access,
  deletion, portability, etc.) — Customer can use the in-app
  self-service tools at `/legal/your-rights` to fulfill most
  requests directly; for those that require operator action, contact
  us at johncolesassistant@gmail.com.
- Assist Customer with data protection impact assessments (DPIAs)
  and prior consultations with supervisory authorities, where
  required.

## 4. Sub-processors

We engage the following sub-processors to provide the Service:

| Sub-processor | Purpose | Location |
|---|---|---|
| Google Cloud Platform (GCP) | Hosting (Cloud Run, Cloud SQL, Cloud Storage) | United States (region us-central1) |
| Anthropic, PBC | AI features (text summarization, drafting) — only invoked when Customer uses an AI feature | United States |
| SendGrid / Gmail | Transactional email delivery | United States |
| QuickBooks Online (Intuit) | Accounting integration (only when Customer connects an account) | United States |

We will:

- Maintain an up-to-date list of sub-processors (this section serves
  as that list).
- Provide at least 30 days' notice of any change in sub-processors
  via email or in-app banner. If Customer objects to a new
  sub-processor, Customer may terminate the affected portions of the
  Service per the Terms.
- Impose data-protection obligations on each sub-processor that are
  no less protective than those in this DPA.

## 5. International transfers

The Service is hosted in the United States. If Customer transfers
Personal Data of individuals located in the European Economic Area
(EEA), United Kingdom, or Switzerland to us, the transfer is governed
by the European Commission's Standard Contractual Clauses (SCCs),
Module Two (Controller-to-Processor), as available at
https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj. The parties
incorporate the SCCs by reference and agree to act as their respective
data exporter and data importer.

> **Counsel review note:** SCCs are required for EEA→US transfers
> under GDPR. The Open CRM does not currently target EEA customers.
> If we begin accepting EEA customers, this section must be expanded
> with the actual SCC schedule and counsel review.

## 6. Data subject rights

- Customer is primarily responsible for responding to Data Subject
  requests (e.g., access, deletion, portability) under applicable
  law.
- We provide self-service tools to help Customer fulfill these
  requests:
  - In-app data export endpoint
  - In-app account deletion endpoint
  - In-app rights summary at `/legal/your-rights`
- Where Customer requires assistance beyond the self-service tools,
  contact us at johncolesassistant@gmail.com. We will respond within
  the timeline required by applicable law.

## 7. Audits

- Customer may request a summary of our security and privacy controls
  no more than once per twelve-month period.
- Where Customer requires a third-party audit (e.g., SOC 2 report),
  we will use commercially reasonable efforts to provide the relevant
  report or accept a contractually-bounded audit by Customer or its
  agent, subject to mutual non-disclosure obligations.

## 8. Term and termination

This DPA remains in effect for as long as Customer's underlying
agreement with us (the Terms of Service plus any subscription
agreement) is in effect.

Upon termination:

- We will, at Customer's choice, return or delete all Personal Data
  in our possession within 90 days of termination, except where
  retention is required by law.
- Backup copies may persist for up to 30 days after deletion (per the
  underlying backup retention).

## 9. Liability

The limitation of liability set forth in the
[Terms of Service](./TERMS_OF_SERVICE.md) applies to this DPA.

## 10. Conflicts

In the event of any conflict between this DPA and the Terms of Service
with respect to processing of Personal Data, this DPA controls.

## 11. Governing law

This DPA is governed by the same law and venue as the Terms of
Service (currently New York), except where applicable data protection
law requires a different governing law for specific provisions.

## 12. Signature

For execution by signature, this DPA template should be exported,
filled in with Customer details, and signed by both parties. Contact
johncolesassistant@gmail.com to begin that process.

---

**Operator:** John Coles, doing business as "The Open CRM"
**Email:** johncolesassistant@gmail.com
