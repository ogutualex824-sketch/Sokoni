#!/usr/bin/env node
/* test-merchant-construction-workspace.js — CONSTRUCTION WORKSPACE in merchant-v2 (hosting, 2026-10-03).

   The REAL module (sokoni-merchant-construction.js) runs in a node VM with the canonical escapeHTML lifted from
   security.js, a fake host element, a fake contactRequests reader/writer and a commerceDispatch that RUNS THE REAL
   rental handlers of functions/marketplace-extensions.js (live == tree, checked against the commerceDispatch archive)
   over an in-memory Firestore. The dispatcher's error wrapping is reproduced (a plain Error from a handler reaches the
   client as 'internal'), so the refusals the page shows are the server's. The shell's ONE browser write
   (_conWriteLead) is lifted from merchant-v2.html and executed against a fake SDK.

   Rows
     O  overview: unknown counts '—' (never 0) · a real loaded zero '0' · capped lists 'N+' · all three owner layouts,
        every section resolves to a registered route · reused sections link to EXISTING routes · plan price only from
        a construction-priced catalog entry · fees copy (materials 15%, services 0%, the rest unpriced + OFF)
     L  leads: legal buttons per status (owner matrix, a subset of the f9a5c45 rules leadNext) · labels · move / note
        payloads exactly {status, respondedAt?} / {sellerNote} · shell writer refuses any other shape · chat gated on
        SokoniInbox.TX_TYPES at runtime · permission-denied / staff / failure copy · exact hasMore · failed write
     R  rentals (REAL handlers of sokoni-f3's fix 74672f3, read from git; OLD = this tree / live): owner resolution
        without shops.ownerId · buttons per booking status (active: complete only) · Unpaid copy, never M-Pesa · no pay step
        · Equipment from rentalOwnerListings (hasMore → 'first 200 — more exist', N+) · the direct read ONLY on an
        'Unknown commerce operation' refusal · HttpsError reasons verbatim · create / confirm / availability / seller cancel
     H  honest: Projects (Work engine) · RFQs / Quotes (B2B release, or the rfqs route when present) · Services ·
        Verification (status as recorded; "Verified" only when verified === true; staff)
     S  safety: no wa.me / tel: / mailto: / WhatsApp · escaping · no Firestore write API in the module · dispatch ops
        limited to the six seller rental ops
     G  registry + shell: ten con-* routes, Construction group appended LAST, validate() clean, MODULES wiring, no
        duplicate module ids, script tag
     N  negative controls — each mutant must FAIL its named row:
          N1 an illegal lead button (pending → won)            → L1
          N2 an extra field in the lead move payload           → L3
          N3 a pay button on a rental                          → R2
          N4 '0' rendered for an unknown count                 → O1
          N5 the direct read used although the op exists       → R10
   node scripts/test-merchant-construction-workspace.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('sokoni-merchant-construction.js');
const SHELL = read('merchant-v2.html');
const SEC = read('security.js');
const escAt = SEC.indexOf('function escapeHTML(str){');
const ESC_SRC = SEC.slice(escAt, SEC.indexOf('\n  }', escAt) + 4);
const dec = (s) => String(s).replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&#x60;/g, '`').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* f9a5c45 firestore.rules leadNext() — the server's table, copied from the commit (sokoni-f3 combined rules). */
const RULES_LEAD_NEXT = {
  pending: ['responded', 'contacted', 'qualified', 'lost'], responded: ['qualified', 'quote_requested', 'quote_sent', 'lost'],
  contacted: ['qualified', 'quote_requested', 'quote_sent', 'lost'], qualified: ['quote_requested', 'quote_sent', 'lost'],
  quote_requested: ['quote_sent', 'lost'], quote_sent: ['negotiating', 'won', 'lost'], negotiating: ['quote_sent', 'won', 'lost']
};
/* The owner brief's button matrix (what the page must draw). */
const OWNER_MATRIX = {
  pending: ['responded', 'qualified', 'lost'], responded: ['qualified', 'quote_requested', 'quote_sent', 'lost'],
  contacted: ['qualified', 'quote_requested', 'quote_sent', 'lost'], qualified: ['quote_requested', 'quote_sent', 'lost'],
  quote_requested: ['quote_sent', 'lost'], quote_sent: ['negotiating', 'won', 'lost'], negotiating: ['quote_sent', 'won', 'lost'],
  won: [], lost: [], cancelled: [], expired: []
};

/* ══ in-memory Firestore + the REAL rental handlers ══
   NEW = sokoni-f3's rentals fix, functions/rentals-on-53100ff @ 74672f3 (NOT deployed), read from the shared object store.
   OLD = this tree's functions/marketplace-extensions.js (== the live commerceDispatch archive): no rentalOwnerListings.
   A missing NEW source FAILS the run (fail closed) — the fixtures are never hand-written. */
const F3_RENTALS_REF = process.env.RENTALS_REF || '74672f3';
let NEW_SRC = null;
try { NEW_SRC = require('child_process').execFileSync('git', ['-C', ROOT, 'show', F3_RENTALS_REF + ':functions/marketplace-extensions.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { NEW_SRC = null; }
const OLD_SRC = read('functions/marketplace-extensions.js');
class HttpsError extends Error { constructor (code, m) { super(m); this.code = code; this.httpErrorCode = { canonicalName: code }; } }
function mkAdmin () {
  const data = {}; let seq = 0, clock = Date.now() - 3600000;
  const TS = (ms) => ({ __ts: ms, toDate: () => new Date(ms), toMillis: () => ms });
  const SERVER = { __server: true }, INC = (n) => ({ __inc: n });
  const resolve = (v, prev) => (v === SERVER ? TS(clock++) : (v && v.__inc != null ? ((prev || 0) + v.__inc) : v));
  const coll = (name) => (data[name] = data[name] || {});
  function docRef (c, id) {
    return {
      id,
      async get () { const d = coll(c)[id]; return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) }; },
      async set (v) { const o = {}; for (const k of Object.keys(v)) o[k] = resolve(v[k]); coll(c)[id] = o; },
      async create (v) { if (coll(c)[id]) throw new Error('ALREADY_EXISTS'); return this.set(v); },
      async update (v) { const d = coll(c)[id]; if (!d) throw new Error('NOT_FOUND'); for (const k of Object.keys(v)) d[k] = resolve(v[k], d[k]); }
    };
  }
  function query (c, filters, lim) {
    return {
      where (f, op, v) { return query(c, filters.concat([[f, op, v]]), lim); },
      limit (n) { return query(c, filters, n); },
      async get () {
        let rows = Object.entries(coll(c)).filter(([, d]) => filters.every(([f, , v]) => d[f] === v));
        if (lim) rows = rows.slice(0, lim);
        return { empty: !rows.length, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => Object.assign({}, d) })) };
      }
    };
  }
  const db = {
    collection: (c) => Object.assign(query(c, [], 0), { doc: (id) => docRef(c, id || ('id' + (++seq))) }),
    async runTransaction (fn) {
      const w = [];
      const out = await fn({ get: (r) => r.get(), set: (r, d) => w.push(() => r.set(d)), update: (r, d) => w.push(() => r.update(d)), create: (r, d) => w.push(() => r.create(d)) });
      for (const x of w) await x();
      return out;
    }
  };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => SERVER, increment: INC };
  firestore.Timestamp = { fromDate: (d) => TS(d.getTime()) };
  return { admin: { firestore }, data, TS };
}
function loadHandlers (adminStub, src) {
  const tmp = path.join(require('os').tmpdir(), 'cw-mx-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(tmp, src);
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'firebase-admin') return adminStub;
    if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError };
    if (req === 'firebase-functions/v2/scheduler') return { onSchedule: (o, h) => h };
    return orig.apply(this, arguments);
  };
  try { return require(tmp)._h; } finally { Module._load = orig; try { fs.unlinkSync(tmp); } catch (_) {} }
}
/* callable wire: Timestamps → {_seconds,_nanoseconds}, as the Functions SDK encodes them */
function wire (v) {
  if (v && typeof v === 'object') {
    if (typeof v.__ts === 'number') return { _seconds: Math.floor(v.__ts / 1000), _nanoseconds: 0 };
    if (Array.isArray(v)) return v.map(wire);
    const o = {}; for (const k of Object.keys(v)) o[k] = wire(v[k]); return o;
  }
  return v;
}
const RENTAL_OPS = ['rentalOwnerListings', 'rentalProductCreate', 'rentalGetAvailability', 'rentalList', 'rentalConfirm', 'rentalComplete', 'rentalCancel'];
/* commerceDispatch, reproduced: unknown op → not-found "Unknown commerce operation"; HttpsError passes through with its
   reason; a plain Error becomes internal "Operation failed unexpectedly." The client sees code 'functions/<code>'. */
function mkServer (opts) {
  const o = opts || {};
  const A = mkAdmin(); const H = loadHandlers(A.admin, o.old ? OLD_SRC : NEW_SRC);
  const OWNER = 'owner1', SHOP = 'owner1';
  /* shops/{uid}: the identity model carries no ownerId (owner = doc id). */
  A.data.shops = { [SHOP]: Object.assign({ name: 'Mjengo Hardware' }, o.ownerId ? { ownerId: o.ownerId } : {}) };
  const calls = [];
  async function dispatch (payload) {
    calls.push(JSON.parse(JSON.stringify(payload)));
    const op = payload.op, h = H[op];
    if (!h) { const e = new Error('Unknown commerce operation: "' + op + '". Valid ops: ' + Object.keys(H).sort().join(', ')); e.code = 'functions/not-found'; throw e; }
    try { return wire(await h({ auth: { uid: o.caller || OWNER, token: {} }, data: payload })); }
    catch (err) {
      if (err && err.httpErrorCode) { const e = new Error(err.message); e.code = 'functions/' + err.code; throw e; }
      const e = new Error('Operation failed unexpectedly.'); e.code = 'functions/internal'; e.cause = err && err.message; throw e;
    }
  }
  return { A, H, dispatch, calls, OWNER, SHOP };
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
async function seedRentals (srv) {
  /* seeded THROUGH the real handlers: one equipment item, then renter bookings */
  const as = (uid) => ({ uid, token: { name: 'Renter ' + uid } });
  const r = await srv.H.rentalProductCreate({ auth: as(srv.OWNER), data: { shopId: srv.SHOP, title: 'Concrete mixer 350L', pricingType: 'daily', dailyRate: 3500, deposit: 5000 } });
  const pid = r.rentalProductId;
  const book = (uid, s, e) => srv.H.rentalBook({ auth: as(uid), data: { rentalProductId: pid, startDate: day(s), endDate: day(e), durationUnit: 'daily' } });
  const b1 = await book('b1', 10, 12), b2 = await book('b2', 13, 14), b3 = await book('b3', 20, 21), b4 = await book('b4', 30, 31), b5 = await book('b5', 40, 41), b6 = await book('b6', 50, 51);
  await srv.H.rentalConfirm({ auth: as(srv.OWNER), data: { bookingId: b2.bookingId, shopId: srv.SHOP } });
  await srv.H.rentalConfirm({ auth: as(srv.OWNER), data: { bookingId: b3.bookingId, shopId: srv.SHOP } });
  await srv.H.rentalComplete({ auth: as(srv.OWNER), data: { bookingId: b3.bookingId, shopId: srv.SHOP } });
  await srv.H.rentalCancel({ auth: as('b4'), data: { bookingId: b4.bookingId } });
  await srv.H.rentalConfirm({ auth: as(srv.OWNER), data: { bookingId: b5.bookingId, shopId: srv.SHOP } });
  srv.A.data.rentalBookings[b5.bookingId].status = 'active';   /* no handler sets 'active' yet; the legal-state table includes it */
  return { pid, pending: b1.bookingId, confirmed: b2.bookingId, completed: b3.bookingId, cancelled: b4.bookingId, active: b5.bookingId,
           stale: b6.bookingId, price1: b1.totalAmount, paymentStatus: b1.paymentStatus };
}

/* ══ the module in a VM ══ */
function load (src) {
  const ctx = { console, Promise, Date, setTimeout, Math, JSON, Object, Array, String, Number, RegExp, isFinite, isNaN, Error };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(ESC_SRC + '\nwindow.escapeHTML = escapeHTML;', ctx, { filename: 'security.js#escapeHTML' });
  vm.runInContext(src, ctx, { filename: 'sokoni-merchant-construction.js' });
  return ctx;
}
function attrs (tag) { const o = {}; for (const m of tag.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) o[m[1]] = m[2] == null ? '' : dec(m[2]); return o; }
function mkHost () {
  return { innerHTML: '', _h: {}, vals: {}, ownerDocument: null,
    addEventListener (t, f) { this._h[t] = f; }, removeEventListener () {},
    querySelector (sel) { const m = /^\[data-note="(.+)"\]$/.exec(sel); if (!m || !this.innerHTML.includes('data-note="' + m[1] + '"')) return null; return { value: this.vals['note:' + m[1]] != null ? this.vals['note:' + m[1]] : '' }; },
    querySelectorAll (sel) {
      if (sel !== '[data-f]') return [];
      const out = [];
      for (const m of this.innerHTML.matchAll(/<(input|textarea|select)[^>]*data-f="([^"]+)"/g)) out.push(m[2]);
      return out.map((n) => ({ value: this.vals['f:' + n] != null ? this.vals['f:' + n] : '', getAttribute: () => n }));
    } };
}
const buttons = (host) => [...host.innerHTML.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => Object.assign(attrs(m[1]), { __text: dec(m[2].replace(/<[^>]+>/g, '')).trim() }));
const text = (host) => dec(host.innerHTML.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
async function flush () { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)); }
async function click (host, pred) {
  const b = buttons(host).find(pred); if (!b) return false;
  const el = { disabled: 'disabled' in b, getAttribute: (n) => (n in b ? b[n] : null), closest: (sel) => { const k = /^\[([a-z-]+)\]$/.exec(sel); return k && (k[1] in b) ? el : null; } };
  await host._h.click({ target: el }); await flush(); return true;
}
async function change (host, attr, value) { await host._h.change({ target: { getAttribute: (n) => (n === attr ? '1' : null), value } }); await flush(); }

/* an empty but WORKING fixed server: no listings, no bookings */
const EMPTY = async (p) => (p.op === 'rentalOwnerListings' ? { listings: [], hasMore: false } : { bookings: [] });
const lead = (id, status, extra) => Object.assign({ id, buyerUid: 'buyer-' + id, sellerUid: 'owner1', productId: 'p-' + id, productName: 'Cement 50kg', buyerName: 'Wanjiru', message: 'Need 40 bags', createdAt: { seconds: 1790000000 + id.length }, status }, extra || {});
function mkCtx (V, view, over) {
  const o = over || {};
  const rec = { writes: [], readLeads: 0, readEquipment: 0, go: [], chat: [] };
  const win = { SokoniInbox: o.inbox === undefined ? undefined : o.inbox };
  const ctx = {
    view, window: win,
    uid: () => (o.uid === undefined ? 'owner1' : o.uid),
    role: () => (o.role === undefined ? 'owner' : o.role),
    shopId: () => (o.shopId === undefined ? 'owner1' : o.shopId),
    readLeads: (lim) => { rec.readLeads++; rec.leadLimit = lim; return o.leadsErr ? Promise.reject(o.leadsErr) : Promise.resolve(JSON.parse(JSON.stringify(o.leads || []))); },
    writeLead: (id, p) => { rec.writes.push({ id, p, keys: Object.keys(p), respondedIsToken: p.respondedAt === V.SokoniMerchantConstruction.SERVER_TIME }); return o.writeErr ? Promise.reject(o.writeErr) : Promise.resolve(); },
    readEquipment: () => { rec.readEquipment++; return o.equipErr ? Promise.reject(o.equipErr) : Promise.resolve(o.equip || []); },
    readApplications: () => (o.appsErr ? Promise.reject(o.appsErr) : Promise.resolve(o.apps || [])),
    dispatch: o.dispatch || (() => Promise.reject({ code: 'functions/internal' })),
    callPlans: () => (o.plansErr ? Promise.reject(o.plansErr) : Promise.resolve({ plans: o.plans || [] })),
    hasRoute: (id) => !!(o.routes || []).includes(id),
    hasModule: (g) => !!(o.modules || []).includes(g),
    go: (id) => rec.go.push(id), onToast: () => {}
  };
  return { ctx, rec, win };
}
async function mountView (V, view, over) {
  V.SokoniMerchantConstruction._reset();
  const host = mkHost(); const m = mkCtx(V, view, over);
  const ui = V.SokoniMerchantConstruction.mount(host, m.ctx); await flush();
  return Object.assign({ host, ui }, m);
}

/* ══ the suite (returns {row: ok}) ══ */
async function suite (src, log) {
  const R = {};
  const ck = (id, label, ok, got) => { R[id] = R[id] === undefined ? !!ok : (R[id] && !!ok); if (log) console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + id + '  ' + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); };
  const V = load(src); const M = V.SokoniMerchantConstruction;
  const routes = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

  /* ── O ── */
  let t = await mountView(V, 'overview', { leadsErr: { code: 'permission-denied' }, equipErr: { code: 'permission-denied' }, dispatch: () => Promise.reject({ code: 'functions/internal' }) });
  let tiles = [...t.host.innerHTML.matchAll(/<div class="cw-tile"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)].map((m) => [dec(m[1]), m[2]]);
  ck('O1', 'unknown counts render — (refused leads / equipment, failed rentals), never 0', tiles.length === 4 && tiles.every((x) => x[0] === '—'), tiles);
  t = await mountView(V, 'overview', { role: 'cashier', equip: [], dispatch: EMPTY });
  tiles = [...t.host.innerHTML.matchAll(/<div class="cw-tile"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)].map((m) => [dec(m[1]), m[2]]);
  ck('O1', 'staff: lead tiles — (not read), canonical empty rentals / equipment are 0', tiles[0][0] === '—' && tiles[1][0] === '—' && tiles[2][0] === '0' && tiles[3][0] === '0' && t.rec.readLeads === 0, tiles);
  t = await mountView(V, 'overview', { leads: [], equip: [], dispatch: EMPTY });
  tiles = [...t.host.innerHTML.matchAll(/<div class="cw-tile"><b>([^<]*)<\/b>/g)].map((m) => dec(m[1]));
  ck('O2', 'a real loaded zero renders 0', tiles.join(',') === '0,0,0,0', tiles);
  const many = Array.from({ length: 201 }, (_, i) => lead('L' + i, i % 2 ? 'pending' : 'quote_sent'));
  t = await mountView(V, 'overview', { leads: many, equip: [], dispatch: EMPTY });
  tiles = [...t.host.innerHTML.matchAll(/<div class="cw-tile"><b>([^<]*)<\/b>/g)].map((m) => dec(m[1]));
  ck('O3', 'capped leads (201 read for a 200 page): counts are lower bounds N+, banner shown, query asked limit+1', tiles[0] === '100+' && tiles[1] === '200+' && /at least that many/.test(text(t.host)) && t.rec.leadLimit === 201, { tiles, lim: t.rec.leadLimit });
  const goes = buttons(t.host).filter((b) => 'data-go-route' in b).map((b) => b['data-go-route']);
  const labels = [...t.host.innerHTML.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => dec(m[1]));
  ck('O4', 'three owner layouts (Contractor / Materials supplier / Equipment rental) and every section button resolves to a registered route', ['Contractor', 'Materials supplier', 'Equipment rental'].every((l) => labels.includes(l)) && goes.length >= 25 && goes.every((id) => routes.resolve(id) === id), { labels, bad: goes.filter((id) => routes.resolve(id) !== id) });
  const contractor = M.LAYOUTS.find((l) => l.key === 'contractor').sections.map((s) => s[0]);
  ck('O4', 'contractor layout is the owner\'s 18 sections in order', contractor.join('|') === 'Overview|Storefront|Services|Products|Projects|RFQs|Leads|Quotes|Orders|Customers|Messages|Delivery|Equipment|Marketing|Wallet|Subscription|Verification|Staff', contractor);
  const reused = Object.values(M.REUSED);
  ck('O5', 'reused sections link to EXISTING non-construction routes (shop, products, inventory, orders, customers, messages, deliveries, marketing, payments, plan, staff)', reused.length === 11 && reused.every((id) => routes.get(id) && !/^con-/.test(id)), reused);
  t = await mountView(V, 'overview', { leads: [], plans: [{ id: 'seller_pro', hubType: 'seller', price: { monthly: 999 } }, { id: 'ent', hubType: 'enterprise', price: { monthly: 5000 } }], dispatch: EMPTY });
  ck('O6', 'plans: none priced for construction → "Construction plans: —" (seller / enterprise plans not shown as construction prices)', /Construction plans: — \(SOKONI has not priced/.test(text(t.host)) && !/999|5,000/.test(text(t.host)), text(t.host).slice(-400));
  t = await mountView(V, 'overview', { leads: [], plans: [{ id: 'con_basic', name: 'Builder Basic', hubType: 'construction', price: { monthly: 1500 } }], dispatch: EMPTY });
  ck('O6', 'plans: a construction-priced catalog entry is shown with its server price', /Builder Basic KES 1,500\/month/.test(text(t.host)), text(t.host).slice(-300));
  t = await mountView(V, 'overview', { leads: [], plansErr: { code: 'internal' }, dispatch: EMPTY });
  ck('O6', 'plans: catalog failure → —', /Construction plans: —/.test(text(t.host)), null);
  const tx = text(t.host);
  ck('O7', 'fees copy: materials 15% marketplace, services 0%, featured / lead / rental / plans unpriced and OFF, release not live', /materials[^.]*15%/.test(tx) && /construction services — 0%/.test(tx) && /not priced and are switched OFF/.test(tx) && /not yet live/.test(tx), null);

  /* ── L ── */
  const statuses = Object.keys(OWNER_MATRIX);
  const got = {};
  t = await mountView(V, 'leads', { leads: statuses.map((s) => lead('id_' + s, s)) });
  for (const s of statuses) got[s] = buttons(t.host).filter((b) => b['data-act'] === 'lead-move' && b['data-id'] === 'id_' + s).map((b) => b['data-to']);
  ck('L1', 'legal lead buttons only, exact owner matrix for every status (terminal won/lost/cancelled/expired: none)', statuses.every((s) => JSON.stringify(got[s]) === JSON.stringify(OWNER_MATRIX[s])), got);
  ck('L1', 'every drawn move is also legal under the f9a5c45 rules leadNext()', statuses.every((s) => got[s].every((to) => (RULES_LEAD_NEXT[s] || []).includes(to))), got);
  t = await mountView(V, 'leads', { leads: [lead('nostat', undefined)] });
  ck('L1', 'a lead with no status field is New (pending) — rules default', buttons(t.host).filter((b) => b['data-act'] === 'lead-move').map((b) => b['data-to']).join(',') === 'responded,qualified,lost', buttons(t.host).map((b) => b['data-to']));
  ck('L2', 'labels: pending "New", responded "Contacted", others title-cased', M._pure.leadLabel('pending') === 'New' && M._pure.leadLabel('responded') === 'Contacted' && M._pure.leadLabel('quote_requested') === 'Quote Requested' && M._pure.leadLabel('negotiating') === 'Negotiating', null);
  t = await mountView(V, 'leads', { leads: [lead('a1', 'pending'), lead('a2', 'quote_sent')] });
  await click(t.host, (b) => b['data-id'] === 'a1' && b['data-to'] === 'responded');
  await click(t.host, (b) => b['data-id'] === 'a2' && b['data-to'] === 'won');
  t.host.vals['note:a2'] = '  Delivered Friday  ';
  await click(t.host, (b) => b['data-act'] === 'lead-note' && b['data-id'] === 'a2');
  const W = t.rec.writes;
  ck('L3', 'move to responded writes EXACTLY {status, respondedAt=SERVER_TIME token}', W[0] && W[0].id === 'a1' && W[0].keys.join(',') === 'status,respondedAt' && W[0].p.status === 'responded' && W[0].respondedIsToken, W[0]);
  ck('L3', 'move to won writes EXACTLY {status} (no respondedAt)', W[1] && W[1].keys.join(',') === 'status' && W[1].p.status === 'won', W[1]);
  ck('L3', 'note writes EXACTLY {sellerNote} (trimmed)', W[2] && W[2].keys.join(',') === 'sellerNote' && W[2].p.sellerNote === 'Delivered Friday', W[2]);
  ck('L3', 'after the move the card reflects the new status and terminal won draws no buttons', /Moved to Contacted/.test(text(t.host)) && !buttons(t.host).some((b) => b['data-id'] === 'a2' && b['data-act'] === 'lead-move'), null);
  const pre = W.length; await t.ui._act.moveLead('a2', 'negotiating');
  ck('L3', 'an illegal move (won → negotiating) is refused client-side with no write', t.rec.writes.length === pre && /not available from/.test(text(t.host)), t.rec.writes.length);

  /* L4: the shell writer, executed */
  const a = SHELL.indexOf('var _CON_LEAD_KEYS'), b = SHELL.indexOf('function _conCtx');
  const writerSrc = SHELL.slice(a, b);
  const SERVER_SENT = { serverTs: true }, upd = [];
  const W2 = { window: { SokoniMerchantConstruction: { SERVER_TIME: M.SERVER_TIME }, firebaseDB: { db: 1 } }, sdk: () => Promise.resolve({ fs: { serverTimestamp: () => SERVER_SENT, doc: (db, c, id) => ({ c, id }), updateDoc: (ref, d) => { upd.push({ ref, d }); return Promise.resolve(); } } }), Promise, Object, String, Error };
  vm.createContext(W2); vm.runInContext('var window = this.window, sdk = this.sdk;\n' + writerSrc + '\nthis.w = _conWriteLead;', W2);
  const okW = await W2.w('lead1', { status: 'responded', respondedAt: M.SERVER_TIME }).then(() => true, () => false);
  const okN = await W2.w('lead1', { sellerNote: 'x' }).then(() => true, () => false);
  const extra = await W2.w('lead1', { status: 'qualified', buyerUid: 'me' }).then(() => 'wrote', (e) => e.message);
  const clock = await W2.w('lead1', { status: 'responded', respondedAt: 1790000000 }).then(() => 'wrote', (e) => e.message);
  const badId = await W2.w('../x', { status: 'lost' }).then(() => 'wrote', (e) => e.message);
  ck('L4', 'shell writer: allowed shapes reach updateDoc(contactRequests/{id}) with respondedAt = serverTimestamp()', okW && okN && upd.length === 2 && upd[0].ref.c === 'contactRequests' && upd[0].d.respondedAt === SERVER_SENT && Object.keys(upd[0].d).join(',') === 'status,respondedAt', upd);
  ck('L4', 'shell writer refuses an extra field, a client-clock respondedAt and a bad id — with no network write', extra === 'lead-update-shape' && clock === 'lead-update-shape' && badId === 'lead-id' && upd.length === 2, { extra, clock, badId });

  /* L5 chat gating */
  t = await mountView(V, 'leads', { leads: [lead('c1', 'pending')] });
  let chat = buttons(t.host).find((b) => /Chat/.test(b.__text));
  ck('L5', 'no SokoniInbox → disabled "Chat coming"', chat && chat.__text === 'Chat coming' && 'disabled' in chat, chat);
  t = await mountView(V, 'leads', { leads: [lead('c1', 'pending')], inbox: { TX_TYPES: ['order', 'rfq'], openForTransaction () {} } });
  chat = buttons(t.host).find((b) => /chat/i.test(b.__text));
  ck('L5', 'TX_TYPES without product_enquiry → still disabled', chat && chat.__text === 'Chat coming' && 'disabled' in chat, chat);
  const opened = [];
  t = await mountView(V, 'leads', { leads: [lead('c1', 'pending')], inbox: { TX_TYPES: ['order', 'product_enquiry'], openForTransaction (ty, id) { opened.push([ty, id]); } } });
  await click(t.host, (b) => b['data-act'] === 'lead-chat');
  ck('L5', 'product_enquiry in TX_TYPES → "Open chat" calls openForTransaction("product_enquiry", leadId) exactly', JSON.stringify(opened) === '[["product_enquiry","c1"]]', opened);

  /* L6/L7/L8 */
  t = await mountView(V, 'leads', { leadsErr: { code: 'permission-denied' } });
  ck('L6', 'permission-denied read → permissions copy, never "No leads yet"', /cannot read these leads/.test(text(t.host)) && /not an empty list/.test(text(t.host)) && !/No leads yet/.test(text(t.host)), text(t.host));
  t = await mountView(V, 'leads', { role: 'manager', leads: [lead('s1', 'pending')] });
  ck('L6', 'staff → "Leads go to the shop owner", no read made', /Leads go to the shop owner/.test(text(t.host)) && t.rec.readLeads === 0, t.rec.readLeads);
  t = await mountView(V, 'leads', { leads: many });
  ck('L7', 'exact hasMore: 201 read → 200 cards + "more exist"', (t.host.innerHTML.match(/data-lead="/g) || []).length === 200 && /first 200 leads — more exist/.test(text(t.host)), null);
  t = await mountView(V, 'leads', { leads: Array.from({ length: 200 }, (_, i) => lead('E' + i, 'pending')) });
  ck('L7', 'exactly 200 read → no "more exist" banner', !/more exist/.test(text(t.host)), null);
  t = await mountView(V, 'leads', { leads: [lead('f1', 'pending')], writeErr: { code: 'permission-denied' } });
  await click(t.host, (b) => b['data-to'] === 'qualified');
  ck('L8', 'refused write → error note, status unchanged (buttons still those of New)', /refused this \(permission\)/.test(text(t.host)) && buttons(t.host).filter((b) => b['data-act'] === 'lead-move').map((b) => b['data-to']).join(',') === 'responded,qualified,lost', text(t.host));

  /* ── R (REAL handlers: NEW = f3 74672f3, OLD = live/tree) ── */
  ck('R0', 'f3 rentals source ' + F3_RENTALS_REF + ' is readable (fail closed: no hand-written fixtures)', !!NEW_SRC && /rentalOwnerListings/.test(NEW_SRC), F3_RENTALS_REF);
  let srv = mkServer(); let ids = await seedRentals(srv);
  t = await mountView(V, 'rentals', { dispatch: srv.dispatch });
  const btnFor = (id) => buttons(t.host).filter((x) => x['data-id'] === id).map((x) => x['data-act']);
  ck('R1', 'rentalList (owner, shops/{uid} has NO ownerId): pending → Confirm + Cancel; confirmed → Mark returned + Cancel; active → Mark returned only; completed / cancelled → none',
    btnFor(ids.pending).join(',') === 'rental-confirm,rental-cancel-ask' && btnFor(ids.confirmed).join(',') === 'rental-complete,rental-cancel-ask' &&
    btnFor(ids.active).join(',') === 'rental-complete' && !btnFor(ids.completed).length && !btnFor(ids.cancelled).length,
    { p: btnFor(ids.pending), c: btnFor(ids.confirmed), a: btnFor(ids.active) });
  ck('R1', 'rentalBook returns paymentStatus unpaid; the card says "Unpaid — paid rentals open once SOKONI sets rental pricing" with the server price', ids.paymentStatus === 'unpaid' && text(t.host).includes(M._pure.UNPAID_COPY) && new RegExp('calculated by SOKONI: KES ' + ids.price1.toLocaleString('en-KE')).test(text(t.host)), ids.paymentStatus);
  ck('R1', 'never "M-Pesa": the stored paymentMethod is not rendered', !/m-?pesa/i.test(text(t.host)) && Object.values(srv.A.data.rentalBookings).every((b) => b.paymentMethod === 'none'), null);
  const noPay = (h) => !buttons(h).some((x) => /\bpay\b|m-?pesa|checkout|deposit now/i.test(x.__text + ' ' + (x['data-act'] || '')));
  const rentalsHost = t.host;
  t = await mountView(V, 'equipment', { dispatch: srv.dispatch });
  ck('R2', 'no pay step anywhere on Rentals / Equipment, and the unpriced copy is shown on both', noPay(rentalsHost) && noPay(t.host) && text(rentalsHost).includes(M._pure.UNPRICED_COPY) && text(t.host).includes(M._pure.UNPRICED_COPY), buttons(rentalsHost).map((x) => x.__text));
  ck('R10', 'Equipment comes from rentalOwnerListings {op, shopId}; the direct rentalProducts read is NOT used on a server that knows the op', srv.calls.some((x) => x.op === 'rentalOwnerListings' && x.shopId === 'owner1' && Object.keys(x).length === 2) && t.rec.readEquipment === 0 && /Concrete mixer 350L/.test(text(t.host)), { reads: t.rec.readEquipment });
  /* hasMore: 201 listings through the real op */
  const srvBig = mkServer();
  for (let i = 0; i < 201; i++) await srvBig.H.rentalProductCreate({ auth: { uid: 'owner1', token: {} }, data: { shopId: 'owner1', title: 'Item ' + i, pricingType: 'daily', dailyRate: 100 + i } });
  t = await mountView(V, 'equipment', { dispatch: srvBig.dispatch });
  ck('R10', 'hasMore from the real op (201 listings): 200 shown + "Showing the first 200 — more exist"', /Showing the first 200 — more exist/.test(text(t.host)) && (text(t.host).match(/Item \d+/g) || []).length === 200, null);
  t = await mountView(V, 'overview', { dispatch: srvBig.dispatch, leads: [] });
  const eqTile = [...t.host.innerHTML.matchAll(/<div class="cw-tile"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)].map((m) => [dec(m[1]), m[2]]).find((x) => x[1] === 'Equipment listed');
  ck('R10', 'Overview equipment tile from a hasMore list is "200+"', eqTile && eqTile[0] === '200+', eqTile);
  /* OLD server (live today): unknown op → fallback direct read; refused → rules copy */
  const srvOld = mkServer({ old: true, ownerId: 'owner1' });
  t = await mountView(V, 'equipment', { dispatch: srvOld.dispatch, equipErr: { code: 'permission-denied' } });
  ck('R3', 'old server ("Unknown commerce operation") → the direct read is the fallback; refused → "Rentals become visible once access rules ship", not an empty list', t.rec.readEquipment === 1 && text(t.host).includes(M._pure.RULES_COPY) && !/No equipment listed yet/.test(text(t.host)), { reads: t.rec.readEquipment });
  t = await mountView(V, 'equipment', { dispatch: () => Promise.reject(Object.assign(new Error('You do not manage this shop.'), { code: 'functions/permission-denied' })) });
  ck('R3', 'any other refusal does NOT fall back: the server reason verbatim, no direct read, no rules copy', t.rec.readEquipment === 0 && /You do not manage this shop\./.test(text(t.host)) && !text(t.host).includes(M._pure.RULES_COPY), { reads: t.rec.readEquipment });
  /* create through the REAL handler */
  t = await mountView(V, 'equipment', { dispatch: srv.dispatch });
  await click(t.host, (x) => x['data-act'] === 'equip-new');
  Object.assign(t.host.vals, { 'f:title': 'Tower scaffold', 'f:pricingType': 'daily', 'f:dailyRate': '', 'f:deposit': '2000' });
  let before = srv.calls.length;
  await click(t.host, (x) => x['data-act'] === 'equip-create');
  ck('R5', 'validation: daily pricing without a daily rate → no server call, a field message', srv.calls.length === before && /Enter the daily rate/.test(text(t.host)), srv.calls.slice(before));
  t.host.vals['f:dailyRate'] = '1800';
  await click(t.host, (x) => x['data-act'] === 'equip-create');
  const createCall = srv.calls.filter((x) => x.op === 'rentalProductCreate').pop();
  const stored = Object.values(srv.A.data.rentalProducts).find((p) => p.title === 'Tower scaffold');
  ck('R5', 'create payload = {op, shopId, title, pricingType, dailyRate, deposit}; the REAL handler stores it under the shop', createCall && Object.keys(createCall).sort().join(',') === 'dailyRate,deposit,op,pricingType,shopId,title' && createCall.dailyRate === 1800 && stored && stored.shopId === 'owner1' && stored.status === 'active', { createCall, stored: !!stored });
  ck('R5', 'after create the list reloads from rentalOwnerListings and shows the new item', /Tower scaffold/.test(text(t.host)) && srv.calls.filter((x) => x.op === 'rentalOwnerListings').length >= 2, null);
  /* confirm via the real handler */
  t = await mountView(V, 'rentals', { dispatch: srv.dispatch });
  await click(t.host, (x) => x['data-act'] === 'rental-confirm' && x['data-id'] === ids.pending);
  const conf = srv.calls.filter((x) => x.op === 'rentalConfirm').pop();
  ck('R7', 'Confirm sends {op:rentalConfirm, bookingId, shopId}; the real handler moves it to confirmed and the list reloads', conf && Object.keys(conf).sort().join(',') === 'bookingId,op,shopId' && srv.A.data.rentalBookings[ids.pending].status === 'confirmed' && btnFor(ids.pending).join(',') === 'rental-complete,rental-cancel-ask', conf);
  /* availability via the real handler */
  t = await mountView(V, 'availability', { dispatch: srv.dispatch });
  await change(t.host, 'data-pick', ids.pid);
  ck('R8', 'Availability: real rentalGetAvailability periods (pending + confirmed + active), with the 200-booking caveat', /Taken periods/.test(text(t.host)) && (text(t.host).match(/→/g) || []).length === 4 && /most recent 200 bookings/.test(text(t.host)), (text(t.host).match(/→/g) || []).length);
  /* seller cancel through the shop authority */
  t = await mountView(V, 'rentals', { dispatch: srv.dispatch });
  before = srv.calls.length;
  await click(t.host, (x) => x['data-act'] === 'rental-cancel-ask' && x['data-id'] === ids.confirmed);
  ck('R9', 'Cancel is two-step (ask, then confirm) — no call on the first tap', srv.calls.length === before && buttons(t.host).some((x) => x['data-act'] === 'rental-cancel'), null);
  await click(t.host, (x) => x['data-act'] === 'rental-cancel');
  const can = srv.calls.filter((x) => x.op === 'rentalCancel').pop();
  ck('R9', 'seller Cancel sends {op, bookingId}; the real handler cancels through the shop authority (cancelledByRole seller); the card closes', can && Object.keys(can).sort().join(',') === 'bookingId,op' && srv.A.data.rentalBookings[ids.confirmed].status === 'cancelled' && srv.A.data.rentalBookings[ids.confirmed].cancelledByRole === 'seller' && !btnFor(ids.confirmed).length, can);
  /* verbatim HttpsError reasons: the renter cancels while the page still shows the request as pending */
  t = await mountView(V, 'rentals', { dispatch: srv.dispatch });
  await srv.H.rentalCancel({ auth: { uid: 'b6', token: {} }, data: { bookingId: ids.stale } });
  await click(t.host, (x) => x['data-act'] === 'rental-confirm' && x['data-id'] === ids.stale);
  ck('R11', 'a server refusal is shown VERBATIM ("A cancelled booking cannot be confirmed.") — no "internal" substitute', /A cancelled booking cannot be confirmed\. Nothing was changed\./.test(text(t.host)) && !/\(internal\)/.test(text(t.host)), text(t.host).slice(0, 600));
  /* owner without ownerId: allowed on the fixed server; refused on the old one (reason shown, not an empty list) */
  const srvOld2 = mkServer({ old: true });
  t = await mountView(V, 'rentals', { dispatch: srvOld2.dispatch });
  ck('R4', 'old server refuses an owner without shops.ownerId → its message verbatim + "not an empty list"', /Rental requests could not be loaded/.test(text(t.host)) && /Operation failed unexpectedly\./.test(text(t.host)) && /not an empty list/.test(text(t.host)) && !/No rental requests yet/.test(text(t.host)), text(t.host));
  const srvStranger = mkServer({ caller: 'stranger' });
  t = await mountView(V, 'rentals', { dispatch: srvStranger.dispatch });
  ck('R4', 'fixed server refuses a non-manager with its reason verbatim ("You do not manage this shop.")', /You do not manage this shop\./.test(text(t.host)) && /not an empty list/.test(text(t.host)), text(t.host));

  /* ── H ── */
  t = await mountView(V, 'projects', {});
  ck('H1', 'Projects: "Projects arrive with the SOKONI Work engine", no records, no buttons', /Projects arrive with the SOKONI Work engine/.test(text(t.host)) && buttons(t.host).length === 0, text(t.host));
  t = await mountView(V, 'rfqs', {});
  let rb = buttons(t.host);
  ck('H2', 'RFQs without the rfqs route: "RFQs arrive with the B2B release" + a disabled entry', /RFQs arrive with the B2B release/.test(text(t.host)) && rb.length === 1 && 'disabled' in rb[0], rb);
  t = await mountView(V, 'rfqs', { routes: ['rfqs'], modules: ['SokoniMerchantRfq'] });
  await click(t.host, (x) => x['data-go-route'] === 'rfqs');
  ck('H2', 'RFQs with f3\'s rfqs route + module present → links to it (no second RFQ surface)', JSON.stringify(t.rec.go) === '["rfqs"]', t.rec.go);
  t = await mountView(V, 'rfqs', { routes: ['rfqs'] });
  ck('H2', 'route registered but module script missing → still the honest entry', /B2B release/.test(text(t.host)), null);
  t = await mountView(V, 'quotes', {});
  ck('H3', 'Quotes without RFQs: honest B2B-release copy, link to Leads only', /Quotes arrive with the B2B release/.test(text(t.host)) && buttons(t.host).map((x) => x['data-go-route']).join(',') === 'con-leads', buttons(t.host));
  t = await mountView(V, 'quotes', { routes: ['rfqs'], modules: ['SokoniMerchantRfq'] });
  ck('H3', 'Quotes with RFQs present → "Open RFQs & Quotes"', buttons(t.host).some((x) => x['data-go-route'] === 'rfqs'), null);
  t = await mountView(V, 'services', {});
  ck('H4', 'Services: honest dependency, no form, no fake list', /not managed here yet/.test(text(t.host)) && !/<input|<textarea/.test(t.host.innerHTML), null);
  const apps = [
    { id: 'A1', uid: 'owner1', hub: 'construction', categoryLabel: 'Contractor / Builder', status: 'approved', createdAt: 1790000000000 },
    { id: 'A2', uid: 'owner1', hub: 'construction', categoryLabel: 'Construction Equipment Rental', status: 'pending', verified: 'yes', createdAt: 1790000001000 },
    { id: 'A3', uid: 'owner1', hub: 'shopping', categoryLabel: 'Electronics', status: 'approved', verified: true }
  ];
  t = await mountView(V, 'verification', { apps });
  ck('H5', 'Verification: construction applications only, status as recorded (Approved / Submitted — awaiting review)', /Contractor \/ Builder/.test(text(t.host)) && /Approved/.test(text(t.host)) && /Submitted — awaiting review/.test(text(t.host)) && !/Electronics/.test(text(t.host)), text(t.host));
  ck('H5', '"Verified" is NOT claimed for status approved, nor for a non-boolean verified field', !/✓ Verified/.test(text(t.host)), null);
  t = await mountView(V, 'verification', { apps: [Object.assign({}, apps[0], { verified: true })] });
  ck('H5', '"✓ Verified" appears only when verified === true', /✓ Verified/.test(text(t.host)), null);
  t = await mountView(V, 'verification', { role: 'cashier', apps });
  ck('H5', 'staff → owner-account copy, nothing listed', /belong to the owner/.test(text(t.host)) && !/Contractor/.test(text(t.host)), null);
  t = await mountView(V, 'verification', { apps: [] });
  ck('H5', 'no application → honest "No Construction application" (not a status)', /No Construction application on this account/.test(text(t.host)), null);

  /* ── S ── */
  const XSS = '<img src=x onerror=alert(1)>';
  t = await mountView(V, 'leads', { leads: [lead('x1', 'pending', { productName: XSS, buyerName: XSS, message: XSS, sellerNote: XSS })] });
  ck('S2', 'escaping: product name / buyer / message / note never render as markup', !/<img/i.test(t.host.innerHTML) && /&lt;img/.test(t.host.innerHTML), null);
  t = await mountView(V, 'verification', { apps: [{ id: 'A9', hub: 'construction', categoryLabel: XSS, status: XSS, reviewReason: XSS }] });
  ck('S2', 'escaping: application label / status / review reason', !/<img/i.test(t.host.innerHTML), null);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ck('S1', 'no wa.me / whatsapp / tel: / mailto: / sms: in the module', !/wa\.me|whatsapp|tel:|mailto:|sms:/i.test(code), null);
  ck('S3', 'no Firestore write API, no browser storage in the module (the only write is ctx.writeLead)', !/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b|localStorage|sessionStorage|indexedDB/.test(code), null);
  const ops = [...new Set(srv.calls.concat(srvOld.calls, srvBig.calls).map((x) => x.op))];
  ck('S4', 'dispatch ops used ⊆ the seven seller rental ops (incl. rentalOwnerListings); never rentalBook', ops.every((o) => RENTAL_OPS.includes(o)) && !/rentalBook\b/.test(code), ops);

  /* ── G ── */
  const con = routes.ROUTES.filter((r) => /^con-/.test(r.id));
  const g = routes.MORE_GROUPS[routes.MORE_GROUPS.length - 1];
  ck('G1', 'ten con-* routes, native, tier more, all in the Construction group which is LAST; validate() clean', con.length === 10 && con.every((r) => r.kind === 'native' && r.tier === 'more') && g.key === 'construction' && g.label === 'Construction' && g.ids.length === 10 && con.every((r) => g.ids.includes(r.id)) && routes.validate().length === 0, { n: con.length, last: g.key, errs: routes.validate() });
  ck('G1', 'module view ↔ route ids agree', M.VIEWS.every((v) => routes.get('con-' + v)) && con.every((r) => M.VIEWS.includes(r.id.slice(4))), null);
  const modBlock = SHELL.slice(SHELL.indexOf('var MODULES = {'), SHELL.indexOf('var _mounted = {};'));
  const entries = [...modBlock.matchAll(/^\s*'?([a-z-]+)'?:\s*\{\s*global:\s*'([A-Za-z]+)'/gm)].map((m) => [m[1], m[2]]);
  const conE = entries.filter((e) => /^con-/.test(e[0]));
  ck('G2', 'MODULES: every con-* route → SokoniMerchantConstruction; no other route uses it; no con-* alias of an existing module', conE.length === 10 && conE.every((e) => e[1] === 'SokoniMerchantConstruction') && entries.filter((e) => e[1] === 'SokoniMerchantConstruction').length === 10 && new Set(entries.map((e) => e[0])).size === entries.length, conE);
  ck('G2', 'reused routes keep their own modules (products / staff / marketing / customers / shop unchanged)', ['products', 'staff', 'marketing', 'customers', 'shop'].every((id) => entries.some((e) => e[0] === id && e[1] !== 'SokoniMerchantConstruction')), null);
  ck('G3', 'script tag present exactly once; module parses', (SHELL.match(/<script src="sokoni-merchant-construction\.js"><\/script>/g) || []).length === 1 && (() => { try { new vm.Script(src); return true; } catch (_) { return false; } })(), null);
  ck('G3', 'shell ctx: leads by auth uid, equipment by active shop, applications by uid, rental ops via commerceDispatch', /collection: 'contactRequests', where: \[\['sellerUid', '==', S\.uid\]\]/.test(SHELL) && /collection: 'rentalProducts', where: \[\['shopId', '==', S\.activeShopId\]\]/.test(SHELL) && /collection: 'applications', where: \[\['uid', '==', S\.uid\]\]/.test(SHELL) && /_conCtx[\s\S]{0,2500}_callable\('commerceDispatch'\)/.test(SHELL), null);
  return R;
}

(async () => {
  console.log('\nConstruction workspace — merchant-v2\n');
  const R = await suite(SRC, true);
  const ids = Object.keys(R); const failed = ids.filter((k) => !R[k]);
  console.log('\n  rows: ' + (ids.length - failed.length) + '/' + ids.length + ' green' + (failed.length ? '   FAILED: ' + failed.join(',') : ''));
  console.log('\nNegative controls (each mutant must fail its named row)');
  const mut = [
    ['N1', 'illegal lead button (pending → won)', 'L1', ["pending:         ['responded', 'qualified', 'lost'],", "pending:         ['responded', 'qualified', 'lost', 'won'],"]],
    ['N2', 'extra field in the lead move payload', 'L3', ["var p = { status: to };", "var p = { status: to, updatedAt: 1 };"]],
    ['N3', 'a pay button on a rental', 'R2', ["return '<div class=\"cw-card\"><div class=\"cw-row\"><b>' + esc(b.customerName", "btns += '<button type=\"button\" class=\"cw-btn pri\" data-act=\"rental-pay\">Pay with M-PESA</button>'; return '<div class=\"cw-card\"><div class=\"cw-row\"><b>' + esc(b.customerName"]],
    ['N5', 'direct rentalProducts read used although rentalOwnerListings exists', 'R10', ["return dispatch('rentalOwnerListings', { shopId: sid }).then(", "return Promise.reject({ code: 'functions/not-found', message: 'Unknown commerce operation' }).then("]],
    ['N4', "'0' rendered for an unknown count", 'O1', ["isFinite(n)) ? String(n) + (partial ? '+' : '') : '—'; }", "isFinite(n)) ? String(n) + (partial ? '+' : '') : '0'; }"]]
  ];
  let caught = 0;
  for (const [id, label, row, [from, to]] of mut) {
    if (!SRC.includes(from)) { console.log('  FAIL  ' + id + '  mutation anchor missing — ' + label); continue; }
    const r = await suite(SRC.replace(from, to), false);
    const ok = r[row] === false;
    console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + id + '  ' + label + ' → ' + row + (ok ? ' fails (caught)' : ' stayed green (NOT caught)'));
    if (ok) caught++;
  }
  const total = ids.length + mut.length, good = ids.length - failed.length + caught;
  console.log('\n  ' + good + ' passed, ' + (total - good) + ' failed  (' + (ids.length - failed.length) + '/' + ids.length + ' rows, ' + caught + '/' + mut.length + ' controls caught)\n');
  process.exit(good === total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
