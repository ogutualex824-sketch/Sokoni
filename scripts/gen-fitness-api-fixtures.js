#!/usr/bin/env node
'use strict';
/* ============================================================================
   Fitness membership API — canonical response fixtures, generated FROM THE REAL HANDLERS (sokoni-e3, 2026-10-03)
   ----------------------------------------------------------------------------
   Drives the actual callable handlers (functions/fitness-membership-create.js, fitness-attendance.js,
   fitness-gym-memberships.js) through the in-memory Firestore + fixtures of scripts/test-fitness-attendance.js, and
   writes every success / duplicate / refusal shape to scripts/fixtures/fitness-api-fixtures.json. Nothing here is
   hand-written: if a handler's response changes, regenerating changes the JSON (and --check fails until it is
   regenerated and committed). The hosting lane tests its UI against these shapes. Contract prose:
   docs/FITNESS_MEMBERSHIP_API.md.

   No network, no emulator, no production: firebase-admin is INERT (the attendance suite's loader; block-admin.js
   also refuses a real admin). The QR token in the fixtures is signed with event-ops' local TEST-ONLY key.

   Run:   NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require=<block-admin.js> node scripts/gen-fitness-api-fixtures.js
   Check: ... node scripts/gen-fitness-api-fixtures.js --check   (exit 1 if the committed JSON is stale)
   ============================================================================ */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const OUT = path.join(__dirname, 'fixtures', 'fitness-api-fixtures.json');
if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) { console.error('refusing to run inside a Cloud Functions runtime'); process.exit(2); }

/* the attendance suite as a MODULE (its inert firebase-admin loader is installed by this require; nothing runs) */
const T = require('./test-fitness-attendance.js');
const FA = T.loadModule(T.SRC);
const FG = T.loadFG(FA, T.FG_SRC, 'fixtures');
const FMC = require(path.join(FN, 'fitness-membership-create.js'));

const { harness, seedLinked, seedBase, mem, req, attempt, MID, MID2, NOW, START } = T;

/* deterministic clock: handler "now" and server timestamps are the same fixed instant (ISO, so ledger reads parse) */
let clock = NOW;
const useClock = (h) => { FA._test.use({ now: () => clock, ts: () => clock.toISOString() }); return h; };
const setClock = (d) => { clock = d; };
const H = FA._h;
const errOf = (r) => ({ httpsErrorCode: r.code, clientErrorCode: 'functions/' + r.code, message: r.msg,
  details: r.e && r.e.details !== undefined ? r.e.details : null });
const must = (label, r) => { if (!r.ok) throw new Error(`fixture "${label}" expected success, got ${r.code} ${r.reason || ''} ${r.msg}`); return r.r; };
const mustFail = (label, r, reason) => {
  if (r.ok) throw new Error(`fixture "${label}" expected a refusal, got success`);
  if (reason !== undefined && (r.reason || null) !== reason) throw new Error(`fixture "${label}" expected reason ${reason}, got ${r.reason} (${r.code} ${r.msg})`);
  return errOf(r);
};
const P = (id) => `providerMemberships/${id || MID}`;
const qr = async (uid, id) => must('qr', await attempt(() => H.membershipQrHandler(req(uid, { membershipId: id || MID })))).token;
const scan = (uid, token, extra) => attempt(() => H.checkInHandler(req(uid, Object.assign({ token }, extra || {}))));
const setDoc = (h, p, patch) => h.db._docs.set(p, Object.assign({}, h.db._docs.get(p), patch));

async function build () {
  const out = {
    _meta: {
      generatedBy: 'scripts/gen-fitness-api-fixtures.js',
      contract: 'docs/FITNESS_MEMBERSHIP_API.md',
      note: 'Generated from the real handlers against an in-memory Firestore. Do not edit by hand — regenerate. '
        + 'Errors: httpsErrorCode is the server HttpsError code; the web SDK surfaces it as clientErrorCode ("functions/<code>"), '
        + 'message as error.message and details as error.details. The QR token is signed with a TEST-ONLY key and is opaque.',
      fixedNow: NOW.toISOString(),
    },
  };

  /* ── fitnessCreateMembership ── */
  {
    const SVC = 'svc_gold3';
    const offer = { providerId: 'gym_A', name: 'Gold 3-month', category: 'Gym', description: 'All classes', priceType: 'fixed', price: 600000,
      fee: 0, deposit: 0, images: [], durationMins: 0, active: true, serviceKind: 'membership', periodCount: 3, periodUnit: 'month' };
    const gym = { uid: 'gym_A', status: 'approved', business: { category: 'fitness_studio', source: 'application' }, linkedBusinessId: 'biz_gymA' };
    const seed = (flag) => {
      const s = seedLinked({}, { [`providerServices/${SVC}`]: offer, 'providers/gym_A': gym });
      if (flag !== undefined) s['featureFlags/fitness_membership_sales'] = flag;
      return s;
    };
    const setup = (flag) => { const h = harness(FA, seed(flag)); let n = 0;
      FMC._test.use({ db: h.db, ts: () => clock.toISOString(), now: () => clock, tsFromDate: (d) => d.toISOString(), newId: () => 'mem_new' + String(++n).padStart(3, '0') });
      return h; };
    const call = (uid, data) => attempt(() => FMC._h.createMembershipHandler(req(uid, data)));
    setClock(NOW);
    setup({ key: 'fitness_membership_sales', enabled: true });
    const created = must('create', await call('member_9', { serviceId: SVC }));
    const reused = must('create reuse', await call('member_9', { serviceId: SVC }));
    const errors = {};
    setup(undefined); errors.SALES_DISABLED = mustFail('SALES_DISABLED', await call('member_9', { serviceId: SVC }), 'SALES_DISABLED');
    setup({ enabled: true });
    errors.unauthenticated = mustFail('unauth', await call(null, { serviceId: SVC }));
    errors.invalid_serviceId = mustFail('bad id', await call('member_9', { serviceId: '../x' }));
    errors.missing = mustFail('missing', await call('member_9', { serviceId: 'svc_nothere' }), 'missing');
    errors.self_purchase = mustFail('self', await call('gym_A', { serviceId: SVC }), 'self_purchase');
    { const h = setup({ enabled: true }); setDoc(h, 'providers/gym_A', { status: 'pending' });
      errors.provider_not_active = mustFail('not active', await call('member_9', { serviceId: SVC }), 'provider_not_active'); }
    { const h = setup({ enabled: true }); setDoc(h, 'providers/gym_A', { business: { category: 'salon', source: 'application' } });
      errors.not_fitness = mustFail('not fitness', await call('member_9', { serviceId: SVC }), 'not_fitness'); }
    { const h = setup({ enabled: true }); setDoc(h, `providerServices/${SVC}`, { serviceKind: undefined });
      errors.not_membership = mustFail('not membership', await call('member_9', { serviceId: SVC }), 'not_membership'); }
    { const h = setup({ enabled: true }); setDoc(h, `providerServices/${SVC}`, { active: false });
      errors.inactive = mustFail('inactive', await call('member_9', { serviceId: SVC }), 'inactive'); }
    out.fitnessCreateMembership = { request: { serviceId: SVC }, created, reused, errors };
  }

  /* ── fitnessMembershipQr ── */
  {
    setClock(NOW);
    useClock(harness(FA, seedLinked()));
    const ok = must('qr', await attempt(() => H.membershipQrHandler(req('member_1', { membershipId: MID }))));
    const errors = {};
    errors.not_found = mustFail('qr other', await attempt(() => H.membershipQrHandler(req('member_2', { membershipId: MID }))), 'not_found');
    { useClock(harness(FA, seedLinked({ status: 'pending_payment', paymentStatus: 'pending' })));
      errors.not_covered = mustFail('qr pending', await attempt(() => H.membershipQrHandler(req('member_1', { membershipId: MID }))), 'not_covered'); }
    { useClock(harness(FA, seedLinked({ status: 'expired' })));
      errors.expired = mustFail('qr expired', await attempt(() => H.membershipQrHandler(req('member_1', { membershipId: MID }))), 'expired'); }
    out.fitnessMembershipQr = { request: { membershipId: MID }, success: ok, errors };
  }

  /* ── fitnessCheckIn ── */
  {
    setClock(NOW);
    let h = useClock(harness(FA, seedLinked({ sessionsIncluded: 12 })));
    const tok = await qr('member_1');
    const first = must('first', await scan('gym_A', tok));
    const duplicate = must('dup', await scan('gym_A', tok));
    const staffSession = must('staff session', await scan('desk_1', tok, { sessionRef: 'evening_hiit' }));
    useClock(harness(FA, seedLinked()));
    const unlimited = must('unlimited', await scan('gym_A', await qr('member_1')));

    const errors = {};
    const fresh = (over, extra) => useClock(harness(FA, seedLinked(over, extra)));
    fresh(); errors.unauthenticated = mustFail('anon', await scan(null, 'x'));
    fresh(); errors.invalid_sessionRef = mustFail('sessionRef', await scan('gym_A', await qr('member_1'), { sessionRef: 'bad ref!' }));
    fresh(); errors.token_invalid = mustFail('junk', await scan('gym_A', 'fm1.junk.' + '0'.repeat(64)), 'token_invalid');
    { fresh(); const t = await qr('member_1'); setClock(new Date(NOW.getTime() + FA.TOKEN_TTL_MS + 1));
      errors.token_expired = mustFail('expired tok', await scan('gym_A', t), 'token_expired'); setClock(NOW); }
    { h = fresh(); const t = await qr('member_1'); h.db._docs.delete(P());
      errors.not_found = mustFail('not found', await scan('gym_A', t), 'not_found'); }
    fresh(); errors.no_permission = mustFail('stranger', await scan('stranger_1', await qr('member_1')), 'no_permission');
    fresh(); errors.other_gym = mustFail('other gym', await scan('gym_B', await qr('member_1')), 'other_gym');
    { fresh({}, { 'providerMemberships/mem_self01': mem({ buyerUid: 'gym_A' }) });
      errors.self_scan = mustFail('self', await scan('gym_A', await qr('gym_A', 'mem_self01')), 'self_scan'); }
    { h = fresh(); const t = await qr('member_1'); setDoc(h, P(), { buyerUid: 'member_2' });
      errors.wrong_member = mustFail('wrong member', await scan('gym_A', t), 'wrong_member'); }
    for (const st of ['expired', 'cancelled', 'suspended']) {
      h = fresh(); const t = await qr('member_1'); setDoc(h, P(), { status: st });
      errors[st] = mustFail(st, await scan('gym_A', t), st);
    }
    { h = fresh(); const t = await qr('member_1'); setDoc(h, P(), { status: 'refund_requested' });
      errors.not_covered = mustFail('not covered', await scan('gym_A', t), 'not_covered'); }
    { h = fresh({ sessionsIncluded: 1 }); const t = await qr('member_1'); setDoc(h, P(), { attendedSessions: 1, firstAttendedAt: NOW.toISOString(), refundEligible: false });
      errors.entitlement_exhausted = mustFail('exhausted', await scan('gym_A', t), 'entitlement_exhausted'); }
    { useClock(harness(FA, seedBase()));                   /* gym_A has NO linkedBusinessId; desk_1 holds 'attendance' at biz_gymA */
      errors.business_link_missing = mustFail('link missing', await scan('desk_1', await qr('member_1')), 'business_link_missing'); }
    { h = fresh(); const t = await qr('member_1'); setDoc(h, 'providers/gym_A', { status: 'pending' });
      errors.not_approved = mustFail('not approved', await scan('gym_A', t), 'not_approved'); }
    { useClock(harness(FA, seedLinked(), { moduleGate: async () => ({ ok: false, reason: 'MODULE_NOT_AVAILABLE' }) }));
      errors.module_unavailable = mustFail('module', await scan('gym_A', await qr('member_1')), 'module_unavailable'); }
    { useClock(harness(FA, seedLinked(), { notify: async () => null }));
      const t = await qr('member_1');
      FA._test.use({ ts: () => { throw new Error('simulated Firestore outage'); } });
      errors.unavailable = mustFail('unavailable', await scan('gym_A', t));
      FA._test.use({ ts: () => clock.toISOString() }); }
    out.fitnessCheckIn = {
      request: { token: '<from fitnessMembershipQr>', sessionRef: '<optional, [A-Za-z0-9_-]{1,64}>' },
      success_first: first, duplicate, success_staff_named_session: staffSession, success_unlimited: unlimited, errors,
    };
  }

  /* ── fitnessCompleteSession / fitnessCorrectAttendance ── */
  {
    setClock(NOW);
    const h = useClock(harness(FA, seedLinked()));
    const t = await qr('member_1');
    const ci = must('ci', await scan('gym_A', t));
    const C = (uid, data, token) => attempt(() => H.completeSessionHandler(req(uid, data, token)));
    const X = (uid, data, token) => attempt(() => H.correctAttendanceHandler(req(uid, data, token)));
    const body = { membershipId: MID, attendanceId: ci.attendanceId };
    const completed = must('complete', await C('gym_A', body));
    const completeDuplicate = must('complete dup', await C('gym_A', body));
    const errors = {};
    errors.invalid_ids = mustFail('ids', await C('gym_A', { membershipId: MID, attendanceId: 'zz' }));
    errors.attendance_not_found = mustFail('att nf', await C('gym_A', { membershipId: MID, attendanceId: 'd_2001-01-01' }));
    errors.other_gym = mustFail('other gym', await C('gym_B', body), 'other_gym');
    const corrected = must('correct', await X('admin_1', Object.assign({ reason: 'Scanned the wrong member' }, body), { admin: true }));
    const correctDuplicate = must('correct dup', await X('admin_1', Object.assign({ reason: 'Scanned the wrong member' }, body), { admin: true }));
    errors.not_checked_in = mustFail('voided', await C('gym_A', body), 'not_checked_in');
    const correctErrors = {
      no_permission: mustFail('gym corrects', await X('gym_A', Object.assign({ reason: 'x y z' }, body)), 'no_permission'),
      reason_required: mustFail('no reason', await X('admin_1', body, { admin: true })),
    };
    void h;
    out.fitnessCompleteSession = { request: body, success: completed, duplicate: completeDuplicate, errors };
    out.fitnessCorrectAttendance = { request: Object.assign({ reason: 'Scanned the wrong member' }, body), success: corrected, duplicate: correctDuplicate, errors: correctErrors };
  }

  /* ── fitnessGymMemberships / fitnessGymMembership ── */
  {
    setClock(NOW);
    const seed = seedLinked({ createdAt: 'C005', attendedSessions: 2, firstAttendedAt: '2026-02-01T06:00:00.000Z', refundEligible: false,
      lastAttendedAt: '2026-03-19T05:10:00.000Z', releasedPeriods: 2, releasedCents: 400000, paymentStatus: 'partially_released' }, {
      [P(MID2)]: mem({ buyerUid: 'member_2', createdAt: 'C004' }),
      'providerMemberships/mem_cap001': mem({ buyerUid: 'member_1', sessionsIncluded: 12, attendedSessions: 3, voidedSessions: 1, firstAttendedAt: '2026-01-20T06:00:00.000Z',
        refundEligible: false, lastAttendedAt: '2026-03-18T05:00:00.000Z', createdAt: 'C003' }),
      'providerMemberships/mem_pen001': mem({ buyerUid: 'member_2', status: 'pending_payment', paymentStatus: 'pending', attendedSessions: undefined, firstAttendedAt: undefined,
        releasedPeriods: undefined, releasedCents: undefined, startAt: '2026-03-20T07:00:00.000Z', createdAt: 'C002' }),
      'providerMemberships/mem_unk001': mem({ buyerUid: 'member_1', attendedSessions: undefined, firstAttendedAt: '2026-02-01T00:00:00.000Z', createdAt: 'C001' }),
      'users/member_2': { name: 'Wanjiru K.' },
      [`${P()}/attendance/d_2026-03-19`]: { status: 'completed', checkedInAt: '2026-03-19T05:10:00.000Z', method: 'qr', actorRole: 'staff', actorUid: 'desk_1', memberUid: 'member_1', sessionRef: null, completedAt: '2026-03-19T06:15:00.000Z' },
      [`${P()}/attendance/s_morning_spin`]: { status: 'voided_by_admin', checkedInAt: '2026-02-01T06:00:00.000Z', method: 'qr', actorRole: 'owner', actorUid: 'gym_A', memberUid: 'member_1', sessionRef: 'morning_spin', completedAt: null },
      'providerPayouts/mem_000001_m1': { providerId: 'gym_A', membershipId: MID, sourceType: 'membership', periodIndex: 1, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-02-15T03:00:00.000Z' },
      'providerPayouts/mem_000001_m2': { providerId: 'gym_A', membershipId: MID, sourceType: 'membership', periodIndex: 2, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-03-15T03:00:00.000Z' },
    });
    useClock(harness(FA, seed));
    const L = (uid, data) => attempt(() => FG._h.gymMembershipsHandler(req(uid, data || {})));
    const D = (uid, data) => attempt(() => FG._h.gymMembershipHandler(req(uid, data || {})));
    const all = must('list all', await L('gym_A', { limit: 50 }));
    const page1 = must('page1', await L('gym_A', { limit: 2 }));
    const page2 = must('page2', await L('gym_A', { limit: 2, cursor: page1.nextCursor }));
    const pending = must('pending tab', await L('gym_A', { status: 'pending' }));
    const listErrors = {
      invalid_status: mustFail('tab', await L('gym_A', { status: 'nope' })),
      invalid_limit: mustFail('limit', await L('gym_A', { limit: 0 })),
      invalid_cursor: mustFail('cursor', await L('gym_A', { cursor: 'mem_B00001' })),
      NO_PERMISSION: mustFail('stranger', await L('stranger_1'), 'NO_PERMISSION'),
    };
    const detail = must('detail', await D('gym_A', { membershipId: MID }));
    const detailNoPayouts = must('detail none', await D('gym_A', { membershipId: 'mem_pen001' }));
    const detailErrors = {
      not_found: mustFail('detail other', await D('gym_B', { membershipId: MID }), 'not_found'),
      invalid_id: mustFail('detail bad', await D('gym_A', { membershipId: 'x' })),
    };
    out.fitnessGymMemberships = { request: { status: '<active|pending|expired|refund|all (default all)>', limit: '<1..50, default 20>', cursor: '<nextCursor | omitted>' },
      success_all: all, success_page1_limit2: page1, success_page2: page2, success_tab_pending: pending, errors: listErrors };
    out.fitnessGymMembership = { request: { membershipId: MID }, success: detail, success_no_payouts: detailNoPayouts, errors: detailErrors };
  }

  /* ── fitnessScannerStatus ── */
  {
    setClock(NOW);
    const SS = (uid) => attempt(() => FG._h.scannerStatusHandler(req(uid, {})));
    const r = {};
    useClock(harness(FA, seedLinked()));
    r.owner = must('owner', await SS('gym_A')); r.staff = must('staff', await SS('desk_1'));
    r.NO_PERMISSION = must('cashier', await SS('cashier_1')); r.NO_PERMISSION_stranger = must('stranger', await SS('stranger_1'));
    r.unauthenticated = mustFail('anon', await SS(null));
    useClock(harness(FA, seedBase())); r.BUSINESS_LINK_MISSING = must('unlinked', await SS('desk_1'));
    useClock(harness(FA, seedLinked({}, { 'providers/gym_A': { uid: 'gym_A', status: 'pending', linkedBusinessId: 'biz_gymA' } })));
    r.NOT_APPROVED = must('pending', await SS('gym_A')); r.NOT_APPROVED_staff = must('pending staff', await SS('desk_1'));
    useClock(harness(FA, seedLinked(), { moduleGate: async () => ({ ok: false, reason: 'MODULE_NOT_AVAILABLE' }) }));
    r.MODULE_NOT_AVAILABLE = must('module', await SS('gym_A'));
    useClock(harness(FA, seedLinked({}, { 'workspaceMemberships/wm6': { uid: 'desk_1', businessId: 'biz_gymB', status: 'active', permissions: ['attendance'] } })));
    r.MULTIPLE_GYMS = must('multi', await SS('desk_1'));
    out.fitnessScannerStatus = r;
  }
  void START;
  return out;
}

(async () => {
  const data = await build();
  const json = JSON.stringify(data, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : null;
    if (cur !== json) { console.error(`STALE: ${path.relative(ROOT, OUT)} does not match the handlers — regenerate and commit.`); process.exit(1); }
    console.log(`OK: ${path.relative(ROOT, OUT)} matches the handlers.`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Object.keys(data).filter((k) => k !== '_meta').join(', ')})`);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
