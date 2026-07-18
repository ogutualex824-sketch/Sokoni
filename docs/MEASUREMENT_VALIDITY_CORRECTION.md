# Measurement Validity Correction — 2026-07-18

**Status:** Corrective record. Supersedes conflicting statements in
[[PRODUCTION_STABILIZATION_REPORT]] and the Phase 2 baseline tables.
**Code changed:** none. Comments and documentation only.

---

## Summary

Three conclusions reported during the Performance Stabilization Sprint were wrong. All three
share one cause: **the measurement harness never asserted which URL it had landed on.** SOKONI's
RBAC-gated pages redirect unauthenticated sessions, so the harness measured the redirect target
while labelling the result with the requested page's name.

Withdrawn:

| Claim as reported | Actual |
|---|---|
| SmartPOS has ~85 aborted requests (reproducible defect) | Navigation cancellation from `/pos` → `/pos-setup`. Expected. |
| All 10 SmartPOS hardware/data modules missing at runtime (P0) | Measured on `/pos-setup`, which correctly does not load them. No defect. |
| SmartPOS heap 3 MB vs 16–24 MB elsewhere (suspected leak/lifecycle bug) | `/pos-setup` loads 35 scripts / 186 KB. Heap tracks payload. No defect. |

A fourth claim, the P0-1 parser-restart mechanism, is withdrawn separately below.

---

## Evidence

Controlled comparison — the same file, reached two ways:

| Page | Final URL | Redirected | Aborts | `document.characterSet` |
|---|---|---|---|---|
| `/pos` | `/pos-setup` | yes | **82** | UTF-8 |
| `/pos-setup` | `/pos-setup` | no | **2** | UTF-8 |
| `/checkout` | `/login` | yes | 6 | UTF-8 |
| `/login` | `/login` | no | 5 | UTF-8 |
| `/` | `/` | no | 5 | UTF-8 |

A byte-identical file produced 82 aborts via redirect and 2 loaded directly. No property of the
file can explain a 40× difference when the file did not change. The aborts are the browser
cancelling in-flight requests on navigation — `net::ERR_ABORTED` behaving as specified.

Memory, measured with `--expose-gc`, forced collection, 600 ms settle:

| Page | Scripts | JS bytes | Heap | Post-GC |
|---|---|---|---|---|
| `/pos-setup` | 35 | 186 KB | 3.4 MB | 3.2 MB |
| `/` | 77 | 779 KB | 18.2 MB | 16.3 MB |
| `/search` | 64 | 683 KB | 19.7 MB | 13.8 MB |

Heap scales with script payload. Post-GC drops of 0.3–5.9 MB indicate live retained objects, not
uncollected garbage. Nothing fails to release.

---

## Baseline validity audit

5 of 9 rows in the Phase 2 baseline were invalid. **Every invalid row is an authenticated page** —
precisely the merchant-critical surfaces.

| Page | Requested | Actually measured | Verdict |
|---|---|---|---|
| Home | `/` | `/` | valid |
| Search | `/search` | `/search` | valid |
| Orders | `/track` | `/track` | valid |
| Inventory | `/pos-inventory` | `/pos-inventory` | valid |
| Checkout | `/checkout` | `/login` | **invalid** |
| Wallet | `/wallet` | `/login?redirect=wallet.html` | **invalid** |
| SmartPOS | `/pos` | `/pos-setup` | **invalid** |
| SellerDash | `/seller` | `/login` | **invalid** |
| Admin | `/admin` | `/login` | **invalid** |

The 5-run median/P95/stddev methodology was sound. The failure was that it never verified its
subject. **Low variance actively disguised the error** — `/pos` reported sd=2 across 5 runs
because it consistently measured the same wrong page. Stability was read as trustworthiness.

### Harness fix

`perf-baseline.js` now compares `page.url()` to the requested path, discards any run that landed
elsewhere, and reports the page as `UNMEASURED` naming the redirect target. It can no longer
publish a number for a page it did not load.

---

## P0-1 root cause — corrected

**Confirmed, unchanged:** the POS/admin pages called
`initializeApp(window._sokoniConfig || {})` (`pos-hq.html:645` at `2cdbe8b~1`) against a global
that was never defined. `git grep 'window._sokoniConfig ='` returns **zero assignments**, before
the fix and after. Firebase Auth / Firestore / Storage / Functions were genuinely dead with
`auth/invalid-api-key`. The defect was real and [[sokoni-firebase-config]] resolves it.

**Withdrawn:** the explanation that the config script was "fetched but never executed" because a
late `<meta charset>` forced a parser restart that discarded the speculatively-preloaded tag.
That rested on the same unasserted-URL DOM probe: the probe inspected the **login page's** DOM,
which legitimately contains no `sokoni-config.js` tag, and misread that absence as a parse
failure. Additionally, `pos.html` and `checkout.html` begin with a **UTF-8 BOM**, which outranks
`<meta charset>` in the encoding-sniffing algorithm — the proposed mechanism cannot apply to them
at all. `document.characterSet` resolved to UTF-8 on every page tested; the parser had nothing to
restart for.

The ES-module implementation is **retained and accepted** — not as a parser workaround, but
because a single exported constant imported through the module graph gives one authoritative
source with no classic-script load-order dependency.

**Not verified:** whether the classic-script global form would also have worked on the eight
module-SDK pages. Confirming that requires an authenticated session on RBAC-gated pages, which
has not been run. This claim must not be restated without that evidence.

---

## Consequences

1. **The charset pilot was not executed.** Its premise is disproven; moving `<meta charset>` would
   remove zero aborts. Filed to [[PHASE1_POST_PILOT_BACKLOG]] as standards hygiene, not an RC1 item.
2. **No generator exists.** Verified: no template engine or bundler in `package.json`; zero
   `.ejs/.pug/.hbs/.njk/.mustache/.liquid` files; no `.eleventy.js`/`gulpfile.js`/`vite.config.js`/
   `_config.yml`; no script in `scripts/` writes `.html`. All 320 HTML files are hand-authored.
   Retained because it answers the same question for any future platform-wide HTML change.
3. **Authenticated pages have never been performance-measured.** This is now the sprint's largest
   open gap, and it covers SmartPOS, Checkout, Wallet, Seller and Admin. Closing it needs an
   authenticated harness session.

---

## Governance note

Under [[feedback_audit_methodology]], a finding is reportable only after scanner blind spots are
fixed and execution paths manually verified. The blind spot here — an unasserted measurement
subject — was in the tooling, and it produced a P0 escalation that had no defect behind it.

**Standing rule added:** any browser-based measurement must assert its final URL before its output
is used as evidence. A metric attributed to a page that was never loaded is not a weak
measurement; it is a fabricated one.
