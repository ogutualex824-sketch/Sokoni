# Revenue Intelligence

Payment-rail analytics for both platform-admin consoles.

- **[[AdminOS]]** — `admin-os.html`, sidebar → Platform → **Revenue** (`claims.admin`)
- **[[Super Admin]]** — `super-admin.html`, sidebar → Operations → **Revenue** (`claims.superAdmin`)

`admin.html` is not a consumer, matching the [[Integrations Control Center]] and
[[Reports Builder]] rulings.

Related: [[Payments]] · [[Wallet]] · [[Commission]] · [[Analytics]]

---

## Two things that would have made this page lie

### 1. The status vocabulary is UPPERCASE, and `succeeded` does not exist

Production `payments` documents carry exactly:

```
PENDING · COMPLETE · FAILED · CANCELLED
```

`succeeded`, `completed`, `paid`, `processing` and `refunded` have **never** been
written by any production writer. A filter spelled `'succeeded'`, or one missing
`.toUpperCase()`, matches nothing and renders a confident **zero revenue** that
looks exactly like a real answer.

Completion is judged as `String(status).toUpperCase() === 'COMPLETE'`, mirroring
`adminGetFinance` in `functions/admin-os.js`. Sabotage mutations `S1`, `S2` and
`S3` plant the broken spellings to prove the guard is live.

### 2. This is not marketplace revenue

Every production payment is a **wallet top-up / STK push**, keyed by `uid` and
`checkoutId`. Summing it under the words "Total Revenue" would misstate the
business. So nothing here carries that label — figures are named *Rail volume*,
*Net of fees*, *Gateway fees*, *Completed*, *Completion rate* — and the surface
discloses what the numbers are in the open.

Certification extracts the KPI **labels** and asserts none claims revenue or GMV.
It cannot simply search the page for "Total Revenue", because the disclosure
explaining that nothing is labelled that way contains the phrase.

## The arithmetic mirrors the server

```
amount = x.amount ?? x.amountKES
net    = x.netAmount ?? amount
fee    = max(0, amount - net)
counts only when String(status).toUpperCase() === 'COMPLETE'
```

If `adminGetFinance` changes, change this in the same commit or the console and
the API will disagree about the same money.

## Unknown, empty, dormant and failed are four different states

| State | Renders as |
| --- | --- |
| read denied | "the payments ledger could not be read" — no figure at all |
| read fine, range empty | "no payments recorded in this range" **plus the date of the newest payment anywhere** |
| completed payment with no readable amount | counted, excluded from money, disclosed |
| **measured `0`** | **`KES 0`** — a real zero survives, at aggregate *and* render level |
| read hit the 1000-doc cap | "PARTIAL … a floor, not a total" |

Dormancy is the subtle one: the collection can go quiet for long stretches, and a
quiet range looks identical to zero revenue unless the surface says when activity
last happened. One extra `orderBy('createdAt','desc').limit(1)` read makes that
legible.

## Deliberately not built

Four panels from the reference design have no source in this platform. They are
**declared**, with reasons, rather than silently missing:

- **Revenue by geography** — no payment or order document carries a country or
  region field. Inferring location from a phone prefix would be a guess.
- **Cohort retention** — no cohort store. Deriving cohorts client-side over a
  capped read produces a number that changes with the cap: an artefact.
- **AI insights** — "revenue rose 10.7% driven by new enterprise clients" is
  causal attribution. No attribution data exists, and narrating a cause from a
  correlation is fabrication in a confident voice.
- **By project / client** — SOKONI has no project or client entity.

Certification (`E1`, `E2`) fails if one appears without a real source.

**Orders and payments are never divided into one another.** Order counts come from
`ops_reports`; payments from `payments`. An order and a wallet top-up are not the
same event, so a "revenue per order" figure built from the two would be meaningless.

## Certification

```
node tests/certify-revenue-intelligence.js     # 110 assertions, 0 failures
node tests/sabotage-revenue-intelligence.js    # 15 mutations, 15 caught, 0 inert
node scripts/validate-admin-nav.js             # all checks passed
```

### Three findings from the sabotage pass

1. **A measured zero was only covered at aggregate level.** `B3` proved `_agg`
   kept a real `0`, but the *formatter* ran afterwards — and a formatter mapping
   `0` to an em dash re-introduced the defect at the last step. `B6` now asserts
   on rendered output.
2. **The capped-read warning had no coverage at all.** `B7` added.
3. **One mutation scored as "caught" by crashing the harness.** A non-zero exit
   from a crash is not a detection — it proves nothing about the assertion. The
   mutation was rewritten to be structure-preserving, and the runner now rejects
   crashes outright rather than counting them.

A fourth issue was in the harness itself: the Firestore stub ignored the `where`
clause, so it modelled a database that does not exist and hid the dormancy case
entirely. It now honours the range filter.
