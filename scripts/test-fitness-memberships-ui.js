#!/usr/bin/env node
/* FITNESS MEMBERSHIPS UI (2026-10-03) — gym module (sokoni-fitness-memberships.js) + member page
 * (fitness-memberships.html + sokoni-fitness-member.js). The REAL files are EXECUTED in a vm with a fake DOM, a
 * stubbed callable layer and a Firestore stub whose every write method is a spy. Owner rules under test:
 * browser only requests/displays · no success before the server · unknown → "—" · "Unlimited" when uncapped ·
 * exact refund wording · QR only for active · buy OFF unless the server flag is on · canonical escaping ·
 * no SokoniPay / platformBook / wa.me · new pages self-update · module renders only when the server workspace
 * reports 'memberships' AVAILABLE.
 *
 * NEGATIVE CONTROLS (run automatically after the main pass): (a) render success before the response,
 * (b) remove escaping, (c) show 0 for an unknown remaining — each MUST fail its named row.
 *
 *   node scripts/test-fitness-memberships-ui.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const GYM = read('sokoni-fitness-memberships.js'), MEMBER = read('sokoni-fitness-member.js'), PAGE = read('fitness-memberships.html');
const HUB = read('fitness-hub.html');
const XSS = '<img src=x onerror=alert(1)>';
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ── fake DOM ── */
function mkEl(tag, doc) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(), className: '', innerHTML: '', textContent: '', hidden: false, disabled: false, type: '', id: '', value: '',
    attrs: {}, children: [], listeners: {}, style: {},
    appendChild(c) { this.children.push(c); if (c && c.id && doc) doc._ids[c.id] = c; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id' && doc) doc._ids[v] = this; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { this.listeners[t] = f; }, querySelector() { return null; }, focus() {},
  };
  return e;
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
    spy.calls.push({ name, data });
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
    get: () => { const r = fsData[p]; return Promise.resolve({ exists: r !== undefined, data: () => r }); },
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
    SokoniQR: { generateCanvas: (t, s) => { spy.qrCanvas.push(t); return mkEl('canvas', doc); } },
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
const err = (code, message, details) => Object.assign(new Error(message), { code: 'functions/' + code, details });

async function suite(src) {
  const rows = [];
  const ck = (id, ok, m, got) => rows.push({ id, ok: !!ok, m, got: ok || got === undefined ? '' : String(got).slice(0, 220) });
  const load = (e, member) => { vm.runInContext(src.gym, e.ctx, { timeout: 3000 }); if (member) vm.runInContext(src.member, e.ctx, { timeout: 3000 }); };

  /* ── G-0 / G-1 visibility: only when the server workspace says 'memberships' AVAILABLE ── */
  const vis = [];
  for (const [label, ws] of [['absent', undefined], ['undefined modules', { state: 'AVAILABLE' }], ['lacks memberships', { state: 'AVAILABLE', modules: { leads: { state: 'AVAILABLE' } } }],
    ['memberships LOCKED', { state: 'AVAILABLE', modules: { memberships: { state: 'LOCKED' } } }]]) {
    const e = env({ workspace: ws, callables: { fitnessScannerStatus: () => ({ canScan: true }), fitnessGymMemberships: () => ({ rows: [] }) } });
    load(e);
    const el = mkEl('div', e.doc); el.innerHTML = 'stale';
    const r = e.ctx.SokoniFitnessMemberships.mount(el);
    await flush();
    vis.push(r === false && el.innerHTML === '' && el.hidden === true && el.children.length === 0 && e.spy.calls.length === 0 ? null : label);
  }
  ck('G-1', vis.every((x) => x === null), 'module NEVER renders (and makes no call) when the workspace answer is absent, has no modules, lacks \'memberships\', or reports it not AVAILABLE', vis.filter(Boolean).join(','));

  /* G-2 live mount + rows */
  const rowsData = [
    { membershipId: 'MEMBERSHIPAAA111', member: { displayName: 'Hostile ' + XSS }, title: 'Gold ' + XSS, startAt: '2026-10-01T06:00:00Z', endsAt: '2026-11-01T06:00:00Z',
      sessionsIncluded: null, attendedSessions: 3, remaining: null, lastAttendedAt: '2026-10-03T07:42:00Z', status: 'active', paymentStatus: 'partially_released',
      refundState: null, refundEligible: false, releasedPeriods: 1, releasedCents: 350000 },
    { membershipId: 'MEMBERSHIPBBB222', member: { displayName: null }, title: 'Ten pack', sessionsIncluded: 10, attendedSessions: 4, remaining: 6, status: 'active', paymentStatus: 'paid_held' },
    { membershipId: 'MEMBERSHIPCCC333', member: {}, title: 'Mystery', sessionsIncluded: 8, status: 'active' },
  ];
  let release; const gate = new Promise((r) => { release = r; });
  const g = env({ workspace: AVAILABLE, callables: {
    fitnessScannerStatus: () => ({ canScan: true, role: 'owner' }),
    fitnessGymMemberships: () => ({ rows: rowsData, nextCursor: null }),
    fitnessGymMembership: () => ({ membership: rowsData[0], attendance: [{ checkedInAt: '2026-10-03T07:42:00Z', status: 'checked_in', method: 'qr', actorRole: 'owner ' + XSS }], settlement: [{ amountCents: 350000, status: 'paid', createdAt: '2026-10-03T08:00:00Z' }] }),
    fitnessCheckIn: async () => { await gate; return { ok: true, duplicate: false, attendanceId: 'd_20261003', status: 'checked_in', firstCheckIn: false, attendedSessions: 4, sessionsIncluded: 12, membershipId: 'MEMBERSHIPABC123', member: { displayName: 'Alex' }, checkedInAt: '2026-10-03T07:42:00Z' }; },
  }, firestore: { providerServices: (f) => [{ id: 'S1', data: { name: 'Monthly ' + XSS, price: 350000, periodCount: 1, periodUnit: 'month', serviceKind: 'membership', active: true, _f: JSON.stringify(f) } }] } });
  load(g);
  const gel = mkEl('div', g.doc);
  const mounted = g.ctx.SokoniFitnessMemberships.mount(gel);
  await flush();
  const T = g.ctx.SokoniFitnessMemberships._t, ui = T.state.ui;
  ck('G-0', mounted === true && ui && g.spy.calls.some((c) => c.name === 'fitnessScannerStatus') && g.spy.calls.some((c) => c.name === 'fitnessGymMemberships' && c.data.status === 'active'),
    'AVAILABLE → mounts, asks fitnessScannerStatus (scan enable only) and fitnessGymMemberships({status:\'active\'})', JSON.stringify(g.spy.calls.map((c) => c.name)));
  const L = ui ? ui.list.innerHTML : '';
  ck('G-2', /Unlimited/.test(L) && />10</.test(L) && />6</.test(L) && /KES 3,500/.test(L) && /1 month\(s\) released/.test(L),
    'rows from the server: "Unlimited" for a null cap, the cap and server remaining for a capped plan, settlement only from releasedPeriods/releasedCents', L.slice(0, 300));
  const r3 = ui ? T.rowHTML(rowsData[2]) : '';
  ck('G-3', /Attended<\/span><b>—/.test(r3) && /Remaining<\/span><b>—/.test(r3) && /Expiry<\/span><b>—/.test(r3) && /Payment<\/span><b>—/.test(r3) && !/<b>0</.test(r3),
    'unknowns render "—" (missing attended / remaining / expiry / payment) — never 0', r3);
  ck('G-ESC', !/<img src=x/.test(L) && /&lt;img src=x/.test(L), 'member names and plan titles are escaped (canonical escapeHTML)', (L.match(/.{20}img src=x.{10}/) || [''])[0]);

  /* G-4 success card only from the server */
  const p = T.submitToken('fm1.token.sig');
  await flush();
  const before = ui.result.innerHTML;
  release(); await p; await flush();
  const after = ui.result.innerHTML;
  ck('G-4', !/ATTENDANCE RECORDED/.test(before) && after.includes('ATTENDANCE RECORDED</strong> · Alex — Membership #ABC123 · Session 4 of 12 · Check-in: 10:42'),
    'no success before the response; after it: "ATTENDANCE RECORDED · Alex — Membership #ABC123 · Session 4 of 12 · Check-in: 10:42" (EAT)', 'before=' + before + ' after=' + after);
  ck('G-5', T.checkInCardHTML({ ok: true, attendanceId: 'x', attendedSessions: 2, sessionsIncluded: null }).includes('Session 2 of Unlimited')
    && T.checkInCardHTML({ ok: true, attendanceId: 'x', attendedSessions: 2 }).includes('Session 2 of —')
    && T.checkInCardHTML({ ok: true, attendanceId: 'x', sessionsIncluded: 5 }).includes('Session — of 5'),
    '"Session N of M": M = "Unlimited" only when the server says null; a missing field is "—", never a number');
  const bad = [{}, null, { ok: false, attendanceId: 'x' }, { ok: true }].map((x) => T.checkInCardHTML(x));
  ck('G-6', bad.every((h) => !/ATTENDANCE RECORDED/.test(h) && /not recorded/.test(h)), 'an incomplete / non-ok server answer never renders ATTENDANCE RECORDED', bad.join(' | '));
  const dup = T.checkInCardHTML({ ok: true, duplicate: true, attendanceId: 'd_1', status: 'checked_in', attendedSessions: 3, sessionsIncluded: null, member: { displayName: 'Alex' } });
  ck('G-7', /Already checked in today/.test(dup) && !/ATTENDANCE RECORDED/.test(dup) && /Session 3 of Unlimited/.test(dup), 'duplicate → "Already checked in today" with the existing record', dup);
  const MAP = { token_invalid: 'not valid', token_expired: 'has expired. Ask', expired: 'membership has expired', cancelled: 'cancelled', suspended: 'suspended', wrong_member: 'does not belong',
    not_covered: 'does not cover', other_gym: 'different gym', entitlement_exhausted: 'All sessions', no_permission: "don't have permission", not_found: 'not found' };
  const mapBad = Object.keys(MAP).filter((r) => !T.refusalText(err('failed-precondition', 'server text', { reason: r })).includes(MAP[r]));
  const permNoReason = T.refusalText(err('permission-denied', 'x'));
  ck('G-8', mapBad.length === 0 && /don't have permission/.test(permNoReason) && /Sign in again/.test(T.refusalText(err('unauthenticated', 'x'))),
    'refusal reasons map to human text (expired, cancelled, suspended, wrong member, not covered, other gym, exhausted, no permission, token expired/invalid)', mapBad.join(','));
  const offA = T.refusalText(err('internal', 'internal'));
  const offB = T.refusalText(err('unavailable', 'Attendance could not be recorded. Please try again.', { correlationId: 'abc' }));
  const o = env({ workspace: AVAILABLE, offline: true, callables: { fitnessScannerStatus: () => ({ canScan: true }), fitnessGymMemberships: () => ({ rows: [] }), fitnessCheckIn: () => ({ ok: true, attendanceId: 'x' }) } });
  load(o); const oel = mkEl('div', o.doc); o.ctx.SokoniFitnessMemberships.mount(oel); await flush();
  await o.ctx.SokoniFitnessMemberships._t.submitToken('fm1.a.b'); await flush();
  const oRes = o.ctx.SokoniFitnessMemberships._t.state.ui.result.innerHTML;
  ck('G-9', offA === 'Attendance unavailable — retry when connected' && /could not be recorded/.test(offB) && /Attendance unavailable — retry when connected/.test(oRes) && !o.spy.calls.some((c) => c.name === 'fitnessCheckIn'),
    'offline (navigator.onLine false) → "Attendance unavailable — retry when connected" and NO fitnessCheckIn call; network error → same; a server failure keeps its own text', offA + ' | ' + offB + ' | ' + oRes);
  /* scanner status */
  const st = [];
  for (const [s, want, enabled] of [[{ canScan: false, reason: 'BUSINESS_LINK_MISSING' }, /isn't linked to a business record yet — <a href="support.html">contact SOKONI support<\/a>/, false],
    [{ canScan: false, reason: 'NOT_APPROVED' }, /isn't approved yet/, false], [{ canScan: false, reason: 'NO_PERMISSION' }, /permission/, false], [{ canScan: true, role: 'owner' }, /Scan the member/, true]]) {
    const e = env({ workspace: AVAILABLE, callables: { fitnessScannerStatus: () => s, fitnessGymMemberships: () => ({ rows: [] }) } });
    load(e); const el2 = mkEl('div', e.doc); e.ctx.SokoniFitnessMemberships.mount(el2); await flush();
    const u = e.ctx.SokoniFitnessMemberships._t.state.ui;
    st.push(u.scan.disabled === !enabled && want.test(u.note.innerHTML + u.note.textContent) ? null : JSON.stringify(s) + '→' + u.note.innerHTML + u.note.textContent);
  }
  ck('G-10', st.every((x) => x === null), 'SCAN MEMBER QR disabled with the REAL reason from fitnessScannerStatus (BUSINESS_LINK_MISSING → setup via SOKONI support; NOT_APPROVED; NO_PERMISSION); enabled only on canScan:true', st.filter(Boolean).join(' || '));
  await T.act('detail', 'MEMBERSHIPAAA111'); await flush();
  const D = ui.drawer.innerHTML;
  ck('G-11', /Attendance ledger/.test(D) && /Checked in/.test(D) && /KES 3,500/.test(D) && !/<img src=x/.test(D), 'detail drawer from fitnessGymMembership: attendance ledger + settlement rows, escaped', D.slice(0, 200));
  const OF = ui.offers.innerHTML, ofCall = g.spy.calls.find((c) => c.name === 'fs.get:providerServices');
  ck('G-12', /Membership offers/.test(OF) && /KES 3,500/.test(OF) && /1 month/.test(OF) && !/<img src=x/.test(OF) && /Services editor/.test(OF) && ofCall
    && JSON.stringify(ofCall.data) === JSON.stringify([['providerId', '==', 'GYM_UID_1'], ['serviceKind', '==', 'membership']]),
    'offers LISTED from providerServices where providerId==uid && serviceKind==\'membership\' (price = integer cents ÷ 100), editing deferred to the services editor', OF.slice(0, 200));
  g.doc.dispatch('sokoni:workspace', { state: 'AVAILABLE', modules: { leads: { state: 'AVAILABLE' } } });
  ck('G-13', gel.innerHTML === '' && gel.hidden === true, 'a later workspace answer without \'memberships\' unmounts the module (fail closed)', gel.innerHTML.slice(0, 80));

  /* ── member page ── */
  const M = {
    act0: { providerId: 'P1', buyerUid: 'GYM_UID_1', title: 'Gold ' + XSS, status: 'active', paymentStatus: 'paid_held', attendedSessions: 0, refundEligible: true, priceCents: 350000, periodCount: 1, periodUnit: 'month', startAt: '2026-10-01T06:00:00Z' },
    act1: { title: 'Used', status: 'active', paymentStatus: 'partially_released', attendedSessions: 1, firstAttendedAt: '2026-10-02T06:00:00Z', refundEligible: false, sessionsIncluded: 12 },
    actNoCount: { title: 'Fresh', status: 'active', paymentStatus: 'paid_held' },
    pend: { title: 'Pending', status: 'pending_payment', paymentStatus: 'pending' },
    rev: { title: 'Review', status: 'pending_payment', paymentStatus: 'payment_review' },
    exp: { title: 'Old', status: 'expired', paymentStatus: 'released', attendedSessions: 5 },
    rreq: { title: 'Asked', status: 'refund_requested', paymentStatus: 'refund_requested', attendedSessions: 0 },
    unk: { title: 'Odd', status: 'active', sessionsIncluded: 12, attendedSessions: 'x' },
    unk2: { title: 'Odd2', status: 'active', sessionsIncluded: 12, firstAttendedAt: '2026-10-02T06:00:00Z' },
  };
  const ids = Object.keys(M).map((k) => 'MEM_' + k.toUpperCase() + '_0001');
  const mdocs = Object.keys(M).map((k, i) => ({ id: ids[i], data: M[k] }));
  const id = (k) => 'MEM_' + k.toUpperCase() + '_0001';
  const mk = (flag) => env({ search: '?provider=PROVIDER_1', callables: {
    fitnessMembershipQr: () => ({ token: 'fm1.QRTOKEN.sig', expiresAt: new Date(Date.now() + 300000).toISOString(), ttlSeconds: 300 }),
    membershipRequestRefund: () => { throw err('failed-precondition', 'Refund unavailable because this membership has already been used.', { code: 'used', detail: 'Member attended 1 session(s).' }); },
    fitnessCreateMembership: () => ({ membershipId: 'NEWMEMBERSHIP01', reused: false }),
    createPaymentIntent: (d) => ({ ref: 'SOK-REF-1', amount: 3500, currency: 'KES', purpose: d.purpose }),
  }, firestore: Object.assign({ providerMemberships: mdocs, providerServices: [{ id: 'SVC_1', data: { name: 'Monthly ' + XSS, price: 350000, periodCount: 1, periodUnit: 'month', serviceKind: 'membership', active: true } }] },
    flag === undefined ? {} : { 'featureFlags/fitness_membership_sales': flag }) });
  const m = mk(undefined); load(m, true); await flush();
  const MT = m.ctx.SokoniFitnessMember._t;
  const card = (k) => MT.cardHTML(id(k), M[k]);
  const snap = m.spy.snaps[0];
  ck('M-0', snap && snap.p === 'providerMemberships' && JSON.stringify(snap.filters) === JSON.stringify([['buyerUid', '==', 'GYM_UID_1']]),
    'member list = live listener on providerMemberships where buyerUid == auth.uid (rules-allowed read)', snap && JSON.stringify(snap.filters));
  ck('M-1', card('act0').includes('<b data-fm-refund>Eligible to request, subject to policy</b>') && /REQUEST REFUND/.test(card('act0'))
    && card('actNoCount').includes('Eligible to request, subject to policy')
    && card('act1').includes('<b data-fm-refund>Not available — membership already used</b>') && !/REQUEST REFUND/.test(card('act1'))
    && !/REQUEST REFUND|Eligible to request/.test(card('pend')) && !/REQUEST REFUND/.test(card('exp')),
    'owner refund wording EXACT: active + 0 attended → "Eligible to request, subject to policy" + REQUEST REFUND; used → "Not available — membership already used"; none for pending/expired');
  const qrBad = ['pend', 'rev', 'exp', 'rreq'].filter((k) => /VIEW MEMBERSHIP QR/.test(card(k)));
  ck('M-2', qrBad.length === 0 && /VIEW MEMBERSHIP QR/.test(card('act0')), 'VIEW MEMBERSHIP QR only on ACTIVE memberships', qrBad.join(','));
  await MT.act('qr', id('pend')); await flush();
  const qrCalls1 = m.spy.calls.filter((c) => c.name === 'fitnessMembershipQr').length;
  await MT.act('qr', id('act0')); await flush();
  const qrBox = m.doc.getElementById('fmQr').innerHTML;
  ck('M-3', qrCalls1 === 0 && m.spy.qrCanvas.length === 1 && m.spy.qrCanvas[0] === 'fm1.QRTOKEN.sig' && !qrBox.includes(id('act0')) && qrBox.includes('#' + id('act0').slice(-6)),
    'QR is NOT requested for a non-active membership; for an active one the server token is rendered and only a short ref is shown', 'calls=' + qrCalls1 + ' canvas=' + m.spy.qrCanvas.join(','));
  MT.closeQR();
  ck('M-4', /Waiting for payment confirmation/.test(card('pend')) && /Payment under review/.test(card('rev')) && !/>Active</.test(card('pend') + card('rev')),
    'pending → "Waiting for payment confirmation"; payment_review → "Payment under review"; neither shows Active');
  const u1 = card('unk'), u2 = card('unk2'), u3 = card('actNoCount');
  ck('M-5', /Used<\/span><b>—/.test(u1) && /Remaining<\/span><b>—/.test(u1) && /Remaining<\/span><b>—/.test(u2) && /Sessions included<\/span><b>Unlimited/.test(u3) && /Remaining<\/span><b>Unlimited/.test(u3) && /Remaining<\/span><b>11/.test(card('act1')),
    'unknown attended → "—" and remaining "—" (never 0); no cap → "Unlimited"; known cap − used shown', u1.match(/Remaining<\/span><b>[^<]*/) + ' / ' + u2.match(/Remaining<\/span><b>[^<]*/));
  ck('M-ESC', !/<img src=x/.test(card('act0')) && /&lt;img src=x/.test(card('act0')), 'plan titles are escaped on the member card', (card('act0').match(/.{20}img src=x.{10}/) || [''])[0]);
  await MT.act('refund', id('act0')); await MT.act('refund-go', id('act0')); await flush();
  const after2 = m.doc.getElementById('fmList').innerHTML;
  ck('M-6', after2.includes('Refund unavailable because this membership has already been used. Member attended 1 session(s).') && m.spy.calls.some((c) => c.name === 'membershipRequestRefund' && c.data.membershipId === id('act0')),
    'REQUEST REFUND → membershipRequestRefund; the server\'s message + detail shown verbatim on refusal', after2.match(/fm-msg[^<]*<|fm-msg.{0,160}/));
  /* buy: flag OFF (doc missing) */
  const off = m.doc.getElementById('fmBuy').innerHTML;
  m.doc._ids.fmPay = m.doc.getElementById('fmPay');
  await MT.act('buy', 'SVC_1'); await flush();
  ck('M-7', /Memberships aren(&#x27;|')t on sale yet/.test(off) && /BUY MEMBERSHIP<\/button>/.test(off) && / disabled aria-disabled="true">BUY MEMBERSHIP/.test(off)
    && !m.spy.calls.some((c) => c.name === 'fitnessCreateMembership' || c.name === 'createPaymentIntent') && /KES 3,500/.test(off) && !/<img src=x/.test(off),
    'flag OFF (featureFlags doc missing) → BUY disabled, "Memberships aren\'t on sale yet", and act(\'buy\') calls nothing', off.slice(0, 200));
  const s2 = mk({ enabled: 'true' }); load(s2, true); await flush();
  ck('M-8', /disabled aria-disabled="true">BUY MEMBERSHIP/.test(s2.doc.getElementById('fmBuy').innerHTML), 'flag must be literally enabled === true (string "true" stays OFF)');
  const on = mk({ enabled: true }); load(on, true); await flush();
  const OT = on.ctx.SokoniFitnessMember._t;
  const onHtml = on.doc.getElementById('fmBuy').innerHTML;
  await OT.act('buy', 'SVC_1'); await flush();
  const seq = on.spy.calls.filter((c) => /fitnessCreateMembership|createPaymentIntent/.test(c.name));
  const payHtml = on.doc.getElementById('fmPay').innerHTML;
  on.doc.getElementById('fmPhone').value = '0712345678';
  await OT.act('pay'); await flush();
  const note = on.doc.getElementById('fmPayNote').textContent;
  ck('M-9', !/disabled aria-disabled/.test(onHtml) && seq.length === 2 && seq[0].name === 'fitnessCreateMembership' && seq[0].data.serviceId === 'SVC_1'
    && seq[1].name === 'createPaymentIntent' && seq[1].data.purpose === 'fitness_membership' && seq[1].data.membershipId === 'NEWMEMBERSHIP01'
    && on.spy.stk.length === 1 && on.spy.stk[0].amount === 3500 && on.spy.stk[0].ref === 'SOK-REF-1' && on.spy.stk[0].phone === '254712345678'
    && !/success|confirmed|active/i.test(payHtml + note) && /updates automatically once SOKONI confirms/.test(note),
    'flag ON: BUY → fitnessCreateMembership({serviceId}) → createPaymentIntent({purpose:\'fitness_membership\', membershipId}) → SokoniIntaSend.initiateSTKPush(server amount, server ref); no success text before the server flips the doc',
    JSON.stringify(seq.map((c) => c.name)) + ' stk=' + JSON.stringify(on.spy.stk) + ' note=' + note);

  /* ── static + executed write audit ── */
  const allWrites = [g, o, m, s2, on].reduce((a, e) => a.concat(e.spy.writes), []);
  const SRC = src.gym + '\n' + src.member + '\n' + (PAGE.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []).join('\n');
  const WRITE_RE = /\.(set|add|update|delete)\(|setDoc|addDoc|updateDoc|deleteDoc|writeBatch|\.batch\(|runTransaction/;
  ck('X-1', allWrites.length === 0 && !WRITE_RE.test(SRC), 'no browser writes to providerMemberships / attendance / providerServices / anything (executed spy + source)', allWrites.join(',') || (SRC.match(WRITE_RE) || [''])[0]);
  const BANNED = /SokoniPay|platformBook|wa\.me|api\.whatsapp|whatsapp:\/\//i;
  ck('X-2', !BANNED.test(src.gym + src.member + PAGE), 'no SokoniPay / platformBook / wa.me / WhatsApp in the new files', ((src.gym + src.member + PAGE).match(BANNED) || [''])[0]);
  ck('X-3', /<script src="shared-header\.js" defer><\/script>/.test(PAGE) && /<script src="sw-register\.js" defer><\/script>/.test(PAGE), 'fitness-memberships.html self-updates (shared-header.js + sw-register.js)');
  ck('X-4', !/localStorage|sessionStorage/.test((src.gym + src.member).replace(/\/\*[\s\S]*?\*\//g, '')), 'no localStorage / sessionStorage in the new modules (no browser source of truth)');
  ck('X-5', /<script src="security\.js"><\/script>/.test(PAGE) && /root\.escapeHTML/.test(src.gym) && /var esc = C\.esc/.test(src.member), 'escaping is the canonical escapeHTML (security.js loaded first; both modules route through it)');
  ck('X-6', /name="viewport" content="width=device-width/.test(PAGE) && /overflow-x:hidden/.test(PAGE) && /minmax\(0,1fr\)/.test(PAGE) && /overflow-x:hidden/.test(src.gym) && /min-height:44px/.test(PAGE),
    'mobile-first source checks: viewport meta, no horizontal overflow, shrinkable grids, 44px touch targets (browser proof is QUEUED)');
  ck('X-7', /href="fitness-memberships\.html"/.test(HUB) && !/onclick="[^"]*fitness-memberships/.test(HUB), 'fitness-hub.html links "My memberships" with a plain link');
  return rows;
}

(async () => {
  const real = { gym: GYM, member: MEMBER };
  console.log('\nFitness Memberships UI   (this tree)\n');
  const rows = await suite(real);
  rows.forEach((r) => console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.id + ' ' + r.m + (r.ok ? '' : '   [got ' + r.got + ']')));
  const failed = rows.filter((r) => !r.ok).length;

  const CONTROLS = [
    ['a', 'render success before the response', 'G-4', (s) => ({ gym: s.gym.replace("ui.result.innerHTML = '<div class=\"sfm-card\" role=\"status\">Checking with SOKONI…</div>';",
      "ui.result.innerHTML = checkInCardHTML({ ok: true, attendanceId: 'pre', attendedSessions: 1, sessionsIncluded: null });"), member: s.member })],
    ['b', 'remove escaping', 'G-ESC', (s) => ({ gym: s.gym.replace("function esc(v) { return (typeof root.escapeHTML === 'function' ? root.escapeHTML : FALLBACK_ESC)(v); }",
      "function esc(v) { return v == null ? '' : String(v); }"), member: s.member })],
    ['c', 'show 0 for an unknown remaining', 'M-5', (s) => ({ gym: s.gym.replace("if (c.cap && isCount(obj.attendedSessions)) return String(Math.max(0, c.cap - obj.attendedSessions));\n    return DASH;",
      "if (c.cap && isCount(obj.attendedSessions)) return String(Math.max(0, c.cap - obj.attendedSessions));\n    return '0';"), member: s.member })],
  ];
  let ctlBad = 0;
  console.log('\nNegative controls (each must FAIL its named row):');
  for (const [k, what, row, mut] of CONTROLS) {
    const s = mut(real);
    if (s.gym === real.gym && s.member === real.member) { console.log('  BROKEN control ' + k + ': mutation did not apply'); ctlBad++; continue; }
    const r = (await suite(s)).find((x) => x.id === row);
    const ok = r && !r.ok;
    console.log('  ' + (ok ? 'OK  ' : 'BAD ') + ' control ' + k + ' (' + what + ') → ' + row + ' ' + (r ? (r.ok ? 'PASSED (control not detected!)' : 'FAILS as required') : 'missing'));
    if (!ok) ctlBad++;
  }
  console.log('\nRESULT: ' + (rows.length - failed) + ' passed, ' + failed + ' failed; controls ' + (CONTROLS.length - ctlBad) + '/' + CONTROLS.length + ' detected');
  process.exit(failed || ctlBad ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
