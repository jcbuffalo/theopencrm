# Privacy Policy — The Open CRM

**Effective date:** 2026-05-12
**Status:** DRAFT — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

The Open CRM ("we," "our," "the Service") is operated by John Coles,
doing business as "The Open CRM" (DBA). This Privacy Policy explains
what personal information we collect, why we collect it, what we do
with it, and your rights with respect to that information.

If you do not agree with this Policy, do not use the Service.

## 1. Information we collect

We collect information in three ways:

### 1.1 Information you provide

- **Account information:** name, email address, password (hashed —
  we never store the plaintext), and any profile fields you fill in.
- **Workspace data:** every business record you create in the Service —
  companies, contacts, deals, quotes, RFQs, purchase orders, invoices,
  documents, activities, tasks, and any notes or attachments.
- **Communications:** content you send via in-app messaging, support
  requests, or feedback forms.

### 1.2 Information we collect automatically

- **Usage data:** pages viewed, features used, API endpoints called,
  timestamps. Tied to your account where you're signed in.
- **Device & network data:** IP address, browser type, operating system,
  device identifiers (if mobile), referring URL.
- **Authentication metadata:** login timestamps, login IP addresses,
  failed-login attempts, security events.
- **Audit log:** every administrative action is recorded with
  actor, target, and timestamp (see "Audit & accountability" below).

### 1.3 Information from third parties

- **Google Sign-In:** if you authenticate via Google, we receive your
  Google profile email, name, and profile picture.
- **QuickBooks / accounting integrations:** if you connect a QuickBooks
  account, we receive customer and invoice data from that connection.
- **Email providers:** outbound email is sent via Gmail or SendGrid; the
  email contents pass through their systems.

## 2. Why we collect it

- Operate the Service (display your data, run your workflows).
- Authenticate your account and protect it from unauthorized access.
- Send transactional emails (password reset, access approval,
  notification of admin actions).
- Diagnose and fix bugs.
- Comply with legal obligations.

We do **not** sell personal information. We do **not** use your
workspace data to train AI models. We do **not** share personal
information with third parties except as described below.

## 3. Who we share with

We share personal information only with:

- **Service providers** who help us operate the Service, bound by
  contractual confidentiality obligations:
  - Google Cloud Platform (hosting + database)
  - Anthropic (AI features — only de-identified queries, no workspace
    data leaves our infrastructure unless you explicitly invoke an AI
    feature)
  - Email delivery (Gmail and/or SendGrid, depending on configuration)
  - Stripe (payment processing and billing, for paid plans only)
  - Twilio (SMS notifications, when enabled)
  - QuickBooks (only for accounts you've connected)
- **Legal authorities** when required by valid legal process (subpoena,
  court order). We will notify you of the request unless legally
  prohibited.
- **Successor entities** if The Open CRM is acquired or merged. Your
  data follows the Service; the acquirer is bound by this Policy or a
  successor policy with equivalent protections.

## 4. How long we keep it

- **Active accounts:** as long as your account is active, plus 30 days
  after deletion.
- **Account deletion:** when you delete your account, we remove your
  workspace data within 30 days and your account record within 90 days.
- **Audit logs:** 365 days, then deleted.
- **Backups:** Cloud SQL backups are retained for 30 days. Data may
  persist in backups during that window after deletion.
- **Legal hold:** if we receive valid legal process requiring retention,
  we may extend the periods above for the period required.

## 5. Your rights

Depending on where you live, you may have the following rights with
respect to your personal information:

- **Right to access** — request a copy of the personal data we hold on
  you (see `/legal/your-rights`).
- **Right to delete** — request that we delete your account and data.
- **Right to portability** — receive a machine-readable export of your
  data.
- **Right to correct** — fix inaccurate information (most fields are
  user-editable in the app; for fields you can't edit, contact us).
- **Right to opt-out** — opt out of marketing communications (we do not
  currently send any).
- **Right to non-discrimination** — exercising any right above will not
  affect your service or pricing.

To exercise any of these rights, use the in-app self-service tools at
`/legal/your-rights` or email johncolesassistant@gmail.com. We respond
within 30 days (or the timeline required by your state's law,
whichever is shorter).

### State-specific rights

- **California (CCPA / CPRA):** in addition to the above, you have the
  right to know what categories of personal information we have
  collected, sold (we do not sell), or disclosed for a business
  purpose.
- **Virginia (CDPA), Colorado (CPA), Connecticut (CTDPA), Utah (UCPA):**
  rights equivalent to the above, exercisable through the same channels.
- **GDPR (if you are in the EU):** we currently do not target EU
  customers and have not registered an EU representative. If you are
  in the EU and have created an account anyway, contact us and we will
  process your data subject request under best-effort GDPR-equivalent
  standards while we evaluate formal compliance.

## 6. Security

We use industry-standard practices to protect your information:

- TLS 1.2+ for all data in transit.
- Password hashing with bcrypt (cost factor 12) — we never see your
  plaintext password.
- JWT-based session tokens with algorithm pinning (HS256).
- Audit log is append-only at the database level (triggers prevent
  modification or deletion).
- Per-route rate limiting on credential endpoints.
- Periodic dependency vulnerability scans.

No system is perfectly secure. If we become aware of a breach involving
your personal information, we will notify you per our
[Breach Notification Policy](./BREACH_NOTIFICATION_POLICY.md) and
applicable law.

## 7. Children

The Service is not directed to children under 13 (or 16 in some
jurisdictions). We do not knowingly collect personal information from
children. If you believe we have, contact us at
johncolesassistant@gmail.com and we will delete it.

## 8. International users

The Open CRM operates from the United States on Google Cloud
infrastructure (region `us-central1`). If you access the Service from
outside the U.S., your information will be transferred to and processed
in the U.S. We have not implemented Standard Contractual Clauses or
other EU-required transfer mechanisms; EU users use the Service at
their own risk.

## 9. Cookies

See our [Cookie Policy](./COOKIE_POLICY.md).

## 10. Changes to this Policy

We may update this Policy from time to time. When we do, we will revise
the "Effective date" above and notify you via the in-app banner or
email. Material changes will be flagged before they take effect.

## 11. Contact

Privacy inquiries, data subject requests, and complaints:

**Email:** johncolesassistant@gmail.com
**Operator:** John Coles, doing business as "The Open CRM"

If you believe we have not adequately addressed your concern, you may
file a complaint with your state attorney general or applicable data
protection authority.


### Traffic analytics (first-party only)

Our own servers record page loads with normalized paths (record IDs and
tokens are masked before storage; query strings are never stored) and the
referring site's hostname. There are no analytics cookies, no third-party
trackers, and no visitor identifiers - we cannot count unique visitors by
design. Analytics rows are deleted after 180 days.
