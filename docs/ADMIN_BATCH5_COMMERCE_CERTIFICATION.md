# Admin Navigation & Device Certification — Batch 5: Commerce

**Date:** 2026-08-25
**Scope:** 5 Commerce pages
**Widths:** 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

> **Not deployed.** Production HOLD stands. Indexes staged.

---

## Results — the cleanest batch so far

| Certification | Result |
|---|---|
| Navigation | **5/5 PASS** (45/45 checks) |
| Responsive | **33/35** — 4 PASS, 1 PARTIAL, 0 BLOCKED, 0 NOT RUN |
| Shell controls (boundary) | **35/35** |

| Page | Result | Widths | Cause |
|---|---|---|---|
| `admin-subscriptions.html` | **PASS** | 7/7 | — |
| `subscription-os.html` | **PASS** | 7/7 | — |
| `subscription-billing.html` | **PASS** | 7/7 | — |
| `sasos-admin.html` | **PASS** | 7/7 | — |
| `automation-center.html` | **PARTIAL** | 5/7 | 10px overflow at 390/360: `div.hdr-right` (188px) + `.stat` (83px) header controls do not wrap |

The architecture scan predicted 5 OK / 0 AT-RISK / 0 BLOCKED for this section, and the
certification agreed — no page blocked. Prediction and result matched here, unlike
`monitor.html` in Batch 4. The scan remains planning information; the run remains authority.

---

## Tier preservation — the opposite direction from Batch 3

`subscription-os.html` requires **superAdmin**, declared in the registry. Wiring it with the
batch default of `admin` would have **LOOSENED** a gate.

That is the mirror image of `moderation.html` in Batch 3, where defaulting to `admin` would
have **LOCKED OUT** every moderator. Both directions are wrong, and both are avoided the same
way: the tier comes from the registry entry, never from a batch default.

| Page | Registry authority | Wired as | Risk if defaulted |
|---|---|---|---|
| `subscription-os.html` | `superAdmin` | `superAdmin` | gate loosened |
| `moderation.html` | `moderator` | `moderator` | moderators locked out |

---

## Navigation defects fixed — 5

| Page | Defect |
|---|---|
| `subscription-billing.html:433` | Denial path dumped admins on the customer marketplace (`location.href="/"`) |
| `automation-center.html:601` | Same — denial to `/` |
| `automation-center.html:603` | Signed-out users sent to **`admin.html`** — losing the destination AND bouncing to another gated console. Now `login.html?next=`, which is resumable. |
| `admin-subscriptions.html`, `sasos-admin.html` | Inline gates racing the shared guard |

`automation-center:603` is a new shape: not a marketplace dump, but a redirect into a
*different admin console* that has its own gate — a signed-out user would bounce between two
gates with no preserved destination.

### Running count of marketplace-dump denial paths

**13 found and fixed** across the original audit and five batches — 11 in the audit,
`fleet-monitor` in Batch 4, and these two. It is the single most persistent defect class in
this codebase, and it appeared in a security console (`security-zero-trust-dashboard`) as
well as in finance and commerce surfaces.

---

## Running total

| | Pages | PASS | PARTIAL | BLOCKED | NOT RUN |
|---|---|---|---|---|---|
| Batch 1 (shell) | 9 | 6 | 2 | 1 | 0 |
| Batch 2 (Finance) | 10 | 6 | 4 | 0 | 0 |
| Batch 3 (Trust) | 5 | 2 | 2 | 1 | 0 |
| Batch 4 (Operations) | 8 | 5 | 1 | 2 | 0 |
| Batch 5 (Commerce) | 5 | 4 | 1 | 0 | 0 |
| **Certified** | **32** | **21** | **9** | **3** | **0** |
| Remaining | 18 | — | — | — | NOT RUN |

Batches 1 and 4 overlap on 5 Operations pages; each page is counted once.

Remaining: Enterprise (5), Administration (2), Platform (15 — last, highest concentration of
unusual auth architecture).

---

## Related

`docs/ADMIN_BLOCKED_REGISTER.md` · `docs/ADMIN_PAGE_LOCAL_REMEDIATION_QUEUE.md` ·
`docs/ADMIN_AUTH_ARCHITECTURE_SCAN.md`
