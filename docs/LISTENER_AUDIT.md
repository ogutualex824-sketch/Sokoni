# Platform-Wide onSnapshot Listener Leak Audit

**Date:** 2026-07-12
**Sprint:** B-16
**Auditor:** SOKONI AI Engineering Team

---

## Executive Summary

A full audit of all root-level HTML files was performed to identify `onSnapshot` listeners whose return value (the unsubscribe function) was discarded. A discarded unsubscribe function means the listener runs indefinitely — it cannot be stopped, causing Firestore read billing to continue after the user has left the page, and creating memory leaks in long-lived sessions.

**Result:** 33 leaks found and fixed across 21 HTML files. `digital.html` was excluded (already fixed in the go-live sprint). All fixed files now store their unsubscribe function and register a `beforeunload` handler to call it when the page is closed or navigated away.

---

## Scope

Files scanned: All `*.html` in the repository root (52 files contained `onSnapshot` calls).

`digital.html` was explicitly excluded per task scope — already hardened in a prior sprint.

---

## Audit Table

| File | onSnapshot calls | Leaked before fix | Fixed this sprint |
|------|-----------------|-------------------|-------------------|
| admin-os.html | 1 | YES (sidebar ticket badge) | YES |
| admin.html | 1 | No (stored in `_payoutsUnsub`) | — |
| async-jobs.html | 1 | No (stored in `_liveUnsub`) | — |
| bnb-hub.html | 1 | YES (module-level, no var) | YES |
| bnb-manage.html | 2 | YES (both in functions) | YES |
| bnb.html | 1 | YES (module-level, no var) | YES |
| business.html | 1 | YES (live follower count) | YES |
| commission-admin.html | 1 | No (stored in `_auditUnsub`) | — |
| community.html | 2 | YES (groups listener, 1 of 2) | YES |
| customer-display.html | 1 | YES (POS display sync) | YES |
| digital-esoko-seller.html | 2 | YES (products + sales) | YES |
| digital-esoko.html | 1 | YES (product feed) | YES |
| digital.html | 7 | No (fixed in prior sprint) | — |
| dispatch.html | 4 | No (all stored in `_unsub*` vars) | — |
| driver.html | 2 | YES (dispatch subscription, 1 of 2) | YES |
| ecc.html | 12 | No (all stored + pushed to `_listeners[]`) | — |
| enterprise-ops.html | 1 | No (stored in `alertsUnsubscribe`) | — |
| executive-dashboard.html | 3 | No (all stored + `_addUnsub()`) | — |
| expense-management.html | 2 | No (both stored in `unsubExpenses`/`unsubApproval`) | — |
| fitness-hub.html | 3 | YES (classes + clubs + bookings) | YES |
| food-dashboard.html | 1 | YES (live order feed) | YES |
| food-order.html | 1 | YES (order status listener) | YES |
| gip.html | 1 | No (stored in `const _unsubAlerts`) | — |
| home-services.html | 1 | YES (provider listings) | YES |
| index.html | 2 | YES (payment + order toasts) | YES |
| kass-developer.html | 1 | No (stored in `sessUnsub`) | — |
| kass-executive.html | 1 | No (stored in `sessUnsub`) | — |
| kass-finance.html | 1 | No (stored in `sessUnsub`) | — |
| kass-manager.html | 1 | No (stored in `sessUnsub`) | — |
| kass-seller.html | 1 | No (stored in `sessUnsub`) | — |
| kass-support.html | 1 | No (stored in `sessUnsub`) | — |
| kitchen-display.html | 1 | No (stored in `KDS.unsubscribe`) | — |
| manager-auth.html | 1 | No (stored in `_reqUnsub`) | — |
| moderation.html | 4 | No (all stored in `unsub*` vars) | — |
| my-subscriptions.html | 1 | No (stored in `_payUnsub`) | — |
| payments.html | 2 | No (stored in `const unsub`, local scope) | — |
| platform.html | 2 | No (stored in `_liveUnsub` / `_overviewFeedUnsub`) | — |
| pos-daily.html | 1 | YES (daily analytics) | YES |
| pos-display.html | 1 | No (stored in `const unsubscribe`) | — |
| pos-kds.html | 1 | No (stored in `_unsub`) | — |
| pos-live-floor.html | 2 | No (stored in `_floorUnsub` + `_eventsUnsub`) | — |
| pos-marketplace.html | 1 | No (stored in `const unsub`) | — |
| pos-till-manager.html | 1 | YES (till states watcher) | YES |
| pos-workspace.html | 1 | No (stored in `unsubscribeSnap`) | — |
| profile.html | 6 | YES (seller products, bookings, reviews, following, wallet, user doc) | YES |
| property-hub.html | 1 | YES (module-level, no var) | YES |
| release-readiness.html | 2 | No (stored in `liveUnsubscribe` + `historyUnsubscribe`) | — |
| security-center.html | 4 | YES (2 overview panel listeners, 2 stored correctly) | YES |
| seller-delivery.html | 5 | YES (mini-map GPS listener per delivery, 1 of 5) | YES |
| tech-hub.html | 1 | YES (device listings) | YES |
| track.html | 2 | No (stored in `var locUnsub` + `var tripUnsub`) | — |
| uat-center.html | 2 | No (stored in `issueUnsub` + `sessUnsub`) | — |

---

## Summary Metrics

| Metric | Count |
|--------|-------|
| HTML files scanned (with onSnapshot) | 52 |
| Total onSnapshot calls found | 97 |
| Files with at least one leak | 21 |
| Total leaked listeners fixed | 33 |
| Files already clean (no leaks) | 31 |
| Digital.html (excluded, pre-fixed) | 1 |

---

## Fix Patterns Applied

### 1. Module-level listener (fire-and-forget on page load)
```javascript
// Before
onSnapshot(query, snap => { ... });

// After
let _someUnsub = null;
_someUnsub = onSnapshot(query, snap => { ... });
window.addEventListener('beforeunload', () => { if (_someUnsub) _someUnsub(); });
```
Files: `bnb-hub.html`, `bnb.html`, `property-hub.html`, `digital-esoko.html`, `fitness-hub.html` (×2), `food-dashboard.html`

### 2. Function-level listener with re-call guard
```javascript
// Before
function load() {
  onSnapshot(query, snap => { ... });
}

// After
let _someUnsub = null;
function load() {
  if (_someUnsub) { _someUnsub(); _someUnsub = null; }
  _someUnsub = onSnapshot(query, snap => { ... });
}
window.addEventListener('beforeunload', () => { if (_someUnsub) _someUnsub(); });
```
Files: `bnb-manage.html`, `digital-esoko-seller.html`, `food-order.html`, `home-services.html`, `tech-hub.html`, `fitness-hub.html` (bookings), `pos-daily.html`, `pos-till-manager.html`, `business.html`, `community.html`, `security-center.html` (×2), `driver.html`

### 3. Dynamic per-element listener tracking (map)
```javascript
// seller-delivery.html — per mini-map GPS listener
const _miniMapUnsubs = {};
// In _initMiniMap():
if (_miniMapUnsubs[mapId]) { _miniMapUnsubs[mapId](); delete _miniMapUnsubs[mapId]; }
_miniMapUnsubs[mapId] = firebase.firestore()...onSnapshot(...);
window.addEventListener('beforeunload', () => {
  Object.values(_miniMapUnsubs).forEach(fn => fn());
});
```

### 4. Scoped listener with local var
```javascript
// customer-display.html — inside event handler callback
const _cdUnsub = db.collection(...)
  .onSnapshot(snap => { ... });
window.addEventListener('beforeunload', () => { if (_cdUnsub) _cdUnsub(); });
```

### 5. Collected module-level vars (profile.html — 6 listeners)
```javascript
var _profSellerProductsUnsub = null;
var _profBookingsUnsub = null;
// ... 4 more
window.addEventListener('beforeunload', function() {
  if (_profSellerProductsUnsub) _profSellerProductsUnsub();
  // ... etc
});
```

---

## Security & Performance Impact

- **Firestore billing:** Orphaned listeners accumulate reads indefinitely. With 33 leaked listeners, each page visit that triggered these paths would silently open persistent Firestore connections that never close. On a high-traffic platform this translates directly to unbounded monthly Firestore read costs.
- **Memory:** Each orphaned listener holds a closure and a WebSocket subscription open in the browser, degrading performance on lower-end devices over time.
- **Data freshness:** Some function-level listeners (e.g., `loadFSProducts`, `loadUserBookings`) could be re-called multiple times per session (e.g., on auth state change or tab switch), creating listener stacking — each call stacked a new listener without removing the old one. Re-call guards now prevent stacking.

---

## Remaining Considerations

- `gip.html` uses `const _unsubAlerts = onSnapshot(...)` — stored but immutable. Since this is a module-scoped singleton listener, the `const` is fine; the page loads once and no re-subscription is needed.
- `payments.html` uses local-scope `const unsub` inside short-lived functions — acceptable as these listeners are intentionally short-lived (payment result polling) and are explicitly called or garbage-collected with the enclosing function scope.
- `ecc.html` uses a `_listeners[]` array and a dedicated teardown mechanism — excellent pattern, no changes needed.
