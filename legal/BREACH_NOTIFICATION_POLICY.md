# Security Incident & Breach Notification Policy — The Open CRM

**Effective date:** 2026-05-12
**Status:** DRAFT — pending counsel review (see [`LEGAL_TODO.md`](./LEGAL_TODO.md))

This Policy describes how we detect, respond to, and notify users about
security incidents affecting The Open CRM (the "Service"). It also
describes our commitments to users and our reciprocal expectations of
users.

## 1. Definitions

- **Security incident:** any event that may have resulted in
  unauthorized access to, disclosure of, or alteration of personal
  information or workspace data.
- **Confirmed breach:** a security incident where forensic
  investigation establishes that unauthorized access actually
  occurred.
- **Affected user:** an account holder whose personal information or
  workspace data is reasonably believed to have been involved in a
  confirmed breach.

## 2. How we detect incidents

- **Continuous logging** of authentication events, administrative
  actions, and database modifications via the append-only
  `audit_log` (tamper-evident via database-level triggers).
- **Per-route rate limiting** on authentication endpoints with admin
  notification when thresholds are exceeded (see
  [Privacy Policy §6](./PRIVACY_POLICY.md)).
- **Dependency vulnerability scanning** via periodic `npm audit` and
  manual quarterly review.
- **User reports** via johncolesassistant@gmail.com — we treat every
  credible report as a potential incident until investigated.

## 3. Response timeline

When we detect or are notified of a possible incident:

| Phase | Target | What happens |
|---|---|---|
| Detection → triage | within 24 hours | Acknowledge internally; assess severity; preserve evidence (audit log, logs, backups) |
| Containment | within 72 hours of confirmation | Patch the vulnerability; revoke compromised credentials; isolate affected systems |
| Investigation | within 14 days of confirmation | Forensic analysis: what data, how many users, was data exfiltrated |
| User notification | per §4 below | Notify affected users + regulators as required |
| Post-incident review | within 30 days of resolution | Document root cause, corrective actions, and updates to this Policy |

## 4. User notification

If a confirmed breach affects your personal information or workspace
data, we will notify you:

- **Method:** email to the address on your account, in-app banner on
  next login, and (for severe incidents) an out-of-band channel like
  SMS where you've provided one.
- **Timeline:** within the timeframe required by applicable law for
  your jurisdiction. As a baseline:
  - **General default:** without unreasonable delay, and no later
    than 60 days from confirmation.
  - **California (CCPA breach notification):** without unreasonable
    delay.
  - **States with statutory clocks (e.g., Florida 30 days, Colorado
    60 days, Washington 30 days):** within the statutory window.
  - **EU (GDPR Article 33):** within 72 hours to the supervisory
    authority if applicable.
- **Content:** what happened, when, what data was involved, what we've
  done in response, what you can do to protect yourself, and contact
  information for follow-up questions.

We may delay notification if law enforcement requests it in writing or
if notification would compromise an ongoing investigation, but only for
the period required.

## 5. Regulator notification

We will notify state attorneys general, federal regulators, and other
authorities where required by law. Each state has its own threshold
(some require notification only above a certain affected-user count;
some require notification for any incident affecting their residents).

A list of state-specific notification triggers will be maintained by
counsel as part of the [`LEGAL_TODO.md`](./LEGAL_TODO.md) follow-up.

## 6. What we will NOT do

- **We will not** notify affected users via a generic blog post or
  press release in lieu of direct notification. Direct notification is
  the rule.
- **We will not** demand payment or any other consideration in exchange
  for notifying affected users.
- **We will not** misrepresent the scope or severity of an incident.

## 7. Your obligations

If you are an account holder and detect or suspect a security incident:

- **Notify us immediately** at johncolesassistant@gmail.com. Include as
  much detail as you can share (timestamps, affected accounts,
  observed behavior).
- **Preserve evidence** if you have logs or screenshots — don't delete
  anything until we've had a chance to investigate.
- **Do not publicly disclose** the incident before coordinating with us
  for at least 90 days (see [Acceptable Use Policy](./ACCEPTABLE_USE_POLICY.md)
  on coordinated disclosure for security researchers).
- **Use strong, unique passwords** and enable two-factor authentication
  where available.

## 8. What "confirmed breach" requires

To avoid false alarms, we distinguish between:

- **Anomaly** — unusual activity that may or may not indicate
  unauthorized access. Logged and investigated; no user notification
  unless escalated.
- **Suspected incident** — credible signal that unauthorized access
  may have occurred. Containment begins; user notification on
  confirmation.
- **Confirmed breach** — investigation establishes that unauthorized
  access occurred. User notification follows §4 above.

We do not notify users of every anomaly, because alarm fatigue erodes
the value of real notifications.

## 9. Liability disclaimer for this Policy

This Policy describes our commitments and current practices. It is
**not a guarantee** that our security measures will prevent all
incidents, and it is not a warranty of any kind. Our overall liability
remains as set forth in the [Terms of Service](./TERMS_OF_SERVICE.md)
and [LICENSE](../LICENSE).

## 10. Changes

We may update this Policy in response to operational changes or new
legal requirements. Material changes will be noticed via the in-app
banner or email at least 30 days before they take effect.

## 11. Contact

**Email:** johncolesassistant@gmail.com
**Operator:** John Coles, doing business as "The Open CRM"
