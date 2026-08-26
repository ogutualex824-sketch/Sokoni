# Admin Re-certification Baseline

**Opened:** 2026-08-26
**Status:** 🔴 **SCOPE DEFINED — not yet run**
**Supersedes:** `docs/ADMIN_CERTIFICATION_FROZEN.md` (preserved, not corrected)
**Admin release:** 🔴 HOLD. Admin tree **frozen** — no code changes pending this baseline.

> The previous certification was real work honestly recorded. It is superseded because it
> measured **the wrong lineage, one navigation surface, and a security model production has
> since replaced** — not because its method was wrong.

---

## Why a new baseline rather than a correction

| # | Finding | Consequence |
|---|---|---|
| 1 | `admin.html`'s 3026 passcode and `super-admin.html`'s `_promptSuperPass` **do not exist in production** — measured at 0 Cloud Functions / 0 rules, with a hardcoded master passcode bypassing the stored hash | 3 of 9 BLOCKED rows describe a control that is gone |
| 2 | Every run enumerated `#sk-adm-side` only | **page-local chrome was never certified on any of 50 surfaces** |
| 3 | Built on a lineage **320 commits behind live**; 9 of 58 publishable files diverged | results describe branch behaviour, not production |
| 4 | The production auth model is **stronger** than the branch's | porting the branch would regress security |

**Principle established, and worth keeping:** *a client-side credential the server never
observes is not a security control because the UI calls it a second factor.* Production
reached that conclusion first, with measurement, and recorded it inline.

---

## Scope the new baseline MUST cover

1. **Shared shell navigation** — `#sk-adm-side`, as before.
2. **Page-local chrome** — the surface the old certification never touched. 7 of 50 pages have
   their own nav: `admin-os`, `enterprise-ops`, `search-quality`, `subscription-billing`,
   `trust-safety`, `commission-engine`, `financial-os`. These are **application chrome**
   (counters, groups, user info, 22 controls on `admin-os` alone), not disposable duplicates.
3. **Current production auth model** — claims checks, `SokoniAdminEntry.guard()`, denial on
   verification failure. Not the branch's passcode overlays.
4. **Registered destinations only** — reachability must not be extended to unregistered pages.

## Explicitly OUT of scope

- Exposing `platform-hub.html`, `finos.html`, `automation-engine.html` (see below).
- Any z-index or shell-authority change made to satisfy a test.
- Re-classifying superseded rows in place.

---

## Open decisions blocking the baseline

### D1 — ADMIN-OS local navigation architecture · ✅ **DECIDED 2026-08-26**

`admin-os.html` is the Admin home. Its own chrome carries 9 cross-page links that are
**unreachable** beneath the shared shell (all 9 sit below the fold; the shell's sidebar owns
the visible column at z-890 vs the page's z-100).

Measured classification of those 9:

| Bucket | Count | Detail |
|---|---|---|
| Registered **and** already in the shell | **6** | `platform-health`, `trust-safety`, `launch-readiness`, `reliability-center`, `automation-center`, `super-admin` |
| Registered, **no** shell equivalent | **0** | — |
| **Unregistered** | **3** | `platform-hub`, `finos`, `automation-engine` |

**There is no functional requirement to expose the buried navigation:** every legitimate
destination is already reachable through the shell at the same authority, and the only links
the shell does *not* offer are the three uncertified ones.

The question is therefore architectural, not corrective:

> Is the shared Admin shell the **sole** cross-page navigation authority, or does `admin-os`
> have its own navigation surface?

- **Shell is sole authority** → keep `admin-os`'s controls, groups, counters and user info;
  rework the 6 redundant shortcuts deliberately so the page does not look hollow; drop the 3
  unregistered links rather than exposing them.
- **`admin-os` has its own navigation** → requires a deliberate shell/layout integration that
  keeps the 3 unregistered destinations behind an authority boundary — **not** a z-index change.

**Do not remove the 6 links as a quick fix.** They are redundant, but removing them hollows
out the Admin home's own chrome — a UX regression traded for no functional gain.

#### DECISION

> **The shared Admin shell is the authoritative cross-page navigation.** `admin-os` keeps its
> page-local operator chrome and in-page controls, but does not need a second set of
> cross-page shortcuts.

**Retained on `admin-os`:**

- the Dashboard / Users / Marketplace local groups
- the ticket badge (`sidebarTicketBadge`), user information (`aosUserName`, `aosUserRole`),
  counters, and the other 22 non-link controls
- the visual structure that makes `admin-os` useful as an operator workspace

**Consequences that follow from this decision, and are now binding:**

- **One navigation authority.** No second cross-page navigation surface is created.
- **The three unregistered destinations stay unavailable** — see D2. Fixing the collision is
  not a route to exposing them.
- **The global shell z-index is not altered.** The shell remains z-890; `admin-os`'s chrome
  remains z-100. The buried links are redundant, not load-bearing.
- **The 6 registered shortcuts are NOT removed yet.** Every one is already reachable through
  the shell at the same authority, so removing them costs nothing functionally — but it would
  hollow out the Admin home's own chrome. That is a **UI cleanup to be designed**, not a
  "fix the broken links" hack. Sequence: decide how the local groups should read without the
  shortcuts, then change the markup once.

**What this decision does NOT do:** it does not make the buried links reachable, does not
change the shell, and does not touch product code. It fixes the *target* so recertification
measures the intended model rather than a moving one.

**Status of the underlying defect:** the 9 unreachable links remain unreachable, deliberately.
With 6 duplicated in the shell and 3 unregistered, there is **no functional requirement** to
expose them. The defect is downgraded from a navigation failure to a **pending UI cleanup**.


### D2 — Three unregistered destinations · ⏸ **CONFIRMED UNAVAILABLE 2026-08-26**

`platform-hub.html`, `finos.html`, `automation-engine.html` — all three exist on disk, none
are in the registry, none carry a certified authority.

**Do not add them to the registry to make navigation or an audit look complete.**
`platform-hub.html` was deliberately excluded for unproven `claims.role` semantics; the other
two have no recorded decision at all.

#### DECISION — keep them unavailable

| Page | Why it stays out |
|---|---|
| `platform-hub.html` | authority semantics unresolved (`claims.role`) |
| `finos.html` | no recorded authorization decision |
| `automation-engine.html` | no recorded authorization decision |

Each needs an explicit product/authority decision **later**. Until then they are not
registered and not certified.

> **Correction (2026-08-26):** the earlier wording said they were "not reachable from any
> admin surface". That was assumed, not measured. It is false for `finos.html` — see the
> violation below.

#### VIOLATION FOUND 2026-08-26 — `financial-os.html` → `finos.html` · 🔴 **FAIL**

Measured by `scripts/recertify-admin-baseline.js` (Phase 2) after three probe defects
were corrected. The first run's assertion counted *all* reachable cross-page links, so
this page failed for the wrong reason and other pages failed spuriously. The corrected
assertion asks the only question D2 cares about: **is an unregistered destination
reachable?**

| Fact | |
|---|---|
| Page | `financial-os.html` |
| Link | page-local chrome → `finos.html` |
| Registry | `finos.html` is **NOT registered** |
| Reachable | **YES** — 1 unregistered present, 1 reachable |
| D2 result | **5/6 PASS, 1 FAIL** |

**`admin-os.html` remains compliant** — 3 unregistered links present, **0 reachable**.
They sit buried beneath the shell, which is precisely the state D1 chose to leave
alone. Presence is not the violation; reachability is.

**Do NOT resolve this by registering `finos.html`.** That would make the test pass by
granting an uncertified surface an authority nobody has decided. `finos.html` has no
recorded authorization decision — see D2 above. Nor is this to be fixed by altering
z-index or shell behaviour.

**Do not fix it before the integration candidate is measured.** Fixing now destroys the
baseline that shows what the Admin programme actually introduces versus what production
already had.

#### DISPOSITION ANALYSIS 2026-08-26 — evidence, and why the link stays for now

**Recommendation: (a) obsolete legacy surface, retire from Admin navigation.**
NOT registration, NOT keep-but-unreachable. **Not yet actioned** — see the
dependency chain below.

##### The three financial surfaces compared

| | Registry | Gate | Claims refs | Collections |
|---|---|---|---|---|
| `financial-os.html` (66,130b) | **registered** finance/admin | `data-admin-guard="admin"` | 2 | escrows, finosAuditLog, fraudAlerts, ledger, payouts, **promotions** |
| `finos-admin.html` (66,171b) | **registered** finance/admin | `data-admin-guard="admin"` | 2 | escrows, fosRefundQueue, subscriptionAuditLog, withdrawals |
| **`finos.html`** (54,290b) | **not registered** | none — only the unenforced `data-require-role` | **0** | commissionRules, finosAuditLog, fraudAlerts, ledger, payouts |

**`finos.html` is functionally near-subsumed.** Four of its five collections —
`finosAuditLog`, `fraudAlerts`, `ledger`, `payouts` — are already served by
`financial-os.html`, which is registered, claims-gated, larger, and covers two more.
Both are "FinOS"; `finos.html` is the smaller, older-model one. File recency does not
discriminate: all three were last touched by the same sweep commit.

##### Its one unique function — narrow, and read-only

`commissionRules`, read at `finos.html:688` in `_loadRules()`. **No other page reads
that collection** (`commission-engine.html` reads none by that pattern;
`commission-admin.html` reads `ledger`/`wallets`). So removing the link WOULD orphan a
viewer — but the rules are:

```
match /commissionRules/{ruleId} {
  allow read:   if isAuthed();
  allow create: if isAdmin();
  allow update: if isAdmin();
}
```

`finos.html` cannot write them. It is a **read-only view of admin-managed data that
any authenticated user may already read.**

##### Why NOT the other two options

- **(b) register it** — it has **zero** claims references. Registering would place an
  uncertified surface into the population and grant it registry authority it does not
  implement. That is registering to make D2 pass. Bringing it to standard means adding
  `data-admin-guard` and a claims gate, at which point it duplicates `financial-os.html`.
- **(c) keep but unreachable** — that is the status quo for `admin-os`'s three buried
  links, and it leaves a surface carrying a **false role declaration** alive in the
  workspace.

##### Why the link is NOT removed yet — ORDERING MATTERS

Deleting the link is **not sufficient**: `finos.html` stays reachable by direct URL
behind only a `localStorage` gate regardless of navigation. Removing it would fix D2's
**certification status** while leaving the authority defect untouched — and would
orphan the `commissionRules` viewer before it has a home.

**D2's resolution depends on the role-authority decision, not the reverse.**

##### Dependency chain

1. **Role-authority decision** — authoritative home for the `commissionRules` viewer;
   address the unenforced `data-require-role`.
2. **FinOS legacy disposition** — formally retire `finos.html` once its remaining
   useful function has a proper home.
3. **Navigation change** — remove the `financial-os` → `finos.html` shortcut.
4. **Re-run D2** — confirm no registered Admin surface exposes an unregistered destination.
5. **Direct-entry test** — separately verify `finos.html` cannot present an admin
   console to an unauthorized user.

**The distinction to preserve:** D2 is a **navigation/registry** violation; the
`finos.html` gate is a **separate authority** defect. Fixing one does not fix the other.

##### AUTHORITY VERIFIED 2026-08-26 — commission-engine is server-enforced

`functions/commission.js:25`

```js
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}
```

**Fails closed** — optional chaining yields `undefined` for absent auth, absent token or
absent claims, so every one throws.

| Callable | `_assertAdmin` | Note |
|---|---|---|
| `listCommissionRules` | ✅ | before the query is even constructed |
| `createCommissionRule` | ✅ | before validation/write |
| `updateCommissionRule` | ✅ | before read/update |
| `deleteCommissionRule` | ✅ | soft-delete, records `deletedBy` |
| `previewCommission` | ❌ **by design** | authenticated only; calculator, returns no rule data |
| `getCommissionConfig` | ❌ **by design** | authenticated only; DEFAULT table, **never reads `commissionRules`** |
| `getAdminRevenueByHub` | ✅ (inline) | same claim check |

**FOUR deliberately separated concepts**, per the file's own comment (848-852):

| Concept | Endpoint | Authority | Reads `commissionRules` |
|---|---|---|---|
| Rule administration | the four rule callables | **admin/superAdmin** | yes |
| Authoritative calculation | `previewCommission` | authenticated | yes, via `finos-utils` |
| Seller display | `getCommissionConfig` | authenticated | **no — defaults only** |
| Admin revenue | `getAdminRevenueByHub` | **admin/superAdmin** | — |

> *"it deliberately requires no admin claim: a seller must be able to see what they will
> be charged… for a real, order-specific, authoritative figure the caller must use
> `previewCommission()`. That distinction is the point: this endpoint is for DISPLAY,
> never for computing money."*

##### What this settles

| Path | Authority |
|---|---|
| `commission-engine.html` → callables | **admin/superAdmin claims, server-enforced** |
| `finos.html` → direct Firestore read | `allow read: if isAuthed()` |

`finos.html` reads **`commissionRules` directly** — the collection the design reserves for
admin-gated administration — while the sanctioned authenticated-display path
(`getCommissionConfig`) deliberately returns defaults and never reads it. It is not merely
a weaker duplicate; it is an authenticated surface reading the administration collection
that the intended display endpoint pointedly avoids.

**D2 disposition CONFIRMED: retire `finos.html` from Admin navigation. Do not register it.**
`commission-engine.html` is already the authoritative home, already linked from
`financial-os.html:171`. No migration and no replacement UI are required.

##### Boundaries that must NOT be blurred

1. **D2 is navigation/certification.** Removing the link resolves D2 only.
2. **`finos.html` stays directly reachable** behind the unenforced `data-require-role` /
   `localStorage` gate. Retiring the link does **not** fix that — separate role-authority track.
3. **`commissionRules` remains `isAuthed()`-readable.** Retiring a page does **not** change a
   Firestore rule. Whether `isAuthed()` is the right authority for that collection is its own
   backend-policy question.
4. **`functions/finos-utils.js:397` reads `commissionRules` directly** server-side. That is a
   server utility, **not** a client-reachable bypass — and it means `commission.js` is not the
   only server module touching the collection.

##### Not yet actioned

The navigation removal is a **product change** and awaits explicit authorization. Production
HOLD stands; D2 remains FAIL in the ledger until the change is made and re-tested.




### D3 — `enterprise-ops` header collision · ✅ **SCOPE AGREED 2026-08-26**

`nav#sidebar.eoc-sidebar` is z-900, **above** the shell's z-890, and its 10 links are
in-page section anchors (`#sec-overview` … `#sec-dr`) with **no** shell equivalent — legitimate
unique navigation that must be preserved. One genuine defect: `#sec-alerts` is covered by the
shell header. Fix locally; **do not** change the shell's global z-index or authority to solve it.

#### AGREED SCOPE

- **Preserve** the unique section navigation (`#sec-overview` … `#sec-dr`, 10 anchors, 0 shell
  equivalents).
- **Fix only** `#sec-alerts` being hidden under the shell header.
- **No global shell z-index change.** The fix is local to this page.

This is the only one of the three that involves a product change, and it is contained to a
single link on a single page.

---

## Method notes carried forward

Recorded because the value of the new baseline depends on not repeating these:

- **Indexing scope decides what you can find.** `#sk-adm-side`-only enumeration produced a
  truthful 49/50 that was irrelevant to the reported symptom. All-`<a>` indexing found it.
- **`a.click()` and `dispatchEvent` do not navigate every element; a real pointer does.**
  Both produced false "does not navigate" results here. Use real pointer clicks, whose
  actionability check also detects interception.
- **A duplicate-link count does not characterise a container.** Five sidebars looked like
  duplicate navigation by link count and turned out to be application chrome with live counters.
- **Uniform results indict the probe.** `0/50` was `cleanUrls` stripping `.html`, not 50 defects.

## Related

`docs/ADMIN_CERTIFICATION_FROZEN.md` (superseded) · `docs/ADMIN_BLOCKED_REGISTER.md` ·
`docs/ROLE_AUTHORITY_CONVERGENCE_TRACK.md` · `docs/admin-certification-ledger.json`
