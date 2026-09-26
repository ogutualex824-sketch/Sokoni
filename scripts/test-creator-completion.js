/* test-creator-completion.js — the remaining Creator Hub requirements, EXECUTED.
 *
 * The REAL functions/creator-hub.js handlers (creatorDispatch OPS + AdminOS
 * _adminH) on the transactional fake Firestore, seeded with the canonical
 * documents each figure must come from. No network, no provider, no money.
 *
 *   dashboard    total earned · pending · available · withdrawn · pending
 *                withdrawal · outcome_unknown held apart · failed not counted
 *   withdrawal   one payout-intent key across double click / two tabs / reload /
 *                retry; released only on a definitive answer
 *   governance   approve ≠ distribute (dual control) · super-admin override needs a
 *                reason and is audited · replay / concurrency · unauthorized
 *   refunds      AdminOS case list over the existing refund authority
 *   oversight    aggregates from canonical collections, no viewer identity
 *   analytics    period filter · preview starts · royalty earned · top content
 *   profile      public fields only · unpublished absent · no-film creator valid
 *   verification an admin never reviews their own application
 *   pricing      70 / 30 of net from the policy · marketplace commission separate
 *
 *   node scripts/test-creator-completion.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-creator-completion';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.UTC(2026, 8, 26, 9);           /* 26 Sep 2026 — Q3 */
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const quiet = console.log; console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { require.cache[require.resolve(m, { paths: [FN] })] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({ file: () => ({ getSignedUrl: async () => ['https://x'] }) }) }) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{ providerId: 'password' }] }) }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }),
  auth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{}] }) }), storage: () => ({ bucket: () => ({}) }) });

const H = require(Path.join(FN, 'creator-hub.js'));
H._internal._setClock(() => NOW);
const OPS = H._internal.OPS;
const TS = F.Timestamp;
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
const op = (name, uid, data = {}) => OPS[name]({ ...who(uid), data });
const adm = (name, uid, data = {}, token = { admin: true }) => H._adminH[name]({ ...who(uid, token), data });
async function out(p) { try { return { ok: await p }; } catch (e) { return { err: e.code, msg: e.message }; } }
const read = async (p) => (await db.doc(p).get()).data() || null;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { quiet('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  /* ═══ DASHBOARD ═══ */
  quiet('\n── dashboard figures (royalty.mine) ──');
  const empty = await op('royalty.mine', 'pNone');
  ck('no earnings: every figure is a real 0 (no wallet doc = nothing credited), totals defined', empty.figures.totalEarnedCents === 0 && empty.figures.pendingCents === 0
    && empty.figures.withdrawnKes === 0 && empty.figures.beingConfirmedKes === 0 && Object.keys(empty.figures.definitions).length === 7);
  const L = (id, d) => db.doc('royaltyLedger/' + id).set({ uid: 'p1', bucket: 'PARTICIPANT_ROYALTY', kind: 'EARN', createdAt: TS.fromMillis(NOW - 86400000), ...d });
  await db.doc('royaltyPeriods/2026-Q2').set({ periodId: '2026-Q2', status: 'CLOSED' });
  await db.doc('royaltyPeriods/2026-Q1').set({ periodId: '2026-Q1', status: 'APPROVED' });
  await L('e1', { amountCents: 10000, periodId: '2026-Q3' });                    /* open quarter */
  await L('e2', { amountCents: 20000, periodId: '2026-Q1' });                    /* approved, not released */
  await L('e3', { amountCents: 30000, periodId: '2026-Q2' });                    /* closed, released */
  await L('r1', { amountCents: 5000, periodId: '2026-Q3', kind: 'REVERSAL' });   /* a refund */
  await db.doc('royaltyStatements/2026-Q2_p1').set({ uid: 'p1', periodId: '2026-Q2', released: true, releaseCents: 30000, releaseKes: 300, carryOutCents: 0 });
  await db.doc('wallets/p1').set({ balance: 250, pendingPayout: 150 });
  const P = (id, amount, status) => db.doc('payoutRequests/' + id).set({ sellerUid: 'p1', amount, status, method: 'mpesa', createdAt: TS.fromMillis(NOW) });
  await P('pout_ok', 100, 'paid'); await P('pout_man', 20, 'settled_manually'); await P('pout_fail', 70, 'failed');
  await P('pout_unk', 90, 'outcome_unknown'); await P('pout_proc', 60, 'processing'); await P('pout_rej', 40, 'rejected');
  const m = await op('royalty.mine', 'p1');
  const fg = m.figures;
  ck('total earned = all ledger EARN − REVERSAL (100+200+300−50)', fg.totalEarnedCents === 55000, fg.totalEarnedCents);
  ck('pending = open + approved-unreleased quarters (100−50 + 200)', fg.pendingCents === 25000, fg.pendingCents);
  ck('released = what a closed quarter released', fg.releasedCents === 30000);
  ck('available = the wallet balance (KES 250)', fg.availableForWithdrawalKes === 250);
  ck('withdrawn = paid + settled_manually only (100 + 20)', fg.withdrawnKes === 120, fg.withdrawnKes);
  ck('failed and rejected payouts are NOT withdrawn', fg.withdrawnKes === 120 && m.wallet.withdrawnKes === 120);
  ck('outcome_unknown held apart as "being confirmed" (90) — not withdrawn, not pending', fg.beingConfirmedKes === 90 && fg.pendingWithdrawalKes === 60, { unk: fg.beingConfirmedKes, pend: fg.pendingWithdrawalKes });
  const page = fs.readFileSync(Path.join(ROOT, 'creator.html'), 'utf8');
  ck('royalties page shows pending withdrawal, being-confirmed and total earned, with definitions', /Pending withdrawal\*/.test(page) && /Being confirmed with M-PESA/.test(page) && /What these figures mean/.test(page));

  /* ═══ WITHDRAWAL UI ═══ */
  quiet('\n── withdrawal forms: one intent, one key ──');
  const PI = require(Path.join(ROOT, 'sokoni-payout-intent.js'));
  const mem = () => { const m2 = new Map(); return { getItem: (k) => (m2.has(k) ? m2.get(k) : null), setItem: (k, v) => m2.set(k, String(v)), removeItem: (k) => m2.delete(k), _m: m2 }; };
  const shared = mem();
  let seq = 0; const rand = () => 'k' + (++seq);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const intent = { uid: 'u1', amount: 500, destination: '254712345678', storage: shared, rand, sleep: tick };
  const [dc1, dc2] = await Promise.all([PI.acquire(intent), PI.acquire(intent)]);
  ck('double click: both taps get the SAME key', dc1 === dc2, [dc1, dc2]);
  const tabB = await PI.acquire({ ...intent });
  ck('a second tab (same storage) reuses it', tabB === dc1);
  const reload = await PI.acquire({ ...intent });
  ck('a reload reuses it', reload === dc1);
  ck('a network error keeps the key (retry = same withdrawal)', !PI.isDefinitive({ code: 'functions/deadline-exceeded' }) && !PI.isDefinitive({ code: 'unavailable' }) && (await PI.acquire(intent)) === dc1);
  const fresh = mem(); seq = 100;
  const race = await Promise.all([PI.acquire({ ...intent, storage: fresh }), PI.acquire({ ...intent, storage: fresh })]);
  ck('two tabs starting at the same instant converge on ONE key', race[0] === race[1], race);
  ck('a different amount is a different intent', (await PI.acquire({ ...intent, amount: 600 })) !== dc1);
  PI.release(intent);
  ck('after success the key is released — the next withdrawal is new', (await PI.acquire(intent)) !== dc1);
  ck('a definitive refusal releases (nothing was created)', PI.isDefinitive({ code: 'functions/failed-precondition' }) && PI.isDefinitive({ code: 'invalid-argument' }));
  const stale = mem(); stale.setItem(PI.slot('u1', 500, '254712345678'), JSON.stringify({ key: 'po_old', at: NOW - PI.TTL_MS - 1 }));
  ck('an intent older than the TTL is not reused', (await PI.acquire({ ...intent, storage: stale, now: () => NOW })) !== 'po_old');
  const pd = fs.readFileSync(Path.join(ROOT, 'provider-dashboard.html'), 'utf8');
  const wv = fs.readFileSync(Path.join(ROOT, 'sokoni-wallet-v2.js'), 'utf8');
  ck("provider-dashboard.html no longer mints 'po_'+Date.now()", !/idempotencyKey:'po_'\+Date\.now\(\)/.test(pd) && /SokoniPayoutIntent\.acquire/.test(pd) && /sokoni-payout-intent\.js/.test(pd));
  ck('wallet.html (Creator withdrawals) uses the same intent key', /SokoniPayoutIntent\.acquire\(_intent\)/.test(wv) && !/_uid \|\| 'anon'\) \+ '_' \+ Date\.now\(\)/.test(wv)
    && /sokoni-payout-intent\.js/.test(fs.readFileSync(Path.join(ROOT, 'wallet.html'), 'utf8')));

  /* ═══ GOVERNANCE — dual control ═══ */
  quiet('\n── royalty settlement dual control ──');
  const seedPeriod = async (pid, approvedBy, uids) => {
    await db.doc('royaltyPeriods/' + pid).set({ periodId: pid, status: 'APPROVED', calculatedBy: 'admCalc', approvedBy });
    for (const u of uids) await db.doc(`royaltyStatements/${pid}_${u}`).set({ uid: u, periodId: pid, released: false, releaseKes: 50, releaseCents: 5000 });
  };
  await seedPeriod('2025-Q1', 'admA', ['gA', 'gB']);
  ck('unauthorized user cannot distribute', (await out(adm('creatorAdminDistribute', 'nobody', { periodId: '2025-Q1' }, {}))).err === 'permission-denied');
  const same = await out(adm('creatorAdminDistribute', 'admA', { periodId: '2025-Q1' }));
  ck('the approver cannot also distribute (same admin refused)', same.err === 'permission-denied' && !(await read('wallets/gA')), same.msg);
  const d1 = await adm('creatorAdminDistribute', 'admB', { periodId: '2025-Q1' });
  ck('a second admin distributes', d1.credited === 2 && (await read('wallets/gA')).balance === 50);
  const d2 = await adm('creatorAdminDistribute', 'admB', { periodId: '2025-Q1' });
  ck('replay → no second distribution', d2.credited === 0 && (await read('wallets/gA')).balance === 50);
  await seedPeriod('2025-Q2', 'admA', ['gC']);
  await Promise.all([adm('creatorAdminDistribute', 'admB', { periodId: '2025-Q2' }), adm('creatorAdminDistribute', 'admC', { periodId: '2025-Q2' })]);
  ck('two admins distributing concurrently → ONE credit', (await read('wallets/gC')).balance === 50 && (await read('walletTransactions/gC_2025-Q2_royalty')).amount === 50);
  await seedPeriod('2025-Q3', 'saX', ['gD']);
  ck('super admin who approved: override WITHOUT a reason refused', (await out(adm('creatorAdminDistribute', 'saX', { periodId: '2025-Q3' }, { superAdmin: true }))).err === 'permission-denied');
  await adm('creatorAdminDistribute', 'saX', { periodId: '2025-Q3', overrideReason: 'second admin unavailable during month-end close' }, { superAdmin: true });
  const aud = (await db.collection('adminAudit').where('action', '==', 'royalty_distribute_override').get()).docs.map((d) => d.data());
  ck('super admin override with a written reason is allowed AND audited', (await read('wallets/gD')).balance === 50 && aud.length === 1 && aud[0].details.approvedBy === 'saX' && /month-end/.test(aud[0].details.overrideReason));
  ck('a plain admin cannot override (reason or not)', (await out(adm('creatorAdminDistribute', 'admA', { periodId: '2025-Q1', overrideReason: 'I want to release it myself please' }))).err === 'permission-denied');

  /* ═══ REFUND REVIEW (AdminOS) ═══ */
  quiet('\n── refund review over the existing authority ──');
  await db.doc('paymentIntents/SKNFILMR1').set({ purpose: 'film_access', resourceId: 'filmR', uid: 'b9' });
  await db.doc('fosRefundQueue/ref_SKNFILMR1').set({ payRef: 'SKNFILMR1', amountKES: 500, reason: 'Could not play', status: 'pending', buyerUid: 'b9', requestedBy: 'b9', createdAt: TS.fromMillis(NOW - 1000) });
  await db.doc('fosRefundQueue/ref_OTHER1').set({ payRef: 'OTHER1', amountKES: 200, reason: 'dup', status: 'outcome_unknown', requestedBy: 'adm1', createdAt: TS.fromMillis(NOW - 2000) });
  await db.collection('finosAudit').add({ action: 'refund_submitted', actorUid: 'b9', refundId: 'ref_SKNFILMR1', timestamp: TS.fromMillis(NOW - 1000) });
  ck('an ordinary user cannot list refund cases', (await out(adm('creatorAdminRefundCases', 'b9', {}, {}))).err === 'permission-denied');
  const rc = await adm('creatorAdminRefundCases', 'adm1', {});
  const film = rc.cases.find((c) => c.refundId === 'ref_SKNFILMR1'), other = rc.cases.find((c) => c.refundId === 'ref_OTHER1');
  ck('cases show payment identity, amount, reason, state', film && film.payRef === 'SKNFILMR1' && film.amountKES === 500 && film.reason === 'Could not play' && film.status === 'pending');
  ck('a film refund is flagged from the server-minted intent', film.filmPurchase === true && film.filmId === 'filmR' && other.filmPurchase === false);
  ck('an OUTCOME_UNKNOWN refund is surfaced as such', other.outcomeUnknown === true);
  ck('audit history is attached', Array.isArray(film.history) && film.history[0].action === 'refund_submitted');
  const mod = fs.readFileSync(Path.join(ROOT, 'sokoni-aos-creator.js'), 'utf8');
  ck('AdminOS actions call the EXISTING authority (no second lifecycle)', /act\('fosApproveRefund', \{ refundId: id \}/.test(mod) && /act\('fosResolveRefund'/.test(mod) && !/fosRefundQueue/.test(mod));

  /* ═══ OVERSIGHT ═══ */
  quiet('\n── Creator oversight ──');
  for (const [id, st] of [['oc1', 'ACTIVE'], ['oc2', 'ACTIVE'], ['oc3', 'PENDING'], ['oc4', 'SUSPENDED']]) await db.doc('creators/' + id).set({ displayName: id, state: st, supportEmail: id + '@mail.test' });
  await db.doc('creatorVerifications/oc3').set({ status: 'SUBMITTED' });
  await db.doc('entertainmentListings/ofilm').set({ creatorHub: true, status: 'active', creatorUid: 'oc1', title: 'Oversight Film' });
  const acc = (id, d) => db.doc('royaltyAccruals/' + id).set({ status: 'ACCRUED', filmId: 'ofilm', creatorUid: 'oc1', grossCents: 50000, poolCents: 33950, deductions: { providerFeeCents: 1500, commissionCents: 14550 }, refundedCents: 0, buyerUid: 'viewerSecret', recognisedAtMs: NOW, ...d });
  await acc('a1', {}); await acc('a2', {}); await acc('a3', { status: 'VOID_REFUNDED', refundedCents: 50000 });
  await db.doc('royaltyParticipations/ofilm_v1_oc1').set({ uid: 'oc1', filmId: 'ofilm' });
  await db.doc('payoutRequests/pout_oc1a').set({ sellerUid: 'oc1', amount: 300, status: 'paid' });
  await db.doc('payoutRequests/pout_oc1b').set({ sellerUid: 'oc1', amount: 80, status: 'outcome_unknown' });
  const ov = await adm('creatorAdminOverview', 'adm1', {});
  ck('creator counts by state', ov.creators.total >= 4 && ov.creators.byState.ACTIVE >= 2 && ov.creators.byState.SUSPENDED >= 1 && ov.creators.byState.PENDING >= 1, ov.creators);
  ck('pending verification + published films', ov.pendingVerification >= 1 && ov.publishedFilms >= 1);
  ck('sales from accruals: purchases, gross, fees, SOKONI 30%, pool 70%', ov.sales.purchases === 2 && ov.sales.grossCents === 100000 && ov.sales.providerFeeCents === 3000
    && ov.sales.commissionCents === 29100 && ov.sales.poolCents === 67900, ov.sales);
  ck('refunds counted', ov.sales.refunds === 1 && ov.sales.refundedCents === 50000);
  ck('released royalty from the royalty_release wallet rows', ov.releasedRoyaltyKes === 200, ov.releasedRoyaltyKes);   /* gA 50 + gB 50 + gC 50 + gD 50 */
  ck('participant payouts: withdrawn vs outcome_unknown kept apart', ov.participantPayouts.withdrawnKes === 300 && ov.participantPayouts.outcomeUnknownCount === 1 && ov.participantPayouts.outcomeUnknownKes === 80);
  ck('oversight carries NO viewer identity and no creator contact', !/viewerSecret|@mail\.test/.test(JSON.stringify(ov)));
  ck('an ordinary user cannot read oversight', (await out(adm('creatorAdminOverview', 'oc1', {}, {}))).err === 'permission-denied');

  /* ═══ VIEWER ANALYTICS ═══ */
  quiet('\n── creator viewer analytics ──');
  await db.doc('entertainmentListings/afilm').set({ creatorHub: true, status: 'active', creatorUid: 'an1', title: 'Analytics Film', pubState: 'PUBLISHED' });
  await db.doc('entertainmentListings/bfilm').set({ creatorHub: true, status: 'active', creatorUid: 'an1', title: 'Quiet Film', pubState: 'PUBLISHED' });
  await db.doc('filmStats/afilm').set({ views: 10, uniqueViewers: 6 });
  await db.doc('filmStats/afilm/shards/0').set({ pageViews: 40, previewStarts: 12, watchSeconds: 600 });
  const aacc = (id, ms, gross) => db.doc('royaltyAccruals/' + id).set({ status: 'ACCRUED', filmId: 'afilm', grossCents: gross, poolCents: 700, deductions: { providerFeeCents: 0, commissionCents: 300 }, refundedCents: 0, recognisedAtMs: ms, buyerUid: 'hiddenBuyer' });
  await aacc('x1', NOW - 2 * 86400000, 1000); await aacc('x2', NOW - 20 * 86400000, 1000); await aacc('x3', NOW - 200 * 86400000, 1000);
  await db.doc('royaltyLedger/an_e1').set({ uid: 'an1', bucket: 'PARTICIPANT_ROYALTY', kind: 'EARN', amountCents: 700, createdAt: TS.fromMillis(NOW - 2 * 86400000) });
  await db.doc('royaltyLedger/an_e2').set({ uid: 'an1', bucket: 'PARTICIPANT_ROYALTY', kind: 'EARN', amountCents: 700, createdAt: TS.fromMillis(NOW - 200 * 86400000) });
  const all = await op('creator.analytics', 'an1', { period: 'all' });
  const wk = await op('creator.analytics', 'an1', { period: '7d' });
  const af = (r) => r.films.find((x) => x.filmId === 'afilm');
  ck('views, preview starts, page views reported (all-time counters, labelled)', af(all).views === 10 && af(all).previewStarts === 12 && af(all).pageViews === 40 && all.countersAreAllTime === true);
  ck('purchases + revenue filtered by period (all 3 · 7d 1)', af(all).purchases === 3 && af(wk).purchases === 1 && af(wk).grossCents === 1000, { all: af(all).purchases, wk: af(wk).purchases });
  ck('conversion = purchases / page views (3/40 = 750 bps)', all.totals.conversionBps === 750);
  ck('royalty earned is the creator\'s own ledger, in the window', all.royaltyEarnedCents === 1400 && wk.royaltyEarnedCents === 700);
  ck('top content ranks films by revenue', all.topContent[0].filmId === 'afilm' && !all.topContent.some((t) => t.filmId === 'bfilm'));
  ck('an unknown period falls back to all', (await op('creator.analytics', 'an1', { period: 'forever' })).period === 'all');
  ck('analytics carry no buyer identity', !/hiddenBuyer/.test(JSON.stringify(all)));

  /* ═══ PUBLIC PROFILE ═══ */
  quiet('\n── public creator profile ──');
  await db.doc('creators/pc1').set({ displayName: 'Public Studio', bio: 'We make films.', avatarUrl: 'https://x/a.jpg', state: 'ACTIVE', verification: 'VERIFIED', supportEmail: 'private@studio.test', phone: '254700000000' });
  await db.doc('creatorPrivate/pc1').set({ email: 'owner@studio.test', phone: '254711111111' });
  await db.doc('entertainmentListings/pcPub').set({ creatorHub: true, status: 'active', pubState: 'PUBLISHED', creatorUid: 'pc1', title: 'Out Now', priceCents: 30000, posterUrl: 'https://x/p.jpg' });
  await db.doc('entertainmentListings/pcDraft').set({ creatorHub: true, status: 'draft', pubState: 'DRAFT', creatorUid: 'pc1', title: 'Secret Draft' });
  const prof = await op('catalog.creator', null, { creatorId: 'pc1' });
  ck('public profile: name, bio, avatar, verification', prof.creator.displayName === 'Public Studio' && prof.creator.bio === 'We make films.' && prof.creator.avatarUrl && prof.creator.verification === 'VERIFIED');
  ck('published films with title, price, poster, link target', prof.films.length === 1 && prof.films[0].filmId === 'pcPub' && prof.films[0].priceCents === 30000 && prof.films[0].posterUrl);
  const blob = JSON.stringify(prof);
  ck('NO email, phone, private data or unpublished content', !/@studio\.test|2547\d{8}|Secret Draft|supportEmail/.test(blob), blob.slice(0, 120));
  await db.doc('creators/pc2').set({ displayName: 'New Studio', state: 'ACTIVE' });
  ck('a creator with no published content still has a valid profile', (await op('catalog.creator', null, { creatorId: 'pc2' })).films.length === 0);
  await db.doc('creators/pc3').set({ displayName: 'Gone', state: 'SUSPENDED' });
  ck('a suspended creator has no public profile', (await out(op('catalog.creator', null, { creatorId: 'pc3' }))).err === 'not-found');
  ck('the creator\'s OWN view keeps their support contact', (await op('creator.me', 'pc1')).creator.supportEmail === 'private@studio.test');

  /* ═══ VERIFICATION ═══ */
  quiet('\n── verification: no self-review ──');
  await db.doc('creatorVerifications/admSelf').set({ status: 'UNDER_REVIEW', version: 1 });
  ck('an admin cannot approve their own application', (await out(adm('creatorAdminVerificationDecision', 'admSelf', { uid: 'admSelf', action: 'approve', reason: 'looks good' }))).err === 'permission-denied'
    && (await read('creatorVerifications/admSelf')).status === 'UNDER_REVIEW');
  await db.doc('creators/admSelf').set({ displayName: 'Self', state: 'PENDING' });
  ck('an admin cannot approve their own creator account', (await out(adm('creatorAdminSetState', 'admSelf', { uid: 'admSelf', to: 'ACTIVE' }))).err === 'permission-denied');

  /* ═══ PRICING ═══ */
  quiet('\n── pricing page ──');
  const C = require(Path.join(FN, 'shared', 'creator-commercial.js'));
  const sub = fs.readFileSync(Path.join(ROOT, 'subscriptions.html'), 'utf8');
  ck('policy is 30 % SOKONI / 70 % creator pool (bps)', C.CREATOR_PPV.sokoniCommissionBps === 3000 && C.CREATOR_PPV.creatorPoolBps === 7000);
  ck('pricing renders both shares FROM the policy, fee deducted first', /pctLabel\(P\.sokoniCommissionBps\)/.test(sub) && /pctLabel\(P\.creatorPoolBps\)/.test(sub) && /IntaSend payment fee/.test(sub));
  ck('pricing says the marketplace commission does not apply to films', /Marketplace commission<\/td><td>Does <b>not<\/b> apply to films/.test(sub));
  const cc = require('child_process').spawnSync('git', ['diff', '--quiet', 'a38b31a', '--', 'functions/commission-config.js'], { cwd: ROOT });
  ck('marketplace commission config byte-identical to the pre-Creator base (a38b31a)', cc.status === 0, cc.status);

  /* ═══ PAYMENT-METHOD READINESS (no provider call) ═══ */
  quiet('\n── payment-method readiness: the record controls availability ──');
  {
    const HC = require(Path.join(FN, 'hosted-checkout.js'))._internal;
    const gw = [];
    HC._setHttps({ request: (opts, cb) => { let body = ''; const req = { on: () => req, write: (b) => { body += b; }, end: () => {
      gw.push(JSON.parse(body)); const data = JSON.stringify({ url: 'https://payment.intasend.com/checkout/r' + gw.length + '/', id: 'RINV' + gw.length });
      const res = { statusCode: 201, on: (ev, fn) => { if (ev === 'data') fn(data); if (ev === 'end') fn(); return res; } }; cb(res); } }; return req; } });
    HC._setClock(() => NOW);
    await db.doc('config/creatorHub').set({ purchasesEnabled: true }, { merge: true });
    await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['film_access'] });
    await db.doc('entertainmentListings/rfilm').set({ creatorHub: true, status: 'active', pubState: 'PUBLISHED', creatorUid: 'pc1', title: 'Ready', priceCents: 50000, currency: 'KES' });
    const SA = { superAdmin: true };
    const PCAP = require(Path.join(FN, 'shared', 'payment-capability.js'));
    const results = [];
    let k = 0;
    for (const m of [...PCAP.METHODS, 'MPESA-XB']) {                 /* the 8 known + one IntaSend might add later */
      await db.doc('config/intasendCapability').delete().catch(() => {});
      await adm('creatorAdminPaymentCapability', 'saR', { set: { method: m, status: 'LIVE_AND_PROVEN', evidence: { type: 'provider_confirmation', reference: 'TKT-' + m }, note: 'harness: provider confirmed this method for the account' } }, SA);
      const g = await op('catalog.get', 'vR', { filmId: 'rfilm' });
      const offered = g.checkout.hostedCheckout && g.checkout.methods.some((x) => x.method === m && x.rail === 'hosted_checkout');
      const ref = 'RDYREF' + (++k);
      await db.doc('paymentIntents/' + ref).set({ ref, uid: 'vR', purpose: 'film_access', amount: 500, currency: 'KES', status: 'created', expiresAt: TS.fromMillis(NOW + 900000), metadata: {} });
      const n0 = gw.length;
      const r = await out(HC.hostedCheckout({ auth: { uid: 'vR' }, data: { ref, method: m.toLowerCase() } }, 'ISPubKey_live_x'));
      results.push({ m, offered, forwarded: gw.length - n0 === 1 && gw[gw.length - 1].method === m, err: r.err || null });
    }
    ck('every known method (8) + a NEW identifier become offerable by the record alone — no code change',
      results.every((x) => x.offered && x.forwarded), results.filter((x) => !(x.offered && x.forwarded)));
    await db.doc('config/intasendCapability').set({ methods: { 'CARD-PAYMENT': { status: 'PROVIDER_CAPABILITY_UNKNOWN', note: 'unknown' } } });
    const g0 = await op('catalog.get', 'vR', { filmId: 'rfilm' });
    const n1 = gw.length;
    await db.doc('paymentIntents/RDYREFX').set({ ref: 'RDYREFX', uid: 'vR', purpose: 'film_access', amount: 500, currency: 'KES', status: 'created', expiresAt: TS.fromMillis(NOW + 900000), metadata: {} });
    const rx = await out(HC.hostedCheckout({ auth: { uid: 'vR' }, data: { ref: 'RDYREFX', method: 'CARD-PAYMENT' } }, 'ISPubKey_live_x'));
    ck('with nothing proven: M-PESA (STK) only, hosted refused, no request', g0.checkout.hostedCheckout === false && rx.err === 'failed-precondition' && gw.length === n1);
    await db.doc('config/hostedCheckout').set({ enabled: false, purposes: [] });
  }

  /* ═══ ANONYMOUS UPGRADE CONTRACT (static; server proof in test-creator-hub) ═══ */
  quiet('\n── anonymous purchase: upgrade contract ──');
  const cpage = fs.readFileSync(Path.join(ROOT, 'creator.html'), 'utf8');
  ck('guest upgrade LINKS the credential to the SAME uid (linkWithCredential), never creates a new account', /linkWithCredential\(USER, cred\)/.test(cpage) && !/createUserWithEmailAndPassword/.test(cpage));
  ck('guest checkout is behind a server flag that defaults OFF', /guestCheckoutEnabled: d\.guestCheckoutEnabled === true/.test(fs.readFileSync(Path.join(FN, 'creator-hub.js'), 'utf8')));
  ck('no client-supplied identity is trusted (the pricer reads only the verified uid)', /The pricer receives only the verified uid/.test(fs.readFileSync(Path.join(FN, 'creator-hub.js'), 'utf8')));

  quiet('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { quiet('HARNESS CRASHED', e && e.stack); process.exit(2); });
