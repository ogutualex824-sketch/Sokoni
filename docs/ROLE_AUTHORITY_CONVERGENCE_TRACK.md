# Role Authority Convergence — remediation track

**Opened:** 2026-08-26
**Status:** 🔴 **OPEN — specification required before any code change**
**Class:** server-side identity / authorization architecture
**Explicitly NOT:** an admin-navigation cleanup, and not part of the admin certification programme.

> Found while auditing the admin programme for a competing role authority. The client
> side is clean — `sokoni-admin-guard.js` only *reads* the claim, which is what
> `role-authority.js` itself names as the sole client-side authority. **The divergence is
> entirely server-side.**

---

## The invariant that is not true

`functions/role-authority.js` opens by declaring itself:

> "the **ONE** primitive that grants or revokes an account role, and the **ONE** writer of
> the Auth custom claim that mirrors it."

Measured against the code, that invariant does not hold.

### Claim-writer census (production code; tests, scripts and vendored code excluded)

**16 call sites across 10 modules** call `setCustomUserClaims()` directly:

| Module | Sites | Lines |
|---|---|---|
| `index.js` | 6 | 216, 264, 303, 5445, 5496, 5949 |
| `security-incident-response.js` | 2 | 152, 235 |
| `account-status.js` | 1 | 39 |
| `admin-os.js` | 1 | 155 |
| `beta-access.js` | 1 | 135 |
| `invitations-core.js` | 1 | 409 |
| `provider-onboarding.js` | 1 | 424 |
| `super-admin.js` | 1 | 150 |
| `universal-onboarding.js` | 1 | 206 |
| **`role-authority.js`** | 1 | 187 — *the declared primitive, one writer among ten* |

Only **three** modules consume the primitive: `application-lifecycle.js`,
`automation-engine.js`, `wap.js`.

### A THIRD layer: `data-require-role` is declared but never read (found 2026-08-26)

`auth-guard.js` gates on client-writable `localStorage` and contains **zero** references to
`role` or `claims`, so `data-require-role` is enforced by nothing. Two pages rely on it as
their only client gate: `finos.html` and `dispatch.html`.
See `docs/DEFECT_UNENFORCED_REQUIRE_ROLE.md`.

**Consequence for item 2 (writer contract):** the convergence work must also settle who READS
role state on the client. Three mechanisms now coexist — `data-admin-guard` (claims),
`data-require-role` (unenforced), and `sokoni-role-authority.js` — and only the first is known
to enforce anything.

### A CLIENT-side authority also exists (found 2026-08-26)

`sokoni-role-authority.js` is present in production and **absent from the branch**. This
track originally recorded only the SERVER-side divergence; there is a second authority
layer in the client, and `sokoni-admin-entry.js` routes denial decisions through its
`RA.hubFor()`. See `docs/PRODUCTION_DENIAL_ROUTING_DEFECT.md`.

**Consequence for item 1 (canonical representation):** the decision must cover the client
layer as well as the server one. A canonical model that only reconciles
`functions/role-authority.js` against the 16 `setCustomUserClaims` sites would leave the
client authority unaccounted for.

### Two role representations, neither writer maintaining the other's

| Writer | Claim | Firestore |
|---|---|---|
| `role-authority.js` (`syncRoleClaim` / `grantAccountRole`) | yes | `users.roles[]` **arrayUnion/arrayRemove**, `registeredAs`, `approved` |
| `super-admin.js` `setUserRole` | direct | `users.role` — a **STRING** |

Approximate reader populations: **~34** files read `roles[]`, **~69** read `.role`.
So each writer is invisible to the other's readers. A role granted through either
super-admin console never appears in `users.roles[]`; a role granted through the
primitive never sets `users.role`.

This is the exact failure mode `role-authority.js` was written to prevent — its own header
describes an account that "looks healthy from every dashboard" while the user lands in the
app without the authority they were granted.

**This is not merely duplicated storage. It is two potentially divergent sources of
authorization truth.**

---

## Do NOT fix it by writing both fields everywhere

Dual-writing would make the inconsistency **harder to detect** and would invent
synchronization semantics nobody has designed. It converts a visible divergence into a
silent one.

---

## What the track must establish, in order

1. **Canonical role representation** — whether `users.roles[]`, the custom claims, or a
   deliberately defined combination is authoritative. One answer, written down.
2. **Writer contract** — exactly which function may grant/revoke a role. Every one of the
   16 sites above is then either migrated to it or explicitly exempted with a reason.
3. **Projection contract** — if claims are a projection of Firestore role state, who
   refreshes them and when. Claims are minted at token issue; a stale token is a real
   authorization state, not an edge case.
4. **Reader migration** — what happens to the ~34 array readers and ~69 string readers.
   Readers cannot migrate before the canonical representation exists.
5. **Existing-user reconciliation** — how divergent accounts are **detected** without
   silently changing anyone's permissions. Detection first; remediation is a separate,
   reviewed decision.
6. **Tests** proving grant, revoke, refresh and **stale-claim** behaviour.
   `scripts/test-role-authority.js` already exists and is now especially valuable — there
   is a real divergence for it to test against, not a hypothetical one.
7. **No silent privilege escalation during migration.** Any step that could widen access
   must fail closed and be observable.

---

## Sequencing

Keep this **separate** from:

- **`superadmin.html` retirement** — deployment-dependent, and mixing two security-sensitive
  changes makes attribution impossible when something moves.
- **The homepage desktop scroll** — unrelated, and independently blocked on real-browser
  evidence.
- **The admin certification programme** — frozen and auditable at `52a2b22` / `634ebe6` /
  `c801b22`.

---

## Standing constraints

- No production deployment. HOLD stands.
- No claim-writing behaviour changes until items 1–3 are specified and accepted.
- Detection work (item 5) is safe to build first: it only observes.

## Related

`functions/role-authority.js` · `functions/super-admin.js` · `scripts/test-role-authority.js` ·
`docs/ROLE_AUTHORITY.md` · `docs/ADMIN_CERTIFICATION_FROZEN.md`
