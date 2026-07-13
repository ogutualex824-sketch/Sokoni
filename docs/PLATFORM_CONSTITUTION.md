# SOKONI Platform Constitution
## Enterprise Architecture Constitution — Version 1.0 (Permanent)

> This document is permanent. Every future sprint must comply with it.
> Only the **Current Sprint** section changes between releases.

---

## Mission

SOKONI is not a marketplace.

SOKONI is **Africa's Commerce, Workforce and Enterprise Operating System.**

Every enhancement must strengthen the platform instead of creating isolated features.

---

## Vision

Build the most trusted, intelligent, scalable and premium commerce platform in Africa.

The experience should rival Google Workspace, Microsoft 365, Shopify Plus, Stripe, Square, Slack Enterprise, Uber, LinkedIn, and Apple — without copying them.

---

## Platform Philosophy

```
One Person
    ↓ One Identity
    ↓ Unlimited Businesses
    ↓ Unlimited Organizations
    ↓ Unlimited Workspaces
    ↓ Unlimited Roles
    ↓ Unlimited Devices
    ↓ Unlimited Opportunities
```

Everything revolves around the user's **permanent identity**.

---

## Engineering Principles

**Always:**
- Reuse existing architecture.
- Prefer integration over expansion.
- Prefer configuration over duplication.
- Prefer reusable services over feature-specific code.
- Prefer platform capabilities over one-off solutions.
- Every feature should be reusable by future modules.

---

## Non-Negotiable Rules

**Never:**
- Duplicate authentication.
- Duplicate wallets.
- Duplicate notifications.
- Duplicate legal systems.
- Duplicate search engines.
- Duplicate analytics.
- Duplicate payment engines.
- Duplicate business logic.
- Duplicate Cloud Functions.
- Duplicate UI components.
- Redesign working systems.
- Break existing APIs.
- Break existing users.

---

## Canonical Platform Engines

These are **canonical**. Extend them. Do not rebuild them.

| Engine | Purpose |
|---|---|
| [[Identity Engine]] | Permanent SOKONI ID, trust, verification |
| [[Authentication Engine]] | Google, Phone, Email, Passkeys, MFA |
| [[Organization Engine]] | Businesses, orgs, branches, hierarchies |
| [[Workforce Engine]] | Staff, shifts, payroll, attendance |
| [[Role Engine]] | buyer, seller, driver, provider, employer, admin |
| [[Permission Engine]] | ABAC, role-scoped access control |
| [[Session Engine]] | Device management, cross-device continuity |
| [[Notification Engine]] | Push, in-app, SMS, email — one entry point |
| [[Communication Engine]] | Chat, inbox, transaction-gated messaging |
| [[Legal Engine]] | Agreements, consent, compliance, eTIMS |
| [[Wallet Engine]] | Single wallet per identity; all roles share it |
| [[Payment Engine]] | M-Pesa, STK push, reconciliation, escrow |
| [[Subscription Engine]] | Plans, billing cycles, grace periods |
| [[Analytics Engine]] | Revenue, orders, growth, seller health |
| [[Search Engine]] | Universal search, Swahili NLP, faceted |
| [[Document Engine]] | Vault, expiry tracking, verification |
| [[Profile Engine]] | Career, achievements, ID card, completion |
| [[Trust Engine]] | Trust Score 0-100, identity levels |
| [[Verification Engine]] | Phone, ID, KRA, bank, business |
| [[AI Engine (KASS)]] | Claude Haiku, tools, executive assistant |
| [[Marketplace Engine]] | Products, listings, orders, reviews |
| [[POS Engine]] | SmartPOS, multi-till, cash manager, eTIMS |
| [[Healthcare Engine]] | Appointments, patients, prescriptions |
| [[Property Engine]] | Listings, occupancy, maintenance, rent |
| [[Logistics Engine]] | Dispatch, tracking, GPS, delivery |
| [[Finance Engine]] | FinOS, double-entry, WHT, settlement |

---

## Architecture Requirements

Every feature must be:

- **Modular** — self-contained, independently testable
- **Composable** — combines cleanly with other engines
- **Reusable** — provides value to future modules
- **Maintainable** — clear ownership, documented contracts
- **Scalable** — works at 10× current load without redesign
- **Enterprise Ready** — audit logs, RBAC, rate limiting
- **Cloud Run Friendly** — cold-start aware, stateless
- **Billing Efficient** — minimal Firestore reads/writes
- **Offline Ready** — graceful degradation without network
- **Mobile First** — 360px baseline, tablet, desktop layers

---

## Identity Model

One person owns:

- Identity, Wallet, Career, Businesses, Organizations
- Certificates, Documents, Achievements, Legal Agreements
- Trust, Security, Session history

**Businesses own permissions. Never identities.**

---

## User Experience Standards

Everything should feel:

- **Executive** — commands, not menus
- **Elegant** — white space, hierarchy, restraint
- **Fast** — <2s meaningful paint, skeleton loading
- **Minimal** — only show what matters now
- **Professional** — premium dark design system
- **Adaptive** — role and context aware
- **Premium** — glass cards, smooth transitions, no clutter

Avoid clutter. Avoid repeated navigation. Avoid duplicate actions.

---

## Intelligence Mandate

The platform must always know:

- Who the user is.
- Where they are working.
- What they were doing.
- What needs attention.
- What should happen next.

Do not make users search for important information. Bring relevant information to them.

---

## Adaptive Experience

Interfaces automatically adapt to:

- Role, Workspace, Permissions, Business Type
- Current Activity, Device, Subscription
- Trust Level, Profile Completion

**Never show every feature to every user. Show what matters.**

---

## Performance Targets

- Low latency — skeleton UI within 200ms
- Minimal Cloud Run services — batch where possible
- Minimal Firestore reads — cache aggressively
- Minimal writes — idempotent, batched
- Minimal cold starts — shared function modules
- Lazy loading — tab and route based
- Smart caching — `window._piOverview`, localStorage
- Parallel requests — fan-out where safe
- Billing efficiency — no polling, no redundant reads

---

## Security Requirements

Everything sensitive is enforced **server-side**. Never trust the client.

Support: MFA, Passkeys, Google/Phone/Email login, Device Management, Session Management, Risk Detection, Immutable Audit Logs.

Audit everything. Protect against XSS, CSRF, IDOR, injection, privilege escalation.

---

## AI (KASS) Role

KASS is the executive assistant. It should:

- **Guide** — onboarding, setup, discovery
- **Recommend** — actions, products, optimisations
- **Predict** — stock alerts, payment failures, churn
- **Explain** — analytics, anomalies, trends
- **Summarize** — daily briefs, order digests, reports
- **Automate** — repetitive decisions with user approval

Without replacing user control.

---

## Sprint Template

> Only the **Current Sprint** section changes between releases.

### Current Sprint

*Defined per-release. References this constitution by default.*

**Rules:**
- Implement ONLY the functionality described for this sprint.
- Reuse every existing engine whenever possible.
- If functionality already exists, extend it — do not rebuild it.
- Only introduce new Cloud Functions when reuse is impossible.
- Keep Cloud Run usage low. Maintain billing efficiency.
- Maintain backward compatibility.

### Deliverables

Every sprint must produce:

1. Working, production-ready code
2. Integration with existing engines
3. Regression verification
4. CHANGELOG entry (date, summary, files, DB changes, API changes, security, breaking changes)
5. Deployment notes
6. Rollback notes
7. Operator actions (if required)

### Success Criteria

| Check | Requirement |
|---|---|
| ✓ | Zero breaking changes |
| ✓ | Zero duplicate engines |
| ✓ | Zero duplicate business logic |
| ✓ | Zero duplicate authentication |
| ✓ | Zero duplicate wallets |
| ✓ | Zero unnecessary Cloud Functions |
| ✓ | Zero unnecessary indexes |
| ✓ | Zero unnecessary billing increase |
| ✓ | Existing users unaffected |
| ✓ | Enterprise quality |
| ✓ | Production ready |

---

## Roadmap Integration

Future features must extend the platform rather than replace it:

- Adaptive Dashboard, Executive Morning Brief
- Universal Command Palette (Ctrl+K)
- Journey Mode, AI Predictions
- Business Health, Smart Widgets
- Marketplace Intelligence
- Cross-Workspace Search, Document Intelligence
- Executive Analytics, Voice Commands
- Public Professional Profiles
- Cross-device Continuity
- Organization Hierarchies

All must fit naturally into the existing architecture.

---

## The Final Rule

> Before writing any code, ask:
>
> **Can an existing engine do this?**
>
> **Can this be reused elsewhere?**
>
> **Will this still make sense when SOKONI is ten times larger?**
>
> If the answer is no — redesign the implementation, not the architecture.

---

*Ratified: 2026-07-13*
*Status: Permanent — supersedes all previous architecture decisions*
*Maintained by: SOKONI Engineering*

[[Profile Engine]] | [[Identity Engine]] | [[Payment Engine]] | [[KASS]] | [[Marketplace Engine]] | [[POS Engine]]
