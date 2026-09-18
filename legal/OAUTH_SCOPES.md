# OAuth Scopes — The Open CRM

> Written for Google OAuth verification review and for customers' security teams.
> One entry per scope: why it is requested, what the code does with it, and where.
> Last verified against code: 2026-09-14.

## Google Sign-In (login only)

| Scope | Why |
|---|---|
| `openid`, `email`, `profile` (ID token via Google Identity Services) | Authentication only. We verify the ID token server-side (`google-auth-library`) to establish the user's identity; sign-ins auto-verify the email. No Google APIs are called with this credential and no token is stored. Code: `backend/routes/authRoutes.js` (google-signin handler). |

## Google Drive — Deal Intel (optional, per-org opt-in, flag `drive_intel_enabled`)

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/drive.readonly` | Read-only listing + content fetch of files in the specific folder(s) an org admin connects to a deal, to produce AI deal summaries. We never modify, create, or delete Drive content. Refresh tokens are AES-256-GCM encrypted at rest (`DRIVE_TOKEN_ENCRYPTION_KEY`). Disconnect deletes the stored token. Code: `backend/services/driveOAuth.js`, `driveSync.js`. |

Note: "Drive intel write-back" (flag `drive_intel_writeback_enabled`) writes suggestions
into the **CRM**, not into Drive — no Drive write scope is requested anywhere.

## Gmail — Deal Email Intel (optional, per-org opt-in, flag `gmail_intel_enabled`)

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Read-only sync of email threads whose participants match a deal's contacts, to show per-deal communication history + AI summaries. We never send, modify, label, or delete mail with this credential. (Outbound CRM email uses the operator's own SMTP transport, not the Gmail API.) Tokens encrypted at rest as above; disconnect deletes them. Code: `backend/services/gmailOAuth.js`, `gmailSync.js`. |

## Google Calendar — Calendar Sync (optional, per-org opt-in, flag `calendar_enabled`)

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/calendar.events` | Read events to match meetings to deals, and create/update the specific events a user explicitly creates from a deal. Deliberately NOT the broader `auth/calendar` scope — no access to calendar settings, ACLs, or other calendars. Code: `backend/services/calendarOAuth.js` (`REQUIRED_SCOPE`), `calendarSync.js`. |

## Principles

1. **Minimum scope:** read-only wherever the feature is read-only; the narrowest write
   scope (`calendar.events`) where a write feature exists. No `drive`, no `gmail.modify`,
   no full `calendar`.
2. **Opt-in per org:** every Google-API scope above sits behind a default-OFF feature
   flag plus an explicit admin connect flow. Sign-in alone grants us no API access.
3. **Encrypted at rest, deletable:** refresh tokens are AES-256-GCM encrypted; the
   admin disconnect action and org/account deletion purge them.
4. **No third-party sharing:** Google user data is never sold, transferred to ad
   platforms, or used to train models. AI summarization calls process content through
   the org's configured AI provider solely to render the org's own summaries (see
   Privacy Policy).
5. **Microsoft 365** (Outlook mail/calendar) uses Microsoft Graph scopes
   (`Mail.Read`, `Calendars.ReadWrite`, `offline_access`) under the same principles —
   documented here for completeness though outside Google verification scope. Code:
   `backend/services/msgraphOAuth.js`.
