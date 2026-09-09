# Certification — recovery candidate `59b6ffe` (2D-2 merchant Messages)

**Read-only.** Not applied, not cherry-picked, no workspace created, shared tree untouched.

# 🔴 NO-GO — ALREADY PRESENT. Do not apply.

**The feature is already in production.** It arrived by a different commit. Applying `59b6ffe`
would add nothing and would overwrite **453 lines of newer production work**.

---

## Target base and ancestry

```
PRODUCTION BASE          d592d8f  (Hosting, PROVEN live)
COMMON ANCESTOR          3dcf572  2026-08-13
ANCESTRY TO PRODUCTION   PROVEN
59b6ffe ANCESTOR OF PROD NO — it lives only on the diverged branch
```

## The seven files, against production

| file | status |
|---|---|
| `sokoni-merchant-messages.js` | 🟢 **ALREADY PRESENT — byte-identical** (`c3260039422b`) |
| `sokoni-merchant-messages-ui.js` | 🟢 **ALREADY PRESENT — byte-identical** (`4d80984fb0c1`) |
| `sokoni-merchant-routes.js` | 🔴 **PRODUCTION IS AHEAD** — +453 / −33 |
| `merchant.html` | 🔴 **PRODUCTION IS AHEAD** — +414 / −413 |
| `scripts/test-merchant-messages.js` | 🔴 overlaps later production work |
| `scripts/test-merchant-messages-ui.js` | 🔴 overlaps later production work |
| `CHANGELOG.md` | 🔴 overlaps later production work |

## How the feature reached production

```
64f5d19  2026-08-19  feat(merchant): integrate the v2 shell's 18 modules
```

The two implementation files are byte-identical between `59b6ffe` and `d592d8f` — **the same
content, delivered by a different commit.** `59b6ffe` is not missing work; it is a parallel
delivery of work production already received through the v2 shell integration.

## What applying it would actually do

| | |
|---|---|
| new functionality added | **none** — both implementation files already identical |
| `sokoni-merchant-routes.js` | **overwrite 453 insertions of newer production routing** |
| `merchant.html` | rewrite backwards, 414/413 |
| test suites | replace production's newer versions |
| net effect | **regression** |

**OVERWRITE RISK: SEVERE.** This is precisely the failure mode a clean-looking cherry-pick
produces: seven files, frontend-only, its own tests, zero `functions/` — every surface signal
said safe, and the only thing that caught it was checking whether production had moved.

---

## Checks not performed, and why

Steps 5–8 — security boundary, dependency graph, frozen-system proof, test execution, UI/UX
review across viewports — were **not carried out**.

The verdict is determined at step 3: the implementation is already in production, byte-for-byte.
Reviewing the UI of a duplicate, or running tests to certify code that is already live, would
produce evidence that reads as diligence while proving nothing about the decision. The
certification correctly terminates early.

Recorded as **NOT PERFORMED — MOOT**, not as passed.

```
SECURITY (message-history boundary)   not assessed — moot; and see 9fe09e2, which is where
                                      the test-chat-history-boundary concern actually lives
PAYMENT / WALLET / LEDGER             not assessed — moot (no functions/ files in the commit)
POS TILL-ON / CARDS                   not assessed — moot
INDEX EXPORT CHANGE REQUIRED          NO — commit touches no functions/ file
TESTS                                 not run — would certify already-live code
UI/UX                                 not reviewed — duplicate of shipped behaviour
```

---

## Verdict

```
FINAL          🔴 NO-GO — ALREADY PRESENT
APPLICATION    NOT APPLIED
PRODUCTION     NOT DEPLOYED · NOT MUTATED
SHARED TREE    UNCHANGED — 235 uncommitted entries intact
```

### What this means for the recovery effort

All four candidates from `77347f1` are now resolved, and **none is recoverable**:

| commit | outcome |
|---|---|
| `59b6ffe` merchant Messages | 🔴 already in production via `64f5d19` |
| `fa5082b` multi-shop checkout | 🔴 unsplittable — frozen payment + excluded index exports |
| `9fe09e2` premium composer | 🟡 271-line backend change, needs its own security review |
| `37aa41d` seller-handover UI | 🔴 frozen |

**The diverged branch holds no work that is both missing from production and safely
recoverable in isolation.** That is a cleaner result than it first appears: the earlier
manifest's "1 of 4 recoverable" was optimistic, and the difference between that reading and
this one is a single check — *did production move these files?*

The remaining genuinely-missing work (multi-shop checkout, premium composer) sits behind the
index export governance and payment freeze. Those gates, not the recovery mechanics, are the
critical path.
