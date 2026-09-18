# Cookie Policy — The Open CRM

**Effective date:** 2026-05-12
**Status:** DRAFT — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

This Policy describes how The Open CRM uses cookies and similar
technologies. It supplements our [Privacy Policy](./PRIVACY_POLICY.md).

## 1. What are cookies

Cookies are small text files that websites store on your device. They
typically contain an identifier or a small amount of information used
to recognize you on return visits, keep you logged in, or remember
your preferences.

Similar technologies include `localStorage`, `sessionStorage`, and
HTTP-only authentication tokens.

## 2. Cookies and storage we use

### Strictly necessary (cannot be disabled)

- **Authentication token** (currently stored in `localStorage` as
  `authToken` — moving to an `httpOnly; Secure; SameSite=Strict`
  cookie per the security roadmap). Required to keep you logged in.
- **CSRF token** (planned, when the cookie migration completes).
  Required to prevent cross-site request forgery.
- **Session preferences** (sidebar collapsed state, table sort
  preference) stored in `localStorage`. Not personal data.

### Analytics and tracking

- **Currently: none.** The Open CRM does not load Google Analytics,
  Meta Pixel, or any third-party tracking tool.
- If we add analytics in the future, this Policy will be updated and
  a cookie consent banner will be required (per CCPA, EU ePrivacy
  Directive, and similar laws) before non-essential cookies are set.

### Third-party

- **Google Sign-In:** if you authenticate via Google, Google's own
  cookies are set on the `accounts.google.com` domain during the
  sign-in flow. Those cookies are governed by Google's privacy
  policy, not ours.
- **QuickBooks Online:** if you connect a QuickBooks account, Intuit
  cookies are set during the OAuth flow on Intuit's domain.

## 3. How to control cookies

- **Browser settings.** Most browsers let you block cookies, see
  what's stored, and delete specific items. Instructions vary by
  browser:
  - Chrome: Settings → Privacy and security → Cookies and other site
    data
  - Firefox: Settings → Privacy & Security → Cookies and Site Data
  - Safari: Preferences → Privacy
  - Edge: Settings → Cookies and site permissions
- **In-app controls.** Once we add non-essential cookies, you'll see
  a consent banner with granular controls.

Disabling strictly-necessary cookies (or `localStorage`) will break
authentication — you won't be able to log in.

## 4. Do Not Track

Our service does not currently respond to "Do Not Track" headers in a
specific way, because we don't use tracking cookies. If we begin
using tracking cookies, we will honor DNT signals or provide an
equivalent opt-out per applicable law.

## 5. Changes

We may update this Policy from time to time. The "Effective date" at
the top reflects the most recent update.

## 6. Contact

**Email:** johncolesassistant@gmail.com
**Operator:** John Coles, doing business as "The Open CRM"
