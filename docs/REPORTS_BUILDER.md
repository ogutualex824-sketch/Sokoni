# Reports Builder

Compose a report from the daily operations record, preview it, export it.

- **[[AdminOS]]** — `admin-os.html`, sidebar → Platform → **Reports** (`claims.admin`)
- **[[Super Admin]]** — `super-admin.html`, sidebar → Operations → **Reports** (`claims.superAdmin`)

`admin.html` is not a consumer, matching the [[Integrations Control Center]] ruling.

Related: [[Payments]] · [[Analytics]] · [[Platform Registry]] · [[Security]]

---

## The data spine

Everything on the canvas comes from **one** canonical store:

```
ops_reports/{YYYY-MM-DD}
```

written each morning by `scheduledDailyOpsReport` (`functions/scheduled-reports.js`)
and admin-readable (`allow read: if isAdmin()`). One document per day, so a date
range *is* the series — no client-side aggregation across unrelated collections,
no interpolation, no derived arithmetic.

Fields, exactly as the scheduler emits them:

`orders24h` · `paidOrders24h` · `failedPayments24h` · `paymentSuccessRate`
`emailFailed24h` · `cspViolations24h` · `openFeedback` · `generatedAt`

The metric registry in the module is certified against this file: every offered
metric must be a string the scheduler actually writes, so a metric cannot be
added to the UI without a writer behind it.

## Null is a hole, not a zero

The scheduler's own `safe()` helper writes **`null`** when a sub-query fails. A
null therefore means *"not measured that day"* — never *"none that day"*. The
builder honours that end to end:

| Situation | Renders as |
| --- | --- |
| `null` in a document | gap in the line; `—` in the table; excluded from sums and averages |
| day has no document | no point at all — not a zero row |
| metric unmeasured all period | `—`, with "not measured" |
| **measured `0`** | **`0`** — a real zero survives |
| no comparable prior period | "no baseline" — never `0%` |

Plotting a null as zero would invent a collapse in payment success that never
happened, inside a document an executive acts on. That is the single most
dangerous thing this module could do, so it is certified **in both directions** —
a gap must render as a gap, *and* a genuine zero must still render as zero. A
suite checking only the first would pass a module that hid every zero, which is
the same lie pointing the other way.

## What it cannot do, and says so

Two controls are visibly disabled with the reason stated in Settings rather than
hidden:

- **Publish** — there is no canonical store for a report definition.
  `ops_reports` is read-only to clients, and `/reports/{reportId}` is the user
  **abuse-report** collection; writing layouts there would corrupt trust & safety
  data. See [[Trust and Safety]].
- **Scheduled delivery** — schedules are fixed in platform code (daily ops 06:00
  EAT, weekly security Mon 07:00 EAT). A frequency/timezone/channel picker would
  write nowhere. Enabling it needs a schedule collection, rules, and a Cloud
  Function deploy — and function deploys are frozen by the Artifact Registry
  investigation.

**Draft save** writes to `localStorage` and is labelled device-local, because that
is what it is. The save reports its actual outcome: if the browser refuses
storage (private mode, blocked site data), it says *"Draft NOT saved"* — never a
success message over a failed write.

**Export is real.** It prints through a stylesheet that hides both rails and all
console chrome, leaving only the report. No backend required.

## Modules

`KPI Summary · Line · Area · Bar · Donut · Data Table · Metric List · Progress
List · Text/Note · Divider`

**Map and Image are deliberately absent.** This platform has no canonical geo
series and no report-asset store, so both would be controls that do nothing.
Certification fails if either is added.

Templates: Executive Summary, Payment Reliability, Operations Report, Blank.
There is no "Project Performance" template — no canonical project series exists,
and a template that renders empty every time is worse than none.

## Certification

```
node tests/certify-reports-builder.js      # 114 assertions, 0 failures
node tests/sabotage-reports-builder.js     # 12 mutations, 12 caught, 0 inert
node scripts/validate-admin-nav.js         # all checks passed
```

The suite runs the real module against a scripted `ops_reports` and asserts on
rendered output.

Two assertions had to be rewritten during the build because they matched the
**certification machinery itself**: `.add(` matched the module's own
`SokoniReports.add(` onclick string, and a search for "frequency" matched the
notice *explaining* that no frequency picker exists. Both now discriminate by
syntax — string literals are stripped before scanning, with a control proving the
stripper did not simply blank the file.

## Extending it

Add a metric only when `scheduledDailyOpsReport` writes it; `D1` fails otherwise.
Add a module only when a canonical source can fill it; `D3` guards the palette.
Never coerce a null to a number — `S1` and `S2` exist to catch exactly that.
