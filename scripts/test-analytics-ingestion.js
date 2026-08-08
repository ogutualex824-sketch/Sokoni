/* Analytics event ingestion & sync test — proves the emit-side contract:
   a transaction event drives the shared analytics state, deduped so revenue can
   never be counted twice, and every subscriber updates WITHOUT a screen opening.
   Runs the real sokoni-analytics.js under mocked globals with a stubbed engine. */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── mock globals BEFORE requiring the module ── */
let computeCalls = 0;
const _listeners = {};
global.window = {
  firebaseAuth: { currentUser: { uid: 'S1' } },
  SokoniAnalyticsEngine: { compute: () => { computeCalls++; return Promise.resolve({ revenue: 1500, orders: 3, aov: 500 }); } },
  addEventListener: (t, fn) => { (_listeners[t] = _listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
global.Event = function (t) { this.type = t; };
global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };

require(path.join(__dirname, '..', 'sokoni-analytics.js'));
const SA = global.window.SokoniAnalytics;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  ok(SA && typeof SA.record === 'function', 'SokoniAnalytics.record() present');
  ok(typeof SA.subscribe === 'function' && typeof SA.getSnapshot === 'function' && typeof SA.compute === 'function', 'subscribe/getSnapshot/compute present');
  ok(typeof SA.track === 'function', 'track() now exists (was called by pos.js but missing)');
  /* the pre-existing API must survive (extend, not replace) */
  ok(typeof SA.subscribeGlobal === 'function' && typeof SA.subscribeShop === 'function' && typeof SA.shape === 'function', 'existing aggregate subscribers preserved');

  const snaps = [];
  const off = SA.subscribe((a) => { snaps.push(a); });

  /* Ingest a sale, a DUPLICATE of it, and a second distinct sale. */
  const e1 = { type: 'SALE_COMPLETED', sellerUid: 'S1', eventId: 'E1', total: 1000, source: 'POS' };
  ok(SA.record(e1).duplicate === false, 'first SALE_COMPLETED ingested');
  ok(SA.record(e1).duplicate === true, 'exact repeat (same sellerUid+eventId) → DUPLICATE, not counted');
  ok(SA.record({ type: 'SALE_COMPLETED', sellerUid: 'S1', eventId: 'E2', total: 500, source: 'POS' }).duplicate === false, 'distinct event ingested');
  /* Same eventId but DIFFERENT seller is a different key (not a dup). */
  ok(SA.record({ type: 'SALE_COMPLETED', sellerUid: 'S2', eventId: 'E1', total: 200, source: 'POS' }).duplicate === false, 'same eventId, different seller → not a duplicate');

  const d = SA.diagnostics();
  ok(d.received === 4, 'received counts every inbound event (4)');
  ok(d.processed === 3, 'processed counts unique events (3)');
  ok(d.duplicates === 1, 'duplicates counted (1)');
  ok(d.lastEvent === 'SALE_COMPLETED', 'last event type recorded');
  ok(d.sources.POS === 'ok', 'source health recorded (POS)');

  /* Recompute is debounced → the burst of events collapses into ONE compute, and
     subscribers receive the shared state without any screen navigation. */
  await delay(600);
  ok(computeCalls === 1, 'burst of events debounced into ONE recompute (no per-event storm)');
  ok(snaps.length >= 1 && snaps[snaps.length - 1].revenue === 1500, 'subscriber received the recomputed shared state');
  ok(SA.getSnapshot().analytics && SA.getSnapshot().analytics.orders === 3, 'getSnapshot() exposes the shared analytics state');
  off();

  console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
