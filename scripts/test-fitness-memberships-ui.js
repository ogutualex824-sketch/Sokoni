#!/usr/bin/env node
/* FITNESS MEMBERSHIPS UI (2026-10-03, pass 2) — gym module (sokoni-fitness-memberships.js) + member page
 * (fitness-memberships.html + sokoni-fitness-member.js), DRIVEN BY THE SERVER CONTRACT FIXTURES:
 * scripts/fixtures/fitness-api-fixtures.json is a copy of the functions lane's GENERATED fixtures
 * (origin/feat/fitness-attendance-on-8bbfb34 @ d5fbd37, produced by the real handlers; first copied @ 3d315a2, re-copied when FX-SYNC caught the drift). Every success and error fixture of
 * the callables this UI calls is pushed through its render path. Member-side Firestore documents (read under rules, not
 * callable output) are synthetic 2f-shaped docs.
 *
 * The REAL files are EXECUTED in a vm with a fake DOM, a stubbed callable layer and a Firestore stub whose every write
 * method is a spy.
 *
 * SOURCE-SYNC ROWS (three states: PASS · FAIL · UNPROVEN). UNPROVEN = the reference ref is not in this clone; it is
 * reported separately and NEVER counted as a pass.
 *   FX-SYNC  the fixture copy equals `git show origin/feat/fitness-attendance-on-8bbfb34:scripts/fixtures/fitness-api-fixtures.json`
 *   OF-DEF   the client OFFER_DEFAULTS equal functions/shared/fitness-offer-defaults.js @ fe33bcc (commercial-fn lane)
 *
 * NEGATIVE CONTROLS (run automatically after the main pass; each MUST fail its named row):
 *   (a) render success before the response            → G-4
 *   (b) remove escaping                               → G-ESC
 *   (c) show 0 for an unknown remaining               → M-5
 *   (d) read settlement as an array                   → G-11
 *   (e) map SALES_DISABLED to a generic error         → M-SALES
 *   (f) report "Saved" without checking serviceKind   → OF-SAVE
 *
 *   node scripts/test-fitness-memberships-ui.js
 * Exit: 0 = no FAIL and every control detected (UNPROVEN rows are printed, not hidden) · 1 = a failure · 2 = harness error
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const GYM = read('sokoni-fitness-memberships.js'), MEMBER = read('sokoni-fitness-member.js'), PAGE = read('fitness-memberships.html');
const HUB = read('fitness-hub.html');
const FX_PATH = 'scripts/fixtures/fitness-api-fixtures.json';
const FX = JSON.parse(read(FX_PATH));
const FX_REF = 'origin/feat/fitness-attendance-on-8bbfb34';
const DEF_REF = 'fe33bcc', DEF_PATH = 'functions/shared/fitness-offer-defaults.js';
const XSS = '<img src=x onerror=alert(1)>';
const clone = (o) => JSON.parse(JSON.stringify(o));
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const gitShow = (spec) => { try { return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }); } catch (_) { return null; } };
/* A fixture error → exactly what the web SDK hands the page: code "functions/<code>", message, details. */
const fxErr = (e) => Object.assign(new Error(e.message), { code: e.clientErrorCode, details: e.details });
const err = (code, message, details) => Object.assign(new Error(message), { code: 'functions/' + code, details });

/* ── fake DOM ── */
function mkEl(tag, doc) {
  return {
    tagName: String(tag || 'div').toUpperCase(), className: '', innerHTML: '', textContent: '', hidden: false, disabled: false, type: '', id: '', value: '',
    attrs: {}, children: [], listeners: {}, style: {},
    appendChild(c) { this.children.push(c); if (c && c.id && doc) doc._ids[c.id] = c; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id' && doc) doc._ids[v] = this; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { this.listeners[t] = f; }, querySelector() { return null; }, focus() {},
  };
}
function env(opts) {
  opts = opts || {};
  const spy = { calls: [], writes: [], stk: [], qrCanvas: [], snaps: [] };
  const doc = { _ids: {}, _listeners: {}, readyState: 'complete', head: null, body: null };
  doc.createElement = (t) => mkEl(t, doc);
  doc.getElementById = (id) => doc._ids[id] || null;
  doc.addEventListener = (t, f) => { (doc._listeners[t] = doc._listeners[t] || []).push(f); };
  doc.dispatch = (t, detail) => (doc._listeners[t] || []).forEach((f) => f({ detail }));
  doc.head = mkEl('head', doc); doc.body = mkEl('body', doc);
  ['fmRoot', 'fmList', 'fmBuy', 'fmQr', 'fmPay', 'fmQrImg', 'fmQrCount', 'fmPhone', 'fmPayBtn', 'fmPayNote'].forEach((id) => { const e = mkEl('div', doc); e.id = id; doc._ids[id] = e; });
  const handlers = opts.callables || {};
  const httpsCallable = (name) => (data) => {
    spy.calls.push({ name, data: clone(data === undefined ? null : data) });
    const h = handlers[name];
    if (!h) return Promise.reject(Object.assign(new Error('not stubbed ' + name), { code: 'functions/not-found' }));
    return Promise.resolve().then(() => h(data)).then((d) => ({ data: d }));
  };
  const W = (m) => () => { spy.writes.push(m); return Promise.reject(new Error('write blocked by test')); };
  const fsData = opts.firestore || {};
  const query = (p, filters) => ({
    where: (f, op, v) => query(p, filters.concat([[f, op, v]])), orderBy: () => query(p, filters), limit: () => query(p, filters),
    get: () => { const r = fsData[p]; if (r instanceof Error) return Promise.reject(r); const rows = typeof r === 'function' ? r(filters) : (r || []);
      spy.calls.push({ name: 'fs.get:' + p, data: filters }); return Promise.resolve({ docs: rows.map((x) => ({ id: x.id, data: () => x.data })) }); },
    onSnapshot: (fn) => { spy.snaps.push({ p, filters, fn }); const rows = (fsData[p] || []); fn({ docs: rows.map((x) => ({ id: x.id, data: () => x.data })) }); return () => {}; },
    add: W('add:' + p), doc: (id) => docRef(p + '/' + id),
  });
  const docRef = (p) => ({
    get: () => { spy.calls.push({ name: 'fs.doc:' + p }); const r = typeof fsData[p] === 'function' ? fsData[p]() : fsData[p]; return Promise.resolve({ exists: r !== undefined, data: () => r }); },
    collection: (c) => query(p + '/' + c, []), set: W('set:' + p), update: W('update:' + p), delete: W('delete:' + p),
  });
  const fst = { collection: (p) => query(p, []), doc: (p) => docRef(p), batch: W('batch'), runTransaction: W('runTransaction') };
  const user = opts.user === null ? null : { uid: 'GYM_UID_1', phoneNumber: '+254712345678' };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} }, Math, Date, JSON, String, Number, Array, Object, Promise, Error, Intl, encodeURIComponent, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { onLine: opts.offline ? false : true, mediaDevices: undefined },
    location: { search: opts.search || '', hostname: 'mysokoni.co.ke' }, document: doc,
    firebase: { functions: () => ({ httpsCallable }), firestore: () => fst, auth: () => ({ currentUser: user, onAuthStateChanged: (cb) => cb(user) }) },
    SokoniQR: { generateCanvas: (t) => { spy.qrCanvas.push(t); return mkEl('canvas', doc); } },
    SokoniIntaSend: { initiateSTKPush: (phone, amount, ref, o) => { spy.stk.push({ phone, amount, ref, o }); return Promise.resolve({ checkoutId: 'C1' }); } },
    waitForFirebaseReady: () => Promise.resolve(),
    escapeHTML: (s) => (s === null || s === undefined ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;'),
  };
  if (opts.workspace !== undefined) ctx.__sokoniWorkspace = opts.workspace;
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, doc, spy };
}
const AVAILABLE = { state: 'AVAILABLE', modules: { memberships: { state: 'AVAILABLE' } } };
const H = (s) => s.replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');   /* read escaped HTML as text */

async function suite(src) {
  const rows = [];
  const ck = (id, ok, m, got) => rows.push({ id, ok: ok === 'UNPROVEN' ? 'UNPROVEN' : !!ok, m, got: ok === true || got === undefined ? '' : String(got).slice(0, 260) });
  const load = (e, member) => { vm.runInContext(src.gym, e.ctx, { timeout: 3000 }); if (member) vm.runInContext(src.member, e.ctx, { timeout: 3000 }); };

  /* ── FX-SYNC: the fixture copy is the functions lane's file ── */
  {
    const up = gitShow(FX_REF + ':' + FX_PATH);
    if (up === null) ck('FX-SYNC', 'UNPROVEN', 'fixture copy equals ' + FX_REF + ':' + FX_PATH + ' — ref not available in this clone', '');
    else {
      const mine = clone(FX); delete mine._copy;
      const theirs = JSON.parse(up);
      ck('FX-SYNC', JSON.stringify(mine) === JSON.stringify(theirs), 'fixture copy (minus its _copy header) equals ' + FX_REF + ':' + FX_PATH + ' (source commit ' + FX._copy.sourceCommit.slice(0, 7) + ')',
        'DRIFT — re-copy the fixtures and re-align the UI');
    }
  }

  /* ── G-1 / G-0 visibility ── */
  const vis = [];
  for (const [label, ws] of [['absent', undefined], ['undefined modules', { state: 'AVAILABLE' }], ['lacks memberships', { state: 'AVAILABLE', modules: { leads: { state: 'AVAILABLE' } } }],
    ['memberships LOCKED', { state: 'AVAILABLE', modules: { memberships: { state: 'LOCKED' } } }]]) {
    const e = env({ workspace: ws, callables: { fitnessScannerStatus: () => FX.fitnessScannerStatus.owner, fitnessGymMemberships: () => FX.fitnessGymMemberships.success_all } });
    load(e);
    const el = mkEl('div', e.doc); el.innerHTML = 'stale';
    const r = e.ctx.SokoniFitnessMemberships.mount(el);
    await flush();
    vis.push(r === false && el.innerHTML === '' && el.hidden === true && el.children.length === 0 && e.spy.calls.length === 0 ? null : label);
  }
  ck('G-1', vis.every((x) => x === null), 'module NEVER renders (and makes no call) when the workspace answer is absent, has no modules, lacks \'memberships\', or reports it not AVAILABLE', vis.filter(Boolean).join(','));

  /* hostile copy of the fixture rows (escaping): the fixture shapes, with a hostile name/title injected */
  const ALL = FX.fitnessGymMemberships.success_all;
  const hostile = clone(ALL); hostile.rows[0].member.displayName = 'Hostile ' + XSS; hostile.rows[0].title = 'Gold ' + XSS;
  let release; const gate = new Promise((r) => { release = r; });
  let svcStore = { SVC_OLD: { providerId: 'GYM_UID_1', name: 'Monthly ' + XSS, price: 500000, priceType: 'fixed', serviceKind: 'membership', periodCount: 1, periodUnit: 'month', active: true } };
  let saveMode = 'hooks';   /* 'hooks' = server keeps membership fields; 'drop' = today's provider-ops (fields dropped) */
  const g = env({ workspace: AVAILABLE, callables: {
    fitnessScannerStatus: () => FX.fitnessScannerStatus.owner,
    fitnessGymMemberships: (d) => (d && d.cursor === 'mem_000002' ? FX.fitnessGymMemberships.success_page2 : d && d.status === 'pending' ? FX.fitnessGymMemberships.success_tab_pending : hostile),
    fitnessGymMembership: (d) => (d.membershipId === 'mem_pen001' ? FX.fitnessGymMembership.success_no_payouts : d.membershipId === 'mem_missing' ? (() => { throw fxErr(FX.fitnessGymMembership.errors.not_found); })() : FX.fitnessGymMembership.success),
    fitnessCheckIn: async () => { await gate; return FX.fitnessCheckIn.success_first; },
    providerDispatch: (d) => {
      if (d.op === 'providerAddService') {
        if (d.name === 'Refuse me') throw err('invalid-argument', 'A membership must run for a whole number of months between 1 and 60.', { reason: 'bad_period' });
        const id = 'SVC_NEW_' + Object.keys(svcStore).length;
        svcStore[id] = saveMode === 'hooks' ? { providerId: 'GYM_UID_1', name: d.name, price: d.price, priceType: d.priceType, serviceKind: d.serviceKind, periodCount: d.periodCount, periodUnit: d.periodUnit, active: true }
          : { providerId: 'GYM_UID_1', name: d.name, price: d.price, priceType: d.priceType, active: true };   /* provider-ops today: kind/period dropped */
        return { success: true, serviceId: id, remaining: -1 };
      }
      if (d.op === 'providerUpdateService') { Object.assign(svcStore[d.serviceId], saveMode === 'hooks' ? { name: d.name, price: d.price, serviceKind: d.serviceKind, periodCount: d.periodCount, periodUnit: d.periodUnit } : { name: d.name, price: d.price }); return { success: true }; }
      if (d.op === 'providerToggleService') { svcStore[d.serviceId].active = d.active; return { success: true }; }
      if (d.op === 'providerRemoveService') { if (g.rmFail) throw err('unavailable', 'remove failed'); svcStore[d.serviceId].active = false; svcStore[d.serviceId].removedAt = 'x'; return { success: true }; }
      throw err('invalid-argument', 'unknown op');
    },
  }, firestore: {
    providerServices: (f) => Object.keys(svcStore).filter((k) => f.every(([fld, , v]) => svcStore[k][fld] === v)).map((k) => ({ id: k, data: svcStore[k] })),
  } });
  Object.defineProperty(g, 'svc', { get: () => svcStore });
  /* per-doc re-read path: providerServices/<id> */
  const fsGet = (id) => () => svcStore[id];
  load(g);
  const fbFs = g.ctx.firebase.firestore();
  const origCol = fbFs.collection;
  fbFs.collection = (p) => { const q = origCol(p); if (p === 'providerServices') { const od = q.doc; q.doc = (id) => { const r = od(id); r.get = () => { g.spy.calls.push({ name: 'fs.doc:providerServices/' + id }); const v = fsGet(id)(); return Promise.resolve({ exists: v !== undefined, data: () => v }); }; return r; }; } return q; };
  g.ctx.firebase.firestore = () => fbFs;
  const gel = mkEl('div', g.doc);
  const mounted = g.ctx.SokoniFitnessMemberships.mount(gel);
  await flush();
  const T = g.ctx.SokoniFitnessMemberships._t, ui = T.state.ui;
  ck('G-0', mounted === true && ui && g.spy.calls.some((c) => c.name === 'fitnessScannerStatus') && g.spy.calls.some((c) => c.name === 'fitnessGymMemberships' && c.data.status === 'active'),
    'AVAILABLE → mounts, asks fitnessScannerStatus and fitnessGymMemberships({status:\'active\'})', JSON.stringify(g.spy.calls.map((c) => c.name)));

  /* G-2 rows from fixture success_all */
  const rowOf = (id) => T.rowHTML(ALL.rows.find((r) => r.membershipId === id));
  const r1 = rowOf('mem_000001'), r2 = rowOf('mem_000002'), rc = rowOf('mem_cap001'), rp = rowOf('mem_pen001'), ru = rowOf('mem_unk001');
  ck('G-2', /Sessions included<\/span><b>Unlimited/.test(r1) && /Attended<\/span><b>2</.test(r1) && /2 of 3 month\(s\) released · KES 4,000/.test(r1)
    && /Sessions included<\/span><b>12/.test(rc) && /Remaining<\/span><b>10</.test(rc)
    && /Refundable<\/span><b>No — membership used/.test(r1) && /Refundable<\/span><b>Yes — not used yet/.test(r2),
    'fixture rows: null cap → "Unlimited"; capped → cap + server remaining (10); settlement only from releasedPeriods/releasedCents; refundEligible true/false → wording', r1.slice(0, 300));
  ck('G-3', /Start<\/span><b>—/.test(rp) && /Expiry<\/span><b>—/.test(rp) && /Refundable<\/span><b>—/.test(rp) && !/Settlement/.test(rp) && /Payment<\/span><b>Awaiting payment/.test(rp)
    && /Attended<\/span><b>—/.test(ru) && /Refundable<\/span><b>—/.test(ru) && !/Attended<\/span><b>0/.test(ru),
    'unknowns render "—": unpaid row start/expiry/refundable "—" and no settlement; attendedSessions null → "—", never 0', 'pending=' + rp.slice(0, 200) + ' unknown=' + ru.slice(0, 200));
  const L = ui ? ui.list.innerHTML : '';
  ck('G-ESC', !/<img src=x/.test(L) && /&lt;img src=x/.test(L), 'member names and plan titles are escaped (canonical escapeHTML)', (L.match(/.{20}img src=x.{10}/) || [''])[0]);

  /* G-4 success card only from the server (fixture success_first) */
  const p = T.submitToken('fm1.token.sig');
  await flush();
  const before = ui.result.innerHTML;
  release(); await p; await flush();
  const after = H(ui.result.innerHTML);
  ck('G-4', !/ATTENDANCE RECORDED/.test(before) && after.includes('ATTENDANCE RECORDED</strong> · Alex bM/b — Membership #000001 · Gold 3-month · Session 1 of 12 · Check-in: 10:30')
    && after.includes('Refund no longer available — membership used'),
    'no success before the response; after it (fixture success_first): "ATTENDANCE RECORDED · Alex bM/b — Membership #000001 · Gold 3-month · Session 1 of 12 · Check-in: 10:30" + firstCheckIn line', 'before=' + before + ' after=' + after);
  const un = H(T.checkInCardHTML(FX.fitnessCheckIn.success_unlimited)), staff = H(T.checkInCardHTML(FX.fitnessCheckIn.success_staff_named_session));
  ck('G-5', un.includes('Session 1 of Unlimited') && un.includes('Refund no longer available') && staff.includes('Session 2 of 12') && !staff.includes('Refund no longer available')
    && T.checkInCardHTML(Object.assign(clone(FX.fitnessCheckIn.success_staff_named_session), { attendedSessions: undefined })).includes('Session — of 12'),
    'fixtures success_unlimited → "Session 1 of Unlimited" (+ used line, firstCheckIn); success_staff_named_session → "Session 2 of 12", no used line (firstCheckIn false); missing count → "—"', un + ' || ' + staff);
  const bad = [{}, null, { ok: false, attendanceId: 'x', duplicate: false }, { ok: true, duplicate: false }, Object.assign(clone(FX.fitnessCheckIn.success_first), { duplicate: undefined })].map((x) => T.checkInCardHTML(x));
  ck('G-6', bad.every((h) => !/ATTENDANCE RECORDED/.test(h) && /not recorded/.test(h)), 'an incomplete / non-ok answer (or one missing the contract\'s duplicate flag) never renders ATTENDANCE RECORDED', bad.join(' | '));
  const dup = H(T.checkInCardHTML(FX.fitnessCheckIn.duplicate));
  ck('G-7', /Already checked in today/.test(dup) && dup.includes('Original check-in: 10:30') && !/ATTENDANCE RECORDED/.test(dup) && !/Refund no longer available/.test(dup) && /Session 1 of 12/.test(dup),
    'fixture duplicate → "Already checked in today" with the ORIGINAL time (10:30), no RECORDED, no used line', dup);
  /* G-8 EVERY check-in error fixture → its contract text */
  const ciErr = FX.fitnessCheckIn.errors, ciBad = [];
  for (const k of Object.keys(ciErr)) { const t = T.refusalText(fxErr(ciErr[k])); if (t !== ciErr[k].message) ciBad.push(k + '→' + t); }
  const dpe = FX.fitnessCheckIn.day_pass_at_end;
  if (!dpe || T.refusalText(fxErr(dpe)) !== dpe.message) ciBad.push('day_pass_at_end');
  const dpOk = H(T.checkInCardHTML(FX.fitnessCheckIn.success_day_pass));
  if (!dpOk.includes('Daily Pass · Session 1 of Unlimited') || !dpOk.includes('Refund no longer available')) ciBad.push('success_day_pass→' + dpOk);
  ck('G-8', Object.keys(ciErr).length === 18 && ciBad.length === 0 && Object.keys(T.REFUSAL).length === 15,
    'all 18 fitnessCheckIn error fixtures (15 reasons + unauthenticated + invalid_sessionRef + unavailable) + day_pass_at_end render the contract text; success_day_pass card; REFUSAL table has the 15 reasons', ciBad.join(' | ') + ' n=' + Object.keys(ciErr).length);
  ck('G-8b', T.refusalText(err('failed-precondition', 'x', { code: 'other_gym' })) === 'This membership is not for your gym.',
    'reason is read from details.reason || details.code (2f\'s shape)');
  const offA = T.refusalText(err('internal', 'internal'));
  const o = env({ workspace: AVAILABLE, offline: true, callables: { fitnessScannerStatus: () => FX.fitnessScannerStatus.owner, fitnessGymMemberships: () => ({ rows: [], nextCursor: null }), fitnessCheckIn: () => FX.fitnessCheckIn.success_first } });
  load(o); const oel = mkEl('div', o.doc); o.ctx.SokoniFitnessMemberships.mount(oel); await flush();
  await o.ctx.SokoniFitnessMemberships._t.submitToken('fm1.a.b'); await flush();
  const oRes = o.ctx.SokoniFitnessMemberships._t.state.ui.result.innerHTML;
  ck('G-9', offA === 'Attendance unavailable — retry when connected' && /Attendance unavailable — retry when connected/.test(oRes) && !o.spy.calls.some((c) => c.name === 'fitnessCheckIn')
    && T.refusalText(fxErr(ciErr.unavailable)) === 'Attendance could not be recorded. Please try again.',
    'offline → "Attendance unavailable — retry when connected" and NO fitnessCheckIn call; the server\'s unavailable (with correlationId) keeps its own text', offA + ' | ' + oRes);
  /* G-10 every scanner-status fixture */
  const SS = FX.fitnessScannerStatus, st = [];
  const WANT = { owner: [/Scan the member/, true], staff: [/Scan the member/, true], NO_PERMISSION: [/permission to record attendance/, false], NO_PERMISSION_stranger: [/permission to record attendance/, false],
    BUSINESS_LINK_MISSING: [/isn't linked to a business record yet — <a href="support.html">contact SOKONI support<\/a>/, false], NOT_APPROVED: [/isn't approved yet/, false], NOT_APPROVED_staff: [/isn't approved yet/, false],
    MODULE_NOT_AVAILABLE: [/Memberships aren't enabled for this business yet/, false], MULTIPLE_GYMS: [/staff at more than one gym/, false], unauthenticated: [/could not be checked/, false] };
  for (const k of Object.keys(SS)) {
    const want = WANT[k]; if (!want) { st.push('no expectation for fixture ' + k); continue; }
    const e = env({ workspace: AVAILABLE, callables: { fitnessScannerStatus: () => { if (SS[k].clientErrorCode) throw fxErr(SS[k]); return SS[k]; }, fitnessGymMemberships: () => ({ rows: [], nextCursor: null }) } });
    load(e); const el2 = mkEl('div', e.doc); e.ctx.SokoniFitnessMemberships.mount(el2); await flush();
    const u = e.ctx.SokoniFitnessMemberships._t.state.ui;
    const txt = H(u.note.innerHTML + u.note.textContent);
    st.push(u.scan.disabled === !want[1] && want[0].test(txt) && !/\(MODULE_NOT_AVAILABLE|\(MULTIPLE_GYMS/.test(txt) ? null : k + '→' + txt);
  }
  ck('G-10', st.every((x) => x === null) && Object.keys(SS).length === 10, 'every fitnessScannerStatus fixture: SCAN enabled only on canScan:true; each reason (incl. MODULE_NOT_AVAILABLE, MULTIPLE_GYMS) in human text, never a raw code', st.filter(Boolean).join(' || '));
  /* G-11 detail: settlement OBJECT */
  await T.act('detail', 'mem_000001'); await flush();
  const D = H(ui.drawer.innerHTML);
  await T.act('detail', 'mem_pen001'); await flush();
  const D0 = H(ui.drawer.innerHTML);
  const arr = H(T.settlementHTML(T.settlementOf({ settlement: FX.fitnessGymMembership.success.settlement.releases })));
  ck('G-11', /Attendance ledger/.test(D) && /Voided by admin/.test(D) && D.includes('Period 1 · gross KES 2,000 · commission KES 100 · net KES 1,900 · Settled')
    && D.includes('Period 2 · gross KES 2,000') && /Periods released<\/span><b>2/.test(D) && /Released \(gross\)<\/span><b>KES 4,000/.test(D) && /Net settled to gym<\/span><b>KES 3,800/.test(D)
    && /No releases yet/.test(D0) && /Net settled to gym<\/span><b>—/.test(D0) && /Periods released<\/span><b>—/.test(D0)
    && /data-sfm-settle="unknown"/.test(arr) && !/KES/.test(arr),
    'detail (fixture success): releases list + totals from settlement{releases, releasedPeriods, releasedCents, netSettledCents}; success_no_payouts → "No releases yet" and "—" totals; an ARRAY is not the contract → "—"', D.slice(0, 400));
  const errs = [];
  for (const [k, e] of Object.entries(FX.fitnessGymMemberships.errors)) { const t = T.scopeText(fxErr(e), 'off', 'fb'); if (t !== e.message) errs.push(k + '→' + t); }
  for (const [k, e] of Object.entries(FX.fitnessGymMembership.errors)) { const t = T.scopeText(fxErr(e), 'off', 'fb'); if (t !== e.message) errs.push(k + '→' + t); }
  for (const r of ['NOT_APPROVED', 'BUSINESS_LINK_MISSING', 'MODULE_NOT_AVAILABLE', 'MULTIPLE_GYMS']) if (!T.scopeText(err('failed-precondition', 'raw', { reason: r }), 'off', 'fb').includes(T.SCOPE[r].slice(0, 20))) errs.push(r);
  await T.act('detail', 'mem_missing'); await flush();
  ck('G-11b', errs.length === 0 && /Membership not found\./.test(ui.drawer.innerHTML), 'gym read error fixtures (list + detail) and every scope reason render their contract text', errs.join(' | '));
  /* G-14 pagination with the fixture cursor */
  const pg = env({ workspace: AVAILABLE, callables: { fitnessScannerStatus: () => SS.owner, fitnessGymMemberships: (d) => (d.cursor === 'mem_000002' ? FX.fitnessGymMemberships.success_page2 : FX.fitnessGymMemberships.success_page1_limit2) } });
  load(pg); const pgel = mkEl('div', pg.doc); pg.ctx.SokoniFitnessMemberships.mount(pgel); await flush();
  const PT = pg.ctx.SokoniFitnessMemberships._t;
  const moreShown = /data-sfm-act="more"/.test(PT.state.ui.more.innerHTML);
  await PT.act('more'); await flush();
  const lastReq = pg.spy.calls.filter((c) => c.name === 'fitnessGymMemberships').pop();
  ck('G-14', moreShown && lastReq.data.cursor === 'mem_000002' && PT.state.rows.length === 4 && /mem_pen001|#PEN001/.test(PT.state.ui.list.innerHTML) && /data-sfm-act="more"/.test(PT.state.ui.more.innerHTML),
    'pagination: nextCursor from the fixture is sent back verbatim; page 2 appends', JSON.stringify(lastReq && lastReq.data));

  /* ── OFFER EDITOR ── */
  const OF0 = H(ui.offers.innerHTML), ofCall = g.spy.calls.find((c) => c.name === 'fs.get:providerServices');
  ck('OF-0', /Membership offers/.test(OF0) && /KES 5,000/.test(OF0) && /1 month/.test(OF0) && /Add membership offer/.test(OF0) && ofCall
    && JSON.stringify(ofCall.data) === JSON.stringify([['providerId', '==', 'GYM_UID_1'], ['serviceKind', '==', 'membership']]),
    'offers LISTED from providerServices where providerId==uid && serviceKind==\'membership\'; "Add membership offer" present', OF0.slice(0, 200));
  ck('OF-ESC', !/<img src=x/.test(ui.offers.innerHTML) && /&lt;img src=x/.test(ui.offers.innerHTML), 'offer names are escaped in the editor list');
  /* defaults equality vs the commercial-fn lane's single source */
  {
    const srcDef = gitShow(DEF_REF + ':' + DEF_PATH);
    if (srcDef === null) ck('OF-DEF', 'UNPROVEN', 'client OFFER_DEFAULTS equal ' + DEF_PATH + ' @ ' + DEF_REF + ' — ref not available in this clone', '');
    else {
      const m = { exports: {} }; vm.runInNewContext(srcDef, { module: m, exports: m.exports, require: () => ({}), Object, Math, Array }, { timeout: 2000 });
      const want = JSON.stringify(m.exports.OFFER_DEFAULTS), got = JSON.stringify(T.OFFER_DEFAULTS);
      const ws = JSON.stringify(m.exports.withSavings().map((o) => [o.key, o.savingPct, o.effectiveMonthlyCents])), gs = JSON.stringify(T.withSavings().map((o) => [o.key, o.savingPct, o.effectiveMonthlyCents]));
      ck('OF-DEF', want === got && ws === gs, 'client OFFER_DEFAULTS and withSavings() equal ' + DEF_PATH + ' @ ' + DEF_REF + ' (values AND savings)', 'server=' + want + ' ' + ws + ' client=' + got + ' ' + gs);
    }
  }
  await T.act('offer-add'); await flush();
  const form = H(ui.offers.innerHTML);
  const sv = T.withSavings().map((o) => o.savingPct);
  ck('OF-SAV', JSON.stringify(sv) === JSON.stringify([null, null, null, 7, 13, 20]) && form.includes('3 Months · KES 14,000 · Save 7%') && form.includes('6 Months · KES 26,000 · Save 13%') && form.includes('Annual · KES 48,000 · Save 20%')
    && form.includes('Daily Pass · KES 500') && form.includes('Weekly Pass · KES 1,500') && /id="sfmOfPrice"[^>]*value="5000"/.test(form) && /value="month" selected/.test(form),
    '"Add membership offer" pre-fills from the owner defaults (Monthly 5,000) and shows savings 7/13/20%', form.slice(0, 400));
  const disp = () => g.spy.calls.filter((c) => c.name === 'providerDispatch');
  /* client validation: no call */
  const n0 = disp().length;
  for (const bad of [{ name: 'X', priceKes: 'abc', periodUnit: 'month', periodCount: 1 }, { name: 'X', priceKes: 0, periodUnit: 'month', periodCount: 1 }, { name: 'X', priceKes: '12.5', periodUnit: 'month', periodCount: 1 },
    { name: 'X', priceKes: 100, periodUnit: 'month', periodCount: 61 }, { name: '', priceKes: 100, periodUnit: 'month', periodCount: 1 }, { name: 'X', priceKes: 100, periodUnit: 'year', periodCount: 1 }]) await T.saveOffer(bad);
  ck('OF-4', disp().length === n0, 'invalid drafts (non-integer / zero price, 61 months, empty name, unknown unit) never reach the server');
  /* save, hooks present */
  saveMode = 'hooks';
  T.offerStart('quarter');
  const ok1 = await T.saveOffer({ name: '3 Months', priceKes: '14,000', periodUnit: 'month', periodCount: 3 }); await flush();
  const add1 = disp().filter((c) => c.data.op === 'providerAddService').pop();
  const want1 = { op: 'providerAddService', name: '3 Months', price: 1400000, priceType: 'fixed', serviceKind: 'membership', periodCount: 3, periodUnit: 'month' };
  ck('OF-1', ok1 === true && JSON.stringify(add1.data) === JSON.stringify(want1) && Number.isInteger(add1.data.price) && typeof add1.data.periodCount === 'number'
    && /Saved — 3 Months\./.test(H(ui.offers.innerHTML)) && g.spy.calls.some((c) => /^fs\.doc:providerServices\/SVC_NEW_/.test(c.name)),
    'save → providerDispatch({op:\'providerAddService\', name, price: integer cents, priceType:\'fixed\', serviceKind:\'membership\', periodCount: number, periodUnit}) EXACTLY; "Saved" only after the re-read shows a membership', JSON.stringify(add1 && add1.data));
  T.offerStart('daily');
  await T.saveOffer({ name: 'Day pass', priceKes: 500, periodUnit: 'day', periodCount: 5 }); await flush();
  const add2 = disp().filter((c) => c.data.op === 'providerAddService').pop();
  ck('OF-2', add2.data.periodUnit === 'day' && add2.data.periodCount === 1 && add2.data.price === 50000, 'day/week offers are sent with count 1 (months input ignored)', JSON.stringify(add2.data));
  /* save, fields DROPPED by today's provider-ops */
  saveMode = 'drop';
  T.offerStart('monthly');
  const okD = await T.saveOffer({ name: 'Monthly', priceKes: 5000, periodUnit: 'month', periodCount: 1 }); await flush();
  const dropTxt = H(ui.offers.innerHTML);
  const dropId = disp().filter((c) => c.data.op === 'providerAddService').length - 1;
  const rm = disp().filter((c) => c.data.op === 'providerRemoveService').pop();
  ck('OF-SAVE', okD === false && !/Saved/.test(dropTxt) && dropTxt.includes("Membership offers aren't enabled on the server yet.") && rm && /^SVC_NEW_/.test(rm.data.serviceId) && g.svc[rm.data.serviceId].removedAt,
    'server DROPS serviceKind (provider-ops without the 5b hooks) → never "Saved"; "Membership offers aren\'t enabled on the server yet."; the stray plain rate card is archived via providerRemoveService', dropTxt.slice(-300) + ' n=' + dropId);
  /* owner 2026-10-03: the cleanup removes ONLY the service this failed attempt created, and nothing bookable is left behind */
  const addsAll = disp().filter((c) => c.data.op === 'providerAddService');
  const createdIds = Object.keys(g.svc).filter((k) => /^SVC_NEW_/.test(k));
  const lastCreated = createdIds[createdIds.length - 1];
  const bookablePlain = Object.keys(g.svc).filter((k) => g.svc[k].active && !g.svc[k].removedAt && g.svc[k].serviceKind !== 'membership' && g.svc[k].name === 'Monthly');
  ck('OF-ORPHAN', rm && rm.data.serviceId === lastCreated && addsAll.length > 0 && bookablePlain.length === 0
    && disp().filter((c) => c.data.op === 'providerRemoveService').length === 1,
    'a rejected membership-offer creation leaves NO bookable plain service: exactly one removal, of exactly the service that attempt created', JSON.stringify({ removed: rm && rm.data.serviceId, lastCreated, bookablePlain }));
  /* removal failure is surfaced, never reported as clean */
  g.rmFail = true;
  T.offerStart('monthly');
  const okF = await T.saveOffer({ name: 'Monthly', priceKes: 5000, periodUnit: 'month', periodCount: 1 }); await flush();
  const failTxt = H(ui.offers.innerHTML);
  g.rmFail = false;
  ck('OF-RMFAIL', okF === false && !/Saved/.test(failTxt) && !failTxt.includes('Nothing was published') && failTxt.includes('could not be removed') && failTxt.includes('archive it in Services'),
    'if the cleanup removal itself fails, the gym is told a plain service exists and must be archived — never "Nothing was published"', failTxt.slice(-300));
  /* tidy the failed-removal orphan out of the fake store so later rows see a clean catalogue */
  Object.keys(g.svc).forEach((k) => { if (/^SVC_NEW_/.test(k) && g.svc[k].serviceKind !== 'membership' && !g.svc[k].removedAt) { g.svc[k].active = false; g.svc[k].removedAt = 'test'; } });
  /* server refusal verbatim */
  saveMode = 'hooks';
  T.offerStart('monthly');
  await T.saveOffer({ name: 'Refuse me', priceKes: 5000, periodUnit: 'month', periodCount: 1 }); await flush();
  ck('OF-3', H(ui.offers.innerHTML).includes('A membership must run for a whole number of months between 1 and 60.') && !/Saved —/.test(H(ui.offers.innerHTML).split('data-sfm-offer-msg')[1] || ''),
    'a server refusal (invalid-argument, reason bad_period) is shown verbatim', H(ui.offers.innerHTML).slice(-200));
  /* edit + toggle */
  await T.act('offer-cancel');
  await T.act('offer-edit', 'SVC_OLD');
  const editForm = ui.offers.innerHTML;
  await T.saveOffer({ name: 'Monthly Plus', priceKes: 5500, periodUnit: 'month', periodCount: 1 }); await flush();
  const upd = disp().filter((c) => c.data.op === 'providerUpdateService').pop();
  await T.act('offer-pause', 'SVC_OLD'); await flush();
  const tog = disp().filter((c) => c.data.op === 'providerToggleService').pop();
  ck('OF-5', /&lt;img src=x/.test(editForm) && !/<img src=x/.test(editForm) && upd && JSON.stringify(upd.data) === JSON.stringify({ op: 'providerUpdateService', serviceId: 'SVC_OLD', name: 'Monthly Plus', price: 550000, priceType: 'fixed', serviceKind: 'membership', periodCount: 1, periodUnit: 'month' })
    && tog && tog.data.active === false && tog.data.serviceId === 'SVC_OLD',
    'edit → providerUpdateService with serviceId + the same explicit typed fields (form value escaped); Pause → providerToggleService({active:false}) explicit', JSON.stringify(upd && upd.data) + ' ' + JSON.stringify(tog && tog.data));
  /* owner 2026-10-03: an EXISTING service is never removed, even when the server drops the membership fields on an edit */
  saveMode = 'drop';
  const rmBefore = disp().filter((c) => c.data.op === 'providerRemoveService').length;
  const oldBefore = JSON.stringify({ active: g.svc.SVC_OLD && g.svc.SVC_OLD.active, removedAt: g.svc.SVC_OLD && g.svc.SVC_OLD.removedAt });
  await T.act('offer-edit', 'SVC_OLD');
  /* the server's copy comes back WITHOUT the membership fields (e.g. provider-ops without the 5b hooks rewrote it) */
  const kindBackup = { serviceKind: g.svc.SVC_OLD.serviceKind, periodCount: g.svc.SVC_OLD.periodCount, periodUnit: g.svc.SVC_OLD.periodUnit };
  delete g.svc.SVC_OLD.serviceKind; delete g.svc.SVC_OLD.periodCount; delete g.svc.SVC_OLD.periodUnit;
  const okE = await T.saveOffer({ name: 'Monthly Again', priceKes: 5000, periodUnit: 'month', periodCount: 1 }); await flush();
  Object.assign(g.svc.SVC_OLD, kindBackup);
  const editDropTxt = H(ui.offers.innerHTML);
  saveMode = 'hooks';
  ck('OF-EDIT-KEEP', okE === false && disp().filter((c) => c.data.op === 'providerRemoveService').length === rmBefore
    && JSON.stringify({ active: g.svc.SVC_OLD.active, removedAt: g.svc.SVC_OLD.removedAt }) === oldBefore
    && editDropTxt.includes("Membership offers aren't enabled on the server yet.") && !/Saved —/.test(editDropTxt.split('data-sfm-offer-msg')[1] || ''),
    'editing an existing service whose membership fields the server drops → no removal call, the gym\'s existing service untouched, honest "not enabled" message', JSON.stringify({ rmBefore, oldBefore, after: g.svc.SVC_OLD }));
  await T.act('offer-cancel');
  g.doc.dispatch('sokoni:workspace', { state: 'AVAILABLE', modules: { leads: { state: 'AVAILABLE' } } });
  ck('G-13', gel.innerHTML === '' && gel.hidden === true, 'a later workspace answer without \'memberships\' unmounts the module (fail closed)', gel.innerHTML.slice(0, 80));

  /* ── member page (synthetic 2f-shaped providerMemberships docs, read under rules) ── */
  const M = {
    act0: { providerId: 'P1', buyerUid: 'GYM_UID_1', title: 'Gold ' + XSS, status: 'active', paymentStatus: 'paid_held', attendedSessions: 0, refundEligible: true, priceCents: 350000, periodCount: 1, periodUnit: 'month', startAt: '2026-10-01T06:00:00Z', endsAt: '2026-11-01T06:00:00Z' },
    act1: { title: 'Used', status: 'active', paymentStatus: 'partially_released', attendedSessions: 1, firstAttendedAt: '2026-10-02T06:00:00Z', refundEligible: false, sessionsIncluded: 12 },
    actNoCount: { title: 'Fresh', status: 'active', paymentStatus: 'paid_held' },
    pend: { title: 'Pending', status: 'pending_payment', paymentStatus: 'pending' },
    rev: { title: 'Review', status: 'pending_payment', paymentStatus: 'payment_review' },
    late: { title: 'Late', status: 'expired', paymentStatus: 'refunded_late', refundedCents: 350000 },
    exp: { title: 'Old', status: 'expired', paymentStatus: 'released', attendedSessions: 5 },
    rreq: { title: 'Asked', status: 'refund_requested', paymentStatus: 'refund_requested', attendedSessions: 0, refund: { state: 'requested' } },
    rdone: { title: 'Done', status: 'refunded', paymentStatus: 'refunded', refund: { state: 'refunded', destination: 'sokoni_wallet' } },
    rrej: { title: 'Rejected', status: 'active', paymentStatus: 'paid_held', attendedSessions: 0, refund: { state: 'rejected' } },
    day: { title: 'Day', status: 'active', paymentStatus: 'paid_held', periodUnit: 'day', periodCount: 1, endsAt: '2026-10-04T06:00:00Z' },
    week: { title: 'Week', status: 'active', paymentStatus: 'paid_held', periodUnit: 'week', periodCount: 1 },
    unk: { title: 'Odd', status: 'active', sessionsIncluded: 12, attendedSessions: 'x' },
    unk2: { title: 'Odd2', status: 'active', sessionsIncluded: 12, firstAttendedAt: '2026-10-02T06:00:00Z' },
  };
  const id = (k) => 'MEM_' + k.toUpperCase() + '_0001';
  const mdocs = Object.keys(M).map((k) => ({ id: id(k), data: M[k] }));
  const QRFX = FX.fitnessMembershipQr;
  const CM = FX.fitnessCreateMembership;
  const mk = (flag, over) => env({ search: '?provider=PROVIDER_1', callables: Object.assign({
    fitnessMembershipQr: (d) => { if (d.membershipId === id('act1')) throw fxErr(QRFX.errors.not_covered); return QRFX.success; },
    membershipRequestRefund: () => { throw err('failed-precondition', 'Refund unavailable because this membership has already been used.', { code: 'used', detail: 'Member attended 1 session(s).' }); },
    fitnessCreateMembership: () => CM.created,
    createPaymentIntent: (d) => ({ ref: 'SOK-REF-1', amount: 6000, currency: 'KES', purpose: d.purpose }),
  }, over || {}), firestore: Object.assign({ providerMemberships: mdocs, providerServices: [{ id: 'svc_gold3', data: { name: 'Gold 3-month ' + XSS, price: 600000, periodCount: 3, periodUnit: 'month', serviceKind: 'membership', active: true } },
    { id: 'svc_day01', data: { name: 'Day', price: 50000, periodCount: 1, periodUnit: 'day', serviceKind: 'membership', active: true } }] },
  flag === undefined ? {} : { 'featureFlags/fitness_membership_sales': flag }) });
  const m = mk(undefined); load(m, true); await flush();
  const MT = m.ctx.SokoniFitnessMember._t;
  const card = (k) => H(MT.cardHTML(id(k), M[k]));
  const snap = m.spy.snaps[0];
  ck('M-0', snap && snap.p === 'providerMemberships' && JSON.stringify(snap.filters) === JSON.stringify([['buyerUid', '==', 'GYM_UID_1']]),
    'member list = live listener on providerMemberships where buyerUid == auth.uid (rules-allowed read)', snap && JSON.stringify(snap.filters));
  ck('M-1', card('act0').includes('<b data-fm-refund>Eligible to request, subject to policy</b>') && /REQUEST REFUND/.test(card('act0'))
    && card('actNoCount').includes('Eligible to request, subject to policy')
    && card('act1').includes('<b data-fm-refund>Not available — membership already used</b>') && !/REQUEST REFUND/.test(card('act1'))
    && !/REQUEST REFUND|Eligible to request/.test(card('pend')) && !/REQUEST REFUND/.test(card('exp')),
    'owner refund wording EXACT: active + 0 attended → "Eligible to request, subject to policy" + REQUEST REFUND; used → "Not available — membership already used"; none for pending/expired');
  const qrBad = ['pend', 'rev', 'exp', 'rreq', 'late', 'rdone'].filter((k) => /VIEW MEMBERSHIP QR/.test(card(k)));
  ck('M-2', qrBad.length === 0 && /VIEW MEMBERSHIP QR/.test(card('act0')), 'VIEW MEMBERSHIP QR only on ACTIVE memberships', qrBad.join(','));
  await MT.act('qr', id('pend')); await flush();
  const qrCalls1 = m.spy.calls.filter((c) => c.name === 'fitnessMembershipQr').length;
  await MT.act('qr', id('act0')); await flush();
  const qrBox = m.doc.getElementById('fmQr').innerHTML;
  ck('M-3', qrCalls1 === 0 && m.spy.qrCanvas.length === 1 && m.spy.qrCanvas[0] === QRFX.success.token && !qrBox.includes(id('act0')) && qrBox.includes('#' + id('act0').slice(-6)),
    'QR is NOT requested for a non-active membership; for an active one the fixture token is rendered (opaque) and only a short ref is shown', 'calls=' + qrCalls1 + ' canvas=' + m.spy.qrCanvas.length);
  MT.closeQR();
  await MT.act('qr', id('act1')); await flush();
  const qrErr = H(m.doc.getElementById('fmQrImg').innerHTML);
  MT.closeQR();
  ck('M-3b', qrErr.includes(QRFX.errors.not_covered.message) && /Try again/.test(qrErr), 'a fitnessMembershipQr error fixture (not_covered) is shown as the server\'s message', qrErr);
  ck('M-4', /Waiting for payment confirmation/.test(card('pend')) && /Payment under review/.test(card('rev')) && !/>Active</.test(card('pend') + card('rev'))
    && card('late').includes('Payment refunded — please start again') && card('late').includes('Refunded to your SOKONI wallet (payment arrived too late)') && !/Attendance history/.test(card('late'))
    && /fm-pill[^"]*">Expired</.test(card('exp')) && card('rdone').includes('Refunded to your SOKONI wallet') && card('rreq').includes('Refund requested — under review') && card('rrej').includes('Refund declined'),
    'money states: pending → "Waiting for payment confirmation"; payment_review → "Payment under review"; refunded_late → "Payment refunded — please start again"; expired; refund.state requested/refunded/rejected wording', card('late').slice(0, 300));
  const u1 = card('unk'), u2 = card('unk2'), u3 = card('actNoCount');
  ck('M-5', /Used<\/span><b>—/.test(u1) && /Remaining<\/span><b>—/.test(u1) && /Remaining<\/span><b>—/.test(u2) && /Sessions included<\/span><b>Unlimited/.test(u3) && /Remaining<\/span><b>Unlimited/.test(u3) && /Remaining<\/span><b>11/.test(card('act1')),
    'unknown attended → "—" and remaining "—" (never 0); no cap → "Unlimited"; known cap − used shown', u1.match(/Remaining<\/span><b>[^<]*/) + ' / ' + u2.match(/Remaining<\/span><b>[^<]*/));
  ck('M-DAY', card('day').includes('Day pass') && card('week').includes('Week pass') && /Expiry<\/span><b>4 Oct 2026/.test(card('day')) && /Expiry<\/span><b>—/.test(card('week')) && /Expiry<\/span><b>1 Nov 2026/.test(card('act0')),
    'day/week passes read "Day pass"/"Week pass"; expiry from the server\'s endsAt, else "—"', card('day').slice(0, 300));
  ck('M-ESC', !/<img src=x/.test(MT.cardHTML(id('act0'), M.act0)) && /&lt;img src=x/.test(MT.cardHTML(id('act0'), M.act0)), 'plan titles are escaped on the member card');
  await MT.act('refund', id('act0')); await MT.act('refund-go', id('act0')); await flush();
  const after2 = m.doc.getElementById('fmList').innerHTML;
  ck('M-6', after2.includes('Refund unavailable because this membership has already been used. Member attended 1 session(s).') && m.spy.calls.some((c) => c.name === 'membershipRequestRefund' && c.data.membershipId === id('act0')),
    'REQUEST REFUND → membershipRequestRefund; the server\'s message + detail shown verbatim on refusal', after2.match(/fm-msg.{0,160}/));
  const off = H(m.doc.getElementById('fmBuy').innerHTML);
  await MT.act('buy', 'svc_gold3'); await flush();
  ck('M-7', /Memberships aren't on sale yet/.test(off) && / disabled aria-disabled="true">BUY MEMBERSHIP/.test(off)
    && !m.spy.calls.some((c) => c.name === 'fitnessCreateMembership' || c.name === 'createPaymentIntent') && /KES 6,000/.test(off) && /Day pass/.test(off) && !/<img src=x/.test(m.doc.getElementById('fmBuy').innerHTML),
    'flag OFF (featureFlags doc missing) → BUY disabled, "Memberships aren\'t on sale yet", act(\'buy\') calls nothing; day offer reads "Day pass"', off.slice(0, 200));
  const s2 = mk({ enabled: 'true' }); load(s2, true); await flush();
  ck('M-8', /disabled aria-disabled="true">BUY MEMBERSHIP/.test(s2.doc.getElementById('fmBuy').innerHTML), 'flag must be literally enabled === true (string "true" stays OFF)');
  /* buy with fixture `created`: review from THAT response, intent only on Pay */
  const on = mk({ enabled: true }); load(on, true); await flush();
  const OT = on.ctx.SokoniFitnessMember._t;
  await OT.act('buy', 'svc_gold3'); await flush();
  const rev = H(on.doc.getElementById('fmPay').innerHTML);
  const intentBefore = on.spy.calls.filter((c) => c.name === 'createPaymentIntent').length;
  on.doc.getElementById('fmPhone').value = '0712345678';
  await OT.act('pay'); await flush();
  const seq = on.spy.calls.filter((c) => /fitnessCreateMembership|createPaymentIntent/.test(c.name));
  const note = on.doc.getElementById('fmPayNote').textContent;
  ck('M-9', rev.includes('Gold 3-month') && !rev.includes('<img') && rev.includes('KES 6,000') && rev.includes('3 months') && rev.includes('Pay by 10:35') && rev.includes('#NEW001') && !/Continuing your pending/.test(rev)
    && intentBefore === 0 && seq.length === 2 && seq[0].data.serviceId === 'svc_gold3' && seq[1].name === 'createPaymentIntent' && seq[1].data.purpose === 'fitness_membership' && seq[1].data.membershipId === CM.created.membershipId
    && on.spy.stk.length === 1 && on.spy.stk[0].amount === 6000 && on.spy.stk[0].ref === 'SOK-REF-1' && on.spy.stk[0].phone === '254712345678'
    && !/success|confirmed|active/i.test(note) && /updates automatically once SOKONI confirms/.test(note),
    'flag ON: BUY → fitnessCreateMembership → review rendered from the RESPONSE (title/price/period/payBy, fixture created) → Pay → createPaymentIntent → STK(server amount, server ref); no success text', rev.slice(0, 300) + ' seq=' + JSON.stringify(seq.map((c) => c.name)));
  const ru2 = mk({ enabled: true }, { fitnessCreateMembership: () => CM.reused }); load(ru2, true); await flush();
  await ru2.ctx.SokoniFitnessMember._t.act('buy', 'svc_gold3'); await flush();
  const mm = mk({ enabled: true }, { createPaymentIntent: () => ({ ref: 'SOK-REF-2', amount: 1, currency: 'KES' }) }); load(mm, true); await flush();
  await mm.ctx.SokoniFitnessMember._t.act('buy', 'svc_gold3'); await flush();
  mm.doc.getElementById('fmPhone').value = '0712345678';
  await mm.ctx.SokoniFitnessMember._t.act('pay'); await flush();
  ck('M-9b', /Continuing your pending membership/.test(ru2.doc.getElementById('fmPay').innerHTML) && mm.spy.stk.length === 0 && /price changed/.test(mm.doc.getElementById('fmPayNote').textContent),
    'fixture reused → "Continuing your pending membership"; an intent amount ≠ the reviewed priceCents pushes NO STK');
  /* M-SALES: every create error fixture + 2f's purpose refusal {code:'SALES_DISABLED'} */
  const salesBad = [];
  for (const [k, e] of Object.entries(CM.errors)) { const t = OT.createRefusalText(fxErr(e), 'fb'); if (t !== e.message) salesBad.push(k + '→' + t); }
  const pr = mk({ enabled: true }, { createPaymentIntent: () => { throw err('failed-precondition', 'Membership sales are not open yet.', { code: 'SALES_DISABLED' }); } }); load(pr, true); await flush();
  await pr.ctx.SokoniFitnessMember._t.act('buy', 'svc_gold3'); await flush();
  pr.doc.getElementById('fmPhone').value = '0712345678';
  await pr.ctx.SokoniFitnessMember._t.act('pay'); await flush();
  const prNote = pr.doc.getElementById('fmPayNote').textContent;
  /* day / week pass purchases (fixtures created_day_pass / created_week_pass): the review reads the RESPONSE's unit */
  const dayRev = [];
  for (const k of ['created_day_pass', 'created_week_pass']) {
    const e2 = mk({ enabled: true }, { fitnessCreateMembership: () => CM[k] }); load(e2, true); await flush();
    await e2.ctx.SokoniFitnessMember._t.act('buy', 'svc_day01'); await flush();
    dayRev.push(H(e2.doc.getElementById('fmPay').innerHTML));
  }
  ck('M-DAY2', dayRev[0].includes('Daily Pass') && dayRev[0].includes('Day pass') && dayRev[0].includes('KES 500') && dayRev[1].includes('Weekly Pass') && dayRev[1].includes('Week pass') && dayRev[1].includes('KES 1,500'),
    'fixtures created_day_pass / created_week_pass → review shows "Day pass" / "Week pass" and the server price', dayRev.map((x) => x.slice(0, 160)).join(' || '));
  ck('M-SALES', salesBad.length === 0 && Object.keys(CM.errors).length >= 11 && CM.errors.bad_unit && CM.errors.bad_period && prNote === "Memberships aren't on sale yet." && pr.spy.stk.length === 0,
    'every fitnessCreateMembership error fixture (incl. bad_unit, bad_period) renders their contract text; 2f\'s purpose refusal details {code:\'SALES_DISABLED\'} → "Memberships aren\'t on sale yet." (not the raw/generic text), no STK', salesBad.join(' | ') + ' pay=' + prNote);

  /* ── static + executed write audit ── */
  const allWrites = [g, o, m, s2, on, ru2, mm, pr, pg].reduce((a, e) => a.concat(e.spy.writes), []);
  const SRC = src.gym + '\n' + src.member + '\n' + (PAGE.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []).join('\n');
  const WRITE_RE = /\.(set|add|update|delete)\(|setDoc|addDoc|updateDoc|deleteDoc|writeBatch|\.batch\(|runTransaction/;
  ck('X-1', allWrites.length === 0 && !WRITE_RE.test(SRC), 'no browser Firestore writes (offers go ONLY through providerDispatch) — executed spy + source', allWrites.join(',') || (SRC.match(WRITE_RE) || [''])[0]);
  const BANNED = /SokoniPay|platformBook|wa\.me|api\.whatsapp|whatsapp:\/\//i;
  ck('X-2', !BANNED.test(src.gym + src.member + PAGE), 'no SokoniPay / platformBook / wa.me / WhatsApp in the new files', ((src.gym + src.member + PAGE).match(BANNED) || [''])[0]);
  ck('X-3', /<script src="shared-header\.js" defer><\/script>/.test(PAGE) && /<script src="sw-register\.js" defer><\/script>/.test(PAGE), 'fitness-memberships.html self-updates (shared-header.js + sw-register.js)');
  ck('X-4', !/localStorage|sessionStorage/.test((src.gym + src.member).replace(/\/\*[\s\S]*?\*\//g, '')), 'no localStorage / sessionStorage in the modules (no browser source of truth)');
  ck('X-5', /<script src="security\.js"><\/script>/.test(PAGE) && /root\.escapeHTML/.test(src.gym) && /var esc = C\.esc/.test(src.member), 'escaping is the canonical escapeHTML (security.js loaded first; both modules route through it)');
  ck('X-6', /name="viewport" content="width=device-width/.test(PAGE) && /overflow-x:hidden/.test(PAGE) && /minmax\(0,1fr\)/.test(PAGE) && /overflow-x:hidden/.test(src.gym) && /min-height:44px/.test(PAGE),
    'mobile-first source checks: viewport meta, no horizontal overflow, shrinkable grids, 44px touch targets (browser proof is QUEUED)');
  ck('X-7', /href="fitness-memberships\.html"/.test(HUB) && !/onclick="[^"]*fitness-memberships/.test(HUB), 'fitness-hub.html links "My memberships" with a plain link');
  return rows;
}

(async () => {
  const real = { gym: GYM, member: MEMBER };
  console.log('\nFitness Memberships UI   (this tree; fixtures ' + FX._copy.sourceRef + ' @ ' + FX._copy.sourceCommit.slice(0, 7) + ')\n');
  const rows = await suite(real);
  rows.forEach((r) => console.log('  ' + (r.ok === 'UNPROVEN' ? 'UNPROVEN' : r.ok ? 'PASS' : 'FAIL') + ' ' + r.id + ' ' + r.m + (r.ok === true ? '' : r.got ? '   [got ' + r.got + ']' : '')));
  const failed = rows.filter((r) => r.ok === false).length, unproven = rows.filter((r) => r.ok === 'UNPROVEN').length;
  const passed = rows.filter((r) => r.ok === true).length;

  const rp = (s, a, b) => (s.includes(a) ? s.replace(a, () => b) : s);
  const CONTROLS = [
    ['a', 'render success before the response', 'G-4', (s) => ({ gym: rp(s.gym, "ui.result.innerHTML = '<div class=\"sfm-card\" role=\"status\">Checking with SOKONI…</div>';",
      "ui.result.innerHTML = checkInCardHTML({ ok: true, duplicate: false, attendanceId: 'pre', attendedSessions: 1, sessionsIncluded: null });"), member: s.member })],
    ['b', 'remove escaping', 'G-ESC', (s) => ({ gym: rp(s.gym, "function esc(v) { return (typeof root.escapeHTML === 'function' ? root.escapeHTML : FALLBACK_ESC)(v); }",
      "function esc(v) { return v == null ? '' : String(v); }"), member: s.member })],
    ['c', 'show 0 for an unknown remaining', 'M-5', (s) => ({ gym: rp(s.gym, "if (c.cap && isCount(obj.attendedSessions)) return String(Math.max(0, c.cap - obj.attendedSessions));\n    return DASH;",
      "if (c.cap && isCount(obj.attendedSessions)) return String(Math.max(0, c.cap - obj.attendedSessions));\n    return '0';"), member: s.member })],
    ['d', 'read settlement as an array', 'G-11', (s) => ({ gym: rp(s.gym, "if (!st || typeof st !== 'object' || Array.isArray(st) || !Array.isArray(st.releases)) return null;\n    return st;",
      "if (!Array.isArray(st)) return null;\n    return { releases: st.map(function (p) { return { periodIndex: p.periodIndex, grossCents: p.amountCents, netCents: p.amountCents, status: p.status, settledAt: p.createdAt }; }), releasedPeriods: null, releasedCents: null, netSettledCents: null };"), member: s.member })],
    ['e', 'map SALES_DISABLED to a generic error', 'M-SALES', (s) => ({ gym: s.gym, member: rp(s.member, '    SALES_DISABLED: SALES_DISABLED_TEXT,\n', '') })],
    ['f', 'report "Saved" without checking serviceKind', 'OF-SAVE', (s) => ({ gym: rp(s.gym, 'function savedAsMembership(doc, sent) {\n    return !!(', 'function savedAsMembership(doc, sent) {\n    return !!doc || !!('), member: s.member })],
    ['g', 'cleanup also removes an EXISTING service (new-only guard dropped)', 'OF-EDIT-KEEP', (s) => ({ gym: rp(s.gym, '        if (!ed.serviceId) {\n          return call(\'providerDispatch\', { op: \'providerRemoveService\'', '        if (true) {\n          return call(\'providerDispatch\', { op: \'providerRemoveService\''), member: s.member })],
    ['h', 'cleanup failure reported as clean', 'OF-RMFAIL', (s) => ({ gym: rp(s.gym, "could not be removed — archive it in Services before customers can book it.'); return false;", "'); offerMsg(NOT_ENABLED + ' Nothing was published.'); return false;"), member: s.member })],
  ];
  let ctlBad = 0;
  console.log('\nNegative controls (each must FAIL its named row):');
  for (const [k, what, row, mut] of CONTROLS) {
    const s = mut(real);
    if (s.gym === real.gym && s.member === real.member) { console.log('  BROKEN control ' + k + ': mutation did not apply'); ctlBad++; continue; }
    const r = (await suite(s)).find((x) => x.id === row);
    const ok = r && r.ok === false;
    console.log('  ' + (ok ? 'OK  ' : 'BAD ') + ' control ' + k + ' (' + what + ') → ' + row + ' ' + (r ? (r.ok === false ? 'FAILS as required' : 'did NOT fail (control not detected!)') : 'missing'));
    if (!ok) ctlBad++;
  }
  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed, ' + unproven + ' UNPROVEN (not counted as passes); controls ' + (CONTROLS.length - ctlBad) + '/' + CONTROLS.length + ' detected');
  process.exit(failed || ctlBad ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
