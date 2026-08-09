# ADR-003 — Business authority may not live in localStorage

**Date:** 2026-08-02 · **Status:** Accepted · **Enforced by:** `scripts/audit-admin-localstorage.js` (ratchet, predeploy)

## Decision

Business-authoritative state lives in Firestore. `localStorage` holds **client-only** state:
preferences, drafts, dismissed banners, per-device session flags, consent decisions.

**Test for KEEP:** losing the key — or another device holding a different value — **cannot change a
business outcome**. "It looks like UI" is not a reason.

## Evidence

`localStorage` is per-origin **and per device**. Three panes failed on that fact independently:

| pane | failure |
|---|---|
| Orders | the dispute button wrote localStorage only; the change never reached Firestore |
| Users | `sokoniAllUsers` had one reader and one writer and **nothing ever populated it** — the pane said "No users found" permanently while **61 accounts** sat in Firestore |
| Properties | approving a listing changed nothing any host, guest or other admin could see |

**Inventory: 49 keys · 4 KEEP · 45 REPLACE.** Several are financial — commission ledger, commissions,
tax payments, costs, booking and lead fees. A commission figure that differs per device is worse than
a listing that does.

## What this forbids

- Reading or writing business records in an admin page's `localStorage`.
- A "cache" that is the only copy. If nothing else writes it, it is not a cache — it is the authority.
- Raising the ratchet baseline to silence a failure.

## Consequences

A ratchet, not a wall: an absolute guard against 45 violations would fail every deploy until the
backlog cleared, and a gate that blocks everything gets disabled. The count may fall freely and may
never rise. **When it reaches zero, `predeploy` switches to `--ci` and the door closes permanently.**
