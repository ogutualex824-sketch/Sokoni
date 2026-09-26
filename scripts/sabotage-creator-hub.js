/* sabotage-creator-hub.js — plant each attack the Creator Hub must stop, run the
 * suite that owns it, and require the EXPECTED case to go red.
 *
 *   CAUGHT        suite failed, and on the expected case
 *   CAUGHT-OTHER  suite failed, but not on the expected case (counted caught, flagged)
 *   MISSED        suite stayed green — the control is inert
 *   CRASHED       suite crashed — not a detection
 *   NO-ANCHOR     the code to sabotage is gone — the mutation proves nothing
 *
 * Every file is restored byte-for-byte in `finally`; a post-restore run proves
 * the tree is green again. Run with the worktree QUIESCENT (no other suite
 * running against these files).
 *
 *   node scripts/sabotage-creator-hub.js            (all, incl. emulator rules)
 *   node scripts/sabotage-creator-hub.js --no-rules (skip the emulator mutations)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITES = {
  royalty:    ['node', ['scripts/test-creator-royalty.js']],
  publishing: ['node', ['scripts/test-creator-publishing.js']],
  hub:        ['node', ['scripts/test-creator-hub.js']],
  rules:      ['node', ['scripts/run-creator-rules.js']],
  callback:   ['node', ['scripts/test-creator-callback.js']],
  hosted:     ['node', ['scripts/test-hosted-checkout.js']],
  withdrawal: ['node', ['scripts/test-creator-withdrawal.js']],
  refund:     ['node', ['scripts/test-refund-exactly-once.js']],
  payout:     ['node', ['scripts/test-payout-outcome-unknown.js']],
};
const IDX = 'functions/index.js';
const FOS = 'functions/financial-os.js';
const COM = 'functions/shared/creator-commercial.js';
const EARLY = '_fiSnap.exists && _fiSnap.data().purpose === "film_access"';
const SECOND = 'if (attribution.purpose === "film_access" || attribution.type === "film_access") {\n        logger.warn';
const HUB = 'functions/creator-hub.js';
const ROY = 'functions/shared/creator-royalty.js';
const PUB = 'functions/shared/creator-publishing.js';
const WM  = 'functions/shared/creator-watermark.js';

const M = [
  /* ── forged percentages / participants ── */
  { name: 'forged royalty %: Σ > 100% accepted', file: ROY, suite: 'royalty',
    from: 'if (total > BPS_TOTAL) errors.push', to: 'if (false) errors.push', expect: /Σ > 100% refused/ },
  { name: 'forged royalty %: negative share accepted', file: ROY, suite: 'royalty',
    from: "else if (bps <= 0) errors.push(`${at}.bps must be > 0`);", to: '', expect: /negative share refused/ },
  { name: 'forged participant: duplicate uid+role accepted', file: ROY, suite: 'royalty',
    from: "if (uid && roles.has(roleKey)) errors.push", to: 'if (false) errors.push', expect: /same uid SAME role refused/ },
  { name: 'allocation drift: largest-remainder removed', file: ROY, suite: 'royalty',
    from: 'for (let i = 0; left > 0; i = (i + 1) % order.length) { order[i].amountCents += 1; left -= 1; }', to: '', expect: /Σ allocated == pool|Σ == pool|sums exactly/ },
  { name: 'locked agreement mutable: re-lock of LOCKED allowed', file: ROY, suite: 'royalty',
    from: "if (draft.status !== AGREEMENT_STATUS.DRAFT) throw", to: 'if (false) throw', expect: /locking a LOCKED version refused/ },
  /* ── double royalty ── */
  { name: 'double royalty: accrual claim create() → set(), no pre-check', file: HUB, suite: 'hub',
    edits: [['if (pre.exists) return { alreadyAccrued: true, status: pre.data().status };', ''],
            ['if (acc.exists) return { alreadyAccrued: true, status: acc.data().status };', ''],
            [/txn\.create\(accRef, \{\n        \.\.\.base, status: 'ACCRUED'/, "txn.set(accRef, {\n        ...base, status: 'ACCRUED'"],
            [/txn\.create\(L\.doc\(/g, 'txn.set(L.doc(']],
    expect: /concurrent accruals|replay → still ONE allocation|alreadyAccrued/ },
  { name: 'double withdrawal: distribution claim create() → set(), no reconcile', file: HUB, suite: 'hub',
    edits: [["txn.create(wtxRef, { uid: s.uid, type: 'royalty_release'", "txn.set(wtxRef, { uid: s.uid, type: 'royalty_release'"],
            ['if (wtx.exists) {', 'if (false) {'],
            ['if (c.released) return \'already\';', '']],
    expect: /NOT re-credited|credits NOTHING twice/ },
  /* ── payment completion / royalty without payment ── */
  { name: 'royalty credit without payment: honourable-payment check removed', file: HUB, suite: 'hub',
    from: "try { engine.assertPaymentHonourable(intent, payment); } catch (e) { return { refused: e.code || 'not_honourable' }; }", to: '',
    expect: /PENDING payment refused|payment by a different uid refused/ },
  { name: 'fee assumed zero when unreported', file: HUB, suite: 'hub',
    from: "return { cents: null, source: 'unreported' };", to: "return { cents: 0, source: 'unreported' };", expect: /unreported fee → accrual WITHHELD/ },
  { name: 'sellerUid leaks onto the film intent (webhook would credit a seller)', file: HUB, suite: 'hub',
    from: "type: PURPOSE, filmId, creatorUid: f.creatorUid,", to: "type: PURPOSE, sellerUid: f.creatorUid, filmId, creatorUid: f.creatorUid,", expect: /NO sellerUid/ },
  { name: 'webhook film branch removed (seller/buyer credit path reopens)', file: 'functions/index.js', suite: 'hub',
    from: '_fiSnap.exists && _fiSnap.data().purpose === "film_access"', to: 'false', expect: /webhook film branch exists/ },
  /* ── forged creator / ownership / cross-creator ── */
  { name: 'cross-creator: film ownership check removed', file: HUB, suite: 'hub',
    from: "if (f.creatorUid !== uid && !(allowAdmin && isAdmin)) fail('permission-denied', 'Not your film.');", to: '', expect: /cross-creator edit denied/ },
  { name: 'forged ownership: server-owned field accepted', file: PUB, suite: 'publishing',
    from: "if (refused.length) throw _err('field_server_owned'", to: "if (false) throw _err('field_server_owned'", expect: /server-owned "creatorUid" refused/ },
  { name: 'creator self-approval path added to the state machine', file: PUB, suite: 'publishing',
    from: "      DRAFT:     ['SUBMITTED'],", to: "      DRAFT:     ['SUBMITTED'],\n      SUBMITTED: ['APPROVED'],", expect: /no creator transition INTO APPROVED/ },
  { name: 'forged settlement: self-approval of a period allowed', file: ROY, suite: 'royalty',
    from: "if (to === PERIOD_STATUS.APPROVED && calculatedBy && actorUid === calculatedBy) {", to: 'if (false) {', expect: /self-approval refused/ },
  { name: 'forged payout: distribute admin guard removed', file: HUB, suite: 'hub',
    from: "_adminH.creatorAdminDistribute = async (req) => {\n  const actor = _admin(req);", to: "_adminH.creatorAdminDistribute = async (req) => {\n  const actor = (req.auth && req.auth.uid) || 'anon';", expect: /creatorAdmin\* ops refuse a non-admin/ },
  /* ── playback ── */
  { name: 'playback without entitlement: status check removed', file: PUB, suite: 'publishing',
    from: "if (entitlement.status !== 'ACTIVE') return", to: 'if (false) return', expect: /refunded \(REVOKED\) viewer denied/ },
  { name: 'playback: concurrent-session limit removed', file: PUB, suite: 'publishing',
    from: "if (live.length >= PLAYBACK.MAX_CONCURRENT_SESSIONS) return", to: 'if (false) return', expect: /third concurrent session denied/ },
  { name: 'watermark leaks the full email', file: WM, suite: 'publishing',
    from: "const ident = maskEmail(email) || maskPhone(phone) || 'viewer';", to: "const ident = email || maskPhone(phone) || 'viewer';", expect: /NO full email in payload/ },
  /* ── rules (real emulator) ── */
  { name: 'rules: participant can write the royalty ledger', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/royaltyLedger\/\{entryId\}\s*\{([\s\S]*?)allow write:\s*if false;/, to: (m) => m.replace(/allow write:\s*if false;/, 'allow write: if isAuthed();'),
    expect: /participant credits themselves in the ledger DENIED/ },
  { name: 'rules: buyer can write an entitlement', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/contentEntitlements\/\{paymentRef\}\s*\{([\s\S]*?)allow write:\s*if false;/, to: (m) => m.replace(/allow write:\s*if false;/, 'allow write: if isAuthed();'),
    expect: /buyer writes an entitlement DENIED/ },
  { name: 'storage: film masters become readable', file: 'storage.rules', suite: 'rules', rules: true,
    from: "match /creator-masters/{uid}/{filmId}/{uploadId} {\n      allow read:   if false;", to: "match /creator-masters/{uid}/{filmId}/{uploadId} {\n      allow read:   if request.auth != null;", expect: /viewer reads a master DENIED/ },

  /* ── money: payment callback (executed webhook, base-differential) ── */
  { group: 'money', name: 'callback: film payment credits the BUYER (all three film guards removed)', file: IDX, suite: 'callback',
    edits: [[EARLY, 'false'], ['if (attribution.purpose === "film_access" || attribution.type === "film_access") {', 'if (false) {'],
            ['const _isFilmAccess = attribution.purpose === "film_access" || attribution.type === "film_access";', 'const _isFilmAccess = false;']],
    expect: /film: NO wallet written/ },
  { group: 'money', name: 'callback: film payment writes a marketplace commissionLedger (exits removed, credit guard kept)', file: IDX, suite: 'callback',
    edits: [[EARLY, 'false'], ['if (attribution.purpose === "film_access" || attribution.type === "film_access") {', 'if (false) {']],
    expect: /NO marketplace commissionLedger/ },
  { group: 'money', name: 'callback: second exit removed → early-intent-read failure leaks to the seller path', file: IDX, suite: 'callback',
    from: 'if (attribution.purpose === "film_access" || attribution.type === "film_access") {', to: 'if (false) {',
    expect: /filmIntentReadFails: (NO marketplace commissionLedger|early branch LOST its read and the SECOND exit fired)/ },
  { group: 'money', name: 'callback: ordinary marketplace payment stops crediting the seller', file: IDX, suite: 'callback',
    from: '} else if (_isFilmAccess) {', to: '} else if (true) {', expect: /marketplace: (SELLER credited|store identical)/ },
  { group: 'money', name: 'callback: POS till payment enters the Creator path', file: IDX, suite: 'callback',
    from: EARLY, to: '_fiSnap.exists', expect: /pos: (store identical|till merchant credited)/ },
  { group: 'money', name: 'callback: wallet top-up leaves its path', file: IDX, suite: 'callback',
    from: 'if (!apiRef || !apiRef.startsWith("wtop_")) return false;', to: 'return false;', expect: /topup:/ },
  { group: 'money', name: 'callback: film payment skips the royalty', file: HUB, suite: 'callback',
    from: "  const royalty = await accrueRoyalty(ref, { source: opts.source || 'payment-trigger' });", to: "  const royalty = { skipped: 'sabotage' };",
    expect: /royalty accrued under the Creator policy/ },
  /* ── money: commission authority ── */
  { group: 'money', name: 'forged 30% commission: Creator policy set to 15/85', file: COM, suite: 'royalty',
    edits: [['sokoniCommissionBps: 3000,', 'sokoniCommissionBps: 1500,'], ['creatorPoolBps: 7000,', 'creatorPoolBps: 8500,']],
    expect: /Example A|policy: SOKONI 3000/ },
  { group: 'money', name: 'forged creator pool: commission taken on GROSS, not net', file: ROY, suite: 'royalty',
    from: 'const commissionCents = Math.floor((netCents * policy.sokoniCommissionBps) / BPS_TOTAL);', to: 'const commissionCents = Math.min(netCents, Math.floor((grossCents * policy.sokoniCommissionBps) / BPS_TOTAL));',
    expect: /Example A/ },
  { group: 'money', name: 'Creator accrual reads the marketplace rate table (commission-config)', file: HUB, suite: 'callback',
    from: "const policy = require('./shared/creator-commercial').policyFor(intent);", to: "const policy = { ...require('./shared/creator-commercial').policyFor(intent), sokoniCommissionBps: require('./commission-config').RATES.ppv.pct * 100, creatorPoolBps: 10000 - require('./commission-config').RATES.ppv.pct * 100 };",
    expect: /SOKONI = 30% of NET|no hard-coded 0\.15/ },
  /* ── money: refund rail (executed, base-differential) ── */
  { group: 'money', name: 'refund: execution lock removed (processing is executable)', file: FOS, suite: 'refund',
    from: "const REFUND_EXECUTABLE = new Set(['pending', 'approved', 'failed']);", to: "const REFUND_EXECUTABLE = new Set(['pending', 'approved', 'failed', 'processing']);",
    expect: /Race|racing approval|ONE provider call|executable states/ },
  { group: 'money', name: 'refund: unknown outcome treated as a definitive rejection (retry blind)', file: FOS, suite: 'refund',
    from: 'return Number.isInteger(s) && s >= 400 && s < 500 && ![408, 409, 425, 429].includes(s);', to: 'return Number.isInteger(s) && s >= 400;',
    expect: /http503: ONE provider call|HTTP 503/ },
  { group: 'money', name: 'refund: dropped connection resets to a re-approvable state', file: FOS, suite: 'refund',
    from: "await _markRefundExecution(refundRef, executionId, { status: 'outcome_unknown', outcomeError: String(e.message || e).slice(0, 300) });",
    to: "await _markRefundExecution(refundRef, executionId, { status: 'failed', outcomeError: String(e.message || e).slice(0, 300) });",
    expect: /throw: (ONE provider call|re-approval REFUSED|left in outcome_unknown)/ },
  { group: 'money', name: 'refund: settlement failure after provider success resets to approved (the original P0)', file: FOS, suite: 'refund',
    from: "await _markRefundExecution(refundRef, executionId, { status: 'provider_succeeded', providerRefundId: result.refundId || null });",
    to: "await _markRefundExecution(refundRef, executionId, { status: 'approved' });",
    expect: /txnfail: (ONE provider call|re-approval REFUSED|left in provider_succeeded)/ },
  { group: 'money', name: 'refund: payRef refund debits the PAYER again', file: FOS, suite: 'refund',
    from: 'sellerUid: _im.sellerUid || _im.merchantUid || _im.providerId || null,', to: 'sellerUid: _im.sellerUid || _im.merchantUid || _im.providerId || pd.uid,',
    expect: /buyer's wallet NEVER debited/ },

  /* ── hosted checkout (§7–8) ── */
  { group: 'hosted', name: 'hosted: client amount reaches the gateway', file: 'functions/hosted-checkout.js', suite: 'hosted',
    from: 'const amountKES = Number(intent.amount);', to: 'const amountKES = Number(d.amount || intent.amount);', expect: /amount = INTENT amount/ },
  { group: 'hosted', name: 'hosted: client-chosen method forwarded (SOKONI restricting the account)', file: 'functions/hosted-checkout.js', suite: 'hosted',
    from: 'const payload = IC.buildPayload({ amountKES, apiRef: ref, publicKey, currency,', to: 'const payload = IC.buildPayload({ amountKES, apiRef: ref, publicKey, currency, method: d.method,', expect: /NO method sent/ },
  { group: 'hosted', name: 'hosted: single-flight reservation removed', file: 'functions/hosted-checkout.js', suite: 'hosted',
    edits: [["    txn.create(attRef, {", "    txn.set(attRef, {"], ["    if (pay.exists) fail('failed-precondition', 'A payment for this order is already in progress.');", ''], ["      fail('failed-precondition', 'A payment for this order is already in progress.');\n    }", '    }'],["    txn.create(payRef, {", "    txn.set(payRef, {"]],
    expect: /ONE gateway call|one rail per intent|no second session/ },
  { group: 'hosted', name: 'hosted: an unknown outcome is released for retry (second session)', file: 'functions/hosted-checkout.js', suite: 'hosted',
    from: "  await attRef.update({ state: 'OUTCOME_UNKNOWN', heldAt: FieldValue.serverTimestamp(), httpStatus: res.status }).catch(() => {});", to: "  await attRef.delete().catch(() => {}); await payRef.delete().catch(() => {});",
    expect: /503 → OUTCOME_UNKNOWN kept|retry after an UNKNOWN outcome refused/ },
  { group: 'hosted', name: 'hosted: foreign intent accepted (ownership check removed)', file: 'functions/hosted-checkout.js', suite: 'hosted',
    from: "  if (intent.uid !== uid) fail('permission-denied', 'This payment does not belong to you.');", to: '', expect: /someone else's intent/ },
  { group: 'hosted', name: 'hosted: untrusted checkout URL handed to the browser', file: 'functions/hosted-checkout.js', suite: 'hosted',
    from: "if (u.protocol === 'https:' && /(^|\\.)intasend\\.com$/.test(u.hostname)) safe = u.href;", to: "safe = u.href;", expect: /non-IntaSend URL is NOT returned/ },
  { group: 'hosted', name: 'withdrawal: payout marked paid on an in-flight provider status', file: 'functions/wallet.js', suite: 'withdrawal',
    from: "const completedWord = /COMPLETE/.test(S) || ['SUCCESS', 'PAID', 'SETTLED'].includes(S);", to: "const completedWord = /COMPLETE|PROCESSING/.test(S) || ['SUCCESS', 'PAID', 'SETTLED'].includes(S);",
    expect: /in-flight provider status leaves it PROCESSING/ },

  /* ── payout ambiguous outcome (OUTCOME_UNKNOWN) — test-payout-outcome-unknown.js ── */
  { group: 'payout', name: 'payout: an ambiguous B2C answer is treated as a rejection (funds released)', file: 'functions/wallet.js', suite: 'payout',
    from: "    if (kind === 'rejected') {\n      /* The provider answered NO", to: "    if (true) {\n      /* The provider answered NO",
    expect: /W3B timeout → OUTCOME_UNKNOWN/ },
  { group: 'payout', name: 'payout: HTTP 429 treated as a definitive rejection', file: 'functions/wallet.js', suite: 'payout',
    from: "const _AMBIGUOUS_4XX = new Set([408, 409, 425, 429]);", to: "const _AMBIGUOUS_4XX = new Set([408, 409, 425]);",
    expect: /HTTP 429 → OUTCOME_UNKNOWN/ },
  { group: 'payout', name: 'payout: retry worker re-sends OUTCOME_UNKNOWN payouts', file: 'functions/wallet.js', suite: 'payout',
    edits: [
      [".where('status', '==', 'retry_scheduled').limit(50).get().catch(() => null);\n    if (!snap || snap.empty) return;\n\n    let parked", ".where('status', '==', 'outcome_unknown').limit(50).get().catch(() => null);\n    if (!snap || snap.empty) return;\n\n    let parked"],
      ["      if (!moved) continue;\n      parked++;", "      await _disburseB2C(db, doc.id, { ...doc.data(), id: doc.id });\n      if (!moved) continue;\n      parked++;"],
    ],
    expect: /retry worker skips it/ },
  { group: 'payout', name: 'payout: admin approve re-sends an OUTCOME_UNKNOWN payout', file: 'functions/wallet.js', suite: 'payout',
    edits: [
      ["  if (!['pending', 'approval_failed'].includes(payout.status)) {\n    throw new HttpsError('failed-precondition', `Cannot approve", "  if (!['pending', 'approval_failed', 'outcome_unknown'].includes(payout.status)) {\n    throw new HttpsError('failed-precondition', `Cannot approve"],
      ["    if (!['pending', 'approval_failed'].includes(st)) return;", "    if (!['pending', 'approval_failed', 'outcome_unknown'].includes(st)) return;"],
    ],
    expect: /admin approve refused/ },
  { group: 'payout', name: 'payout: generic manual mark-paid settles an OUTCOME_UNKNOWN payout', file: 'functions/wallet.js', suite: 'payout',
    edits: [
      ["    if (payout.status === 'outcome_unknown') {\n      throw new HttpsError('failed-precondition', 'This payout has an unknown provider outcome", "    if (false) {\n      throw new HttpsError('failed-precondition', 'This payout has an unknown provider outcome"],
      [", refuseStatuses: ['outcome_unknown'],", ","],
    ],
    expect: /generic manual mark-paid refused/ },
  { group: 'payout', name: 'payout: resolution without Super Admin', file: 'functions/wallet.js', suite: 'payout',
    from: "  if (request.auth.token?.superAdmin !== true) throw new HttpsError('permission-denied', 'Super admin only');", to: "",
    expect: /admin \(not super admin\) refused/ },
  { group: 'payout', name: 'payout: resolution without a written evidence note', file: 'functions/wallet.js', suite: 'payout',
    from: "  if (note.length < 20) throw new HttpsError(", to: "  if (false) throw new HttpsError(",
    expect: /note that says nothing refused/ },
  { group: 'payout', name: 'payout: one IntaSend transaction settles two payouts (evidence claim removed)', file: 'functions/wallet.js', suite: 'payout',
    from: "    claimRef: decision === 'paid' ? db.collection('payoutEvidenceClaims').doc(_sha256(reference.toUpperCase())) : null,", to: "    claimRef: null,",
    expect: /same IntaSend transaction cannot settle a second payout/ },
  { group: 'payout', name: 'payout: returned funds settled a second time (terminal guard removed)', file: 'functions/wallet.js', suite: 'payout',
    from: "    if (['rejected', 'failed', 'reversed'].includes(payout.status)) return;\n", to: "",
    expect: /COMPLETE webhook afterwards does not settle|manual mark-paid of a FAILED payout refused/ },

  /* ── security: identity, verification, viewer, analytics (§26) ── */
  { group: 'security', name: 'creator impersonation: anonymous tokens reach creator ops', file: HUB, suite: 'hub',
    from: "if (provider === 'anonymous' && !ANON_OPS.has(op)) fail(", to: "if (false) fail(", expect: /anonymous token refused for creator\.register/ },
  { group: 'security', name: 'anonymous entitlement theft: guest buys while guest checkout is OFF', file: HUB, suite: 'hub',
    from: "if (anonymous && !cfg.guestCheckoutEnabled) fail(", to: "if (false) fail(", expect: /anonymous buyer refused while guest checkout is OFF/ },
  { group: 'security', name: 'forged verification: creator path into APPROVED', file: PUB, suite: 'publishing',
    from: "      DRAFT: ['SUBMITTED'],\n      MORE_INFORMATION_REQUIRED: ['SUBMITTED'],", to: "      DRAFT: ['SUBMITTED', 'APPROVED'],\n      MORE_INFORMATION_REQUIRED: ['SUBMITTED'],",
    expect: /no creator transition INTO APPROVED \/ UNDER_REVIEW/ },
  { group: 'security', name: 'forged verification: account approval mints the VERIFIED projection', file: HUB, suite: 'hub',
    from: "      updatedAt: FieldValue.serverTimestamp() });\n    return { from: s.data().state, to };",
    to: "      ...(to === P.CREATOR_STATE.ACTIVE ? { verification: 'VERIFIED' } : {}), updatedAt: FieldValue.serverTimestamp() });\n    return { from: s.data().state, to };",
    expect: /account approval alone does NOT mint the VERIFIED projection/ },
  { group: 'security', name: 'verification filed FOR another creator (creatorId accepted)', file: PUB, suite: 'publishing',
    from: "const owned = ['status', 'reviewer', 'reviewedAt', 'decisionReason', 'version', 'creatorId',", to: "const owned = ['status', 'reviewer', 'reviewedAt', 'decisionReason', 'version',",
    expect: /verification: server-owned "creatorId" refused/ },
  { group: 'security', name: 'cross-creator analytics: owner filter removed', file: HUB, suite: 'hub',
    from: "const filmsSnap = await _db().collection(COL.FILMS).where('creatorUid', '==', uid).where('creatorHub', '==', true).limit(200).get();",
    to: "const filmsSnap = await _db().collection(COL.FILMS).where('creatorHub', '==', true).limit(200).get();",
    expect: /cross-creator analytics impossible/ },
  { group: 'security', name: "viewer signs out another buyer's device", file: HUB, suite: 'hub',
    from: "if (!s.exists || s.data().uid !== uid) fail('permission-denied', 'Unknown session.');   /* never another buyer's */",
    to: "if (!s.exists) fail('permission-denied', 'Unknown session.');",
    expect: /cannot end another buyer's device session/ },
  { group: 'security', name: 'watch-time inflation: elapsed-time cap removed', file: HUB, suite: 'hub',
    from: "const elapsedSec = Math.max(0, Math.min(60, Math.round((nowMs - Number(sd.lastSeenMs || nowMs)) / 1000)));",
    to: "const elapsedSec = Math.max(0, Math.round((nowMs - Number(sd.lastSeenMs || nowMs)) / 1000));",
    expect: /watch time credits real elapsed time only/ },
  { group: 'security', name: 'rules: any signed-in user reads any verification application', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/creatorVerifications\/\{uid\}\s*\{\s*allow read:[^;]*;/, to: (m) => m.replace(/allow read:[^;]*;/, 'allow read: if isAuthed();'),
    expect: /cross-creator verification read DENIED/ },
  { group: 'security', name: 'rules: cross-participant statement read', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/royaltyStatements\/\{id\}\s*\{\s*allow read:[^;]*;/, to: (m) => m.replace(/allow read:[^;]*;/, 'allow read: if isAuthed();'),
    expect: /cross-participant statement read DENIED/ },
];

const noRules = process.argv.includes('--no-rules');
const onlyGroup = (process.argv.find((a) => a.startsWith('--group=')) || '').slice(8) || null;
const onlyName = (process.argv.find((a) => a.startsWith('--match=')) || '').slice(8) || null;
function run(suite) {
  const [cmd, args] = SUITES[suite];
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 400000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function apply(src, m) {
  const edits = m.edits || [[m.from, m.to]];
  let out = src;
  for (const [from, to] of edits) {
    if (typeof from === 'string') {
      const n = out.split(from).length - 1;
      if (n !== 1) return { error: `anchor found ${n}×: ${from.slice(0, 60)}` };
      out = out.replace(from, to);
    } else {
      const hits = out.match(from);
      if (!hits) return { error: `regex anchor not found: ${from}` };
      out = out.replace(from, typeof to === 'function' ? to : to);
    }
  }
  return { out };
}

const tally = { CAUGHT: 0, 'CAUGHT-OTHER': 0, MISSED: 0, CRASHED: 0, 'NO-ANCHOR': 0, SKIPPED: 0 };
for (const m of M) {
  if ((m.rules && noRules) || (onlyGroup && m.group !== onlyGroup) || (onlyName && !m.name.includes(onlyName))) { tally.SKIPPED++; continue; }
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file);
  const res = apply(orig.toString('utf8'), m);
  if (res.error) { tally['NO-ANCHOR']++; console.log(`  ?  NO-ANCHOR     ${m.name}   [${res.error}]`); continue; }
  let verdict;
  try {
    fs.writeFileSync(file, res.out);
    const r = run(m.suite);
    const failLines = r.out.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
    if (/HARNESS CRASHED|THREW/.test(r.out) && failLines.length === 0) verdict = 'CRASHED';
    else if (r.code === 0) verdict = 'MISSED';
    else if (failLines.some((l) => m.expect.test(l))) verdict = 'CAUGHT';
    else verdict = failLines.length ? 'CAUGHT-OTHER' : 'CRASHED';
    tally[verdict]++;
    const mark = verdict === 'CAUGHT' ? '✓' : verdict === 'CAUGHT-OTHER' ? '~' : '✗';
    console.log(`  ${mark}  ${verdict.padEnd(13)} ${m.name}` + (verdict !== 'CAUGHT' ? `   [${(failLines[0] || r.out.split('\n').slice(-3).join(' ')).trim().slice(0, 110)}]` : ''));
  } finally {
    fs.writeFileSync(file, orig);
  }
}

console.log('\n  post-restore:');
let green = true;
for (const s of ['royalty', 'publishing', 'hub'].concat(noRules ? [] : ['rules']).concat(onlyGroup === 'money' || !onlyGroup ? ['callback', 'refund'] : []).concat(onlyGroup === 'hosted' || !onlyGroup ? ['hosted', 'withdrawal'] : [])) {
  const r = run(s);
  const t = (r.out.match(/\d+ passed, \d+ failed/) || ['?'])[0];
  console.log(`    ${s.padEnd(11)} ${r.code === 0 ? 'GREEN' : 'RED'}  ${t}`);
  if (r.code !== 0) green = false;
}
const clean = spawnSync('git', ['diff', '--quiet', '--', ...new Set(M.map((m) => m.file))], { cwd: ROOT }).status === 0;
console.log(`    tree       ${clean ? 'byte-identical to HEAD for every sabotaged file' : 'DIRTY — restore failed'}`);
console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
const ok = tally.MISSED === 0 && tally.CRASHED === 0 && tally['NO-ANCHOR'] === 0 && green && clean;
process.exit(ok ? 0 : 1);
