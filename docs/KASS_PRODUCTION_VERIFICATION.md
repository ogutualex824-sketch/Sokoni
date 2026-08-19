# KASS — production verification, 2026-08-19

**Read-only.** Nothing was written. Run: `node scripts/verify-kass-subscription.js <uid>`

## The correction that matters

**My audit diagnosis was wrong for KASS.** I concluded the KES 499 was an `ai_starter`
purchase resolving to FREE. Production says otherwise:

- **`aiSubscriptions` is empty platform-wide — 0 documents.** No merchant has ever had an
  AI subscription provisioned.
- **`aiPaymentRefs` is empty — 0 documents.**
- KASS has **no** `aiSubscriptions` record.

The `ai_starter → FREE` defect in the code is **real** and the fix is worth keeping — but
it affects **zero production merchants today**, and it is **not** what is blocking KASS. I
matched 499 to `ai_starter`'s price and stopped there. The actual plan id is `starter`, sold
as *"SOKONI Starter Plan"* through IntaSend, and `starter` already resolved to STARTER/100
before I touched anything.

## What is actually wrong: KASS is two accounts

| | paying account | shop account |
|---|---|---|
| uid | `xrH21J5GFbW8PluCZ2ny5nIuf602` | `D5Ql2EYr95bt79IpcGTmOMTK0P83` |
| `users.name` | KASS | KASS |
| `shops/{uid}` | **MISSING** | KASS SHOP |
| subscription | **`starter` / `active`** | `seller_free` / `trialing` |
| entitlement resolves | **STARTER / 100** | FREE / 10 |
| `productCounters.count` | 10 | **−23** |
| `productCounters.maxProducts` | 10 | 10 |
| real products | 0 | **103** |

**The paid Starter sits on the account with no shop. The shop sits on the account with no
paid subscription.** Entitlement is resolved per-uid, so the shop resolves FREE — correctly,
given the data it can see. Nothing in the entitlement engine is misbehaving here.

This is the account-merge defect: the merge into `D5Ql2…` did not carry the subscription.

## The payment is genuine and confirmed

```
id                SKN51E7BD480
amount            499 KES          confirmedAmount 484.02
status            COMPLETE         intasendState   COMPLETE
createdAt         2026-08-04T12:55:53Z
webhookReceivedAt 2026-08-04T12:56:23Z     ← the webhook DID arrive, 30s later
meta.providerName "SOKONI Starter Plan"
uid               xrH21J5GFbW8PluCZ2ny5nIuf602
```

Four further 499 attempts exist on the same uid: 1 FAILED, 3 PENDING. The payment chain
worked — money in, webhook received, `subscriptions/{uid}` written as `starter / active`.
**Arrow 1–6 are green on the paying account.** The break is downstream of billing entirely.

## Two more defects, both measured

### 1. `productCounters` is wrong on both accounts, in opposite directions

| account | counter | real | effect |
|---|---|---|---|
| shop `D5Ql2…` | **−23** | **103** | `withinProductLimit()` is `count < maxProducts` → `−23 < 10` → **passes**. The cap is bypassed; this is how 103 products exist against a limit of 10. |
| paying `xrH21J5…` | **10** | **0** | reads as 10/10 — **at the limit on an empty shop**. Adding a product there would be refused despite a paid plan. |

### 2. The ceiling was never re-synced on the paying account

`maxProducts` is **10** while the entitlement is **100**. The subscription is `active` and
dated 2026-08-04, so either the trigger did not fire or the document predates it. The
merchant paid for 100 and the enforcement point still says 10.

## Verdict against the requested arrows

| # | arrow | shop `D5Ql2…` | paying `xrH21J5…` |
|---|---|---|---|
| 1 | payment exists | 🔴 none | 🟢 KES 499 COMPLETE |
| 2 | payment→subscription linkage | 🔴 | 🟢 `starter / active` |
| 3 | `aiSubscriptions` record | ⚪ n/a — not an AI plan | ⚪ n/a |
| 4 | plan = `ai_starter` | ⚪ **wrong premise** — plan is `starter` | ⚪ |
| 5 | amount = KES 499 | 🔴 | 🟢 |
| 6 | status/lifecycle correct | 🟡 `seller_free/trialing` | 🟢 `active` |
| 7 | `resolveEffective()` = STARTER | 🔴 FREE | 🟢 **STARTER / 100** |

**The entitlement engine resolves the paid account correctly.** The chain breaks at the
account↔shop association, not at billing and not at entitlement.

## What must NOT be done

- **Do not move the subscription** or edit either account's data without a decision. This is
  a real customer's paid record.
- **Do not change a price.** The purchase is `starter` at KES 499; the catalogue tier
  `STARTER` lists KES 999. That gap is now recorded in the `purchase` provenance block and
  must stay visible until the commercial price is deliberately decided.
- **Do not "fix" the counter by writing −23 → 103** without deciding whether the 103
  products were published legitimately under a bypassed cap.

## The actual fix, for decision

The failing layer is **shop↔subscription association**, and there are three candidate
repairs. Each is a business decision, not a code one:

1. **Associate the shop with the paying uid** — the shop `D5Ql2…` becomes owned by, or
   linked to, `xrH21J5…`. Cleanest if they are genuinely one merchant.
2. **Move the subscription to the shop uid** — write `subscriptions/D5Ql2…` as
   `starter / active` carrying the original payment reference.
3. **Resolve entitlement across linked accounts** — teach `resolveEffective()` to follow an
   account-link record, so a merged identity carries its subscription. Broadest fix,
   requires a trustworthy link record that does not exist yet.

Whichever is chosen, `productCounters` for the shop must be recounted from reality (103) and
`maxProducts` re-synced from the entitlement — otherwise the merchant swaps a bypassed cap
for a wrong one.

---

## The repair, prepared and dry-run (2026-08-19)

`scripts/apply-kass-repair.js` performs exactly two writes and refuses everything else.
Parameters are fixed in the file, not typed at a prompt — a uid entered by hand is how the
wrong merchant gets linked. Dry run against production is clean:

| precondition | result |
|---|---|
| paid subscription | `starter` / `active` |
| shop document | KASS SHOP |
| payment evidence `SKN51E7BD480` | 499 KES / COMPLETE |
| existing identities | none — both uids free |

| operation | change |
|---|---|
| link | canonical `xrH21J5GF…` → linked `D5Ql2…`, shopId `D5Ql2…` |
| recount shop | counter **−23 → 103** |
| recount paid | counter **10 → 0** |

**Predicted result:** shop resolves **STARTER / 100** with **103 products** — over limit, so
existing products stay and new creation is blocked until 100 or below. The limit is
deliberately NOT raised to 103 to make the UI green; a migration allowance would be a
separate, explicitly recorded commercial decision.

It never modifies a subscription, changes a price, touches `maxProducts`, or deletes a
product. If any precondition fails it stops before writing anything — a half-applied
identity repair is worse than none.

**`--apply` has NOT been run.**

---

## Re-verified 2026-08-19 — the repair is now BLOCKED, and correctly so

**No products were deleted.** All 103 are present. Nothing in this session ever wrote to
production: every operation was a read, and `--apply` has never run.

But re-verification found something that invalidates the prepared counter write.

### Archive state already exists — under three disagreeing spellings

| signal | products |
|---|---|
| `status === archived` | 7 |
| `archivedAt` present | 8 |
| `active === false` | 5 |
| **union** (archived by ANY) | **8** |
| **agreed by all three** | **5** |

Only 84 of 103 products carry a `status` field at all. One product (`AD111`) has
`archivedAt` and nothing else. Two more carry `status`+`archivedAt` but not `active:false`.

### Why this blocks the repair

The prepared write was `count = 103`. Under a lifecycle where archived products do not
consume the allowance, KASS is at **95 active** (union basis) or **96** (status basis) —
**already under the 100 limit**. Writing 103 would charge the merchant for archived
products and block a shop that should not be blocked.

Counting by any single signal picks a winner among three that disagree. Neither option is
a recount; both are a guess written into an enforcement record.

`apply-kass-repair.js` now REFUSES with this measurement rather than proceeding.

### What must come first

The canonical product lifecycle — Active / Archived / Permanently deleted — with ONE
definition of archived, a migration that reconciles the three existing spellings, and the
counter counting ACTIVE only. Then the recount is a count rather than a guess.
