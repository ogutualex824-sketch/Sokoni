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

### D1 — ADMIN-OS local navigation architecture · **DECISION REQUIRED** (not a defect)

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

### D2 — Three unregistered destinations · **AUTHORITY DECISION REQUIRED**

`platform-hub.html`, `finos.html`, `automation-engine.html` — all three exist on disk, none
are in the registry, none carry a certified authority.

**Do not add them to the registry to make navigation or an audit look complete.**
`platform-hub.html` was deliberately excluded for unproven `claims.role` semantics; the other
two have no recorded decision at all.

### D3 — `enterprise-ops` header collision · **NARROW LAYOUT DEFECT**

`nav#sidebar.eoc-sidebar` is z-900, **above** the shell's z-890, and its 10 links are
in-page section anchors (`#sec-overview` … `#sec-dr`) with **no** shell equivalent — legitimate
unique navigation that must be preserved. One genuine defect: `#sec-alerts` is covered by the
shell header. Fix locally; **do not** change the shell's global z-index or authority to solve it.

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
