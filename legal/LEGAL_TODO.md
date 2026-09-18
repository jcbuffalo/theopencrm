# Legal Documentation — Status & TODOs

> **READ THIS FIRST if you are evaluating, modifying, or relying on any
> document in `legal/`.**

## Status: DRAFT — pending counsel review

Every document in this directory was **drafted by an LLM (Claude) as a
working template**, not authored by an attorney. They use defensible
defaults and reasonable language, but they are **not legally binding
finished documents** until reviewed and approved by qualified counsel
for the jurisdiction(s) in which The Open CRM operates.

**Drafted:** 2026-05-12
**Drafted by:** Claude (Anthropic), instructed by John Coles
**Operating entity name on the docs:** "The Open CRM" (operating as a DBA
of John Coles until incorporation completes)
**Last reviewed by counsel:** NEVER YET

## 2026-09-14 update — "something in place now" pass (owner-directed)

Per John's direction ("something is better than nothing... I want something in
place to protect me for now"), this pass put the interim protections live:

- ✅ **Terms re-acceptance forced**: `CURRENT_TERMS_VERSION` bumped to
  `2026-09-14` (AI pay-as-you-go billing section added §5a / public page §4a;
  effective dates bumped). Every user re-accepts; acceptances are recorded
  server-side per (user, version) in `terms_acceptances` (migration 157). The
  Terms bar's localStorage cache is now VERSION-KEYED so bumps can never be
  masked or silently backfilled.
- ✅ **Subprocessor list updated**: Microsoft Graph (Outlook/M365 integration)
  and OpenStreetMap tile servers (map view, browser-direct) added.
- 📝 **`drafts/BRANDLETE_ORDER_FORM.md`** — one-page order form incorporating
  the published Terms + DPA by reference. **John: review + send** (email
  assent acceptable interim).
- 📝 **`drafts/ZANG_SOW_S15_AMENDMENT.md`** — ownership→perpetual-license
  conversion resolving review finding P1-11 (SOW §15 vs. AGPL/multi-tenant).
  **John: review + negotiate**; fill in the SOW date first.
- Everything remains DRAFT pending counsel per below — unchanged.

## Why these exist anyway

Two reasons we ship them in draft form:

1. **Defense-in-depth.** Surfacing visible Privacy Policy, Terms of
   Service, etc. is a baseline expectation for any SaaS. Having
   reasonable language available is better than having nothing while we
   wait for counsel — particularly for the AS-IS warranty disclaimer
   and liability cap, which are load-bearing.
2. **Counsel review baseline.** Lawyers charge much less to *review and
   edit* a reasonable draft than to *author from scratch*. These drafts
   give counsel a structured starting point.

## What to do before relying on these as binding

### Short term (before any paying customer)

- [ ] Engage a qualified attorney (preferably one who has worked on
      SaaS / data-processor agreements) to review **all** documents in
      `legal/`.
- [ ] Decide which legal entity is operating The Open CRM. The current
      drafts name "The Open CRM" as a DBA of John Coles. If/when an
      LLC or corporation is formed, search-and-replace and re-confirm
      indemnification + limitation-of-liability clauses with counsel.
- [ ] Verify Governing Law clause (currently New York) aligns with
      where the operating entity is incorporated and where you expect
      to litigate.
- [ ] Confirm dispute-resolution preferences (arbitration vs. court;
      class-action waiver yes/no). The drafts currently allow court
      action; some operators prefer mandatory arbitration.

### Medium term (before the first state-AG inquiry or breach)

- [ ] Have counsel audit the Privacy Policy against the **specific
      state laws** that apply based on your customer base:
      - California (CCPA / CPRA) — almost always applies for SaaS
      - Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana,
        Iowa, Tennessee, Indiana, Florida, Delaware, New Hampshire,
        New Jersey, Maryland, Minnesota, Rhode Island, Nebraska,
        Kentucky, Maine, Vermont (as of 2026)
- [ ] Confirm breach-notification timelines per state where customers
      reside. Several states require disclosure within 30 or 60 days;
      the draft Breach Notification Policy uses generic language that
      may need state-specific override clauses.
- [ ] Register a designated DMCA agent with the U.S. Copyright Office
      (https://dmca.copyright.gov/) if hosting user-generated content
      that could include third-party copyrighted material.
- [ ] If processing health, financial, or children's data, add the
      specific addenda (HIPAA BAA template, GLBA disclosures, COPPA
      notice). The current drafts do **not** cover those use cases.

### Long term (mid-revenue or enterprise customers)

- [ ] Replace the templated DPA (`DATA_PROCESSING_AGREEMENT.md`) with a
      counsel-authored version once an enterprise customer asks for
      one. Templated DPAs are acceptable for SMB customers; enterprise
      legal teams routinely propose their own.
- [ ] Engage counsel to confirm whether SOC 2 Type I or II
      certification is needed for the customer base you're pursuing.
      None of these drafts claim any certification.
- [ ] Re-verify all documents annually. Laws change; what's compliant
      in 2026 may not be in 2027.

## What's in this directory

- `README.md` — index + customer-facing navigation
- `PRIVACY_POLICY.md` — what data we collect, why, retention, third
  parties, user rights, contact
- `TERMS_OF_SERVICE.md` — the customer agreement (warranty disclaimer,
  liability cap, governing law, dispute resolution)
- `ACCEPTABLE_USE_POLICY.md` — what users may not do (spam, illegal
  content, security circumvention, etc.)
- `BREACH_NOTIFICATION_POLICY.md` — our internal commitments + the
  customer-facing disclosure timeline
- `DATA_PROCESSING_AGREEMENT.md` — DPA template for customers who
  request one (most won't; enterprise will)
- `DMCA_POLICY.md` — copyright takedown procedure + designated agent
  contact
- `COOKIE_POLICY.md` — what we set, why, opt-out mechanism

## What's NOT in this directory (and where counsel should fill gaps)

- HIPAA Business Associate Agreement (BAA) — needed if healthcare data
- GLBA disclosures — needed if financial-services data
- COPPA notice — needed if children-under-13 data
- Subprocessor list with named third parties (Anthropic, Google Cloud,
  SendGrid, Gmail, QuickBooks, Stripe, etc.) — counsel should confirm
  whether each is sub-processor or third-party-recipient
- Standard Contractual Clauses (SCCs) — needed for EU data export under
  GDPR; only applicable if EU customers
- California Consumer Privacy Notice at collection — separate from the
  main Privacy Policy, required at the point of data collection in CA

## How users encounter these documents

- Public URLs: `https://app.theopencrm.com/legal/<doc>` (frontend route)
- API: `GET /api/legal/:doc` returns the markdown content
- Click-through Terms modal on first authenticated session (already
  implemented in `frontend/src/components/TermsModal.js`)
- Footer of every quote PDF (already implemented in
  `backend/services/pdfQuote.js`)
- Liability summary in every error response body (already implemented
  in `backend/index.js` error handler)

## Liability-of-author note

These drafts are provided **as-is, for the convenience of The Open CRM's
operator**, with no warranty as to legal sufficiency. The drafting
LLM and its operators (Anthropic) are not party to any agreement
formed by these documents. If you adopt them without counsel review and
something goes wrong, that's on you — not on the drafter.
