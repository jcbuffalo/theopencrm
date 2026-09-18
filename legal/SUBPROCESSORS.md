# Subprocessors — The Open CRM

**Effective date:** 2026-07-06
**Status:** DRAFT — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

A subprocessor is a third party we engage to process personal data on
behalf of our customers. This page lists every subprocessor currently
in use and the purpose for each.

We update this list when the lineup changes. Material changes (a new
subprocessor for a previously-internal function, or a meaningful change
in data-handling scope) are notified to customers in advance per the
[Data Processing Agreement](./DATA_PROCESSING_AGREEMENT.md).

## Current subprocessors

| Subprocessor | Purpose | Region | Data accessed |
|---|---|---|---|
| **Google Cloud Platform** (Alphabet, Inc.) | Hosting (Cloud Run), database (Cloud SQL PostgreSQL), object storage (Cloud Storage), structured logging | United States — `us-central1` | All workspace data + structured logs |
| **Anthropic, PBC** | Claude AI inference for in-app assist (deal summaries, follow-up drafts, plugin authoring) | United States | Only the prompts users invoke AI on — typically deal context the user is already viewing. Never bulk-fed |
| **SendGrid** (Twilio) | Transactional email delivery (when configured) | United States | Email subject + body + recipient address |
| **Gmail / Google Workspace** (Alphabet, Inc.) | Alternate transactional email delivery (when configured) | United States | Email subject + body + recipient address |
| **Twilio** | SMS notification delivery (when SMS notifications are enabled) | United States | Recipient phone number + notification text |
| **Stripe, Inc.** | Payment processing and subscription / AI-usage billing (paid plans only) | United States | Billing contact + payment method details (we never store full card numbers) |
| **Intuit (QuickBooks Online)** | Accounting integration — only for customers who explicitly connect a QuickBooks account | United States | Customer records + invoice line items for the deals being synced |

## Optional subprocessors (only when the integration is connected)

These are activated only by an explicit per-customer action.

| Optional subprocessor | When it's used | Data accessed |
|---|---|---|
| **Microsoft Teams** | When a customer enables Teams webhook receivers | Meeting log payloads the customer chooses to forward |
| **Zoom** | When a customer enables Zoom webhook receivers | Meeting log payloads the customer chooses to forward |
| **Microsoft (Microsoft Graph / Microsoft 365)** | When a customer connects Outlook mail and/or calendar (`outlook_mail_enabled` / `outlook_calendar_enabled`) | Mail metadata + previews and calendar events for deal matching; OAuth refresh tokens stored AES-256-GCM encrypted |
| **OpenStreetMap tile servers** (OpenStreetMap Foundation) | When a user opens the Map view | No workspace data — the user's **browser** fetches map imagery directly, exposing only their IP address and requested map area to the tile server |

## What we do not currently use

- We do **not** use third-party analytics (no Google Analytics, no Mixpanel, no Segment, no Facebook Pixel).
- We do **not** use customer-data-sharing advertising networks.
- We do **not** use third-party support chat widgets (e.g., Intercom) that would have access to your in-app data.

## Sub-processor change notification

Per the Data Processing Agreement §4:

- We maintain this list and treat it as authoritative.
- Material changes are noticed at least 30 days in advance via the
  in-app banner and/or email to organization owners.
- If you object to a new subprocessor, you may terminate the affected
  portions of the service per the [Terms of Service](./TERMS_OF_SERVICE.md).

## Data location

The Open CRM operates from the United States. All subprocessors above
process data in the United States. We have not implemented Standard
Contractual Clauses or other EU-required transfer mechanisms; EU users
use the service at their own risk. See the
[Privacy Policy](./PRIVACY_POLICY.md) §8 for the full international
transfer notice.

## Contact

Questions or objections about subprocessors:

**Email:** johncolesassistant@gmail.com
**Operator:** John Coles, doing business as "The Open CRM"
