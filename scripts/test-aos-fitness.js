#!/usr/bin/env node
/* ADMINOS FITNESS MEMBERSHIPS VIEW (2026-10-03) — sokoni-aos-fitness.js executed in a vm with a fake DOM, a fake
 * Firestore (records every query's where/orderBy/limit/startAfter; every write method is a spy) and a stubbed
 * callable layer. Callable answers come from scripts/fixtures/fitness-api-fixtures.json (e3, generated from the real
 * handlers) where e3 owns the callable (fitnessCorrectAttendance); 2f's callables (membershipDecideRefund,
 * membershipRequestException) and the Firestore documents are synthetic 2f-shaped data, using 2f's exact refusal
 * messages/codes from functions/membership-settlement.js.
 *
 * NEGATIVE CONTROLS (each MUST fail its named row):
 *   (1) the sales toggle omits `enabled`              → A-FLAG
 *   (2) "why locked" computed from client-loaded rows → A-WHY
 *   (3) unescaped member/plan text                    → A-ESC
 *
 *   node scripts/test-aos-fitness.js        Exit: 0 all pass + controls detected · 1 failure · 2 harness error
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-aos-fitness.js'), 'utf8');
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/fitness-api-fixtures.json'), 'utf8'));
const XSS = '<img src=x onerror=alert(1)>';
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const fxErr = (e) => Object.assign(new Error(e.message), { code: e.clientErrorCode, details: e.details });
const err = (code, message, details) => Object.assign(new Error(message), { code: 'functions/' + code, details });
const H = (s) => String(s).replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

/* synthetic 2f-shaped membership docs */
function seed() {
  const ms = {};
  ms.mem_req0001 = { providerId: 'gym_A', buyerUid: 'member_1', title: 'Gold ' + XSS, priceCents: 600000, periodCount: 3, periodUnit: 'month', status: 'refund_requested', paymentStatus: 'refund_requested',
    paymentRef: 'ISREF-1', heldCents: 600000, releasedPeriods: 0, releasedCents: 0, nextReleaseAt: null, attendedSessions: 3, voidedSessions: 1, refundEligible: false, createdAt: '2026-03-20T07:00:00.000Z',
    refund: { state: 'requested', exception: true, used: true, attendedSessionsAtRequest: 3, requestedBy: 'admin_1', reason: 'Gym closed ' + XSS } };
  ms.mem_atr0001 = { providerId: 'gym_A', buyerUid: 'member_2', title: 'Silver', status: 'refunded', paymentStatus: 'refunded', createdAt: '2026-03-19T07:00:00.000Z',
    refund: { state: 'refunded', attendedSessionsAtRequest: 2, requestedBy: 'admin_1', decidedBy: 'admin_2', decisionReason: 'Approved ' + XSS, executedAt: '2026-03-19T09:00:00.000Z', destination: 'sokoni_wallet', walletCreditShillings: 6000, ledgerId: 'LEDGER_1' } };
  ms.mem_unused01 = { providerId: 'gym_B', buyerUid: 'member_3', title: 'Bronze', status: 'active', paymentStatus: 'paid_held', priceCents: 300000, heldCents: 300000, attendedSessions: 0, refundEligible: true, createdAt: '2026-03-18T07:00:00.000Z' };
  ms.mem_bare0001 = { providerId: 'gym_B', buyerUid: 'member_4', status: 'pending_payment', paymentStatus: 'pending', createdAt: '2026-03-17T07:00:00.000Z' };
  for (let i = 0; i < 30; i++) ms['mem_bulk' + String(i).padStart(4, '0')] = { providerId: 'gym_C', buyerUid: 'm', title: 'Bulk', status: 'active', paymentStatus: 'paid_held', createdAt: '2026-01-' + String(1 + (i % 28)).padStart(2, '0') + 'T00:00:00.000Z' };
  const att = { mem_req0001: FX.fitnessGymMembership.success.attendance.map((a) => ({ id: a.attendanceId, checkedInAt: a.checkedInAt, method: a.method, actorRole: a.actorRole, status: a.status, completedAt: a.completedAt,
    voidedAt: a.status === 'voided_by_admin' ? '2026-02-02T08:00:00.000Z' : undefined, voidReason: a.status === 'voided_by_admin' ? 'Scanned the wrong member ' + XSS : undefined })) };
  const events = { mem_req0001: [{ id: 'e1', type: 'payment_held', at: '2026-03-01T07:00:00.000Z', heldCents: 600000 }, { id: 'e2', type: 'refund_exception_requested', at: '2026-03-20T07:00:00.000Z', by: 'admin_1', amountCents: 600000, reason: 'Gym closed ' + XSS }] };
  const payouts = [
    { id: 'mem_req0001_m2', membershipId: 'mem_req0001', sourceType: 'membership', periodIndex: 2, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-03-15T03:00:00.000Z' },
    { id: 'mem_req0001_m1', membershipId: 'mem_req0001', sourceType: 'membership', periodIndex: 1, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-02-15T03:00:00.000Z' },
    { id: 'other', membershipId: 'mem_req0001', sourceType: 'booking', periodIndex: 9, gross: 1, commission: 0, net: 1 },
  ];
  /* adminAudit rows in the exact shape fitness-attendance.js _audit() writes */
  const audit = [
    { hub: 'fitness', action: 'fitness_checkin', outcome: 'ok', membershipId: 'mem_000001', providerId: 'gym_A', attendanceId: 'd_2026-03-20', performedBy: 'staff_1', actorRole: 'staff', firstCheckIn: true, correlationId: FX.fitnessCheckIn.success_first.correlationId, createdAt: '2026-03-20T07:30:00.000Z' },
    { hub: 'fitness', action: 'fitness_checkin_duplicate', outcome: 'ok', membershipId: 'mem_000001', providerId: 'gym_A', attendanceId: 'd_2026-03-20', performedBy: 'staff_1', actorRole: 'staff', firstCheckIn: false, createdAt: '2026-03-20T07:31:00.000Z' },
    { hub: 'fitness', action: 'fitness_checkin', outcome: 'refused', reason: 'other_gym ' + XSS, membershipId: 'mem_000009', providerId: null, performedBy: 'owner_9', createdAt: '2026-03-20T07:32:00.000Z' },
    { hub: 'fitness', action: 'fitness_attendance_corrected', outcome: 'ok', membershipId: 'mem_000001', attendanceId: 'd_2026-03-20', performedBy: 'admin_1', actorRole: 'admin', duplicate: false, createdAt: '2026-03-20T08:00:00.000Z' },
    { hub: 'events', action: 'other_hub', outcome: 'ok', createdAt: '2026-03-20T09:00:00.000Z' },
  ];
  return { ms, att, events, payouts, audit, flag: undefined, flagErr: false };
}

function env(opts) {
  opts = opts || {};
  const data = seed();
  if (opts.mutate) opts.mutate(data);
  const spy = { queries: [], calls: [], writes: [], confirms: [] };
  const W = (m) => () => { spy.writes.push(m); return Promise.reject(new Error('write blocked')); };
  const snapOf = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => { const c = Object.assign({}, r.d); return c; } })) });
  const query = (coll, rowsFn, ops) => ({
    where: (f, op, v) => query(coll, rowsFn, ops.concat([['where', f, op, v]])),
    orderBy: (f, dir) => query(coll, rowsFn, ops.concat([['orderBy', f, dir]])),
    limit: (n) => query(coll, rowsFn, ops.concat([['limit', n]])),
    startAfter: (d) => query(coll, rowsFn, ops.concat([['startAfter', d && d.id]])),
    get: () => {
      spy.queries.push({ coll, ops });
      if (opts.failColl === coll) return Promise.reject(err('permission-denied', 'Missing or insufficient permissions.'));
      let rows = rowsFn();
      for (const o of ops) if (o[0] === 'where') rows = rows.filter((r) => get(r.d, o[1]) === o[3]);
      const ob = ops.find((o) => o[0] === 'orderBy');
      if (ob) rows = rows.slice().sort((a, b) => (String(get(a.d, ob[1])) < String(get(b.d, ob[1])) ? 1 : -1) * (ob[2] === 'desc' ? 1 : -1));
      const sa = ops.find((o) => o[0] === 'startAfter'); if (sa) { const i = rows.findIndex((r) => r.id === sa[1]); rows = rows.slice(i + 1); }
      const lim = ops.find((o) => o[0] === 'limit'); if (lim) rows = rows.slice(0, lim[1]);
      return Promise.resolve(snapOf(rows));
    },
    add: W('add:' + coll), doc: (id) => docRef(coll, id),
  });
  const docRef = (coll, id) => ({
    get: () => {
      spy.queries.push({ coll: coll + '/' + id, ops: [] });
      if (coll === 'featureFlags') { if (data.flagErr) return Promise.reject(new Error('unreadable')); return Promise.resolve({ exists: data.flag !== undefined, data: () => data.flag }); }
      const d = data.ms[id]; return Promise.resolve({ exists: !!d, data: () => d });
    },
    collection: (c) => query(coll + '/' + id + '/' + c, () => ((c === 'attendance' ? data.att[id] : c === 'events' ? data.events[id] : []) || []).map((r) => ({ id: r.id, d: r })), []),
    set: W('set:' + coll + '/' + id), update: W('update:' + coll + '/' + id), delete: W('delete:' + coll + '/' + id),
  });
  const fst = {
    collection: (c) => query(c, () => (c === 'providerMemberships' ? Object.keys(data.ms).map((k) => ({ id: k, d: data.ms[k] }))
      : c === 'providerPayouts' ? data.payouts.map((p) => ({ id: p.id, d: p })) : c === 'adminAudit' ? data.audit.map((a, i) => ({ id: 'a' + i, d: a })) : []), []),
    batch: W('batch'), runTransaction: W('runTransaction'),
  };
  const handlers = opts.callables || {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, String, Number, Array, Object, Promise, Error, Intl,
    navigator: { onLine: true },
    document: { getElementById: (id) => (opts.fields && id in opts.fields ? { value: opts.fields[id] } : null) },
    confirm: (m) => { spy.confirms.push(m); return opts.confirm !== false; },
    firebase: {
      firestore: () => fst,
      functions: () => ({ httpsCallable: (name) => (d) => { spy.calls.push({ name, data: clone(d) }); const h = handlers[name]; if (!h) return Promise.reject(err('not-found', 'not stubbed ' + name));
        return Promise.resolve().then(() => h(d, data)).then((x) => ({ data: x })); } }),
    },
    escapeHTML: (s) => (s === null || s === undefined ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;'),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, spy, data };
}
const mkEl = () => ({ innerHTML: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });

const SOD = { message: 'The refund must be decided by a different authorized person than the one who requested it.', code: 'separation_of_duties' };

async function suite(src) {
  const rows = [];
  const ck = (id, ok, m, got) => rows.push({ id, ok: !!ok, m, got: ok || got === undefined ? '' : String(got).slice(0, 300) });
  const boot = async (opts) => { const e = env(opts); vm.runInContext(src, e.ctx, { timeout: 3000 }); const el = mkEl(); e.ctx.SokoniAOSFitness.mount(el); await flush(); return Object.assign(e, { el, T: e.ctx.SokoniAOSFitness._t }); };
  const lastQ = (e, coll) => e.spy.queries.filter((q) => q.coll === coll).pop();
  const limits = (e) => e.spy.queries.flatMap((q) => q.ops.filter((o) => o[0] === 'limit').map((o) => o[1]));

  /* A-0 list */
  const a = await boot({});
  const q0 = lastQ(a, 'providerMemberships');
  const L0 = H(a.el.innerHTML);
  ck('A-0', q0 && JSON.stringify(q0.ops) === JSON.stringify([['orderBy', 'createdAt', 'desc'], ['limit', 25]]) && /mem_req0001|#EQ0001/i.test(L0) && /KES 6,000/.test(L0) && /refund_requested/.test(L0),
    'mount → providerMemberships orderBy createdAt desc · limit 25 (no filter); rows rendered', JSON.stringify(q0 && q0.ops));
  await a.T.setFilter('status', 'active'); await flush();
  const q1 = lastQ(a, 'providerMemberships').ops;
  await a.T.setFilter('paymentStatus', 'paid_held'); await flush();
  const q2 = lastQ(a, 'providerMemberships').ops;
  await a.T.setFilter('refund.state', 'requested'); await flush();
  const q3 = lastQ(a, 'providerMemberships').ops;
  const L3 = H(a.el.innerHTML);
  await a.T.setFilter('status', 'nonsense'); await flush();
  const q4 = lastQ(a, 'providerMemberships').ops;
  ck('A-1', JSON.stringify(q1[0]) === JSON.stringify(['where', 'status', '==', 'active']) && q2.filter((o) => o[0] === 'where').length === 1 && JSON.stringify(q2[0]) === JSON.stringify(['where', 'paymentStatus', '==', 'paid_held'])
    && JSON.stringify(q3[0]) === JSON.stringify(['where', 'refund.state', '==', 'requested']) && /Gold/.test(L3) && !/Bronze/.test(L3) && !q4.some((o) => o[0] === 'where'),
    'filters: status / paymentStatus / refund.state — ONE where at a time (bounded index set); an unknown value clears the filter', JSON.stringify([q1, q2, q3, q4]));
  await a.T.setFilter('status', ''); await flush();
  const firstPage = a.T.state.rows.length;
  await a.T.act('more'); await flush();
  const qm = lastQ(a, 'providerMemberships').ops;
  ck('A-2', firstPage === 25 && qm.some((o) => o[0] === 'startAfter' && o[1]) && a.T.state.rows.length === 34 && limits(a).every((n) => n <= 50),
    'cursor paging: a full page sets the cursor; Load more → startAfter(last doc); every query limit ≤ 50', JSON.stringify(qm) + ' rows=' + a.T.state.rows.length);

  /* A-3 detail */
  await a.T.openDetail('mem_req0001'); await flush();
  const D = H(a.el.innerHTML);
  const pq = lastQ(a, 'providerPayouts');
  const attQ = lastQ(a, 'providerMemberships/mem_req0001/attendance'), evQ = lastQ(a, 'providerMemberships/mem_req0001/events');
  ck('A-3', /Payment ref<\/span><b>ISREF-1/.test(D) && /Held<\/span><b>KES 6,000/.test(D) && /Status<\/span><b>refund_requested/.test(D) && /Attended sessions<\/span><b>3/.test(D) && /Voided sessions<\/span><b>1/.test(D)
    && /State<\/span><b>requested/.test(D) && /Exception<\/span><b>Yes/.test(D) && /Requested by<\/span><b>#DMIN_1/.test(D)
    && D.indexOf('<td>1</td>') < D.indexOf('<td>2</td>') && !/<td>9<\/td>/.test(D) && /KES 1,900/.test(D)
    && /refund_exception_requested/.test(D) && /payment_held/.test(D) && /voided_by_admin/.test(D) && /Scanned the wrong member/.test(D) && /staff/.test(D)
    && JSON.stringify(pq.ops) === JSON.stringify([['where', 'membershipId', '==', 'mem_req0001'], ['where', 'sourceType', '==', 'membership'], ['limit', 50]])
    && JSON.stringify(attQ.ops) === JSON.stringify([['orderBy', 'checkedInAt', 'desc'], ['limit', 50]]) && JSON.stringify(evQ.ops) === JSON.stringify([['orderBy', 'at', 'desc'], ['limit', 50]])
    && /Approve refund/.test(D) && /Reject refund/.test(D) && !/Request exception/.test(D),
    'detail: payment/lifecycle/refund fields, attendance ledger (method, actor role, status, void correction), events timeline, providerPayouts sourceType membership sorted by period; Approve/Reject only on an open request', D.slice(0, 400));
  await a.T.openDetail('mem_atr0001'); await flush();
  const D2 = H(a.el.innerHTML);
  ck('A-3b', /Decided by<\/span><b>#DMIN_2/.test(D2) && /Destination<\/span><b>sokoni_wallet/.test(D2) && /Wallet credit<\/span><b>KES 6,000/.test(D2) && /Ledger<\/span><b>LEDGER_1/.test(D2) && /Executed<\/span><b>19 Mar 2026/.test(D2)
    && !/Approve refund|Request exception/.test(D2), 'executed refund: decidedBy, destination, walletCreditShillings (whole KES), ledgerId, executedAt; no actions on a refunded membership', D2.slice(0, 300));

  /* A-WHY: from the server doc only */
  const whyReq = a.T.whyLocked(a.data.ms.mem_req0001), whyAtr = a.T.whyLocked(a.data.ms.mem_atr0001), whyNone = a.T.whyLocked(a.data.ms.mem_unused01);
  await a.T.openDetail('mem_req0001'); await flush();
  const DW = H(a.el.innerHTML);
  ck('A-WHY', whyReq === 'Member attended 3 session(s).' && whyAtr === 'Member attended 2 session(s).' && whyNone === '' && DW.includes('Why the refund is locked:</b> Member attended 3 session(s).')
    && a.T.whyLocked({ refundEligible: false }).includes('—'),
    '"WHY refund is locked" from the membership DOC (attendedSessions 3, though only 2 ledger rows are loaded; else refund.attendedSessionsAtRequest); unused → none; used with no count → "—"', [whyReq, whyAtr, whyNone].join(' | '));

  /* A-UNK */
  await a.T.openDetail('mem_bare0001'); await flush();
  const DB = H(a.el.innerHTML);
  const f0 = await boot({ mutate: (d) => { d.flagErr = true; } });
  await f0.T.act('view', 'sales'); await flush();
  ck('A-UNK', /Held<\/span><b>—/.test(DB) && /Released periods<\/span><b>—/.test(DB) && /Released<\/span><b>—/.test(DB) && /Attended sessions<\/span><b>—/.test(DB) && /Payment ref<\/span><b>—/.test(DB) && !/<b>0</.test(DB) && !/<b>KES 0/.test(DB)
    && /data-afz-flag>—</.test(f0.el.innerHTML) && !/Turn sales/.test(f0.el.innerHTML),
    'unknown → "—" (never 0 / KES 0): missing held/released/attended/paymentRef; unreadable flag → "—" and NO toggle', DB.slice(0, 300));

  /* A-4 decide */
  const sod = await boot({ callables: { membershipDecideRefund: () => { throw err('failed-precondition', SOD.message, { code: SOD.code }); } } });
  await sod.T.openDetail('mem_req0001'); await flush();
  await sod.T.decide('mem_req0001', 'approve', 'ok'); await flush();
  const tooShort = sod.spy.calls.filter((c) => c.name === 'membershipDecideRefund').length;
  await sod.T.decide('mem_req0001', 'approve', 'Gym confirmed closure'); await flush();
  const sodHtml = H(sod.el.innerHTML);
  const call1 = sod.spy.calls.find((c) => c.name === 'membershipDecideRefund');
  const nc = await boot({ confirm: false, callables: { membershipDecideRefund: () => ({ ok: true, state: 'rejected' }) } });
  await nc.T.openDetail('mem_req0001'); await flush(); await nc.T.decide('mem_req0001', 'reject', 'Not eligible'); await flush();
  const okd = await boot({ callables: { membershipDecideRefund: (d, data) => { data.ms.mem_req0001.refund.state = 'rejected'; data.ms.mem_req0001.status = 'active'; return { ok: true, state: 'rejected' }; } } });
  await okd.T.openDetail('mem_req0001'); await flush(); await okd.T.decide('mem_req0001', 'reject', 'Not eligible'); await flush();
  const okHtml = H(okd.el.innerHTML);
  ck('A-4', tooShort === 0 && call1 && JSON.stringify(call1.data) === JSON.stringify({ membershipId: 'mem_req0001', decision: 'approve', reason: 'Gym confirmed closure' })
    && sodHtml.includes(SOD.message) && sodHtml.includes('(separation_of_duties)')
    && nc.spy.calls.filter((c) => c.name === 'membershipDecideRefund').length === 0 && nc.spy.confirms.length === 1
    && /Server recorded: rejected/.test(okHtml) && /State<\/span><b>rejected/.test(okHtml),
    'Approve/Reject → membershipDecideRefund({membershipId, decision, reason}) after a confirm; the server\'s separation_of_duties refusal shown VERBATIM; cancel → no call; success re-reads the doc', sodHtml.slice(-300));

  /* A-5 exception */
  const ex = await boot({ callables: { membershipRequestException: (d) => { if (d.membershipId === 'mem_atr0001') throw err('failed-precondition', 'A refund is already open or completed.', { code: 'refund_exists' }); return { ok: true, exception: true }; } } });
  await ex.T.openDetail('mem_unused01'); await flush();
  const exHtml0 = H(ex.el.innerHTML);
  await ex.T.requestException('mem_unused01', 'too short'); await flush();
  const nEx0 = ex.spy.calls.filter((c) => c.name === 'membershipRequestException').length;
  await ex.T.requestException('mem_unused01', 'Gym shut for renovation'); await flush();
  const exCall = ex.spy.calls.find((c) => c.name === 'membershipRequestException');
  await ex.T.openDetail('mem_atr0001'); await flush();
  await ex.T.requestException('mem_atr0001', 'Gym shut for renovation'); await flush();
  ck('A-5', /Request exception/.test(exHtml0) && nEx0 === 0 && exCall && JSON.stringify(exCall.data) === JSON.stringify({ membershipId: 'mem_unused01', reason: 'Gym shut for renovation' })
    && H(ex.el.innerHTML).includes('A refund is already open or completed. (refund_exists)'),
    'Request exception → membershipRequestException({membershipId, reason ≥ 10}); shorter reasons never reach the server; refusals verbatim', H(ex.el.innerHTML).slice(-200));

  /* A-6 void attendance (e3 fixtures) */
  const vo = await boot({ callables: { fitnessCorrectAttendance: (d) => (d.attendanceId === 'd_2026-03-19' ? FX.fitnessCorrectAttendance.success : (() => { throw fxErr(FX.fitnessCorrectAttendance.errors.no_permission); })()) } });
  await vo.T.openDetail('mem_req0001'); await flush();
  const voHtml0 = vo.el.innerHTML;
  await vo.T.voidAttendance('mem_req0001', 'd_2026-03-19', 'Scanned the wrong member'); await flush();
  const voCall = vo.spy.calls.find((c) => c.name === 'fitnessCorrectAttendance');
  const voOk = H(vo.el.innerHTML);
  await vo.T.voidAttendance('mem_req0001', 'x_other', 'Scanned the wrong member'); await flush();
  ck('A-6', /data-afz-act="void" data-id="d_2026-03-19"/.test(voHtml0) && !/data-afz-act="void" data-id="s_morning_spin"/.test(voHtml0)
    && voCall && JSON.stringify(voCall.data) === JSON.stringify({ membershipId: 'mem_req0001', attendanceId: 'd_2026-03-19', reason: 'Scanned the wrong member' })
    && /NEVER restores refund eligibility/.test(vo.spy.confirms[0]) && /Refund lock unchanged/.test(voOk)
    && H(vo.el.innerHTML).includes(FX.fitnessCorrectAttendance.errors.no_permission.message),
    'Void → fitnessCorrectAttendance({membershipId, attendanceId, reason}) after a confirm that says it never restores refund eligibility; only non-voided rows offer Void; fixture refusal verbatim', vo.spy.confirms[0]);

  /* A-FLAG */
  const fl = await boot({ mutate: (d) => { d.flag = { key: 'fitness_membership_sales', enabled: false }; },
    callables: { adminOsDispatch: (d, data) => { if (d.op !== 'adminUpdateFeatureFlag') throw err('invalid-argument', 'op'); data.flag = Object.assign({}, data.flag, { enabled: d.enabled === undefined ? true : d.enabled }); return { success: true }; } } });
  await fl.T.act('view', 'sales'); await flush();
  const offHtml = fl.el.innerHTML;
  await fl.T.setSales(true); await flush();
  const onHtml = H(fl.el.innerHTML);
  await fl.T.setSales(false); await flush();
  const fcalls = fl.spy.calls.filter((c) => c.name === 'adminOsDispatch');
  const lie = await boot({ mutate: (d) => { d.flag = { enabled: false }; }, callables: { adminOsDispatch: () => ({ success: true }) } });
  await lie.T.act('view', 'sales'); await flush(); await lie.T.setSales(true); await flush();
  const no = await boot({ confirm: false, callables: { adminOsDispatch: () => ({ success: true }) } });
  await no.T.act('view', 'sales'); await flush(); await no.T.setSales(true); await flush();
  ck('A-FLAG', /data-afz-flag>OFF</.test(offHtml) && /Turn sales ON/.test(offHtml) && fcalls.length === 2
    && fcalls.every((c) => c.data.op === 'adminUpdateFeatureFlag' && c.data.key === 'fitness_membership_sales' && Object.prototype.hasOwnProperty.call(c.data, 'enabled') && typeof c.data.enabled === 'boolean')
    && fcalls[0].data.enabled === true && fcalls[1].data.enabled === false && /Sales are now ON \(read back/.test(onHtml) && /data-afz-flag>OFF</.test(fl.el.innerHTML)
    && !/Sales are now ON/.test(H(lie.el.innerHTML)) && /reload and check/.test(H(lie.el.innerHTML)) && no.spy.calls.length === 0,
    'sales switch → adminOsDispatch({op:\'adminUpdateFeatureFlag\', key, enabled:<explicit boolean>}) after a confirm; the new state is claimed only when the re-read flag shows it', JSON.stringify(fcalls.map((c) => c.data)));
  const fs1 = fl.T.flagState({ exists: false }), fs2 = fl.T.flagState({ exists: true, data: () => ({ enabled: 'true' }) }), fs3 = fl.T.flagState({ exists: true, data: () => ({ enabled: true }) });
  ck('A-FLAG2', fs1.label === 'OFF (not set)' && fs1.on === false && fs2.on === false && /not the boolean true/.test(fs2.label) && fs3.on === true && fs3.label === 'ON',
    'flag display uses the server predicate: missing → OFF (not set); "true" string → OFF (flagged); true → ON');

  /* A-AUDIT */
  const au = await boot({});
  await au.T.act('view', 'checkins'); await flush();
  const aq = lastQ(au, 'adminAudit');
  const AU = H(au.el.innerHTML);
  await au.T.setAuditAction('fitness_checkin'); await flush();
  const aq2 = lastQ(au, 'adminAudit');
  const AU2 = H(au.el.innerHTML);
  ck('A-AUDIT', JSON.stringify(aq.ops) === JSON.stringify([['where', 'hub', '==', 'fitness'], ['orderBy', 'createdAt', 'desc'], ['limit', 50]]) && !/other_hub/.test(AU)
    && /fitness_checkin_duplicate/.test(AU) && /fitness_attendance_corrected/.test(AU) && /Refused \(other_gym/.test(AU) && /First check-in/.test(AU) && /#TAFF_1 · staff/.test(AU) && /#000001/.test(AU) && /#GYM_A/.test(AU)
    && /<td>—<\/td>/.test(AU)
    && JSON.stringify(aq2.ops) === JSON.stringify([['where', 'hub', '==', 'fitness'], ['where', 'action', '==', 'fitness_checkin'], ['orderBy', 'createdAt', 'desc'], ['limit', 50]]) && !/fitness_checkin_duplicate<\/td>/.test(AU2),
    'Check-ins audit: adminAudit where hub==\'fitness\' [&& action==] orderBy createdAt desc · limit 50 — member/gym/actor+role/time/result; method "—" (the audit row does not record it)', AU.slice(0, 300));

  /* A-ESC */
  await a.T.openDetail('mem_req0001'); await flush();
  const all = a.el.innerHTML + au.el.innerHTML;
  await a.T.openDetail('mem_atr0001'); await flush();
  const all2 = all + a.el.innerHTML;
  ck('A-ESC', !/<img src=x/.test(all2) && /&lt;img src=x/.test(all2), 'plan titles, reasons, decision reasons and audit reasons are escaped', (all2.match(/.{30}img src=x.{10}/) || [''])[0]);

  /* A-RO + nav compatibility */
  const envs = [a, f0, sod, nc, okd, ex, vo, fl, lie, no, au];
  const writes = envs.flatMap((e) => e.spy.writes);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('A-RO', writes.length === 0 && !/\.(set|add|update|delete)\(|writeBatch|\.batch\(|runTransaction|localStorage|sessionStorage/.test(code), 'no browser writes and no browser storage (executed spy + source)', writes.join(','));
  const html = envs.map((e) => e.el.innerHTML).join('');
  ck('A-NAV', !/tab-bar|tab-btn/.test(html + code) && !/<a\s[^>]*href=/.test(html) && /window\.SokoniAOSFitness|root\.SokoniAOSFitness/.test(src),
    'module markup uses no .tab-bar/.tab-btn (AdminOS router tab selectors) and no page links — the nav-coverage test stays green');
  return rows;
}

(async () => {
  console.log('\nAdminOS Fitness Memberships view\n');
  const rows = await suite(SRC);
  rows.forEach((r) => console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.id + ' ' + r.m + (r.ok ? '' : '   [got ' + r.got + ']')));
  const failed = rows.filter((r) => !r.ok).length;
  const rp = (s, x, y) => (s.includes(x) ? s.replace(x, () => y) : s);
  const CONTROLS = [
    ['1', 'sales toggle omits enabled', 'A-FLAG', (s) => rp(s, "key: FLAG_KEY, enabled: on === true, description:", 'key: FLAG_KEY, description:')],
    ['2', 'why-locked computed from client-loaded rows', 'A-WHY', (s) => rp(s, '    var why = whyLocked(m);', "    var why = d.att && d.att.length ? 'Member attended ' + d.att.length + ' session(s).' : '';")],
    ['3', 'unescaped member/plan text', 'A-ESC', (s) => rp(s, "function esc(v) { return (typeof root.escapeHTML === 'function' ? root.escapeHTML : FALLBACK_ESC)(v); }", "function esc(v) { return v == null ? '' : String(v); }")],
  ];
  let bad = 0;
  console.log('\nNegative controls (each must FAIL its named row):');
  for (const [k, what, row, mut] of CONTROLS) {
    const s = mut(SRC);
    if (s === SRC) { console.log('  BROKEN control ' + k + ': mutation did not apply'); bad++; continue; }
    const r = (await suite(s)).find((x) => x.id === row);
    const ok = r && !r.ok;
    console.log('  ' + (ok ? 'OK  ' : 'BAD ') + ' control ' + k + ' (' + what + ') → ' + row + ' ' + (ok ? 'FAILS as required' : 'did NOT fail'));
    if (!ok) bad++;
  }
  console.log('\nRESULT: ' + (rows.length - failed) + ' passed, ' + failed + ' failed; controls ' + (CONTROLS.length - bad) + '/' + CONTROLS.length + ' detected');
  process.exit(failed || bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
