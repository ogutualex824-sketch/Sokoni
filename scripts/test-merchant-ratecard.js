#!/usr/bin/env node
'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   test-merchant-ratecard.js — the ONE generic provider rate-card editor
   (sokoni-merchant-ratecard.js), driven in a VM against the REAL server code.

   The fake providerDispatch does not re-implement anything: it loads the LIVE
   providerDispatch archive's functions/provider-ops.js (C:/temp/pd-live/src, byte-identical
   to this tree's functions/provider-ops.js — asserted below) over an in-memory Firestore,
   and runs its real handlers: providerListServices, providerAddService,
   providerUpdateService, providerToggleService, providerUpdateServicePricing (the real
   _sanitizePricing, owner check and whole-field REPLACE) and bookingPreviewPrice (the real
   service-pricing computePrice). Every payload the editor sends is therefore validated by
   the server code itself.

   NO browser, NO emulator, NO network, NO production access.

   Negative controls (each must turn ONE named row red):
     X-a  the editor sends a PARTIAL pricing object      → R2 (full-object replace)
     X-b  the editor sends KES floats instead of cents   → R3 (cents integrity)
     X-c  the editable rule fails OPEN (!== false)       → R7 (read-only matrix)
   Exit code 1 on any failure.
   ════════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LIVE = 'C:/temp/pd-live/src';
const MOD_SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-ratecard.js'), 'utf8');
const NOTE = 'Changes apply to new bookings only; existing bookings keep their price.';

/* ── the server code: live archive, else this tree's copy (reported) ── */
const liveOps = path.join(LIVE, 'provider-ops.js');
const treeOps = path.join(ROOT, 'functions', 'provider-ops.js');
const OPS_PATH = fs.existsSync(liveOps) ? liveOps : treeOps;
const PRICING_PATH = path.join(path.dirname(OPS_PATH), 'service-pricing.js');
const DISPATCH_PATH = path.join(path.dirname(OPS_PATH), 'provider-dispatch.js');
const OPS_SRC = fs.readFileSync(OPS_PATH, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let printing = true;
let results = [];
function ck (name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (printing) console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   [' + safe(detail) + ']'));
}
function safe (d) { try { return typeof d === 'string' ? d : JSON.stringify(d); } catch (_) { return String(d); } }
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o, kk) => (o[kk] = x[kk], o), {}) : x);
const deq = (a, b) => canon(a) === canon(b);
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

/* ── fake Firestore (enough for provider-ops' service handlers) ── */
const TS = { __ts: true };
function makeDb () {
  const cols = {};
  const col = (n) => (cols[n] || (cols[n] = new Map()));
  let seq = 0;
  const resolve = (v) => (v === TS ? '__ts__' : v);
  function ref (n, id) {
    return {
      id,
      async get () { const d = col(n).get(id); return { id, exists: !!d, data: () => JSON.parse(JSON.stringify(d)) }; },
      async update (patch) {
        const d = col(n).get(id); if (!d) throw new Error('NOT_FOUND ' + n + '/' + id);
        Object.keys(patch).forEach((k) => { d[k] = JSON.parse(JSON.stringify(resolve(patch[k]))); });   /* field-level REPLACE, like Firestore update */
      },
      async set (obj, opt) {
        const cur = (opt && opt.merge && col(n).get(id)) || {};
        Object.keys(obj).forEach((k) => { cur[k] = JSON.parse(JSON.stringify(resolve(obj[k]))); });
        col(n).set(id, cur);
      },
    };
  }
  function query (n, filters, lim) {
    return {
      where (f, op, v) { return query(n, filters.concat([[f, op, v]]), lim); },
      limit (k) { return query(n, filters, k); },
      async get () {
        let docs = [...col(n).entries()].filter(([, d]) => filters.every(([f, op, v]) => op === '==' && d[f] === v));
        if (lim) docs = docs.slice(0, lim);
        docs = docs.map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) }));
        return { docs, size: docs.length, empty: !docs.length };
      },
    };
  }
  return {
    cols, col,
    collection (n) {
      return Object.assign(query(n, [], 0), {
        doc: (id) => ref(n, id),
        async add (obj) { const id = 'new' + (++seq); await ref(n, id).set(obj); return { id }; },
      });
    },
  };
}

class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }

function loadServer (db) {
  const pricingMod = require(PRICING_PATH);
  const stubs = {
    'firebase-functions/v2/https': { HttpsError },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => TS, increment: (n) => n }, Timestamp: {} },
    'firebase-functions/logger': { info () {}, warn () {}, error () {}, log () {} },
    './subscription-core': { getCommissionRate: async () => 0 },
    './legal-agreements': { assertLegalCompliance: async () => {} },
    './reservation-core': { slotKey: () => 'k' },
    './booking-events': { bookingEvent () {}, TYPES: {} },
    './service-pricing': pricingMod,
  };
  const mod = { exports: {} };
  const req = (n) => { if (n in stubs) return stubs[n]; throw new Error('unexpected server require ' + n); };
  vm.runInNewContext(OPS_SRC, { module: mod, exports: mod.exports, require: req, console, process: { env: {} }, setTimeout, Promise }, { filename: OPS_PATH });
  return { _h: mod.exports._h, computePrice: pricingMod.computePrice };
}
/* The REAL _sanitizePricing, sliced out of the same source (it is not exported). */
function loadSanitiser () {
  const san = OPS_SRC.match(/^const _san\s*=.*$/m)[0];
  const cents = OPS_SRC.match(/^const _cents\s*=.*$/m)[0];
  const a = OPS_SRC.indexOf('function _sanRate'), b = OPS_SRC.indexOf('_h.providerUpdateServicePricing');
  if (a < 0 || b < 0) throw new Error('sanitiser block not found in ' + OPS_PATH);
  const ctx = {};
  vm.runInNewContext(san + '\n' + cents + '\n' + OPS_SRC.slice(a, b) + '\nthis._sanitizePricing = _sanitizePricing;', ctx);
  return ctx._sanitizePricing;
}
const sanitize = loadSanitiser();

/* ── the client module, from (possibly mutated) source ── */
function loadModule (src) {
  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, console, Promise, JSON, setTimeout }, { filename: 'sokoni-merchant-ratecard.js' });
  return mod.exports;
}

/* ── fixtures ── */
const RICH = sanitize({
  currency: 'KES', basePrice: 150000, durationMins: 120, extraHourRate: 50000,
  holidays: ['2026-12-25', '2026-12-26'],
  weekendRate: { type: 'pct', value: 20 },
  holidayRate: { type: 'flat', value: 30000 },
  peakRate: { type: 'pct', value: 15, hours: ['17:00', '20:00'] },
  offPeakDiscount: { type: 'pct', value: 10, hours: ['06:00', '09:00'] },
  deposit: { mode: 'pct', value: 30, balanceDue: 'before' },
  travel: { fee: 20000, perKm: 5000, freeRadiusKm: 5, maxKm: 40 },
  packages: [
    { id: 'pkg_basic', name: 'Basic', price: 100000, durationMins: 60, description: 'One hour', includes: ['Audit'], extras: ['addon_rush'] },
    { id: 'pkg_pro', name: 'Pro', price: 300000, durationMins: 180, description: 'Full', deposit: { mode: 'fixed', value: 50000, balanceDue: 'completion' }, includes: ['Audit', 'Plan'] },
  ],
  addOns: [
    { id: 'addon_rush', name: 'Rush', price: 25000, qtyMax: 2, available: true, description: '24h' },
    { id: 'addon_report', name: 'Report', price: 10000, qtyMax: 0, available: false, description: '' },
  ],
});

function seed (db, opts) {
  opts = opts || {};
  const s = db.col('providerServices');
  s.set('s1', { providerId: 'p1', name: opts.evilName || 'SEO audit', category: opts.evilCat || 'seo', subcategory: 'audit', description: 'd', priceType: 'fixed', price: 150000, fee: 0, deposit: 0, durationMins: 120, active: true, pricing: JSON.parse(JSON.stringify(RICH)) });
  s.set('s2', { providerId: 'p1', name: 'Office cleaning', category: 'cleaning', subcategory: '', description: '', priceType: 'quotation', price: 0, fee: 0, deposit: 0, durationMins: 0, active: true });
  s.set('s3', { providerId: 'p2', name: 'Someone else', category: 'seo', active: true, price: 1 });
  s.set('s4', { providerId: 'p1', name: 'Deleted', category: 'seo', active: false, removedAt: '__ts__', price: 1 });
  db.col('providerSubscriptions').set('p1', { limits: { listings: opts.cap == null ? -1 : opts.cap } });
}

function makeCallable (srv, uid, log, override) {
  return function (name) {
    return async function (payload) {
      log.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
      if (name !== 'providerDispatch') throw Object.assign(new Error('unknown callable ' + name), { code: 'functions/not-found' });
      const { op, ...data } = payload;
      if (override && override[op]) return { data: await override[op](data) };
      const h = srv._h[op];
      if (!h) throw Object.assign(new Error('Unknown op: "' + op + '"'), { code: 'functions/not-found' });
      try { return { data: await h({ auth: uid ? { uid } : null, data }) }; }
      catch (e) { throw Object.assign(new Error(e.message), { code: 'functions/' + (e.code || 'internal') }); }
    };
  };
}
function host () {
  const h = { innerHTML: '', listeners: {} };
  h.addEventListener = (t, fn) => { (h.listeners[t] = h.listeners[t] || []).push(fn); };
  h.removeEventListener = (t, fn) => { h.listeners[t] = (h.listeners[t] || []).filter((f) => f !== fn); };
  return h;
}
function target (attrs, value, checked) {
  return { value, checked, disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest () { return this; } };
}
const chg = (ui, s, card, f, value, extra) => ui._onChange({ target: target(Object.assign({ 'data-s': s, 'data-card': card, 'data-f': f }, extra && extra.attrs), value, extra && extra.checked) });
const click = (ui, act, card, extra) => ui._onClick({ target: target(Object.assign({ 'data-act': act, 'data-card': card }, extra || {})) });

async function env (M, ctxExtra, opts) {
  const db = makeDb(); seed(db, opts); const srv = loadServer(db); const log = [];
  const el = host(); const toasts = [];
  const ctx = Object.assign({ callable: makeCallable(srv, 'p1', log, opts && opts.override), uid: 'p1', session: 'provider', filter: {}, editable: true, onToast: (m) => toasts.push(m) }, ctxExtra || {});
  const ui = M.mount(el, ctx);
  await settle();
  return { db, srv, log, el, ui, ctx, toasts, svc: (id) => db.col('providerServices').get(id) };
}
const opsOf = (log) => log.map((c) => c.payload.op);
const lastOp = (log, op) => log.filter((c) => c.payload.op === op).pop();

/* ════════════════════════════════════════════════════════════════════════════ */
async function suite (src) {
  results = [];
  try { await suiteBody(src); }
  catch (e) { ck('CRASH ' + ((e && e.message) || e), false, e && e.stack); }   /* fails closed */
  return results;
}
async function suiteBody (src) {
  const M = loadModule(src);
  const C = M._core;

  /* ── P: provenance of the server code ── */
  if (fs.existsSync(liveOps) && fs.existsSync(treeOps)) {
    ck('P1  live archive provider-ops.js is byte-identical to this tree\'s functions/provider-ops.js', sha(fs.readFileSync(liveOps, 'utf8')) === sha(fs.readFileSync(treeOps, 'utf8')), { live: sha(fs.readFileSync(liveOps, 'utf8')).slice(0, 12), tree: sha(fs.readFileSync(treeOps, 'utf8')).slice(0, 12) });
  } else ck('P1  server code present (' + OPS_PATH + ')', fs.existsSync(OPS_PATH), OPS_PATH);
  const DISPATCH = fs.readFileSync(DISPATCH_PATH, 'utf8');
  const usedOps = ['providerListServices', 'providerAddService', 'providerUpdateService', 'providerToggleService', 'providerUpdateServicePricing', 'bookingPreviewPrice'];
  const srcOps = (src.match(/dispatch\('([A-Za-z]+)'/g) || []).map((m) => m.slice(10, -1)).sort();
  ck('P2  every op the editor sends is one of the six, and each is in the live providerDispatch ROUTES', deq(srcOps, usedOps.slice().sort()) && usedOps.every((op) => DISPATCH.indexOf("'" + op + "'") > -1), srcOps);

  /* ── R1: list + filter ── */
  let E = await env(M, { filter: {} });
  ck('R1a list comes from providerListServices (owner-scoped by the server); deleted + other owners never shown', opsOf(E.log)[0] === 'providerListServices' && deq(E.ui._state.services.map((s) => s.id).sort(), ['s1', 's2']), E.ui._state.services.map((s) => s.id));
  E = await env(M, { filter: { categories: ['seo'] } });
  ck('R1b filter.categories ["seo"] → only s1', deq(E.ui._state.services.map((s) => s.id), ['s1']), E.ui._state.services.map((s) => s.id));
  E = await env(M, { filter: { categories: [] } });
  ck('R1c filter.categories [] (declared, empty) → nothing (fails closed)', E.ui._state.services.length === 0 && /No services in this category yet/.test(E.el.innerHTML), E.ui._state.services.length);
  E = await env(M, { filter: { serviceKind: 'marketing' } });
  ck('R1d filter.serviceKind with no service carrying it → nothing', E.ui._state.services.length === 0, E.ui._state.services.length);
  ck('R1e filterServices matches subcategory too', deq(C.filterServices([{ id: 'a', category: 'x', subcategory: 'seo' }], { categories: ['seo'] }).map((s) => s.id), ['a']), null);

  /* ── R2: full-object replace ── */
  E = await env(M);
  click(E.ui, 'open', 's1'); chg(E.ui, 'p', 's1', 'basePrice', '2500.75');
  await E.ui._savePricing('s1'); await settle();
  const sent = lastOp(E.log, 'providerUpdateServicePricing');
  const want = sanitize(Object.assign(JSON.parse(JSON.stringify(RICH)), { basePrice: 250075 }));
  const stored = E.svc('s1').pricing;
  ck('R2  full-object replace: one field edited → stored = the WHOLE loaded card + that edit (packages, add-ons, rates, deposit, travel, holidays all kept)',
    !!sent && deq(stored, want) && Object.keys(RICH).every((k) => k in sent.payload.pricing) && stored.packages.length === 2 && stored.addOns.length === 2,
    { sentKeys: sent && Object.keys(sent.payload.pricing), stored });
  ck('R2b success adopts the SERVER\'s sanitised object as the new baseline + shows the new-bookings note', deq(E.ui._state.cards.s1.saved, stored) && E.ui._state.cards.s1.msg.text.indexOf(NOTE) > -1, E.ui._state.cards.s1.msg);

  /* ── R3: cents integrity ── */
  const ints = (o) => { const bad = []; (function w (x, p) { if (x && typeof x === 'object') Object.keys(x).forEach((k) => w(x[k], p + '.' + k)); else if (typeof x === 'number' && !Number.isInteger(x) && !/(value|freeRadiusKm|maxKm)$/.test(p)) bad.push(p); })(o, ''); return bad; };
  const moneyPaths = ['basePrice', 'extraHourRate', 'travel.fee', 'travel.perKm', 'packages.0.price', 'addOns.0.price'];
  E = await env(M);
  click(E.ui, 'open', 's1');
  const cases = [['basePrice', '1500.50', 150050], ['extraHourRate', '0.07', 7], ['travel.fee', '1,500', 150000], ['travel.perKm', '12.3', 1230], ['packages.0.price', '999.99', 99999], ['addOns.0.price', '250', 25000]];
  cases.forEach(([p, v]) => chg(E.ui, 'p', 's1', p, v));
  chg(E.ui, 'p', 's1', 'holidayRate.value', '333.33');
  await E.ui._savePricing('s1'); await settle();
  const st3 = E.svc('s1').pricing;
  const got = cases.map(([p]) => p.split('.').reduce((a, kk) => (a == null ? undefined : a[kk]), st3));
  const sent3 = lastOp(E.log, 'providerUpdateServicePricing');
  ck('R3  cents integrity: KES input → exact integer cents stored by the real server (1500.50→150050, 0.07→7, 1,500→150000, 12.3→1230, 999.99→99999, 250→25000; flat rate 333.33→33333)',
    !!sent3 && deq(got, cases.map((c) => c[2])) && !!st3.holidayRate && st3.holidayRate.value === 33333 && ints(sent3.payload.pricing).length === 0,
    { got, flat: st3.holidayRate && st3.holidayRate.value, nonInt: sent3 && ints(sent3.payload.pricing) });
  const k = C.kesToCents;
  ck('R3b fractions of a cent / negatives / junk are refused client-side (1500.505, 0.001, -5, 12a)', !k('1500.505').ok && !k('0.001').ok && !k('-5').ok && !k('12a').ok && k('').ok && k('').cents === 0, null);
  E = await env(M); click(E.ui, 'open', 's1'); click(E.ui, 'tab', '', { 'data-tab': 'pricing' });
  chg(E.ui, 'p', 's1', 'basePrice', '1500.505');
  ck('R3d the rejected text stays visible beside its error (aria-invalid), never silently replaced', /value="1500\.505"[^>]*>|aria-invalid="true"[^>]*value="1500\.505"/.test(E.el.innerHTML) && /role="alert">KES amounts go to the cent/.test(E.el.innerHTML), null);
  const n0 = E.log.length; await E.ui._savePricing('s1'); await settle();
  ck('R3c an invalid money entry leaves the draft unchanged and BLOCKS the save (no call)', E.ui._state.cards.s1.draft.basePrice === 150000 && E.log.length === n0 && /Not saved/.test(E.ui._state.cards.s1.msg.text) && E.ui._state.cards.s1.errors.basePrice === 'KES amounts go to the cent — at most 2 decimal places.',{ draft: E.ui._state.cards.s1.draft.basePrice, calls: E.log.length - n0 });
  void moneyPaths;

  /* ── R4: every sub-shape round-trips ── */
  E = await env(M); click(E.ui, 'open', 's1');
  await E.ui._savePricing('s1'); await settle();
  const rt = E.svc('s1').pricing;
  const shapes = ['currency', 'basePrice', 'durationMins', 'extraHourRate', 'holidays', 'weekendRate', 'holidayRate', 'peakRate', 'offPeakDiscount', 'deposit', 'travel', 'packages', 'addOns'];
  ck('R4a untouched save round-trips EVERY sub-shape unchanged (' + shapes.join(', ') + ')', shapes.every((s) => deq(rt[s], RICH[s])), shapes.filter((s) => !deq(rt[s], RICH[s])));
  /* edits through the controls */
  E = await env(M); click(E.ui, 'open', 's2');   /* s2: no pricing at all */
  chg(E.ui, 'p', 's2', 'basePrice', '800'); chg(E.ui, 'p', 's2', 'durationMins', '90'); chg(E.ui, 'p', 's2', 'extraHourRate', '200');
  chg(E.ui, 'p', 's2', 'holidays', '2026-12-25\n2027-01-01, 2026-12-25');
  chg(E.ui, 'p', 's2', 'weekendRate.type', 'pct'); chg(E.ui, 'p', 's2', 'weekendRate.value', '12.5');
  chg(E.ui, 'p', 's2', 'holidayRate.type', 'flat'); chg(E.ui, 'p', 's2', 'holidayRate.value', '150');
  chg(E.ui, 'p', 's2', 'peakRate.type', 'flat'); chg(E.ui, 'p', 's2', 'peakRate.value', '100'); chg(E.ui, 'p', 's2', 'peakRate.hours.0', '17:00'); chg(E.ui, 'p', 's2', 'peakRate.hours.1', '19:30');
  chg(E.ui, 'p', 's2', 'offPeakDiscount.type', 'pct'); chg(E.ui, 'p', 's2', 'offPeakDiscount.value', '5');
  chg(E.ui, 'p', 's2', 'deposit.mode', 'fixed'); chg(E.ui, 'p', 's2', 'deposit.value', '250.50'); chg(E.ui, 'p', 's2', 'deposit.balanceDue', 'before');
  chg(E.ui, 'p', 's2', 'travel.fee', '100'); chg(E.ui, 'p', 's2', 'travel.perKm', '20'); chg(E.ui, 'p', 's2', 'travel.freeRadiusKm', '3.5'); chg(E.ui, 'p', 's2', 'travel.maxKm', '25');
  click(E.ui, 'add-addon', 's2'); chg(E.ui, 'p', 's2', 'addOns.0.name', 'Windows'); chg(E.ui, 'p', 's2', 'addOns.0.price', '300'); chg(E.ui, 'p', 's2', 'addOns.0.qtyMax', '3');
  click(E.ui, 'add-addon', 's2'); chg(E.ui, 'p', 's2', 'addOns.1.name', 'Oven'); chg(E.ui, 'p', 's2', 'addOns.1.price', '400'); chg(E.ui, 'p', 's2', 'addOns.1.available', '', { checked: false });
  const aid0 = E.ui._state.cards.s2.draft.addOns[0].id, aid1 = E.ui._state.cards.s2.draft.addOns[1].id;
  click(E.ui, 'add-pkg', 's2'); chg(E.ui, 'p', 's2', 'packages.0.name', 'Deep clean'); chg(E.ui, 'p', 's2', 'packages.0.price', '5000'); chg(E.ui, 'p', 's2', 'packages.0.durationMins', '240');
  chg(E.ui, 'p', 's2', 'packages.0.includes', 'Kitchen\nBathrooms'); chg(E.ui, 'p', 's2', 'packages.0.extras', '', { checked: true, attrs: { 'data-v': aid0 } }); chg(E.ui, 'p', 's2', 'packages.0.extras', '', { checked: true, attrs: { 'data-v': aid1 } });
  chg(E.ui, 'p', 's2', 'packages.0.deposit.mode', 'pct'); chg(E.ui, 'p', 's2', 'packages.0.deposit.value', '40');
  const pkgId = E.ui._state.cards.s2.draft.packages[0].id;
  click(E.ui, 'rm-addon', 's2', { 'data-i': '1' });   /* removing an add-on unlinks it from packages */
  await E.ui._savePricing('s2'); await settle();
  const p2 = E.svc('s2').pricing;
  const expect2 = {
    currency: 'KES', basePrice: 80000, durationMins: 90, extraHourRate: 20000, holidays: ['2026-12-25', '2027-01-01'],
    weekendRate: { type: 'pct', value: 12.5 }, holidayRate: { type: 'flat', value: 15000 },
    peakRate: { type: 'flat', value: 10000, hours: ['17:00', '19:30'] }, offPeakDiscount: { type: 'pct', value: 5 },
    deposit: { mode: 'fixed', value: 25050, balanceDue: 'before' },
    travel: { fee: 10000, perKm: 2000, freeRadiusKm: 3.5, maxKm: 25 },
    packages: [{ id: pkgId, name: 'Deep clean', price: 500000, durationMins: 240, description: '', deposit: { mode: 'pct', value: 40, balanceDue: 'completion' }, includes: ['Kitchen', 'Bathrooms'], extras: [aid0] }],
    addOns: [{ id: aid0, name: 'Windows', price: 30000, qtyMax: 3, available: true, description: '' }],
  };
  ck('R4b every sub-shape edited through the controls lands exactly (rates pct/flat/hours, deposit, travel, holidays dedup, package+deposit+includes+extras, add-on; removed add-on unlinked)', deq(p2, expect2), { got: p2 });
  ck('R4c the payload the editor sent was already canonical (the server only defaulted currency to KES on a card that had none)', deq(sanitize(lastOp(E.log, 'providerUpdateServicePricing').payload.pricing), p2) && deq(Object.assign({ currency: 'KES' }, lastOp(E.log, 'providerUpdateServicePricing').payload.pricing), p2), lastOp(E.log, 'providerUpdateServicePricing').payload.pricing);
  E = await env(M); click(E.ui, 'open', 's1');
  chg(E.ui, 'p', 's1', 'weekendRate.type', 'off'); chg(E.ui, 'p', 's1', 'deposit.mode', 'none');
  await E.ui._savePricing('s1'); await settle();
  ck('R4d "Off" removes a rate and "No deposit" removes the deposit (the rest kept)', !('weekendRate' in E.svc('s1').pricing) && !('deposit' in E.svc('s1').pricing) && E.svc('s1').pricing.packages.length === 2, Object.keys(E.svc('s1').pricing));
  E = await env(M); click(E.ui, 'open', 's1');
  chg(E.ui, 'p', 's1', 'weekendRate.type', 'flat');   /* unit changes → value must be re-entered */
  click(E.ui, 'add-pkg', 's1');                       /* nameless package */
  const n4 = E.log.length; await E.ui._savePricing('s1'); await settle();
  ck('R4e pre-checks block a 0-value rate and a nameless package (server would silently drop them)', E.log.length === n4 && /Weekend surcharge: enter a value above 0/.test(E.ui._state.cards.s1.msg.text) && /Package 3: a name is required/.test(E.ui._state.cards.s1.msg.text), E.ui._state.cards.s1.msg);

  /* ── R5: server refusals verbatim ── */
  E = await env(M); click(E.ui, 'open', 's1');
  E.svc('s1').providerId = 'p9';     /* ownership moved after load: the server must refuse */
  await E.ui._savePricing('s1'); await settle();
  ck('R5a owner check is the SERVER\'s: refusal shown verbatim ("Not your service.") and nothing stored', E.ui._state.cards.s1.msg.text === 'Not your service.' && E.el.innerHTML.indexOf('Not your service.') > -1 && deq(E.svc('s1').pricing, RICH), E.ui._state.cards.s1.msg);
  E = await env(M, {}, { cap: 2 });
  click(E.ui, 'add-open', '');
  chg(E.ui, 'a', '', 'name', 'Third'); chg(E.ui, 'a', '', 'price', '100');
  await E.ui._addService(); await settle();
  ck('R5b plan cap refusal from providerAddService shown verbatim', E.ui._state.add && E.ui._state.add.msg.text === 'Your plan allows 2 active services. Upgrade to add more.', E.ui._state.add && E.ui._state.add.msg);
  E = await env(M, {}, { override: { providerUpdateServicePricing: async () => { throw new HttpsError('failed-precondition', 'Pricing is <b>locked</b> & frozen.'); } } });
  click(E.ui, 'open', 's1'); click(E.ui, 'tab', '', { 'data-tab': 'pricing' });
  await E.ui._savePricing('s1'); await settle();
  ck('R5c a refusal with markup is shown verbatim AND escaped', E.ui._state.cards.s1.msg.text === 'Pricing is <b>locked</b> & frozen.' && E.el.innerHTML.indexOf('Pricing is &lt;b&gt;locked&lt;/b&gt; &amp; frozen.') > -1 && E.el.innerHTML.indexOf('<b>locked') < 0, null);

  /* ── R6: preview through bookingPreviewPrice ── */
  E = await env(M); click(E.ui, 'open', 's1');
  chg(E.ui, 'p', 's1', 'basePrice', '2000');   /* unsaved draft */
  chg(E.ui, 'pv', 's1', 'packageId', 'pkg_pro'); chg(E.ui, 'pv', 's1', 'addOns', '', { checked: true, attrs: { 'data-v': 'addon_rush' } });
  chg(E.ui, 'pv', 's1', 'date', '2026-12-25'); chg(E.ui, 'pv', 's1', 'startTime', '18:00'); chg(E.ui, 'pv', 's1', 'distanceKm', '12');
  click(E.ui, 'tab', '', { 'data-tab': 'preview' });
  await E.ui._preview('s1'); await settle();
  const pvCall = lastOp(E.log, 'bookingPreviewPrice');
  const engine = E.srv.computePrice(sanitize(pvCall.payload.pricing), { packageId: 'pkg_pro', addOns: [{ id: 'addon_rush', qty: 1 }] }, { date: '2026-12-25', startTime: '18:00', distanceKm: 12 });
  ck('R6a preview = ONE bookingPreviewPrice call with the DRAFT pricing + selection + ctx; shows the engine\'s total and deposit', !!pvCall && pvCall.payload.pricing.basePrice === 200000 &&
    deq(pvCall.payload.selection, { packageId: 'pkg_pro', addOns: [{ id: 'addon_rush', qty: 1 }] }) && deq(pvCall.payload.ctx, { date: '2026-12-25', startTime: '18:00', distanceKm: 12 }) &&
    E.el.innerHTML.indexOf(C.fmtKes(engine.totalCents)) > -1 && E.el.innerHTML.indexOf(C.fmtKes(engine.depositCents)) > -1, { total: engine.totalCents, html: E.el.innerHTML.slice(-600) });
  E = await env(M, {}, { override: { bookingPreviewPrice: async () => ({ totalCents: 123, depositCents: 0, depositMode: 'none', breakdown: [{ label: 'Server says', amount: 123 }] }) } });
  click(E.ui, 'open', 's1'); click(E.ui, 'tab', '', { 'data-tab': 'preview' });
  await E.ui._preview('s1'); await settle();
  ck('R6b the UI displays the SERVER\'s figure, not its own (a server total of 123 cents renders as KES 1.23)', E.el.innerHTML.indexOf('KES 1.23') > -1 && E.el.innerHTML.indexOf('Server says') > -1, null);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* code, not comments */
  ck('R6c no price engine in the browser: the module CODE never names computePrice / _applyRate / subtotal arithmetic', !/computePrice|_applyRate|subtotal\s*=/.test(code), null);

  /* ── R7: read-only matrix (P0-F owner-state rule) ── */
  const matrix = [
    ['editable missing', {}, false], ['editable false', { editable: false }, false], ['editable "true"', { editable: 'true' }, false],
    ['editable 1', { editable: 1 }, false], ['editable true', { editable: true }, true], ['editable true + readOnly', { editable: true, readOnly: true }, false],
    ['readOnly false, editable missing', { readOnly: false }, false],
  ];
  const mres = [];
  for (const [label, ex, wantEdit] of matrix) {
    const ctxEx = Object.assign({}, ex); if (!('editable' in ex)) ctxEx.editable = undefined;
    const e = await env(M, Object.assign(ctxEx, { reason: wantEdit ? null : 'Your account is deactivated.' }));
    click(e.ui, 'open', 's1'); click(e.ui, 'tab', '', { 'data-tab': 'pricing' });
    const html = e.el.innerHTML;
    const ctlTags = html.match(/<(input|select|textarea)[^>]*data-s="(p|b)"[^>]*>/g) || [];
    const allDisabled = ctlTags.length > 0 && ctlTags.every((t) => / disabled/.test(t));
    const saveDisabled = /data-act="save-pricing"[^>]*disabled/.test(html);
    const before = canon(e.ui._state.cards.s1.draft);
    chg(e.ui, 'p', 's1', 'basePrice', '1');
    const mutated = canon(e.ui._state.cards.s1.draft) !== before;
    const n = e.log.length;
    await e.ui._savePricing('s1'); await e.ui._saveBasic('s1'); await e.ui._toggle('s1'); await settle();
    const writes = e.log.slice(n).filter((c) => c.payload.op !== 'bookingPreviewPrice').length;
    await e.ui._preview('s1'); await settle();
    const previewed = e.log.some((c) => c.payload.op === 'bookingPreviewPrice');
    const ok = wantEdit
      ? (C.canEdit(e.ctx) && !allDisabled && !saveDisabled && mutated && writes > 0 && html.indexOf('Read-only.') < 0)
      : (!C.canEdit(e.ctx) && allDisabled && saveDisabled && !mutated && writes === 0 && previewed && html.indexOf('Your account is deactivated.') > -1);
    mres.push([label, ok, { allDisabled, saveDisabled, mutated, writes, previewed }]);
  }
  ck('R7  read-only matrix: ONLY editable === true (and not readOnly) edits; every other ctx disables every control, shows the reason, sends no write, keeps preview',
    mres.every((r) => r[1]), mres.filter((r) => !r[1]));

  /* ── R8: escaping ── */
  E = await env(M, {}, { evilName: '<img src=x onerror=alert(1)>', evilCat: '"><script>alert(2)</script>' });
  click(E.ui, 'open', 's1');
  const h8 = E.el.innerHTML;
  ck('R8  every stored text is escaped (name, category; text and attribute contexts)', h8.indexOf('<img') < 0 && h8.indexOf('<script') < 0 && h8.indexOf('&lt;img src=x onerror=alert(1)&gt;') > -1 && h8.indexOf('&quot;&gt;&lt;script&gt;') > -1, null);
  ck('R8b esc covers & < > " \'', C.esc('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;', C.esc('&<>"\''));

  /* ── R9: basic fields + toggle + add ── */
  E = await env(M); click(E.ui, 'open', 's1');
  chg(E.ui, 'b', 's1', 'name', 'SEO audit plus'); chg(E.ui, 'b', 's1', 'price', '1750.25');
  await E.ui._saveBasic('s1'); await settle();
  const ub = lastOp(E.log, 'providerUpdateService');
  ck('R9a basic save → providerUpdateService with ONLY the changed fields, price in cents', !!ub && deq(ub.payload, { op: 'providerUpdateService', serviceId: 's1', name: 'SEO audit plus', price: 175025 }) && E.svc('s1').name === 'SEO audit plus' && E.svc('s1').price === 175025 && deq(E.svc('s1').pricing, RICH), ub && ub.payload);
  await E.ui._toggle('s1'); await settle();
  ck('R9b pause → providerToggleService {serviceId, active:false}; server answer adopted', deq(lastOp(E.log, 'providerToggleService').payload, { op: 'providerToggleService', serviceId: 's1', active: false }) && E.svc('s1').active === false && E.ui._state.cards.s1.svc.active === false, lastOp(E.log, 'providerToggleService'));
  E = await env(M, { filter: { categories: ['seo'] } });
  click(E.ui, 'add-open', ''); chg(E.ui, 'a', '', 'name', 'Backlinks'); chg(E.ui, 'a', '', 'price', '4999.99'); chg(E.ui, 'a', '', 'durationMins', '60');
  await E.ui._addService(); await settle();
  const ad = lastOp(E.log, 'providerAddService');
  const created = [...E.db.col('providerServices').entries()].find(([, d]) => d.name === 'Backlinks');
  ck('R9c add → providerAddService in the filter\'s single category, price in cents; list reloads and opens the new card', !!ad && ad.payload.category === 'seo' && ad.payload.price === 499999 && !!created && E.ui._state.open === created[0] && E.ui._state.services.some((s) => s.id === created[0]), ad && ad.payload);

  /* ── R10/R11: note + bookings untouched ── */
  E = await env(M); click(E.ui, 'open', 's1'); click(E.ui, 'tab', '', { 'data-tab': 'pricing' });
  ck('R10 the pricing panel states: "' + NOTE + '"', E.el.innerHTML.indexOf(NOTE) > -1, null);
  ck('R11 the editor never reads or writes bookings (no booking op but the preview, no bookings collection)', !/providerBookings|bookingCreate|providerConfirmBooking/.test(src), null);

  /* ── R12: destroy ── */
  E = await env(M); E.ui.destroy();
  ck('R12 destroy() clears the host and removes its listeners', E.el.innerHTML === '' && !(E.el.listeners.change || []).length && !(E.el.listeners.click || []).length, null);

  /* ── W: shell wiring (static, real files) ── */
  const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  const RC = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('W1  merchant-v2 loads the module and mounts it as MODULES.rates', /<script src="sokoni-merchant-ratecard\.js"><\/script>/.test(SHELL) && /rates:\s*\{ global: 'SokoniMerchantRateCard'/.test(SHELL), null);
  const mctx = (SHELL.match(/rates:\s*\{ global: 'SokoniMerchantRateCard'[\s\S]*?onToast: toast \}; \} \}/) || [''])[0];
  ck('W2  the shell ctx passes editable ONLY from S.editable.editable === true in a provider session; readOnly otherwise', /S\.session === 'provider' && !!E && E\.editable === true/.test(mctx) && /editable: ok, readOnly: !ok/.test(mctx) && /callable: _callable/.test(mctx), mctx);
  ck('W3  route rates: provider-only, gated on module:services', deq(RC.sessionsOf('rates'), ['provider']) && RC.groupRequires('rates') === 'module:services' && RC.validate().length === 0, RC.validate());
}

(async function main () {
  console.log('\nsokoni-merchant-ratecard — server code: ' + OPS_PATH + ' (sha256 ' + sha(OPS_SRC).slice(0, 16) + '…)');
  const main = await suite(MOD_SRC);
  let fail = main.filter((r) => !r.ok).length;

  console.log('\nX  negative controls (each must turn its named row red)');
  printing = false;
  const controls = [
    ['X-a partial pricing payload', 'var p = clone(draft) || {};', 'var p = { basePrice: draft.basePrice };', 'R2 '],
    ['X-b KES floats instead of cents', "var cents = parseInt(m[1], 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);", 'var cents = Number(s);', 'R3 '],
    ['X-c editable fails open', 'ctx.readOnly !== true && ctx.editable === true', 'ctx.readOnly !== true && ctx.editable !== false', 'R7 '],
  ];
  for (const [label, from, to, row] of controls) {
    const applied = MOD_SRC.indexOf(from) > -1;
    let red = false;
    if (applied) {
      const res = await suite(MOD_SRC.replace(from, to));
      red = res.some((r) => r.name.indexOf(row) === 0 && !r.ok);
    }
    printing = true;
    ck(label + ' → ' + row.trim() + ' goes red', applied && red, { applied, red });
    printing = false;
    if (!(applied && red)) fail++;
  }
  printing = true;
  const total = main.length + controls.length;
  console.log('\n' + (total - fail) + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fails closed):', e); process.exit(1); });
