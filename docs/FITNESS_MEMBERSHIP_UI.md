# Fitness Memberships — UI (hosting lane)

**Status (2026-10-03, pass 2):** built on `hosting/fitness-memberships-on-31f5844`, which descends from F0 containment (`31f5844`) on live `72dca56`. **NOT deployed.**
Selling is **OFF** until every release gate is green. Related: [[Fitness Hub]] · [[Payments]] · [[Provider Dashboard]] · [[AdminOS]] · [[FITNESS_MEMBERSHIP_API]] · `CHANGELOG.md` (2026-10-03 entries).

**Source of truth (pass 2).** The server contract is `docs/FITNESS_MEMBERSHIP_API.md` and `scripts/fixtures/fitness-api-fixtures.json` on `origin/feat/fitness-attendance-on-8bbfb34`. The fixtures are **generated from the real handlers**. This branch carries a copy at `scripts/fixtures/fitness-api-fixtures.json`, with a `_copy` header that names the source commit. The UI suite drives every success and error fixture of the callables it calls through the render paths.
- Suite row **FX-SYNC** compares the copy (minus `_copy`) with `git show origin/feat/fitness-attendance-on-8bbfb34:scripts/fixtures/fitness-api-fixtures.json`. It FAILS on drift, and reports **UNPROVEN** (never a pass) when the ref is not in the clone.
- FX-SYNC caught real drift during pass 2: the lane moved `3d315a2` → `d5fbd37` (day and week passes, `bad_unit` / `bad_period`, `success_day_pass`, `day_pass_at_end`). The copy was re-made from `d5fbd37`, and the new fixtures are covered.

## Owner rules this UI enforces

- The browser only **requests and displays**. It never writes `providerMemberships`, `attendance` or `providerServices`.
- It never shows success before the server state exists:
  - "ATTENDANCE RECORDED" is built only from a `fitnessCheckIn` response.
  - A purchase stays "Waiting for payment confirmation" until the membership document changes.
- An unknown value shows `—`. A membership with no session cap shows `Unlimited`. Nothing is guessed.
- There is no localStorage source of truth, no WhatsApp and no SokoniPay.
- All user-written text goes through the canonical `escapeHTML` (`security.js`).
- Layout is mobile-first (390px, no horizontal scroll), with labelled controls, visible focus and 44px touch targets.

## Files

| File | Role |
|---|---|
| `sokoni-fitness-memberships.js` | Gym module, mounted in the provider workspace. It also exports the shared core (`SokoniFitnessMemberships._core`). |
| `sokoni-fitness-member.js` | Member page logic: list, QR, refund request and the flag-gated buy flow. |
| `fitness-memberships.html` | The "My memberships" page. It loads `shared-header.js` and `sw-register.js`. With `?provider=<id>` it also lists that gym's plans. |
| `fitness-hub.html` | Two plain `<a href="fitness-memberships.html">` links, one under Progress and one under My Gym. |
| `sokoni-aos-fitness.js` | AdminOS "Fitness Memberships" workspace: `window.SokoniAOSFitness.mount(el)`. Self-contained. |
| `scripts/fixtures/fitness-api-fixtures.json` | Copy of the generated server contract (see above). Do not edit by hand. |
| `scripts/test-fitness-memberships-ui.js` | Node/vm suite driven by the fixtures: 51 rows (FX-SYNC and OF-DEF are source rows) plus 6 negative controls. |
| `scripts/test-aos-fitness.js` | Node/vm suite for the AdminOS view: 16 rows plus 3 negative controls. |
| `scripts/test-fitness-memberships-browser.js` | Browser certification at 390 and 1280, now fixture-driven, with FMB8a (review step) and FMB10 (offer editor). **QUEUED, not run.** |
| `scripts/test-fitness-containment.js` | F0 suite, extended with FT-15 (plain link) and FT-16 (the hub page still starts no payment). |

## Reuse census (what already existed, and what was reused)

| Need | Canonical path in the repo | Used here |
|---|---|---|
| Calling a callable | `firebase.functions().httpsCallable(name)`, the compat shim in `firebase.js` (App Check initialised there). `sokoni-book-service.js` uses the same path. | `_core.call` |
| Starting a payment | `createPaymentIntent` gives `{ref, amount (whole KES)}`, then `SokoniIntaSend.initiateSTKPush(phone, amount, ref, opts)` (`sokoni-book-service.js` → `sokoni-intasend.js`). | Identical, with `purpose:'fitness_membership'` |
| Drawing a QR | `sokoni-qr.js`: `SokoniQR.generateCanvas(text, size)`. It needs no external dependency and holds up to 271 bytes (V10-L). The `fm1.` token is about 250 bytes with 20-character ids. | Member QR |
| Scanning a QR with the camera | `SokoniQR.scan(video, onDetect)` (BarcodeDetector). `sokoni-premium-scanner.js` is tied to POS (`PosBarcode`), so it is not reused. | Gym scanner; `sokoni-qr.js` is lazy-loaded if missing. A paste box is always offered as a fallback. |
| Workspace visibility | b2's `sokoni-business-workspace.js` on `hosting/techhub-on-chain` (from `430713e`): `[data-hc-module]`, `window.__sokoniWorkspace`, `sokoni:workspace` event | Module key `memberships`. No second visibility call is made. |
| Feature flag | `featureFlags/{key}`: rules `allow read: if true; allow write: if isAdmin()`. Written by AdminOS `adminUpdateFeatureFlag` (super admin). `platformConfig/flags` is admin-read only, so the browser cannot read it. | `featureFlags/fitness_membership_sales` |
| Escaping | `security.js` `escapeHTML` | Both modules; an identical fallback is used only if the page lacks `security.js` |
| Login redirect | `login.html?next=` | Member page shown signed out |

## Gym module (`SokoniFitnessMemberships.mount(el)`)

**Visibility.**
- The module renders only when `window.__sokoniWorkspace.modules.memberships.state === 'AVAILABLE'`.
- Every other case clears the mount point and hides it:
  - the answer is absent;
  - the answer has no `modules`;
  - the answer lacks `memberships`;
  - the module reports any other state.
- A later `sokoni:workspace` event re-evaluates. An answer without the module unmounts it, so the module fails closed.

**Scanner access.**
- `fitnessScannerStatus()` sets only the **SCAN MEMBER QR** enable state and its reason:
  - `BUSINESS_LINK_MISSING` → "Your gym isn't linked to a business record yet — contact SOKONI support to finish setup." (links to `support.html`; no self-serve linking surface exists)
  - `NOT_APPROVED` → "Your gym isn't approved yet…"
  - `NO_PERMISSION` → "You don't have permission to record attendance for this gym."
  - `MODULE_NOT_AVAILABLE` → "Memberships aren't enabled for this business yet, so scanning is off."
  - `MULTIPLE_GYMS` → "You are staff at more than one gym. Ask the gym owner for access to this view."
  - An unknown reason never shows its raw code.

**Tabs.** Active, Pending, Expired and Refunds, from `fitnessGymMemberships({status, limit:25, cursor})`. "Load more" uses `nextCursor`.

**Each row shows:**
- member, plan title and `#ref`
- start and expiry
- sessions included (`Unlimited` when `null`), attended and remaining
- last attendance
- refund state and payment state (`refunded_late` → "Payment refunded — please start again")
- **Refundable**: `refundEligible` true → "Yes — not used yet"; false → "No — membership used"; `null` (unpaid or unknown) → `—`
- settlement, only when `releasedPeriods` or `releasedCents` is returned

**Details drawer.** Loaded from `fitnessGymMembership({membershipId})`. It shows the attendance ledger (status, method, actor role) and the settlement. Attendance is never deleted from here.
- `settlement` is the contract **object** `{releases[{periodIndex, grossCents, commissionCents, netCents, status, settledAt}], releasedPeriods, releasedCents, netSettledCents}`. The drawer lists the releases and shows the three totals. A `null` total renders `—`.
- Anything that is not that object (an array, or `.rows`) is not the contract and renders `Settlement: —`. The old array and `.rows` guesses were removed. Negative control (d) proves it.
- Scope refusals (`NO_PERMISSION`, `NOT_APPROVED`, `BUSINESS_LINK_MISSING`, `MODULE_NOT_AVAILABLE`, `MULTIPLE_GYMS`) and `not_found` render the contract text.

**Scan flow.**
1. The camera reads the code, or staff paste it. The code is sent as `fitnessCheckIn({token})`.
2. While the call is in flight the screen shows "Checking with SOKONI…". It never shows success at this point.
3. The result card is built only from the response's contract keys (`membershipId`, `attendanceId`, `duplicate`, `firstCheckIn`, `attendedSessions`, `sessionsIncluded`, `checkedInAt`, `title`, `member.displayName`). An answer without `ok:true`, an `attendanceId` and a boolean `duplicate` is never shown as recorded:
   `ATTENDANCE RECORDED · <name> — Membership #<short> · <title> · Session N of M · Check-in: HH:MM` (Nairobi time; M is `Unlimited` when uncapped).
   - `firstCheckIn: true` adds the line "Refund no longer available — membership used".
4. `duplicate: true` shows "Already checked in today", with the **original** check-in time and the existing record's status. It says nothing new was recorded.

**Refusals.** The full table of the contract (§3): the 15 reasons `token_invalid`, `token_expired`, `not_found`, `no_permission`, `other_gym`, `self_scan`, `wrong_member`, `expired`, `cancelled`, `suspended`, `not_covered`, `entitlement_exhausted`, `business_link_missing`, `not_approved` and `module_unavailable`, plus `unauthenticated` ("Sign in required.") and `unavailable` ("Attendance could not be recorded. Please try again."). Each renders the contract message.
- The web SDK delivers errors as `functions/<code>` with `details`. The reason is read from `details.reason || details.code`, because e3's callables use `reason` and 2f's use `code`.

**Offline.** When `navigator.onLine` is false, or the error is a network error, the screen shows "Attendance unavailable — retry when connected" and makes no call.

**Membership offer editor** (owner 2026-10-03, "Defaults gyms can edit").
- **Listing.** Read from `providerServices` where `providerId == uid && serviceKind == 'membership'`. Each offer shows its name, KES price, length ("Day pass", "Week pass" or N months), its savings % against the gym's own 1-month offer, Active or Paused, and **Edit** and **Pause** / **Activate** buttons.
- **Add membership offer** offers the owner's six defaults: Daily Pass KES 500, Weekly Pass 1,500, Monthly 5,000, 3 Months 14,000 (save 7%), 6 Months 26,000 (save 13%) and Annual 48,000 (save 20%). Picking one pre-fills the form. Monthly is pre-filled by default.
  - The values **mirror** `functions/shared/fitness-offer-defaults.js` (`origin/convergence/commercial-fn-on-ef1e992` @ `fe33bcc`), the single source. Savings use the same arithmetic as its `withSavings()`.
  - Suite row **OF-DEF** loads that file with `git show fe33bcc:…` and FAILS if the values or the savings differ. It is UNPROVEN when the ref is absent.
- **The gym edits** the name, the price in whole shillings, and the months for a monthly offer. The unit is `day` or `week` with count 1, or `month` with count 1–60. The form validates first, so a non-integer or zero price, more than 60 months, an empty name or an unknown unit never reaches the server.
- **Writers.** Offers are written ONLY through the existing provider path: `providerDispatch` with op `providerAddService`, `providerUpdateService` (with `serviceId`) or `providerToggleService` (with `active` always explicit). That is the same path `provider-dashboard.html` `Sv` uses. The payload is exactly `{name, price: <integer cents = shillings×100>, priceType:'fixed', serviceKind:'membership', periodCount: <number>, periodUnit}`. The browser never writes `providerServices`.
- **Server refusals** (`invalid-argument` / `failed-precondition` with reason `bad_price`, `bad_period`, `bad_unit`, `bad_kind` …) are shown verbatim.
- **"Saved" is claimed only after a re-read.** After the write, the module re-reads `providerServices/{id}`. It says "Saved — <name>." only when the server's copy has `serviceKind:'membership'` and the period and price that were sent.
  - **Until 5b's `providerDispatch` release carries the membership-offer hooks, the server DROPS these fields.** provider-ops on `origin/convergence/commercial-fn-on-ef1e992` whitelists name / price / priceType and ignores `serviceKind` / `periodUnit` / `periodCount`. The editor then says "Membership offers aren't enabled on the server yet." and never "Saved".
  - A NEW save that came back as a plain rate card would be a bookable fixed-price service nobody asked for. The module archives it straight away through the server's own soft delete, `providerRemoveService`, and says "Nothing was published". If that archive also fails, it tells the gym plainly that a plain service was created and could not be removed, and to archive it in Services before customers can book it. **Owner decision (2026-10-03): KEEP**, narrowly scoped. It removes only the service created by that failed membership-offer attempt, never one the gym already had. A failed removal is surfaced, never reported as clean. The server stays the source of truth, so the UI still says memberships aren't enabled. Proven by OF-ORPHAN (no bookable plain service left, exactly one removal of exactly the new id), OF-RMFAIL and OF-EDIT-KEEP (an edit never removes), with negative controls g and h.
  - Negative control (f), which reports "Saved" without checking `serviceKind`, fails row OF-SAVE.

### Exact diff for b2 (`provider-dashboard.html`, branch `hosting/techhub-on-chain`). This lane does not edit the file.

Sidebar, after the `leads` item, matching the neighbouring items' label and icon style:
```html
      <div class="sb-item" data-hc-module="memberships" hidden aria-hidden="true" onclick="P.show('memberships',this)"><span class="sb-icon">🎫</span>Memberships</div>
```
Panel, after `panel-leads`:
```html
    <!-- ── Memberships (Fitness) — providerMemberships via fitnessGymMemberships / fitnessCheckIn; module sokoni-fitness-memberships.js ── -->
    <div class="panel" id="panel-memberships">
      <div class="pg-header"><div><div class="pg-title">Memberships</div><div style="font-size:12px;opacity:.65">Members, attendance and check-in. Attendance is recorded only when SOKONI confirms a scan.</div></div></div>
      <div style="padding:14px 20px"><div id="mbList"></div></div>
    </div>
```
In `P.show`, after the `leads` line:
```js
    if(id==='memberships'&&window.SokoniFitnessMemberships)SokoniFitnessMemberships.mount(_q('mbList'));
```
Script, next to `sokoni-leads.js`:
```html
<script src="sokoni-fitness-memberships.js" defer></script>
```

## Member page (`fitness-memberships.html`)

**List.** A live `onSnapshot` on `providerMemberships` where `buyerUid == auth.uid`, sorted newest first in the browser (no composite index). Each card shows:
- plan, status, start and expiry
- sessions included (`Unlimited` when absent or `null`), used and remaining
- price

**Status wording.**
- `pending_payment` → "Waiting for payment confirmation". The card updates itself when the server changes the document.
- `paymentStatus:'payment_review'` → "Payment under review".
- `paymentStatus:'refunded_late'` (2f §13.4: paid after `payBy` or on an expired record) → "Payment refunded — please start again". The refund line reads "Refunded to your SOKONI wallet (payment arrived too late)". No QR or history is offered.
- `status:'expired'` → "Expired".
- `refund.state`: `requested` → "Refund requested — under review"; `refunded` → "Refunded to your SOKONI wallet" (when `destination` is `sokoni_wallet`), else "Refunded"; `rejected` → "Refund declined".
- **Length.** Day and week offers read "Day pass" and "Week pass". Expiry comes only from the server's `endsAt`, and is `—` without it.

**Used count.** If `attendedSessions` is absent and there is no `firstAttendedAt`, the count is the server's own initial 0, as `fitness-attendance.js` reads it. A malformed value, or an absent count on a record that has `firstAttendedAt`, shows `—`, and so does remaining.

**Refund** (owner wording, exact):
- An active membership with 0 attended and `refundEligible !== false` shows "Eligible to request, subject to policy" and **REQUEST REFUND**. An inline confirmation follows, then `membershipRequestRefund`.
- An active membership with any attendance, or with `refundEligible === false`, shows "Not available — membership already used".
- On refusal, the server's message and `details.detail` are shown verbatim, for example "Refund unavailable because this membership has already been used. Member attended 1 session(s)."

**VIEW MEMBERSHIP QR** (active only):
- The button calls `fitnessMembershipQr` and draws the token.
- A countdown runs, and the code refreshes 30 seconds before `expiresAt`.
- Only a short `#ref` is shown, never full ids.
- The QR closes if the membership stops being active.
- Escape closes it, and focus returns to the button that opened it.

**Attendance history.** Read from the `attendance` subcollection, newest 50.

**Buy** (`?provider=<id>`):
1. The page lists that gym's `providerServices` where `serviceKind == 'membership' && active == true` (and not `removedAt`).
2. **BUY MEMBERSHIP** calls `fitnessCreateMembership({serviceId})` → `{membershipId, reused, priceCents, periodCount, periodUnit, title, payBy}`.
3. **Review step, built from THAT response** and never from the offer document: title, `#ref`, length, price, and "Pay by HH:MM". When `reused` is true, it says "Continuing your pending membership — nothing new was created".
4. **Pay** calls `createPaymentIntent({purpose:'fitness_membership', membershipId})`. The intent amount (whole KES) must equal the reviewed `priceCents`, or nothing is pushed ("The price changed. Please start again.").
5. Then `SokoniIntaSend.initiateSTKPush` with the **server** amount and ref. The text shown is "Enter your M-Pesa PIN… updates automatically once SOKONI confirms the payment". The card itself stays "Waiting for payment confirmation".
6. **Refusals.** Every `fitnessCreateMembership` error fixture renders its contract text. `SALES_DISABLED`, whether it comes in e3's `details.reason` or in 2f's purpose refusal `details.code` (with the message "Membership sales are not open yet."), renders "Memberships aren't on sale yet.". Negative control (e), which maps it to a generic error, fails row M-SALES.

## Feature flag (selling OFF by default)

- `featureFlags/fitness_membership_sales` must hold `{ enabled: true }`, as a boolean. Any other state leaves **BUY** disabled with the message "Memberships aren't on sale yet":
  - the document is missing;
  - it cannot be read;
  - it holds the string `"true"`;
  - it holds any other value.
- To enable it, use AdminOS feature flags (`adminUpdateFeatureFlag`, super admin) with the key `fitness_membership_sales`. Never use localStorage.
- **This gate is presentation only. The server is the gate.** As of `d5fbd37` (NOT deployed), `fitnessCreateMembership` and the `fitness_membership` payment purpose both refuse with `SALES_DISABLED` through ONE predicate, `functions/shared/fitness-sales-switch.js` `salesEnabled`. Until those functions are deployed, the server gate does not exist in production.
- **Operator caveat.** `adminUpdateFeatureFlag` writes `enabled: enabled ?? true`, so a call that **omits `enabled` turns sales ON**. Each call also resets `description` / `rolloutPct` / `enabledForRoles` to defaults. The AdminOS view below always sends an explicit boolean.
- Viewing memberships, the QR and scanning are not gated. They only work for real, server-active memberships anyway.

## AdminOS — Fitness Memberships view (`sokoni-aos-fitness.js`, owner brief §19–20)

**Mount.** `window.SokoniAOSFitness.mount(el)`. It is self-contained (own CSS, own escaping fallback) and uses the page's compat `firebase`.
- Its inner navigation (Memberships · Check-ins audit · Sales switch) deliberately does **not** use `.tab-bar` / `.tab-btn`. Those are AdminOS router tab selectors, and `test-adminos-nav-coverage.js` requires every one of them to be deep-linkable.
- It contains no page links. Suite row A-NAV checks both points.

**Reads.** The admin reads directly under the candidate rules: `isAdmin()` read on `providerMemberships` and its `attendance` / `events` / `releases` subcollections, `providerPayouts` and `adminAudit`. Every query is bounded:

| View | Query |
|---|---|
| Memberships list | `providerMemberships` [`where <ONE of status / paymentStatus / refund.state> ==`] `orderBy createdAt desc` · `limit 25` · `startAfter(cursor)`. One filter at a time keeps the index set to three. |
| Detail | the doc; `attendance` `orderBy checkedInAt desc` · `limit 50`; `events` `orderBy at desc` · `limit 50`; `providerPayouts` `where membershipId == id` `where sourceType == 'membership'` · `limit 50` (sorted by `periodIndex` in the page) |
| Check-ins audit | `adminAudit` `where hub == 'fitness'` [`where action ==`] `orderBy createdAt desc` · `limit 50` · cursor |
| Sales switch | `featureFlags/fitness_membership_sales` |

**Detail shows:**
- **Payment:** `paymentStatus`, `paymentRef`, `heldCents`, price.
- **Lifecycle:** `status`, `startAt`, `endsAt`, `releasedPeriods`, `releasedCents`, `nextReleaseAt`, attended and voided sessions, `refundEligible`.
- **Refund:** `state`, `exception`, `used`, `attendedSessionsAtRequest`, `requestedBy`, `decidedBy`, `decisionReason`, `executedAt`, `destination`, `walletCreditShillings` (whole KES) and `ledgerId`.
- **"Why the refund is locked: Member attended N session(s)."** This is computed **only from the membership document**: `attendedSessions`, else `refund.attendedSessionsAtRequest`. It is never computed from the ledger rows the page loaded, because a page of 50 rows is not the count. Negative control (2) proves it.
- **Attendance ledger:** time, method, actor role, status and corrections (`voidedAt`, `voidReason`).
- **Events timeline:** 2f's append-only `events`.
- **Settlement:** `providerPayouts` rows with `sourceType 'membership'` (period, gross, commission, net, status, settled).
- Unknown values render `—`, never `0` or `KES 0`.

**Actions** (admin only; the server enforces role, separation of duties, state and money). Each action asks for a `confirm()` first, re-reads the document afterwards, and shows any refusal **verbatim**, with its code (for example "The refund must be decided by a different authorized person than the one who requested it. (separation_of_duties)").
- **Approve / Reject refund** — shown only on an open request. Calls `membershipDecideRefund({membershipId, decision:'approve'|'reject', reason})`; a reason of at least 3 characters is required.
- **Request exception** — shown when no refund is open or done. Calls `membershipRequestException({membershipId, reason})`; the reason needs at least 10 characters.
- **Void** (per non-voided ledger row) — calls `fitnessCorrectAttendance({membershipId, attendanceId, reason})`. The confirm says it "NEVER restores refund eligibility — the refund lock stays".

**Check-ins audit.** This lists the `adminAudit` rows that `functions/fitness-attendance.js` `_audit()` writes with `hub:'fitness'`. The actions are `fitness_checkin`, `fitness_checkin_duplicate`, `fitness_session_completed` and `fitness_attendance_corrected`, refusals included (`outcome:'refused'`, `reason`).
- Columns: time, action, result, membership, gym (`providerId`), actor (`performedBy` + `actorRole`), method and first check-in.
- The audit row does **not** record the method (the only method is `qr`, which lives on the ledger row), so the method column shows `—` rather than an inference. It also records no member name.

**Sales switch.**
- The page shows ON only when `enabled === true`. A missing doc shows "OFF (not set)". Any other value shows "OFF (enabled is not the boolean true)". A read error shows `—` and offers **no** toggle.
- Toggling asks for a confirm, then calls `adminOsDispatch({op:'adminUpdateFeatureFlag', key:'fitness_membership_sales', enabled:<explicit boolean>, description})`. That is the same route AdminOS `updateFlag` uses (`_requireSuperAdmin`).
- The new state is claimed only once the re-read flag shows it. Negative control (1), which omits `enabled`, fails row A-FLAG.

**Indexes this view needs (functions/rules lane; NOT in this hosting branch).** None of these exist in `firestore.indexes.json` today, and each query fails until its index exists:
- `providerMemberships`: (`status` ASC, `createdAt` DESC), (`paymentStatus` ASC, `createdAt` DESC) and (`refund.state` ASC, `createdAt` DESC).
- `adminAudit`: (`hub` ASC, `createdAt` DESC) and (`hub` ASC, `action` ASC, `createdAt` DESC).
- `providerPayouts`: `membershipId ==` combined with `sourceType ==` needs no composite index, because Firestore merges single-field equality indexes.

### Wiring diff for `admin-os.html` + `sokoni-aos.js` on `origin/hosting/chain-on-3e8dd53` (NOT applied here; this branch does not edit `admin-os.html`)

This adds one sidebar parent in the existing **Commerce** group, next to Service Hubs. It is a parent with no tab children, so `_TAB_SELECTORS` is untouched and the module's inner views are not router tabs.
- `test-adminos-nav-coverage.js` C1 (a panel has a sidebar parent) and C2 (a parent has a panel) hold.
- The deep link `#fitness` validates through `_parseRoute`.
- Generated with `git diff --no-index` against `git show origin/hosting/chain-on-3e8dd53:<file>`.

`admin-os.html`:
```diff
@@ -439,4 +439,5 @@ body:not(.is-super) [data-requires-superadmin]{display:none !important;}
       <button class="nav-item nav-child" data-section="marketplace" data-tab="reviews" data-label="Reviews" onclick="SokoniAOS.navigate('marketplace','reviews');_closeSidebar()"><span class="nav-icon">&#x2B50;</span><span class="nav-label">Reviews</span></button>
       <button class="nav-item" data-section="services" data-label="Service Hubs" onclick="SokoniAOS.navigate('services');_closeSidebar()"><span class="nav-icon">&#x1F527;</span><span class="nav-label">Service Hubs</span></button>
+      <button class="nav-item" data-section="fitness" data-label="Fitness Memberships" onclick="SokoniAOS.navigate('fitness');_closeSidebar()"><span class="nav-icon">&#x1F3CB;&#xFE0F;</span><span class="nav-label">Fitness Memberships</span></button>
       <button class="nav-item" data-section="delivery" data-label="Delivery Operations" onclick="SokoniAOS.navigate('delivery');_closeSidebar()"><span class="nav-icon">&#x1F697;</span><span class="nav-label">Delivery</span></button>
     </div>
@@ -588,4 +589,9 @@ body:not(.is-super) [data-requires-superadmin]{display:none !important;}
       </div>
 
+      <div class="aos-panel" id="panel-fitness" hidden>
+        <div class="panel-toolbar"><h2>Fitness Memberships</h2></div>
+        <div id="fitnessBody"><div class="aos-spinner"><div></div></div></div>
+      </div>
+
       <div class="aos-panel" id="panel-delivery" hidden>
         <div class="panel-toolbar"><h2>Delivery Operations</h2></div>
@@ -789,4 +795,5 @@ body:not(.is-super) [data-requires-superadmin]{display:none !important;}
     </div>
   </main>
+  <script src="sokoni-aos-fitness.js"></script>
   <script src="sokoni-aos.js"></script>
   <script>
```

`sokoni-aos.js` (the loader map in `_loadPanel`; `_navigate` caches the first open, so it mounts once):
```diff
@@ -232,4 +232,5 @@ window.SokoniAOS = (() => {
       marketplace:   () => _loadMarketplace(),
       services:      () => _loadServices(),
+      fitness:       () => { if (window.SokoniAOSFitness) window.SokoniAOSFitness.mount(document.getElementById("fitnessBody")); },
       delivery:      () => _loadDelivery(),
       financial:     () => _loadFinancial(),
```

### Super Admin entry (`super-admin.html` on the chain)

`super-admin.html` reaches every AdminOS destination that has no native Super Admin panel through the **"AdminOS Workspaces"** group (`#saAdminOsGroup`). Each entry is a same-tab link `admin-os.html#<section>[/<tab>]` with `data-aos-route`, which the AdminOS router validates. `test-adminos-nav-coverage.js` (SUPER ADMIN block) requires every AdminOS destination to be reachable this way, so a new `fitness` section **needs** the link:
```diff
@@ -466,4 +466,7 @@
       <span class="nav-icon">&#x1F527;</span><span class="nav-label">Service Hubs</span>
     </a>
+    <a class="nav-item" href="admin-os.html#fitness" data-aos-route="fitness" onclick="_closeSidebar()">
+      <span class="nav-icon">&#x1F3CB;&#xFE0F;</span><span class="nav-label">Fitness Memberships</span>
+    </a>
     <a class="nav-item" href="admin-os.html#delivery" data-aos-route="delivery" onclick="_closeSidebar()">
       <span class="nav-icon">&#x1F697;</span><span class="nav-label">Delivery Operations</span>
```

## Security

- No client writes.
- Every id is passed to callables as data; the server authorizes. The gym scope is the caller's resolved provider, never a client-supplied id.
- The token is shown only to its holder, is short-lived (5 minutes) and is drawn locally. It never goes to a third-party QR service.
- Hostile names and titles are escaped (suite rows G-ESC, M-ESC, OF-ESC and A-ESC; negative controls (b) and (3)).
- Offer writes go only through `providerDispatch`. The server validates them; the browser's validation is a convenience.
- AdminOS actions are requests: role, separation of duties, state and money are enforced server-side, and the page shows refusals verbatim.
- The sales flag is always written with an explicit boolean.

## Performance

- The gym list is paged at 25. Offers are capped at 50 (gym view) and 20 (buy view).
- The member list uses one listener capped at 50 documents. Attendance is read on demand.
- `sokoni-qr.js` is lazy-loaded in the dashboard only when the scanner opens.

## Dependencies and open items (none of these are this lane's files)

1. **Callables.** `fitnessGymMemberships`, `fitnessGymMembership`, `fitnessScannerStatus`, `fitnessCheckIn` and `fitnessCreateMembership` are built and fixture-proven on `origin/feat/fitness-attendance-on-8bbfb34` @ `d5fbd37`, and NOT deployed. Pass 2 aligned this UI to their generated fixtures, so the earlier assumed shapes are gone.
2. **Offer hooks.** provider-ops must carry the membership-offer hooks (5b `providerDispatch` release), or the editor can only report "Membership offers aren't enabled on the server yet."
2a. **Composite indexes** for the AdminOS view (listed above) must be added by the functions/rules lane before that view can list with a filter or read the audit.
3. **The `memberships` module** must be emitted by the workspace authority (5b, `business-workspace.js`) for `fitness_studio`. Until then the section never shows.
4. **Rules**: buyer reads of `providerMemberships` and of the `attendance` subcollection are in the e3 rules candidate and are NOT served. Until they are, the member page cannot read.
5. **`createPaymentIntent` `fitness_membership`** (2f, `commercial-fn`) and the webhook membership purpose (5b) are not deployed.
6. **The server-side sales flag** is built (`d5fbd37`, ONE predicate) and NOT deployed.
7. **The browser certification** is QUEUED. Free RAM was below the 512 MB floor in both passes (about 210 MB in pass 2). Run `node scripts/test-fitness-memberships-browser.js` when RAM allows. Do not add it to `predeploy-browser-suites.js` until it has passed.
8. **AdminOS wiring.** The diffs above go onto `hosting/chain-on-3e8dd53` (owner of the AdminOS layout), together with `sokoni-aos-fitness.js`. They are not applied here. After wiring, run `scripts/test-adminos-nav-coverage.js` there.
9. **Admin reads.** The `isAdmin()` reads on `providerMemberships`, its `attendance` / `events` / `releases` subcollections and `providerPayouts` are in the candidate rules. They are not proven here (emulator QUEUED).
10. **`adminUpdateFeatureFlag` hardening (functions lane).** Suggest requiring a boolean `enabled` and not resetting `description` / `rolloutPct` / `enabledForRoles` on a partial call. Until then, every UI caller must pass `enabled` explicitly, as this view does.
11. **Audit method.** `adminAudit` check-in rows carry no `method`. If the owner wants it in the audit list, e3 can add `method:'qr'` to `_audit()`.
