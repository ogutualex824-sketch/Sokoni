# Fitness Memberships — UI (hosting lane)

**Status (2026-10-03):** built on `hosting/fitness-memberships-on-31f5844`, which descends from F0 containment (`31f5844`) on live `72dca56`. **NOT deployed.**
Selling is **OFF** until every release gate is green. Related: [[Fitness Hub]] · [[Payments]] · [[Provider Dashboard]] · `CHANGELOG.md` (2026-10-03 Fitness Memberships UI).

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
| `scripts/test-fitness-memberships-ui.js` | Node/vm suite: 33 rows plus 3 negative controls. |
| `scripts/test-fitness-memberships-browser.js` | Browser certification at 390 and 1280. **QUEUED, not run.** |
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

**Tabs.** Active, Pending, Expired and Refunds, from `fitnessGymMemberships({status, limit:25, cursor})`. "Load more" uses `nextCursor`.

**Each row shows:**
- member, plan title and `#ref`
- start and expiry
- sessions included (`Unlimited` when `null`), attended and remaining
- last attendance
- refund state and payment state
- settlement, only when `releasedPeriods` or `releasedCents` is returned

**Details drawer.** Loaded from `fitnessGymMembership({membershipId})`. It shows the attendance ledger (status, method, actor role) and the settlement rows. Attendance is never deleted from here.

**Scan flow.**
1. The camera reads the code, or staff paste it. The code is sent as `fitnessCheckIn({token})`.
2. While the call is in flight the screen shows "Checking with SOKONI…". It never shows success at this point.
3. The result card is built only from the response:
   `ATTENDANCE RECORDED · <name> — Membership #<short> · Session N of M · Check-in: HH:MM` (Nairobi time; M is `Unlimited` when uncapped).
4. A duplicate scan shows "Already checked in today" with the existing record.

**Refusals.** The server's `details.reason` is mapped to human text:
- token invalid or expired
- not found, expired, cancelled, suspended
- wrong member, not covered, other gym
- entitlement exhausted, no permission, self scan

**Offline.** When `navigator.onLine` is false, or the error is a network error, the screen shows "Attendance unavailable — retry when connected" and makes no call.

**Membership offers.**
- Read from `providerServices` where `providerId == uid && serviceKind == 'membership'`.
- The list shows name, KES price (integer cents ÷ 100), period, and active or inactive.
- Offers are edited only in the existing services editor once it supports membership offers. This module writes nothing.

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
2. **BUY MEMBERSHIP** calls `fitnessCreateMembership({serviceId})`.
3. Then `createPaymentIntent({purpose:'fitness_membership', membershipId})`.
4. Then `SokoniIntaSend.initiateSTKPush` with the **server** amount and ref.
5. The text shown is "Enter your M-Pesa PIN… updates automatically once SOKONI confirms the payment". The card itself stays "Waiting for payment confirmation".

## Feature flag (selling OFF by default)

- `featureFlags/fitness_membership_sales` must hold `{ enabled: true }`, as a boolean. Any other state leaves **BUY** disabled with the message "Memberships aren't on sale yet":
  - the document is missing;
  - it cannot be read;
  - it holds the string `"true"`;
  - it holds any other value.
- To enable it, use AdminOS feature flags (`adminUpdateFeatureFlag`, super admin) with the key `fitness_membership_sales`. Never use localStorage.
- **This gate is presentation only.** `fitnessCreateMembership` does not read the flag (`origin/feat/fitness-attendance-on-8bbfb34`), so a crafted call can still create a pending membership.
  - **Server enforcement is required**: `fitnessCreateMembership` (or `createPaymentIntent` for `fitness_membership`) must refuse while the flag is off. This is handed to the e3 functions lane.
- Viewing memberships, the QR and scanning are not gated. They only work for real, server-active memberships anyway.

## Security

- No client writes.
- Every id is passed to callables as data; the server authorizes. The gym scope is the caller's resolved provider, never a client-supplied id.
- The token is shown only to its holder, is short-lived (5 minutes) and is drawn locally. It never goes to a third-party QR service.
- Hostile names and titles are escaped (suite rows G-ESC and M-ESC; negative control b).

## Performance

- The gym list is paged at 25. Offers are capped at 50 (gym view) and 20 (buy view).
- The member list uses one listener capped at 50 documents. Attendance is read on demand.
- `sokoni-qr.js` is lazy-loaded in the dashboard only when the scanner opens.

## Dependencies and open items (none of these are this lane's files)

1. **`fitnessGymMemberships`, `fitnessGymMembership` and `fitnessScannerStatus`** are being built by the e3 functions lane. This UI follows the release contract. The detail shape (`membership`, `attendance[]`, `settlement[]`) is assumed and must be confirmed.
2. **The `fitnessCheckIn` response** (8bbfb34 lineage) has no `membershipId`, `member.displayName` or `checkedInAt`. Until it does, the card renders `—` for those fields and never fills them from the token. The functions lane should add them.
3. **The `memberships` module** must be emitted by the workspace authority (5b, `business-workspace.js`) for `fitness_studio`. Until then the section never shows.
4. **Rules**: buyer reads of `providerMemberships` and of the `attendance` subcollection are in the e3 rules candidate and are NOT served. Until they are, the member page cannot read.
5. **`createPaymentIntent` `fitness_membership`** (2f, `commercial-fn`) and the webhook membership purpose (5b) are not deployed.
6. **The server-side sales flag** (see above).
7. **The browser certification** is QUEUED (free RAM was below the 512 MB floor). Run `node scripts/test-fitness-memberships-browser.js` when RAM allows. Do not add it to `predeploy-browser-suites.js` until it has passed.
