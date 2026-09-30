# Decision packets — DJ Bvmbxno and King Bruce (identities 3 and 4 of 6): the admin approval decision, planned read-only

**Date:** 2026-09-29 (plans at 22:03Z / 22:04Z) · **Nothing written.** Packet: `docs/release-gates/approval-decision-plans.json`. Authority: `bizAdminApprovalDecide` ([[APPROVAL_DECISION_AUTHORITY]], proven 40/0). Contract: `scripts/approval-decision-manifest.js` (`--plan` read-only; `--apply <digest> --actor <adminUid>`), proven on the fake store **15 / 0** (`scripts/test-approval-decision-manifest.js`). Kasindi is on a different path (its own application; gate tomorrow) and is not in this packet.

## 1 · What both identities are (observed, production)

| | DJ Bvmbxno `AiJp5yzT…` | King Bruce `aOdQxmUG…` |
|---|---|---|
| `providers/{uid}` | `status: active`, **no `approvedAt`**, no `approvedBy`, no `approvalDecision`, **publicly listed** | same shape: `active`, no evidence, publicly listed |
| Applications | **0** (none ever filed) | **0** |
| Activity | **4 bookings · 1 service · 3 wallet transactions**; 0 products, 0 orders | none at all (dormant); last sign-in 2026-07-18 |
| sellers / businesses / shops | absent / absent / absent | absent / absent / absent |
| Auth claims | none (no `provider` claim) | none |
| Read model today | `CAPABILITY_CONFLICT` — `provider_status_without_approval` | same |

Both are the exact class the authority was built for: live by a client-written status alone, no application to decide, and (for DJ Bvmbxno) real trading history that must remain historical evidence.

## 2 · The two possible decisions, exactly (plans, both `ok`, no refusals)

**approve** → `providers/{uid}` gets `approvalDecision { approve, decidedBy: <admin uid>, decidedAt, reason, prior { status active, approvedAt null, approvedBy null, decidedBy null }, source admin_decision }`, `status active`, `approvedAt` (server), `approvedBy <admin uid>`, `suspended false`, `updatedAt`; one `adminAudit business_approval_decision` (previous `{active, null}` → next `{active}`); the `provider` role granted through `role-authority.grantAccountRole` (each currently holds no claim). Read model afterwards: provider live by evidence, conflict cleared; resolver **still `PENDING_CLASSIFICATION`** — no route until a separate classification decision.

**refuse** → `approvalDecision { refuse, … }`, `status suspended`, `suspended true`, `searchable false`, `isPublic false`; one audit; **no** `approvedAt`, **no** role. The record stops being public.

**Untouched under either decision:** applications (none created), bookings (4 / 0), services (1 / 0), wallet + transactions (3 / 0), products, orders, sellers/businesses/shops, `users` beyond the role authority, `providers.business` (approval never classifies).

## 3 · Digests (identify the reviewed state; authorize nothing)

| Identity | Digest |
|---|---|
| DJ Bvmbxno | `7541ba8f8cf6e6086155bdfceb410aade6d42f6434a1067c70ecd5c1c796b5d7` |
| King Bruce | `21746cfc69025723ec4f7a308d23c1db4c54970926b65f6762aa2e32e2cc7e8b` |

The digest covers provider, users, sellers, businesses, shops, wallet, applications, activity counts and Auth claims. Any change before apply → `digest_mismatch`, nothing written.

## 4 · Apply controls (proven)

- `--actor` must be a **real Auth account holding the admin claim**; a tool label, a non-account, or a non-admin account is refused before any read of the target. The resulting record names that account (`decidedBy`, `approvedBy`, `performedBy`). Owner decision 2 for Kasindi applied here as well.
- One handler call; a repeated apply reports `already_decided_same` and writes nothing; a conflicting later decision is refused by the handler (`DECISION_EXISTS`).
- Landing proof after apply (template = the k Riss landing): one provider row + one audit changed; activity, wallet, users (beyond role), Auth claims (beyond `provider`) byte-identical; re-census; second apply no-op.

## 5 · What the owner decides (tomorrow), per identity

1. approve or refuse, with the reason text that goes into the record;
2. the admin account that makes it;
3. only after an approve lands: whether to classify (DJ Bvmbxno → `artist_creator` is a *separate* `bizAdminClassify` manifest with its own digest; nothing here implies it).

Command shape when authorized: `node scripts/approval-decision-manifest.js --uid <uid> --decision <approve|refuse> --reason "<owner text>" --apply <digest> --actor <adminUid>` — one identity at a time, landing proof between.

Related: [[ADJUDICATION_SIX_UNRESOLVED]] · [[APPROVAL_DECISION_AUTHORITY]] · [[KASINDI_REPAIR_PRECONDITIONS]]
