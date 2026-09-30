# Slice B + Header candidate — certification record (2026-09-30)

**Branch:** `hosting/parcel-rail-on-b108ae3` @ `C:/temp/sok-parcel-web` · **Live base re-verified:** `b108ae3` (v647) at certification time.
**Status:** CERTIFIED, **NOT DEPLOYED**. Owner authorized build + certify only.
Related: [[PARCEL_DELIVERY_WHATSAPP_AUTHORITY_MAP]] · [[Support]] · [[Delivery Hub]]

## Commits on the candidate (above live)

| Commit | Slice | Files |
|---|---|---|
| `2bcdae2` | Header asks (independent track) | `index.html`, `notifications.html`, `shared-header.js`, `sokoni-command-palette.js`, `sokoni-nav-engine.css`, `sokoni-nav-engine.js`, `sokoni-notif-center.js`, `sokoni-notif-engine.js`, `style.css`, `scripts/test-notif-activity-view.js` |
| `79ce3e0` | Slice B — support authority + WhatsApp booking replacement | `support.html`, `sokoni-support-contact.js` (new), `sokoni-record-links.js` (new), `sokoni-company.js`, `sokoni-pay.js`, `delivery.html`, `driver.html`, `delivery-tracking.html`, `cleaning.html`, `plumbing.html`, `electrical.html`, `phone-repair.html`, `car-rental.html`, `home-services.html`, `tech-hub.html`, `mechanics.html`, `legal-hub.html`, `car-hub.html`, `construction.html`, `CHANGELOG.md`, `scripts/test-slice-b-support-whatsapp.js` |
| (this) | certification record + header browser test | `docs/…`, `scripts/test-header-candidate.js` |

No functions, no rules, no `firebase.json`, no service-worker or version artefacts. Tree clean after each commit; all paths authored by this session.

## Evidence

| Check | Result |
|---|---|
| `scripts/test-slice-b-support-whatsapp.js` (Firestore emulator on alternate ports, functions = `C:/temp/sok-f1/functions` = deployed F1-R lineage; `admin-os*.js` byte-identical on `f50e675`) | **26 / 0** |
| … S: `SokoniSupportContact` in a VM — payload `op:adminCreateSupportTicket`; server id only; localStorage written after the reply, flagged `server:true`; no id → submit fails | 6/6 |
| … W: no supported surface hands a booking/support request to WhatsApp (waConnect, 11 hub pages, delivery/driver/tracking, support page); negative control turns W1 red | 12/12 |
| … B: the REAL `support.html` in Chromium, every non-local origin aborted, stub firebase: `?topic=parcel&ref=` prefills; clicking Submit dispatches exactly one `adminOsDispatch` with the typed message; the page shows the server id and only then caches it; 0 page errors | 4/4 |
| … R: the exact browser payload through the REAL `adminOsDispatch` → `supportTickets/{id}` with the caller's uid, `status:open`; unauthenticated refused; a customer cannot list; **the super admin's `adminGetSupportTickets` returns it** (owner: routed to AdminOS) | 4/4 |
| `scripts/test-header-candidate.js` (Chromium, hermetic) — no back button; cart before bell; no ⚡; drawer header logo-first / no wordmark / ✕ last / logo ≥48px; palette ✕ visible and closes; Escape closes from the list; home static nav matches | **8 / 0** |
| `scripts/test-notif-activity-view.js` on this line | **26 / 0** |
| `scripts/predeploy-syntax-gate.js` | 1799 files + 454 inline blocks parse cleanly |
| `scripts/gate-inventory.js` | SKIPPED — no inventory path touched (gate not bypassed; it ran and found nothing in scope) |
| `scripts/deploy/guard-no-rollback.js` (read-only) | local `79ce3e0` contains live `b108ae3` — would allow |
| Behaviour not changed (diff grep) | no `createDelivery`/IntaSend/M-Pesa/`deliveryFee`/`proofPIN` lines changed on `delivery.html`; no claim/`packageRequests`/`completeDelivery`/`driverNet` lines changed on `driver.html` or `delivery-tracking.html` |

## What Slice B changed, by class

- **Support authority (customer page):** submit → `SokoniSupportContact.submit` → `adminOsDispatch {op:'adminCreateSupportTicket'}` → `supportTickets` (the collection AdminOS lists and badges). Lookup reads the server record. Both WhatsApp controls on the page → in-app Messages. `?topic=&ref=&desc=` prefill; `sos` → priority critical + Delivery chip.
- **Lever:** `waConnect` keeps the deposit gateway (server STK; the webhook creates `bookings/{ref}`) and ends in an in-app "Booking recorded" dialog with a Support link. 13 callers converge with no per-page change to their call.
- **Direct booking hops migrated:** cleaning, plumbing, electrical, phone-repair, car-rental, home-services, tech-hub (incl. 2× "Hire via WhatsApp" → "Hire via SOKONI"), mechanics, legal-hub, car-hub (mechanic + inspection), construction (contractor + equipment fallbacks). Each modal gains "🛟 Need help? Contact Support".
- **Request-shaped hops → prefilled ticket:** car-hub roadside SOS, car-hub vehicle transport request, mechanics SOS, home-services quote request, tech-hub IT service request. Their own Firestore side-records are unchanged.
- **Parcel/rider/tracking:** `delivery.html` Book-via-WhatsApp → Support, hard-coded number removed, share → native share/copy; `driver.html` rider support → ticket (tel kept); `delivery-tracking.html` SOS → ticket.

## Enumerated and deliberately NOT changed (owner's instruction)

- **`bookNow` and its three malformed callers** (`construction.html:1212/1270`, `healthcare.html:1468`) — own contract repair. `bookNow` body untouched (asserted W3).
- **Remaining `wa.me` on the eleven hub pages** (counted by the cert, not removed): cleaning 1 · plumbing 1 · electrical 1 · phone-repair 1 · car-rental 1 · home-services 4 · tech-hub 10 · mechanics 2 · legal-hub 10 · car-hub 14 · construction 3. Classes: provider **contact chips** on cards (communication class), **registrations / admin follow-ups** (mechanic, provider, startup, job post, advocate, law firm, "list your tool"), **responses to requests** ("Respond", "Send Quote"), **share** (`legal-hub:3390`, `car-hub:3987`, `delivery-tracking` dtShareWA — keep), legal **commission/verification** admin links. Owner decision needed per class before Slice B2.
- **Hard-coded support number elsewhere** (footer/policy pages, checkout, contact.html, index.html, script.js): support-hand-off class, not booking; untouched.
- **Known upstream fact, not this slice:** the gateway's "payment confirmed" depends on `payments/{ref}` reaching COMPLETE, which only `webhookIntasend` writes — recorded as contained with no callbacks since 09-14. Slice B did not change that seam.

## Deployment (NOT authorized)

If authorized: hosting only, from this branch tip, `firebase deploy --only hosting` from `C:/temp/sok-parcel-web` (both node_modules junctions present), predeploy gates as configured; verify with `curl -s "https://mysokoni.co.ke/support.html?cb=…" | grep -c SokoniSupportContact` (expect ≥1) and `version.json` commit. The header commit `2bcdae2` can ship alone by deploying from a worktree at that commit.
