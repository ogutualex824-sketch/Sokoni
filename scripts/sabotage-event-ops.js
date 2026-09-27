/* sabotage-event-ops.js — plant each attack the Events operations slice (P1–P6) must stop, run the
 * suite that owns the control, and require the EXPECTED case to go red.
 *
 *   CAUGHT        suite failed, and on the expected case
 *   CAUGHT-OTHER  suite failed, but not on the expected case (counted caught, flagged)
 *   MISSED        suite stayed green — the control is inert
 *   CRASHED       suite crashed — not a detection
 *   NO-ANCHOR     the code to sabotage is gone — the mutation proves nothing
 *
 * A mutation may carry several edits (`edits`), for layered controls where removing one layer alone
 * is correctly still safe. Every file is restored byte-for-byte in `finally`; a post-restore run
 * proves the tree is green again. Run with the worktree QUIESCENT.
 *
 *   node scripts/sabotage-event-ops.js                (all, incl. emulator rules + Chromium)
 *   node scripts/sabotage-event-ops.js --no-rules     (skip emulator mutations)
 *   node scripts/sabotage-event-ops.js --no-browser   (skip Chromium mutations)
 *   node scripts/sabotage-event-ops.js --group=pin    (one group)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITES = {
  ops:      ['node', ['scripts/test-event-ops.js']],
  sales:    ['node', ['scripts/test-event-sales.js']],
  refunds:  ['node', ['scripts/test-event-refunds.js']],
  admin:    ['node', ['scripts/test-event-admin.js']],
  identity: ['node', ['scripts/test-event-ticket-identity.js']],
  credit:   ['node', ['scripts/test-event-credit-notes.js']],
  notify:   ['node', ['scripts/test-event-notifications.js']],
  rules:    ['node', ['scripts/run-entertainment-rules.js']],
  browser:  ['node', ['scripts/test-event-ops-browser.js']],
  transmit: ['node', ['scripts/test-etims-transmission.js']],
  integ:    ['node', ['scripts/test-entertainment-integrations.js']],
  settle:   ['node', ['scripts/test-event-settlement.js']],
  appdec:   ['node', ['scripts/test-application-decision-authority.js']],
  ready:    ['node', ['scripts/test-entertainment-readiness.js']],
  legal:    ['node', ['scripts/test-legal-compliance.js']],
  crules:   ['node', ['scripts/run-creator-rules.js']],
  bkg:      ['node', ['scripts/test-entertainment-bookings.js']],
  avail:    ['node', ['scripts/test-ent-availability.js']],
  comms:    ['node', ['scripts/test-ent-communications.js']],
  journeys: ['node', ['scripts/test-ent-journeys.js']],
  rep:      ['node', ['scripts/test-reputation.js']],
  repb:     ['node', ['scripts/test-reputation-browser.js']],
  share:    ['node', ['scripts/test-share-integrity-browser.js']],
  shopf:    ['node', ['scripts/test-shop-follow.js']],
  shopa:    ['node', ['scripts/test-follow-shop-authority.js']],
};
const OPS = 'functions/event-ops.js';
const SALES = 'functions/event-sales.js';
const RF = 'functions/event-refunds.js';
const ES = 'functions/event-settlement.js';
const EH = 'functions/event-hub.js';
const EA = 'functions/event-admin.js';
const RULES = 'firestore.rules.build';
const UI = 'sokoni-event-ops.js';
const AOS = 'sokoni-aos-entertainment.js';
const FIS = 'functions/event-fiscal.js';
const KAD = 'functions/etims-kra-adapter.js';
const ETM = 'functions/etims.js';
const EH_ = 'functions/event-hub.js';
const EI = 'functions/entertainment-integrations.js';
const CATF = 'sokoni-integration-catalogue.js';
const EIP = 'entertainment-integrations.html';
const FOS = 'functions/financial-os.js';
const CRH = 'functions/creator-hub.js';
const VBK = 'functions/venue-booking.js';
const ENH = 'functions/entertainment-hub.js';
const ENA = 'functions/entertainment-admin.js';
const APL = 'functions/application-lifecycle.js';
const LEG = 'functions/legal-agreements.js';
const HUB = 'entertainment.html';
const STR = 'storage.rules';
const EBK = 'functions/entertainment-bookings.js';
const EBI = 'functions/shared/ent-booking-identity.js';
const PVO = 'functions/provider-ops.js';
const VPY = 'functions/venue-payments.js';
const MSG = 'functions/messages.js';
const BKG = 'functions/booking.js';
const PHB = 'functions/provider-hub.js';
const SSP = 'functions/shared/self-settling-purposes.js';
const FOSF = 'functions/financial-os.js';
const AVX = 'functions/ent-availability.js';
const AVC = 'functions/shared/ent-availability-core.js';
const BSV = 'functions/booking-service.js';
const BPS = 'functions/booking-payment-sweep.js';
const AVJ = 'functions/availability.js';
const EQJ = 'functions/ent-enquiries.js';
const RCJ = 'functions/ent-rate-cards.js';
const REPJ = 'functions/reputation.js';
const REPUI = 'sokoni-reputation.js';
const SHR = 'sokoni-share.js';
const SOC = 'sokoni-social.js';
const PDB = 'provider-dashboard.html';
const PPF = 'provider-profile.html';
const PON = 'functions/provider-onboarding.js';
const MSJ = 'functions/minishop.js';
const MSUI = 'sokoni-minishop.js';
const MSH = 'minishop.html';
const SPUB = 'seller-public.html';
const MIGR = 'scripts/migrate-reputation.js';

const M = [
  /* ── ticket PIN + admission ── */
  { group: 'pin', name: 'PIN hash no longer bound to the event', file: OPS, suite: 'ops',
    from: 'update(`evtpin|${String(eventId)}|${p}`)', to: 'update(`evtpin|${p}`)', expect: /hash binds the PIN to ONE event|event A cannot admit at event B/ },
  { group: 'pin', name: 'missing key falls back to the in-repo test key in Cloud Functions', file: OPS, suite: 'ops',
    from: "  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) fail('failed-precondition', 'Ticket credential key unavailable.');\n", to: '', expect: /fails CLOSED/ },
  { group: 'pin', name: 'wrong-PIN lockout removed (verify + admit)', file: OPS, suite: 'ops', all: true,
    from: "if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');", to: '', expect: /lockout/ },
  { group: 'pin', name: '4-digit guessing throttle loosened to 10 per staff', file: OPS, suite: 'ops',
    from: 'PER_STAFF_FAILS: 5,', to: 'PER_STAFF_FAILS: 10,', expect: /lockout after 5/ },
  { group: 'pin', name: 'a crossed lockout is not recorded as a security event', file: OPS, suite: 'ops',
    from: "  if (r.crossed) await _audit('event_pin_lockout',", to: "  if (false) await _audit('event_pin_lockout',", expect: /security event/ },
  /* ── ticket identity (4-digit PIN + ticket number) ── */
  { group: 'identity', name: 'PIN derived from the ticket number (its last 4 digits)', file: OPS, suite: 'identity',
    from: '  return pins.map((pin, i) => ({ pin, hash: pinHash(eventId, pin), ticketNumber: numbers[i] }));',
    to: '  return numbers.map((n) => { const pin = n.slice(-4); return { pin, hash: pinHash(eventId, pin), ticketNumber: n }; });',
    expect: /300 distinct 4-digit PINs|forced collision|distinct PINs/ },
  { group: 'identity', name: 'create()-and-hope: candidates not READ before use', file: OPS, suite: 'identity',
    from: '    const snaps = await Promise.all(cands.map((v) => txn.get(refOf(v))));', to: '    const snaps = cands.map(() => ({ exists: false }));',
    expect: /forced collision|forced onto candidate|CONCURRENT|retried losers/ },
  { group: 'confirm', name: 'admission on the PIN ALONE (confirmed ticket number not required)', file: OPS, suite: 'identity',
    from: "  if (!TICKET_NUMBER_RE.test(confirmed)) fail('invalid-argument',", to: "  if (false) fail('invalid-argument',", expect: /PIN ALONE/ },
  { group: 'confirm', name: 'a confirmed number that does NOT match the PIN\'s ticket still admits', file: OPS, suite: 'identity',
    from: '    if (_normNumber(t.ticketNumber) !== confirmed) return { mismatch: true, t };\n', to: '', expect: /DIFFERENT ticket number/ },
  { group: 'confirm', name: 'a mismatch is not counted against the guessing limits', file: OPS, suite: 'identity',
    from: '  await _wrongPin(actor);\n  await _audit(\'event_admission_mismatch\'', to: '  await _audit(\'event_admission_mismatch\'', expect: /counted as a wrong attempt|lock the staff/ },
  { group: 'confirm', browser: true, name: 'CONFIRM ADMISSION enabled before the number is confirmed', file: UI, suite: 'browser',
    from: 'id="adAdmit" disabled>CONFIRM ADMISSION', to: 'id="adAdmit">CONFIRM ADMISSION', expect: /stays disabled until confirmed/ },
  { group: 'identity', name: 'no per-event PIN ceiling at ticket configuration', file: EH_, suite: 'identity',
    from: '    if (everConfigured + parsedQty > PIN_CEILING) {', to: '    if (false) {', expect: /beyond 8,000/ },
  { group: 'identity', name: 'admission window ignored (PIN valid any time)', file: OPS, suite: 'identity',
    edits: [{ from: "  if (w.opensAt != null && nowMs < w.opensAt) return 'ISSUED';\n", to: '' }, { from: "  if (w.closesAt != null && nowMs > w.closesAt) return 'EXPIRED';\n", to: '' }],
    expect: /before the window|EXPIRED/ },
  { group: 'identity', name: 'QR check-in bypasses the PIN lifetime (status only)', file: EH_, suite: 'identity',
    from: "    const why = OPS.admissibleReason(t, evs.exists ? evs.data() : actor.event, Date.now());", to: "    const why = t.status !== 'valid' ? 'invalid' : null;",
    expect: /QR path refuses the expired/ },
  { group: 'identity', name: 'a refunded ticket still shows its PIN to the buyer', file: EH_, suite: 'identity',
    from: "  const _valid = tickets.filter((t) => t.status === 'valid' && t.buyerUid === uid);", to: "  const _valid = tickets.filter((t) => t.buyerUid === uid);",
    expect: /refunded ticket shows no PIN/ },
  /* ── fiscal (KRA eTIMS) ── */
  { group: 'fiscal', name: 'an unsubmitted sale shown as KRA-CONFIRMED with an invented receipt', file: FIS, suite: 'identity',
    from: "  if (!f.invoiceId || !inv) return out(FS.PENDING);", to: "  if (!f.invoiceId || !inv) return out(FS.ACCEPTED, { receiptNumber: 'SOKONI-' + f.saleKey });",
    expect: /not yet submitted/ },
  { group: 'fiscal', name: 'a queued invoice shown as KRA-CONFIRMED with an invented receipt', file: FIS, suite: 'identity',
    from: "  return out(FS.PENDING, { invoiceNumber: inv.invoiceNumber || f.invoiceNumber || null });", to: "  return out(FS.ACCEPTED, { receiptNumber: 'SOKONI-' + f.saleKey, invoiceNumber: inv.invoiceNumber || null });",
    expect: /PENDING|no KRA field/ },
  { group: 'fiscal', name: 'a non-https KRA value rendered as an image / link', file: FIS, suite: 'identity',
    from: 'const _https = (u) => (typeof u === \'string\' && /^https:\\/\\/[^\\s"\'<>]+$/.test(u) ? u : null);', to: 'const _https = (u) => u || null;',
    expect: /non-https/ },
  { group: 'fiscal', name: 'free tickets fiscalised (a sale that never happened)', file: FIS, suite: 'identity',
    from: '  if (!(Number(grossCents) > 0)) return false;\n', to: '',
    expect: /zero-value sale is never fiscalised|free tickets → NO fiscal record/ },
  { group: 'fiscal', name: 'failed submissions retried without bound', file: FIS, suite: 'identity',
    from: '    .concat(errs.docs.filter((d) => (Number(d.data().attempts) || 0) < MAX_ATTEMPTS));', to: '    .concat(errs.docs);',
    expect: /bounded/ },
  { group: 'fiscal', name: 'fiscal state gates the ticket (unpaid-to-KRA ticket void)', file: FIS, suite: 'identity',
    from: "  if (f.status === REC.SUBMISSION_ERROR) return out(FS.FAILED, { reason: 'submission_error' });",
    to: "  if (f.status === REC.SUBMISSION_ERROR) { require('firebase-admin/firestore').getFirestore().doc('eventTickets/' + (f.orderId || '_') + '_k0').set({ status: 'void' }, { merge: true }); return out(FS.FAILED, { reason: 'submission_error' }); }",
    expect: /ticket still valid|states are separate/ },
  /* ── credit notes / refund → fiscal linkage (the credit-note slice) ── */
  { group: 'credit', name: 'fake credit-note number stamped when the credit note is built', file: FIS, suite: 'credit',
    from: "    await ref.update({ status: CN.PENDING, creditNoteDocId: res.id,", to: "    await ref.update({ status: CN.PENDING, creditNoteReference: 'CN-' + res.id, creditNoteDocId: res.id,", expect: /carries NO reference|PENDING credit note/ },
  { group: 'credit', name: '"000" without a reference accepted with an invented number', file: KAD, suite: 'credit',
    from: "  if (!rcptNo) return { outcome: 'UNKNOWN', reason: 'accepted_without_reference' };", to: "  if (!rcptNo) return { outcome: 'ACCEPTED', reference: 'SOKONI-CN', data: { qrCodeUrl: 'https://sokoni.fake/qr.png' } };", expect: /WITHOUT a reference/ },
  { group: 'credit', name: 'a timeout treated as a definitive rejection (blind retry)', file: KAD, suite: 'credit',
    from: "  if (!p || p.kind === 'timeout' || p.kind === 'network_error') return { outcome: 'UNKNOWN',", to: "  if (!p || p.kind === 'timeout' || p.kind === 'network_error') return { outcome: 'REJECTED',", expect: /timeout → CREDIT_NOTE_OUTCOME_UNKNOWN/ },
  { group: 'credit', name: 'a 5xx treated as a definitive rejection', file: KAD, suite: 'credit',
    from: "  if (!Number.isFinite(code) || code >= 500) return { outcome: 'UNKNOWN',", to: "  if (!Number.isFinite(code) || code >= 500) return { outcome: 'REJECTED',", expect: /5xx/ },
  /* Two layers refuse it: the explicit UNKNOWN check, and "only a FAILED credit note is retried". The
     first run removed only the first (MISSED — the second still refused). The attack is both. */
  { group: 'credit', name: 'an unknown outcome retried blindly (both refusal layers removed)', file: FIS, suite: 'credit',
    edits: [{ from: "    if (d.status === CN.UNKNOWN) return { error: 'outcome_unknown_needs_evidence' };\n", to: '' },
            { from: '    if (d.status !== CN.FAILED) return { error: `nothing_to_retry_${d.status}` };', to: '    if (d.status !== CN.FAILED && d.status !== CN.UNKNOWN) return { error: `nothing_to_retry_${d.status}` };' }],
    expect: /NOT retried blindly/ },
  { group: 'credit', name: 'evidence resolution may assert ACCEPTED', file: FIS, suite: 'credit',
    from: "  if (resolution !== 'NOT_ACCEPTED') return { error: 'only_not_accepted' };\n", to: '', expect: /resolve it as ACCEPTED/ },
  { group: 'credit', name: 'an ordinary admin resolves an unknown outcome', file: EA, suite: 'credit',
    from: "  if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.');\n  const d = req.data || {};\n  const executionId", to: "  const d = req.data || {};\n  const executionId", expect: /ordinary admin cannot resolve/ },
  { group: 'credit', name: 'no execution claim (concurrent / replayed credit-note execution)', file: FIS, suite: 'credit',
    edits: [{ from: '      if (d.status !== CN.REQUIRED) return null;\n      const c = _ms(d.claimedAt);\n      if (c != null && _now() - c < CLAIM_MS) return null;\n      txn.update(ref, { claimedAt:', to: '      txn.update(ref, { claimedAt:' }],
    expect: /concurrent executions|re-execution|ONE lifecycle document/ },
  { group: 'credit', name: 'ACCEPTED is not terminal (a replayed answer overwrites it)', file: FIS, suite: 'credit',
    from: "    if (d.status !== CN.PENDING) return { skipped: `status_${d.status}`, outcome: c.outcome };\n", to: '', expect: /terminal/ },
  { group: 'credit', name: 'the refund writes onto the ORIGINAL fiscal record', file: FIS, suite: 'credit',
    from: "    return { pending: true, creditNoteDocId: res.id, deduplicated: !!res.deduplicated };", to: "    await db.collection(COL.FISCAL).doc(r.fiscalRecordId).update({ refunded: true, reversedCents: r.refundCents });\n    return { pending: true, creditNoteDocId: res.id, deduplicated: !!res.deduplicated };", expect: /ORIGINAL fiscal record/ },
  { group: 'credit', name: 'credit note reverses the GROSS instead of the approved principal', file: FIS, suite: 'credit',
    from: '      originalGrossCents: f.grossCents, refundCents: amount,', to: '      originalGrossCents: f.grossCents, refundCents: f.grossCents,', expect: /APPROVED principal|1,700|1,600|no-show principal/ },
  { group: 'credit', name: 'a credit note for an organizer NOT on eTIMS (fake reversal of nothing)', file: FIS, suite: 'credit',
    from: "  if (f.status === REC.NOT_REGISTERED) return { skipped: NOT_REQUIRED_REASON.ORGANIZER_NOT_REGISTERED };\n", to: '', expect: /NO credit note/ },
  { group: 'credit', name: 'refund amount substituted by the client', file: 'functions/event-refunds.js', suite: 'credit',
    from: "amountKES: verdict.refundCents / 100, reason: text,", to: "amountKES: Number(d.amountKES) || verdict.refundCents / 100, reason: text,", expect: /forged client amount/ },
  { group: 'credit', name: 'refund bypass: ANY partial settles as if approved', file: 'functions/event-settlement.js', suite: 'credit',
    from: '  const approvedPartial = rq && Number(rq.refundCents) === Number(amountCents) && Number(amountCents) < Number(intent.amountCents);', to: '  const approvedPartial = true;', expect: /mismatched partial/ },
  { group: 'credit', name: 'penalty charged on an organizer-side reason (event cancelled)', file: 'functions/event-refunds.js', suite: 'credit',
    from: "const PENALTY_BASES = new Set(['policy', 'no_show']);", to: "const PENALTY_BASES = new Set(['policy', 'no_show', 'organizer', 'payment']);", expect: /organizer-side reason never carries a penalty/ },
  { group: 'credit', name: 'provider-answer ingress exposed as an AdminOS operation', file: EA, suite: 'credit',
    from: '  eventAdminCreditNoteRetry: creditNoteRetry, eventAdminCreditNoteResolve: creditNoteResolve,', to: '  eventAdminCreditNoteRetry: creditNoteRetry, eventAdminCreditNoteResolve: creditNoteResolve, eventAdminCreditNoteOutcome: (req) => FISCAL.recordCreditNoteOutcome(req.data.executionId, req.data.result),', expect: /not exposed/ },
  { group: 'fiscal', name: 'AdminOS row carries the PIN hash instead of ••••', file: EA, suite: 'identity',
    from: "  if (x.pinHash) out.pinDisplay = '••••';", to: "  if (x.pinHash) out.pinDisplay = x.pinHash;", expect: /••••/ },
  { group: 'pin', name: 'a used ticket admits again (both admission guards removed)', file: OPS, suite: 'ops',
    edits: [{ from: "  if ((t.admissionStatus || 'NOT_ADMITTED') === 'ADMITTED') return 'CONSUMED';\n", to: '' },
            { from: '    if (as.exists) return { already: true, t };\n', to: '' },
            { from: 'txn.create(aRef, {', to: 'txn.set(aRef, {' }],
    expect: /second admission of the same PIN refused|exactly one "admitted"|already admitted/ },
  { group: 'pin', name: 'a ticket with a refund in flight is admitted at the gate', file: OPS, suite: 'ops',
    from: "  if (['REQUESTED', 'APPROVED'].includes(t.refundStatus)) return 'SUSPENDED_REFUND';\n", to: '',
    expect: /refund REQUESTED → refused at the gate|refunded ticket cannot be admitted/ },
  /* ── temporary staff ── */
  { group: 'staff', name: 'staff access never expires', file: OPS, suite: 'ops',
    from: "  if (b == null || nowMs >= b) return { ok: false, why: 'expired' };\n", to: '', expect: /EXPIRES/ },
  { group: 'staff', name: 'admission (gate) staff gain SELL', file: OPS, suite: 'sales',
    from: '  admission: [CAPS.ADMIT],', to: '  admission: [CAPS.ADMIT, CAPS.SELL],', expect: /admission staff cannot sell/ },
  { group: 'staff', name: 'invitation accepted from an UNVERIFIED email', file: OPS, suite: 'ops',
    from: "if (!email || tok.email_verified !== true) fail(", to: 'if (!email) fail(', expect: /UNVERIFIED/ },
  /* ── door sales ── */
  /* 'cash below the total accepted' RETIRED 2026-09-27: cash tender was removed from event sales (owner
     decision). Re-enabling cash at all is the attack now — [conv] 'cash re-enabled for event ticket sales'. */
  { group: 'sales', name: 'another cashier may replay a sale key', file: SALES, suite: 'sales',
    from: 'if (c.actorUid !== actor.uid) fail(', to: 'if (false) fail(', expect: /another cashier cannot reuse the key/ },
  { group: 'sales', name: 'tier availability not checked (oversell)', file: SALES, suite: 'sales',
    from: "    if ((Number(t.quantity) || 0) - (Number(t.sold) || 0) < want) fail(", to: '    if (false) fail(', expect: /exactly 3 succeed|sold out/ },
  { group: 'sales', name: 'door commission priced at the POS rate (5 %) not events (3 %)', file: SALES, suite: 'sales',
    from: "POLICY.commissionCents('event_ticket', { grossCents, providerFeeCents: 0 })", to: "POLICY.commissionCents('pos_till', { grossCents, providerFeeCents: 0 })", expect: /3 %/ },
  { group: 'sales', name: 'release pays the organizer without netting door commission', file: ES, suite: 'sales',
    from: '  for (const r of recs) {', to: '  for (const r of []) {', expect: /nets outstanding door-sale commission|COLLECTED|collects PART/ },
  { group: 'sales', name: 'any cashier reads another cashier\'s walk-in PINs', file: SALES, suite: 'sales',
    from: "if (s.cashierUid !== actor.uid && !actor.caps.includes(OPS.CAPS.VIEW_SALES)) fail('permission-denied', 'Only the cashier who made this sale can see its PINs.');",
    to: '', expect: /another cashier cannot read that sale's PINs/ },
  /* ── refunds ── */
  { group: 'refund', name: 'an ADMITTED ticket refundable for a change of plans', file: RF, suite: 'refunds',
    from: "    if (admitted.length) return { eligible: 'NO', why: 'A ticket in this order was already used to enter the event.' };\n", to: '', expect: /ADMITTED ticket, change of plans → NO/ },
  { group: 'refund', name: 'no-show window never closes', file: RF, suite: 'refunds',
    from: 'if (nowMs > endMs + NO_SHOW_WINDOW_MS) return', to: 'if (false) return', expect: /15 days after the event/ },
  { group: 'refund', name: 'refund policy editable after tickets were sold', file: RF, suite: 'refunds',
    from: "    if ((Number(ev.totalTicketsSold) || 0) > 0) fail('failed-precondition', 'The refund policy is locked: tickets have been sold under it.');\n", to: '', expect: /LOCKED once a ticket has been sold/ },
  { group: 'refund', name: 'a refund can be requested twice', file: RF, suite: 'refunds',
    from: "  if (tickets.some((t) => ['REQUESTED', 'APPROVED', 'REFUNDED'].includes(t.refundStatus))) return { eligible: 'NO', why: 'A refund has already been requested for this order.' };\n", to: '',
    expect: /refund already requested → NO|REFUNDED → NO|cannot be refunded again|second request/ },
  { group: 'refund', name: 'a rejected refund leaves the tickets blocked at the gate', file: ES, suite: 'refunds',
    from: "tix.docs.forEach((d) => { if (d.data().refundStatus === 'REQUESTED') txn.update(d.ref, { refundStatus: 'NONE', refundRejectedAt: FieldValue.serverTimestamp() }); });", to: '',
    expect: /rejected → tickets NONE|admitted again/ },
  /* ── AdminOS investigation ── */
  { group: 'admin', name: 'AdminOS investigation returns the PIN hash', file: EA, suite: 'admin',
    from: "const NEVER = new Set(['pin', 'pinHash', 'token',", to: "const NEVER = new Set(['pin', 'token',", expect: /no pin \/ pinHash/ },
  { group: 'admin', name: 'PIN identity lookup not audited', file: EA, suite: 'admin',
    from: "    await _audit('event_admin_pin_lookup', actor, { eventId }, { found: !!hit, ticketId: hit ? hit.ticketId : null });\n", to: '', expect: /audited/ },
  { group: 'admin', name: 'eventAdmin* admin guard removed', file: EA, suite: 'admin',
    from: "  if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.');\n", to: '', expect: /refused/ },
  { group: 'admin', name: 'trace reports a MISSING payment as observed', file: EA, suite: 'admin',
    from: "stage('payment', payment ? 'observed' : 'empty',", to: "stage('payment', 'observed',", expect: /missing payment record/ },
  { group: 'admin', name: 'buyer phone returned unmasked', file: EA, suite: 'admin',
    from: "    if (/phone|msisdn/i.test(k) && typeof v === 'string') out[k] = maskPhone(v);\n    else ", to: '    ', expect: /phone masked/ },
  /* ── notices + cancellation ── */
  { group: 'notify', name: 'cancelEvent back to ONE batch (500-write cap)', file: EH, suite: 'notify',
    edits: [{ from: 'for (let i = 0; i < ordersSnap.docs.length; i += 400) {', to: 'for (let i = 0; i < ordersSnap.docs.length; i += 1e9) {' },
            { from: 'ordersSnap.docs.slice(i, i + 400)', to: 'ordersSnap.docs.slice(i, i + 1e9)' }],
    expect: /more than one batch can hold|pending_refund/ },
  { group: 'notify', name: 'concurrent cancels both proceed (no in-transaction re-check)', file: EH, suite: 'notify',
    from: "    if (cur.data().status === 'cancelled') throw new HttpsError('failed-precondition', 'Already cancelled');\n", to: '', expect: /concurrent cancels/ },
  { group: 'notify', name: 'a replayed activation re-sends "tickets confirmed"', file: ES, suite: 'notify',
    from: '    if (r && r.alreadyActive) return { alreadyActive: true };\n', to: '', expect: /replayed activation/ },
  { group: 'notify', name: 'cashier walk-in order notifies the cashier as the buyer', file: ES, suite: 'notify',
    from: "if (!o || !o.buyerUid || o.channel === 'cashier') return;", to: 'if (!o || !o.buyerUid) return;', expect: /walk-in/ },
  /* ── served rules (emulator) ── */
  { group: 'rules', rules: true, name: 'buyer may write their own refund request', file: RULES, suite: 'rules',
    from: 'match /eventRefundRequests/{orderId} {\n  allow read:  if isAuthed() && (resource.data.buyerUid == request.auth.uid || isAdmin());\n  allow write: if false;',
    to: 'match /eventRefundRequests/{orderId} {\n  allow read:  if isAuthed() && (resource.data.buyerUid == request.auth.uid || isAdmin());\n  allow write: if isAuthed();',
    expect: /refund request directly|approves own refund request/ },
  { group: 'rules', rules: true, name: 'raw ticket PINs readable by any signed-in user', file: RULES, suite: 'rules',
    from: 'match /eventTicketSecrets/{ticketId} { allow read, write: if false; }', to: 'match /eventTicketSecrets/{ticketId} { allow read: if isAuthed(); allow write: if false; }',
    expect: /RAW ticket PIN|cannot read a raw PIN/ },
  { group: 'rules', rules: true, name: 'organizer may write the fiscal record (fake a KRA confirmation)', file: RULES, suite: 'rules',
    from: 'match /eventFiscal/{saleKey}         { allow read: if isAdmin(); allow write: if false; }', to: 'match /eventFiscal/{saleKey}         { allow read: if isAdmin(); allow write: if isAuthed(); }',
    expect: /fiscally CONFIRMED|fiscal record/ },
  { group: 'rules', rules: true, name: 'client may write the credit-note lifecycle (mark CREDIT_NOTE_ACCEPTED)', file: RULES, suite: 'rules',
    from: 'match /eventFiscalReversals/{executionId} { allow read: if isAdmin(); allow write: if false; }', to: 'match /eventFiscalReversals/{executionId} { allow read: if isAdmin(); allow write: if isAuthed(); }',
    expect: /CREDIT_NOTE_ACCEPTED|credit note to accepted/ },
  { group: 'rules', rules: true, name: 'organizer may mark own door commission COLLECTED', file: RULES, suite: 'rules',
    from: 'match /eventCommissionReceivables/{saleId}  { allow read: if isAdmin(); allow write: if false; }', to: 'match /eventCommissionReceivables/{saleId}  { allow read: if isAdmin(); allow write: if isAuthed(); }',
    expect: /COLLECTED/ },
  /* ── real pages (Chromium) ── */
  { group: 'browser', browser: true, name: 'sale-complete cards drop the sale\'s fiscal state (every ticket "unavailable")', file: UI, suite: 'browser',
    from: '      r.tickets = r.tickets.map((t) => ({ ...t, fiscal: r.fiscal }));\n', to: '', expect: /KRA shows its real status/ },
  { group: 'browser', browser: true, name: 'event-day sections re-mount on the SAME element (stacked listeners)', file: UI, suite: 'browser',
    from: '    const fresh = host.cloneNode(false);\n    host.replaceWith(fresh);\n    RENDER[section](fresh, ctx || {});', to: '    RENDER[section](host, ctx || {});',
    expect: /Admit|same PIN again/ },
  /* Three layers keep a searched PIN off the page: state is cleared, the input is cleared, and the
     form re-render never writes a PIN back. Removing the first two alone leaves the third holding
     (observed: MISSED, 132/0) — a PIN retained only in closure memory is not observable from the
     page, so the attack is all three together. */
  { group: 'browser', browser: true, name: 'AdminOS keeps the searched PIN on the page (all three layers)', file: AOS, suite: 'browser',
    edits: [{ from: "        if (q.by === 'pin') q.value = '';          /* the PIN is not kept in page state */\n", to: '' },
            { from: "      f.value.value = '';\n", to: '' },
            { from: "value=\"${cur.by === 'pin' ? '' : esc(cur.value || '')}\"", to: "value=\"${esc(cur.value || '')}\"" }],
    expect: /not left on the page/ },
  /* ── KRA transmission workers (etims.js) ── */
  { group: 'kra', name: 'invoice worker: no transactional claim (overlapping runs)', file: ETM, suite: 'transmit',
    from: '      if (!cur.exists || cur.data().status !== "pending") return null;\n      t.update(doc.ref, { status: "processing"',
    to: '      if (!cur.exists) return null;\n      t.update(doc.ref, { status: "processing"', expect: /exactly ONE transmission/ },
  { group: 'kra', name: 'credit-note drainer: no transactional claim (concurrent drainers)', file: ETM, suite: 'transmit',
    from: '      if (!cur.exists || cur.data().status !== "pending") return null;\n      t.update(qd.ref, { status: "transmitting"',
    to: '      if (!cur.exists) return null;\n      t.update(qd.ref, { status: "transmitting"', expect: /2 concurrent drainers/ },
  { group: 'kra', name: 'invoice worker retries an AMBIGUOUS outcome (timeout / 5xx treated as rejection)', file: ETM, suite: 'transmit',
    from: '      if (err.kraOutcome === "UNKNOWN") {\n        await doc.ref.update({ status: "outcome_unknown", error: err.message });',
    to: '      if (false) {\n        await doc.ref.update({ status: "outcome_unknown", error: err.message });', expect: /OUTCOME_UNKNOWN|does NOT re-send/ },
  /* Two layers refuse it (the explicit outcome_unknown check, then "only failed / draft"); removing the
     first alone leaves the second holding (observed: MISSED, 43/0), so the attack removes both. */
  { group: 'kra', name: 'requeue accepts an outcome-unknown invoice (both refusal layers removed)', file: ETM, suite: 'transmit',
    edits: [{ from: '  if (inv.status === "outcome_unknown") throw new HttpsError("failed-precondition", "KRA\'s outcome for this invoice is unknown', to: '  if (false) throw new HttpsError("failed-precondition", "KRA\'s outcome for this invoice is unknown' },
            { from: '  if (inv.status !== "failed" && inv.status !== "draft") throw', to: '  if (false) throw' }], expect: /REFUSED/ },
  /* The queue entry AND the invoice are both marked unknown; the worker then refuses an unknown invoice.
     Re-pending only the queue entry leaves the invoice guard holding (observed: MISSED), so the attack
     re-pends the entry and leaves the invoice untouched. */
  { group: 'kra', name: 'a crashed claim is put back to pending (resent although it may have reached KRA)', file: ETM, suite: 'transmit',
    edits: [{ from: '    await d.ref.update({ status: "outcome_unknown", error: "claim expired mid-transmission" });', to: '    await d.ref.update({ status: "pending", error: "claim expired mid-transmission" });' },
            { from: '    await db.collection("etimsInvoices").doc(d.data().invoiceId).update({ status: "outcome_unknown", errorMessage: "transmission interrupted', to: '    if (false) await db.collection("etimsInvoices").doc(d.data().invoiceId).update({ status: "outcome_unknown", errorMessage: "transmission interrupted' }],
    expect: /crashed run/ },
  { group: 'kra', name: 'an ACCEPTED invoice is sent again', file: ETM, suite: 'transmit',
    from: '    if (inv.status === "accepted") { await doc.ref.update({ status:"completed" }); continue; }\n', to: '', expect: /never sent again/ },
  { group: 'kra', name: 'evidence resolution asserts ACCEPTED (a forged acceptance without a KRA receipt)', file: ETM, suite: 'transmit',
    from: '    t.update(ref, { status: "failed", resolution: { resolution: "NOT_ACCEPTED"', to: '    t.update(ref, { status: "accepted", resolution: { resolution: "NOT_ACCEPTED"', expect: /FAILED \(retryable\)/ },
  { group: 'kra', name: 'direct provider call: drainer sends a payload the adapter did not certify', file: ETM, suite: 'transmit',
    from: '    if (!A.isTransmittable(payload)) {', to: '    if (false) {', expect: /NEVER sent with the real adapter/ },
  { group: 'kra', name: 'drainer transmits under another seller\'s KRA identity', file: ETM, suite: 'transmit',
    from: '    try { ({ client } = await clientFor(d.sellerUid)); }', to: '    try { ({ client } = await clientFor("__platform__")); }', expect: /own identity/ },
  { group: 'kra', name: 'fake sandbox success: credit-note builder claims the spec is loaded', file: KAD, suite: 'transmit',
    from: 'SPEC_LOADED = false', to: 'SPEC_LOADED = true', expect: /SPEC_LOADED is false|NEVER sent|blocked/ },

  /* ── Entertainment integrations: status + routing (entertainment-integrations.js) ── */
  { group: 'integ', name: 'organizer A reads organizer B (uid taken from the request)', file: EI, suite: 'integ',
    from: '  const out = await statusFor(req.auth.uid, req.auth.token || {});', to: '  const out = await statusFor((req.data && req.data.uid) || req.auth.uid, req.auth.token || {});', expect: /IGNORED/ },
  { group: 'integ', name: 'the organizer KRA PIN returned unmasked', file: EI, suite: 'integ',
    from: 'kraPinMasked: maskPin(p.kraPin)', to: 'kraPinMasked: p.kraPin', expect: /IGNORED|FULL KRA PIN|masked/ },
  { group: 'integ', name: 'the taxpayer secret leaks into the status response', file: EI, suite: 'integ',
    from: "kraPinMasked: maskPin(p.kraPin), businessName", to: "kraPinMasked: maskPin(p.kraPin), taxpayerSecretEnc: p.taxpayerSecretEnc, businessName", expect: /no taxpayer secret/ },
  { group: 'integ', name: 'fake LIVE: a method marked live WITHOUT evidence shows LIVE', file: EI, suite: 'integ',
    from: "m.status === 'LIVE_AND_PROVEN' && !m.evidence ? STATE.CONFIGURED :", to: "false ? STATE.CONFIGURED :", expect: /WITHOUT evidence/ },
  { group: 'integ', name: 'credit notes shown as enabled while the spec is missing', file: EI, suite: 'integ',
    from: 'creditNoteCapability: { state: KRA.SPEC_LOADED ? STATE.CONFIGURED : STATE.DISABLED', to: 'creditNoteCapability: { state: STATE.CONFIGURED', expect: /credit notes DISABLED/ },
  { group: 'integ', name: 'fake sandbox success on the status card', file: EI, suite: 'integ',
    from: "sandbox: { state: STATE.UNKNOWN,", to: "sandbox: { state: STATE.VERIFIED,", expect: /sandbox UNKNOWN/ },
  { group: 'integ', name: 'the admin investigation read is open to organizers', file: EI, suite: 'integ',
    from: "  if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.');\n", to: '', expect: /admin read/ },
  { group: 'integ', name: 'organizers are handed the AdminOS route', file: EI, suite: 'integ',
    from: '(admin ? c : { ...c, adminRoute: undefined })', to: 'c', expect: /NO admin route/ },
  { group: 'integ', name: 'KRA routed to a new Entertainment config page (second authority)', file: EI, suite: 'integ',
    from: "organizerRoute: '/etims-seller.html'", to: "organizerRoute: '/entertainment-kra-setup.html'", expect: /canonical eTIMS page/ },
  { group: 'integ', name: 'the canonical catalogue claims eTIMS live again', file: CATF, suite: 'integ',
    from: "      status: 'configured', direction: 'bidirectional', hubs: ['entertainment'],", to: "      status: 'live', direction: 'bidirectional', hubs: ['entertainment'],", expect: /no longer claims/ },
  { group: 'integ', name: 'the canonical console ignores the hub filter', file: 'sokoni-integrations.js', suite: 'integ',
    from: '(i.hubs || []).indexOf(_filter.hub) === -1', to: 'false', expect: /filters the catalogue by hub/ },
  { group: 'integ', name: 'duplicate config: the Entertainment page gains a credentials form', file: EIP, suite: 'integ',
    from: '  <div class="grid" id="cards"></div>\n', to: '  <div class="grid" id="cards"></div>\n  <form id="cfg"><input name="apiKey" /></form>\n', expect: /no form/ },
  /* ── whole-hub readiness sweep (2026-09-27) ── */
  { group: 'ready', name: 'organizer authority back on the client-writable users.roles (self-mint)', file: EH, suite: 'settle',
    from: "  const claims = (u && u.customClaims) || {};\n  if (claims.event_organizer !== true)",
    to: "  const claims = { event_organizer: ((await getUser(uid).catch(() => ({}))).roles || []).includes('event_organizer') };\n  if (claims.event_organizer !== true)",
    expect: /SELF-MINT/ },
  { group: 'ready', name: 'a suspended organizer may publish (no re-check on publish)', file: EH, suite: 'settle',
    from: "  await requireOrganizer(uid);\n  if (ev.status === 'live')", to: "  if (ev.status === 'live')", expect: /SUSPENDED/ },
  { group: 'ready', name: 'promo maxUses checked outside the transaction only (over-redemption)', file: EH, suite: 'settle',
    from: "    if (promoCodeId) {\n      const ps = await t.get(", to: "    if (false) {\n      const ps = await t.get(", expect: /G9/ },
  { group: 'ready', name: 'purchase idempotency key global (another buyer\'s order returned)', file: EH, suite: 'settle',
    from: ".doc(`${uid}__${_ik}`)", to: ".doc(_ik)", expect: /G12/ },
  { group: 'ready', name: 'fractional / NaN ticket prices accepted', file: EH, suite: 'settle',
    from: "  if (!Number.isFinite(parsedPrice) || !Number.isInteger(parsedPrice)) throw", to: "  if (false) throw", expect: /G8/ },
  { group: 'ready', name: 'organizer cancels after the event started (refunds from SOKONI funds)', file: EH, suite: 'settle',
    from: "  if (!isAdmin && ev.startDate && new Date(ev.startDate).getTime() <= Date.now()) {", to: "  if (false) {", expect: /G4/ },
  { group: 'ready', name: 'a retained refund penalty is never released (stranded)', file: ES, suite: 'settle',
    from: "    if (!_o || (_o.status !== 'paid' && !_penaltyKept))", to: "    if (!_o || _o.status !== 'paid')", expect: /G3/ },
  { group: 'ready', name: 'event-ticket refund accepted DIRECTLY by fosSubmitRefund (wizard bypass)', file: FOS, suite: 'refunds',
    from: "      if (_fi.exists && _fi.data().purpose === 'event_ticket' && opts.via !== 'event_wizard' && opts.via !== 'event_admin') {", to: "      if (false) {", expect: /DIRECTLY/ },
  { group: 'ready', name: 'cancelled-event refund priced from the REQUEST, not the payment record', file: EA, suite: 'refunds',
    from: "  const amountKES = pay ? Number(pay.amount) : NaN;", to: "  const amountKES = Number(d.amountKES) || (pay ? Number(pay.amount) : NaN);", expect: /PAYMENT RECORD/ },
  { group: 'ready', name: 'forged approval: decidedBy trusted without the server decision record', file: APL, suite: 'appdec',
    edits: [{ from: "  if (!rec) return { ok: false, reason: 'no server decision record — a decision is only made through applicationDecide' };\n", to: '' },
            { from: "  if (rec.status !== canonStatus(after.status) || rec.decidedBy !== by) {", to: "  if (false) {" }],
    expect: /A8|A9/ },
  { group: 'ready', name: 'reconcile applies a status with no server decision (repair = grant)', file: APL, suite: 'ready',
    from: "        const authN = await decisionAuthority(app, d.id);", to: "        const authN = { ok: true, by: req.auth.uid };", expect: /reconcile/ },
  { group: 'ready', name: 'a suspended creator\'s films stay public (no visibility sync)', file: CRH, suite: 'ready',
    from: "  const filmsChanged = await _syncCreatorVisibility(uid, out.to);", to: "  const filmsChanged = 0;", expect: /suspension moves/ },
  { group: 'ready', name: 'catalogue lists films of a non-ACTIVE creator', file: CRH, suite: 'ready',
    from: "films: snap.docs.filter((x) => activeC.has(x.data().creatorUid)).map(", to: "films: snap.docs.map(", expect: /legacy active film/ },
  { group: 'ready', name: 'venue owner lifts their own suspension through venueUpdate', file: VBK, suite: 'ready',
    from: "  if (updates.status !== undefined && !require('./admin-claim').isAdmin(request)) {", to: "  if (false) {", expect: /lift their own suspension/ },
  { group: 'ready', name: 'moderator uid written onto the public venue document', file: ENA, suite: 'ready',
    from: "      status: to, moderatedAt: FieldValue.serverTimestamp(),", to: "      status: to, moderatedBy: actor, moderatedAt: FieldValue.serverTimestamp(),", expect: /moderator's uid/ },
  { group: 'ready', name: 'unlimited ratings (both the prior check and create-once removed)', file: ENH, suite: 'ready',
    edits: [{ from: "    if (prior.exists) throw new HttpsError('already-exists', 'You have already rated this.');\n", to: '' },
            { from: "    t.create(reviewRef, {", to: "    t.set(reviewRef, {" }],
    expect: /cannot rate again/ },
  { group: 'ready', name: 'ratings from viewers with no access', file: ENH, suite: 'ready',
    from: "    if (!has) throw new HttpsError('permission-denied', 'Only viewers who have watched this can rate it.');", to: "", expect: /WITHOUT access/ },
  { group: 'ready', name: 'the Hub page keeps business data in localStorage again', file: HUB, suite: 'ready',
    from: "  const LOADERS = { events: loadEvents, films: loadFilms, mine: () => { loadBookings(); loadEnquiries(); loadMyReviews(); } };", to: "  try { localStorage.setItem('sokoniBookings', '[]'); } catch (_) {}\n  const LOADERS = { events: loadEvents, films: loadFilms, mine: () => { loadBookings(); loadEnquiries(); loadMyReviews(); } };", expect: /localStorage/ },
  { group: 'ready', name: 'acceptance records rewritable (merge over the original signature)', file: LEG, suite: 'legal',
    edits: [{ from: "    if (existing.has(docId)) { alreadyAccepted.push({ agreementId, version }); continue; }\n", to: '' },
            { from: "    batch.create(_db().collection('legalAcceptances').doc(docId), {", to: "    batch.set(_db().collection('legalAcceptances').doc(docId), {" }],
    expect: /unchanged|byte-identical/ },
  { group: 'ready', rules: true, name: 'users.roles may add event_organizer (organizer self-mint, rules layer)', file: RULES, suite: 'rules',
    from: "  return noSelfGrant() && noServerRoleSelfGrant()", to: "  return noSelfGrant()", expect: /self-mint|already holding event_organizer/ },
  { group: 'ready', rules: true, name: 'applicant may write a decisive status / decidedBy (rules layer)', file: RULES, suite: 'rules', all: true,
    from: "noAdminFields() && noApplicationDecision();", to: "noAdminFields();", expect: /status:approved|decidedBy/ },
  { group: 'ready', rules: true, name: 'every signed-in user reads every promo code', file: RULES, suite: 'rules',
    from: "  match /eventPromoCodes/{codeId} {\n  allow read:  if isAdmin();", to: "  match /eventPromoCodes/{codeId} {\n  allow read:  if isAuthed();", expect: /promo code/ },
  { group: 'ready', rules: true, name: 'legacy artist profiles (phone + email) public again', file: RULES, suite: 'rules',
    from: "  match /entArtists/{artistId} {\n  allow read:   if isAdmin() || isOwner();", to: "  match /entArtists/{artistId} {\n  allow read:   if true;", expect: /PII|lists legacy artists/ },
  { group: 'ready', rules: true, name: 'venue owner may write status / rating (rules layer)', file: RULES, suite: 'rules',
    from: ".hasAny(['status','rating','reviewCount','suspendedBy','suspendReason',\n  'ratingSum','ratingDist','followerCount','shareCount','shareHandle','repV','followV','reputationUpdatedAt']));", to: ".hasAny(['suspendedBy']));", expect: /un-suspends|inflates/ },
  { group: 'ready', rules: true, name: 'the superAdmin claim locked out of creator KYC review again', file: STR, suite: 'crules',
    from: "                       || request.auth.token.superAdmin == true\n", to: "", expect: /SUPER ADMIN/ },
  { group: 'ready', browser: true, name: 'Hub event cards link to a non-canonical page', file: HUB, suite: 'browser',
    from: 'href="/event-hub.html?event=${encodeURIComponent(e.eventId)}"', to: 'href="/entertainment.html?event=${encodeURIComponent(e.eventId)}"', expect: /canonical page/ },
  /* ── convergence Slice A: booking identity, PIN, conversation, show-up settlement, venue rail (2026-09-27) ── */
  { group: 'conv', name: 'booking PIN not bound to its booking (cross-booking PIN)', file: EBK, suite: 'bkg',
    from: "  return p ? _key().credentialHash(`entbk|${envId}|${p}`) : null;", to: "  return p ? _key().credentialHash(`entbk|${p}`) : null;", expect: /PIN never verifies booking A/ },
  { group: 'conv', name: 'booking PIN in the TICKET PIN domain (cross-category PIN)', file: EBK, suite: 'bkg',
    from: "  return p ? _key().credentialHash(`entbk|${envId}|${p}`) : null;", to: "  return p ? _key().credentialHash(`evtpin|${envId}|${p}`) : null;", expect: /TICKET PIN hash never equals/ },
  { group: 'conv', name: 'any signed-in user verifies someone else\'s booking', file: EBK, suite: 'bkg',
    from: "  if (!env || env.providerUid !== uid) fail('permission-denied', 'This booking is not one of yours to verify.');", to: "  if (!env) fail('permission-denied', 'This booking is not one of yours to verify.');", expect: /only the booking's provider can verify|buyer cannot verify/ },
  { group: 'conv', name: 'wrong-PIN lockout removed', file: EBK, suite: 'bkg',
    from: "  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');", to: "", expect: /locked out|RIGHT PIN is refused while locked/ },
  { group: 'conv', name: 'a booking PIN verifies again after use / after cancellation', file: EBK, suite: 'bkg',
    from: "    if (st !== ID.PIN_STATE.ACTIVE) return { verified: false, state: st };", to: "    if (false) return { verified: false, state: st };", expect: /used ONCE|cancelled booking is refused|TOO EARLY/ },
  { group: 'conv', name: 'show-up window removed (verify, and get paid, days early)', file: EBI, suite: 'bkg',
    from: "  if (Number.isFinite(startMs) && nowMs < startMs - SHOW_UP_OPENS_MS) return PIN_STATE.NOT_YET;", to: "", expect: /TOO EARLY/ },
  { group: 'conv', name: 'the provider is shown the buyer\'s raw booking PIN', file: EBK, suite: 'bkg',
    from: "buyer: { initials: ID.initials(name) }, pin: env.pin ? '••••' : null,", to: "buyer: { initials: ID.initials(name) }, pin: ((await _db().collection(COL.SECRETS).doc(env.envId).get()).data() || {}).pin || null,", expect: /PROVIDER sees ••••/ },
  { group: 'conv', name: 'a stranger can read any booking', file: EBK, suite: 'bkg',
    from: "  }\n  return null;\n}\n\nasync function mine(req) {", to: "  }\n  return { ..._base(env), role: 'other' };\n}\n\nasync function mine(req) {", expect: /stranger learns nothing|stranger cannot open/ },
  { group: 'conv', name: 'the booking conversation seats someone other than the provider', file: EBK, suite: 'bkg',
    from: "    participants: [env.buyerUid, env.providerUid],", to: "    participants: [env.buyerUid, 'support_bot'],", expect: /parties = the booking's buyer \+ provider/ },
  { group: 'conv', name: 'a client may create a booking conversation (participant substitution)', file: MSG, suite: 'bkg',
    from: "  if (SERVER_ANCHORED.has(transactionType)) {\n    throw new HttpsError('permission-denied', 'This conversation is opened from the booking itself.');\n  }", to: "", expect: /client cannot create an ent_booking conversation/ },
  { group: 'conv', name: 'a venue booking with a forged owner gets an identity', file: EBK, suite: 'bkg',
    from: "    if (!venue || venue.ownerId !== d.ownerId) return { skip: 'owner_mismatch' };", to: "    if (!venue) return { skip: 'owner_mismatch' };", expect: /forged provider/ },
  { group: 'conv', name: 'venue check-in without the booking PIN', file: BKG, suite: 'bkg',
    from: "    await require('./entertainment-bookings').assertVerified('bookings', bookingId);\n", to: "", expect: /cannot check in BEFORE verifying/ },
  { group: 'conv', name: 'the customer checks themselves in', file: BKG, suite: 'bkg',
    from: "    if (booking.ownerId !== uid) {\n      throw new HttpsError('permission-denied','Only the venue can check a booking in.');", to: "    if (booking.ownerId !== uid && booking.customerId !== uid) {\n      throw new HttpsError('permission-denied','Only the venue can check a booking in.');", expect: /CUSTOMER can no longer check themselves in/ },
  { group: 'conv', name: 'show-up settlement credits the PAYER (wallet substitution)', file: PVO, suite: 'bkg',
    from: "  const uid = data.providerId;\n  const m = await _settlementMath(uid, ref, data);", to: "  const uid = data.customerUid;\n  const m = await _settlementMath(uid, ref, data);", expect: /PROVIDER's business wallet|never the buyer/ },
  { group: 'conv', name: 'completion pays AGAIN after a show-up settlement', file: PVO, suite: 'bkg',
    from: "    if (cur.settledTrigger === 'show_up' && cur.paymentStatus === 'settled') {", to: "    if (false) {", expect: /WITHOUT paying again/ },
  { group: 'conv', name: 'the 5 % lane leaks to every provider (commission policy changed)', file: PHB, suite: 'bkg',
    from: "  return { category: 'services', hubId: 'provider', subscriptionRole: 'provider' };", to: "  return { category: 'entertainment_bookings', hubId: 'entertainment', skipMinimum: true };", expect: /NO plan-rate override/ },
  { group: 'conv', name: 'venue release credits the buyer (wallet substitution)', file: VPY, suite: 'bkg',
    from: "    const wRef = db.collection(COL.WALLETS).doc(s.ownerUid);", to: "    const wRef = db.collection(COL.WALLETS).doc(s.customerUid);", expect: /owner's business wallet|never the buyer/ },
  { group: 'conv', name: 'venue refund ignores the venue policy (fee refunded too)', file: VPY, suite: 'bkg',
    from: "amountKES: q.refundKes, reason", to: "amountKES: q.refundKes + q.feeKes, reason", expect: /priced by the policy/ },
  { group: 'conv', name: 'a no-show is paid to the venue before the dispute window', file: VPY, suite: 'bkg',
    from: "    if (due == null || nowMs < due) return 'not_due';", to: "", expect: /NOT paid before end/ },
  { group: 'conv', name: 'venue_booking not self-settling (the webhook credits the payer)', file: SSP, suite: 'bkg',
    from: "'film_access', 'event_ticket', 'venue_booking'", to: "'film_access', 'event_ticket'", expect: /SELF-SETTLING/ },
  { group: 'conv', name: 'direct fosSubmitRefund accepted for a venue payment (refund bypass)', file: FOSF, suite: 'bkg',
    from: "      if (_fi.exists && _fi.data().purpose === 'venue_booking' && opts.via !== 'venue_booking') {", to: "      if (false) {", expect: /DIRECT fosSubmitRefund for a venue payment/ },
  { group: 'conv', name: 'a declined paid booking keeps the customer\'s money', file: PVO, suite: 'bkg',
    from: "  if (data.paymentStatus === 'paid_held') await _disburseHeldFunds(data, ref, { by: 'provider', isNoShow: false });", to: "", expect: /DECLINING a paid booking refunds/ },
  { group: 'conv', name: 'an ordinary admin reads booking conversation content', file: EBK, suite: 'bkg',
    from: "  if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.');\n  const reason = String((req.data || {}).reason || '').trim();", to: "  if (!AC.isAdmin(req)) fail('permission-denied', 'Super admin only.');\n  const reason = String((req.data || {}).reason || '').trim();", expect: /ordinary admin cannot read the conversation content/ },
  { group: 'conv', name: 'a conversation read is not audited', file: EBK, suite: 'bkg',
    from: "  await _db().collection('adminAudit').add({ action: 'ent_conversation_read',", to: "  if (false) await _db().collection('adminAudit').add({ action: 'ent_conversation_read',", expect: /AUDITED/ },
  { group: 'conv', name: 'admission payout credits the BUYER (wallet substitution)', file: ES, suite: 'settle',
    from: "  const wRef = db.collection(COL.WALLETS).doc(s.organizerUid);", to: "  const wRef = db.collection(COL.WALLETS).doc(s.buyerUid || s.organizerUid);", expect: /NEVER the buyer|business wallet/ },
  { group: 'conv', name: 'an admitted ticket settles twice (both guards removed)', file: ES, suite: 'settle',
    edits: [{ from: "      if (done.includes(t.ticketId)) return { skipped: 'already_released' };\n", to: '' },
            { from: "    txn.create(txRef, { uid: s.organizerUid, type: 'event_ticket_earning',", to: "    txn.set(txRef, { uid: s.organizerUid, type: 'event_ticket_earning'," }],
    expect: /never settles twice/ },
  { group: 'conv', name: 'cash re-enabled for event ticket sales', file: SALES, suite: 'sales',
    edits: [{ from: "  if (tender === 'cash') fail('failed-precondition', 'Cash is not accepted for event ticket sales. Take M-PESA through SOKONI, or a card with its terminal reference.');\n", to: '' },
            { from: "const TENDERS = Object.freeze(['card_external', 'intasend']);", to: "const TENDERS = Object.freeze(['cash', 'card_external', 'intasend']);" }],
    expect: /CASH is refused/ },
  { group: 'conv', rules: true, name: 'the provider reads the buyer\'s booking PIN (rules)', file: RULES, suite: 'rules',
    from: "  match /entBookingSecrets/{envId} {\n  allow read:  if isAuthed() && resource.data.buyerUid == request.auth.uid;", to: "  match /entBookingSecrets/{envId} {\n  allow read:  if isAuthed();", expect: /raw booking PIN/ },
  { group: 'conv', rules: true, name: 'a client pre-creates a booking conversation (rules)', file: RULES, suite: 'rules',
    from: "  && !convId.matches('^ent_booking_.*')", to: "", expect: /booking conversation id/ },
  { group: 'conv', rules: true, name: 'the venue owner checks a booking in directly (rules)', file: RULES, suite: 'rules',
    from: "  .hasOnly(['providerNote','updatedAt']));", to: "  .hasOnly(['providerNote','updatedAt','status','checkIn']));", expect: /checked-in directly/ },
  /* ── availability authority · booking engines · communications · rate cards (2026-09-27) ── */
  { group: 'avail', name: 'occupancy ignored (overlapping bookings allowed)', file: AVC, suite: 'avail',
    from: "    if (!touches(c, it)) continue;", to: "    if (true) continue;", expect: /exactly ONE|a 14:00–16:00 booking closes/ },
  { group: 'avail', name: 'buffers ignored (a booking runs into the next one)', file: AVC, suite: 'avail',
    from: "  return (c.s < it.e + iba && c.e > it.s - ibb) || (c.s - c.bb < it.e && c.e + c.ba > it.s);", to: "  return (c.s < it.e && c.e > it.s);", expect: /buffer closes 13:00/ },
  { group: 'avail', name: 'the public slot carries the private reason and items', file: AVC, suite: 'avail',
    from: "    return { start: hhmm(t), end: hhmm(t + cfg.durationMins), state: r.ok ? r.publicState : r.publicState };", to: "    return { start: hhmm(t), end: hhmm(t + cfg.durationMins), state: r.ok ? r.publicState : r.publicState, why: r.code, items };", expect: /exactly \{ start, end, state \}|nothing in the response says/ },
  { group: 'avail', name: 'BOOKING_NOT_OPEN collapsed into UNAVAILABLE', file: AVC, suite: 'avail',
    from: "  if (dayStartMs(date) >= horizonEndMs(cfg, nowMs)) return PUBLIC_STATE.BOOKING_NOT_OPEN;", to: "  if (dayStartMs(date) >= horizonEndMs(cfg, nowMs)) return PUBLIC_STATE.UNAVAILABLE;", expect: /BOOKING_NOT_OPEN/ },
  { group: 'avail', name: 'claim does not evaluate the occupancy (double booking)', file: AVX, suite: 'avail',
    from: "    if (!r.ok) return { ok: false, code: r.code, message: CORE.refusalMessage(r.code) };\n  } else {", to: "  } else {", expect: /exactly ONE/ },
  { group: 'avail', name: 'an unverified artist takes public bookings', file: AVX, suite: 'avail',
    from: "  else if (cp.requiresVerification && category !== 'PROVIDER' && !cls.entClass) code = 'NOT_VERIFIED';", to: "", expect: /UNVERIFIED artist/ },
  { group: 'avail', name: 'Premium settings honoured without the plan (direct write)', file: AVX, suite: 'avail',
    from: "  if (!advanced) {\n    cfg.capacity = 1;", to: "  if (false) {\n    cfg.capacity = 1;", expect: /DIRECTLY without the plan/ },
  { group: 'avail', name: 'Premium settings accepted without the plan (callable)', file: AVX, suite: 'avail',
    from: "  if (used.length && !advanced) fail(", to: "  if (false) fail(", expect: /capacity 2 \(multiple staff\) is refused|730-day horizon is refused/ },
  { group: 'avail', name: 'another provider edits / reads this calendar', file: AVX, suite: 'avail',
    from: "  if (cal.ownerUid !== uid) fail('permission-denied', 'This calendar is not yours.');", to: "", expect: /another provider cannot block/ },
  { group: 'avail', name: 'an ordinary admin sees the provider\'s private labels', file: AVX, suite: 'avail',
    from: "label: _isSuper(req) ? (it.label || null) : undefined", to: "label: it.label || null", expect: /not the provider's private labels/ },
  { group: 'avail', name: 'release_orphan opens a LIVE booking\'s time', file: AVX, suite: 'avail',
    from: "      if (b && !TERMINAL.includes(String(b.status || '').toLowerCase())) fail(", to: "      if (false) fail(", expect: /release_orphan refuses a LIVE/ },
  { group: 'avail', name: 'a reschedule move skips the occupancy check', file: AVX, suite: 'avail',
    from: "  if (!r.ok) return { ok: false, code: r.code, message: CORE.refusalMessage(r.code) };\n  for (const m of fromRec.months)", to: "  for (const m of fromRec.months)", expect: /move onto a BOOKED time is refused|OVERLAPPING booked window is refused/ },
  { group: 'avail', name: 'closing the payment sheet reopens a slot whose STK push is unanswered', file: BPS, suite: 'avail',
    from: "  if (by !== 'intasend-webhook' && await AV.paymentInFlight(bookingId)) return { released: false, reason: 'payment-in-flight' };", to: "", expect: /does NOT release a hold whose STK push/ },
  { group: 'avail', name: 'the expiry timer reopens a slot whose payment may have succeeded', file: BPS, suite: 'avail',
    from: "    if (await AV.paymentInFlight(doc.id)) {", to: "    if (false) {", expect: /expiry timer does not reopen/ },
  { group: 'avail', name: 'a confirmed payment leaves the slot as a hold (never BOOKED)', file: BPS, suite: 'avail',
    from: "      if (avRec) AV.setKind(txn, avRec, avSt, 'B');", to: "", expect: /turns the hold into a BOOKING/ },
  { group: 'avail', name: 'a canonical cancel never reopens the time', file: PVO, suite: 'avail',
    from: "    if (avRec) AV.release(t, avRec, avSt, { cooldown, cooldownMins });", to: "", expect: /AVAILABLE again/ },
  { group: 'avail', name: 'a stale client total is charged (price race)', file: BSV, suite: 'avail',
    from: "    if (expectedTotalCents != null && expectedTotalCents !== finalPrice + fee) { outcome = { conflict: 'price', totalCents: finalPrice + fee }; return; }\n", to: "", expect: /Price changed/ },
  { group: 'avail', name: 'a venue owner self-publishes a new venue', file: BKG, suite: 'avail',
    from: "      venueData.status       = 'pending';", to: "      venueData.status       = data.status || 'active';", expect: /starts pending/ },
  { group: 'avail', name: 'a PAID venue booking is cancelled directly (no refund, slot reopened)', file: BKG, suite: 'avail',
    from: "    if (booking.paymentStatus === 'paid') {\n      throw new HttpsError('failed-precondition', isCustomer ?", to: "    if (false) {\n      throw new HttpsError('failed-precondition', isCustomer ?", expect: /PAID venue booking cannot be cancelled/ },
  { group: 'avail', name: 'the legacy reserveSlot (unpaid confirmed booking) is re-enabled', file: AVJ, suite: 'avail',
    from: "  throw new HttpsError(\"failed-precondition\", \"Book through the provider's booking page.\", { code: \"RETIRED\" });", to: "  return { success: true };", expect: /reserveSlot/ },
  { group: 'avail', name: 'enquiry rate limit removed (unlimited enquiries)', file: EQJ, suite: 'comms',
    from: "    if (bCount >= LIMITS.perBuyerPerDay) fail(", to: "    if (false) fail(", expect: /RATE_LIMITED/ },
  { group: 'avail', name: 'duplicate enquiry suppression removed', file: EQJ, suite: 'comms',
    from: "    if (dd.exists && now - (Number(dd.data().at) || 0) < LIMITS.dedupWindowMs) fail(", to: "    if (false) fail(", expect: /DUPLICATE/ },
  { group: 'avail', name: '"customers with an enquiry" lets a newcomer in', file: EQJ, suite: 'comms',
    from: "  if (who === 'ENQUIRY') return !(await", to: "  if (who === 'ENQUIRY') return true || !(await", expect: /customers with an enquiry/ },
  { group: 'avail', name: 'journey: the show-up settlement pays the BUYER', file: PVO, suite: 'journeys',
    from: "  const uid = data.providerId;\n  const m = await _settlementMath(uid, ref, data);", to: "  const uid = data.customerUid;\n  const m = await _settlementMath(uid, ref, data);", expect: /BUSINESS wallet/ },
  { group: 'avail', name: 'a blocked user still sends public enquiries', file: EQJ, suite: 'comms',
    from: "  if ((await _db().collection(COL.BLOCKS).doc(`${prov.providerUid}_${buyerUid}`).get()).exists) fail('permission-denied', 'You cannot send enquiries to this provider.', { code: 'BLOCKED' });", to: "", expect: /public enquiries from that user are refused/ },
  { group: 'avail', name: 'a template may claim a payment / booking / refund is complete', file: EQJ, suite: 'comms',
    from: "  if (CLAIM_RE.test(text)) return", to: "  if (false) return", expect: /CLAIMS a payment|booking is confirmed or a refund completed/ },
  /* Two layers keep a booking conversation out of the enquiry controls: the caller only gates ent_enquiry,
     and the gate itself returns for anything else (first run: MISSED with one layer removed). Both. */
  { group: 'avail', name: 'enquiry controls gate the PRIVATE booking conversation (strands a paying buyer)', file: EQJ, suite: 'comms',
    edits: [{ from: "  if (!conv || conv.transactionType !== 'ent_enquiry') return;", to: "  if (!conv) return;" }],
    also: { file: MSG, from: "    if (conv.transactionType === 'ent_enquiry') {\n      await require('./ent-enquiries').assertCanSend(", to: "    if (conv.transactionType === 'ent_enquiry' || conv.transactionType === 'ent_booking') {\n      await require('./ent-enquiries').assertCanSend(" },
    expect: /does not strand a paying buyer/ },
  { group: 'avail', name: 'a PRIVATE / segment rate card shown to an ineligible buyer', file: RCJ, suite: 'comms',
    from: "    if (restricted && !(await isEligible(doc.id, c, viewer))) continue;", to: "", expect: /PRIVATE and a CORPORATE segment are invisible/ },
  { group: 'avail', name: 'the browser\'s discount becomes the discount', file: BSV, suite: 'comms',
    from: "      discountCents = cd.discountCents;\n    }\n    const finalPrice", to: "      discountCents = Math.round(Number(d.discountCents) || cd.discountCents);\n    }\n    const finalPrice", expect: /browser "discount"/ },
  { group: 'avail', name: 'an unaccepted quote can be booked (accepting skipped)', file: RCJ, suite: 'comms',
    from: "    if (q.status !== QUOTE.ACCEPTED) fail(", to: "    if (false) fail(", expect: /unaccepted quote cannot be booked/ },
  { group: 'avail', name: 'anyone answers a call request (fake call authorization)', file: EQJ, suite: 'comms',
    from: "    if (c.recipientUid !== uid) fail('permission-denied', 'Only the person asked can answer.');", to: "", expect: /only the provider asked can answer/ },
  { group: 'avail', name: 'an ordinary admin reads enquiry content', file: EQJ, suite: 'comms',
    from: "  if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');\n  const d = req.data || {};\n  const reason = _san(d.reason, 500);\n  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');\n  const id = _san(d.enquiryId, 128);",
    to: "  if (!_isAdmin(req)) fail('permission-denied', 'Super admin only.');\n  const d = req.data || {};\n  const reason = _san(d.reason, 500);\n  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');\n  const id = _san(d.enquiryId, 128);", expect: /content needs a super admin/ },
  { group: 'avail', rules: true, name: 'any signed-in user reads a provider\'s private occupancy (rules)', file: RULES, suite: 'rules',
    from: "  match /months/{month} {\n  allow read:  if isAdmin();", to: "  match /months/{month} {\n  allow read:  if isAuthed();", expect: /private occupancy/ },
  { group: 'avail', rules: true, name: 'a client creates a hold on any venue\'s time (rules)', file: RULES, suite: 'rules',
    from: "  allow read:   if isAdmin() || (isAuthed() && resource.data.userId == request.auth.uid);\n  allow create: if false;", to: "  allow read:   if isAdmin() || (isAuthed() && resource.data.userId == request.auth.uid);\n  allow create: if isAuthed();", expect: /creates a hold on a venue/ },
  { group: 'avail', rules: true, name: 'a client creates an enquiry directly, skipping the limits (rules)', file: RULES, suite: 'rules',
    from: "  match /entEnquiries/{id} {\n  allow read:  if isAdmin() || (isAuthed() && (resource.data.providerUid == request.auth.uid || resource.data.buyerUid == request.auth.uid));\n  allow write: if false;",
    to: "  match /entEnquiries/{id} {\n  allow read:  if isAdmin() || (isAuthed() && (resource.data.providerUid == request.auth.uid || resource.data.buyerUid == request.auth.uid));\n  allow write: if isAuthed();", expect: /creates an enquiry directly|moves the enquiry state/ },
  { group: 'avail', rules: true, name: 'a client pre-creates an enquiry conversation (rules)', file: RULES, suite: 'rules',
    from: "  && !convId.matches('^ent_enquiry_.*')", to: "", expect: /pre-creates an ENQUIRY conversation/ },
  { group: 'avail', rules: true, name: 'every signed-in user lists coupon codes (rules)', file: RULES, suite: 'rules',
    from: "  match /mktCouponCodes/{couponId} {\n  allow read:  if isAdmin() || (isAuthed() && resource.data.merchantId == request.auth.uid);", to: "  match /mktCouponCodes/{couponId} {\n  allow read:  if isAuthed();", expect: /coupon codes/ },
  { group: 'avail', rules: true, name: 'an owner spoofs their public open / closed status (rules)', file: RULES, suite: 'rules',
    from: "  match /availabilityStatus/{uid} {\n  allow read:  if true;\n  allow write: if false;", to: "  match /availabilityStatus/{uid} {\n  allow read:  if true;\n  allow write: if isAuthed() && request.auth.uid == uid;", expect: /spoofs their public open/ },
  { group: 'avail', rules: true, name: 'a client creates a VENUE booking directly (rules)', file: RULES, suite: 'rules',
    from: "  'venueId','ownerId','startTs','endTs','availability','slotKey']);", to: "  'slotKey']);", expect: /creates a VENUE booking directly/ },

  /* ── provider reputation: followers · ratings · reviews · sharing (2026-09-27) ── */
  { group: 'rep', name: 'duplicate follow inflation (idempotency removed)', file: REPJ, suite: 'rep',
    from: "    if (f.exists && f.data().via === 'server') { out = { following: true, followerCount: cur, already: true }; return; }", to: "", expect: /duplicate follow is idempotent/ },
  { group: 'rep', name: 'fake follow for another user (client-sent uid trusted)', file: REPJ, suite: 'rep',
    from: "_h.repFollow = async (req) => {\n  const uid = _need(req);", to: "_h.repFollow = async (req) => {\n  const uid = (req.data && req.data.uid) || _need(req);", expect: /identity spoofing/ },
  { group: 'rep', name: 'negative follower count (floor removed)', file: REPJ, suite: 'rep',
    from: "    const next = Math.max(0, cur - 1);", to: "    const next = cur - 1;", expect: /floors at 0|never goes negative/ },
  { group: 'rep', name: 'a follow marks a legacy owner-written rating as server-derived', file: REPJ, suite: 'rep',
    from: "    txn.set(eRef, { followerCount: Math.max(0, next), followV: REP_VERSION }, { merge: true });", to: "    txn.set(eRef, { followerCount: Math.max(0, next), followV: REP_VERSION, repV: REP_VERSION }, { merge: true });", expect: /PUBLIC aggregate|average of eligible reviews/ },
  { group: 'rep', name: 'fake aggregate: an owner-written rating shown publicly', file: REPJ, suite: 'rep',
    from: "  if (d.repV) {\n    return { rating: d.reviewCount > 0", to: "  if (d.repV || typeof d.rating === 'number') {\n    return { rating: d.reviewCount > 0", expect: /legacy owner-written rating/ },
  { group: 'rep', name: 'fake eligibility: an unfinished booking can be rated', file: REPJ, suite: 'rep',
    from: "    if (!done) return { ok: false, code: 'failed-precondition', why: 'You can review a booking only after it is completed.' };\n  } else if (source === 'bookings') {", to: "  } else if (source === 'bookings') {", expect: /not yet completed cannot be rated/ },
  { group: 'rep', name: 'a refunded booking can be rated', file: REPJ, suite: 'rep',
    from: "    if (['cancelled', 'declined', 'no_show'].includes(b.status) || ['refunded'].includes(b.paymentStatus)) return", to: "    if (['cancelled', 'declined', 'no_show'].includes(b.status)) return", expect: /COMPLETED booking that was refunded/ },
  { group: 'rep', name: 'the review window is ignored', file: REPJ, suite: 'rep',
    from: "  if (end && nowMs > end + POLICY.REVIEW_WINDOW_MS) return", to: "  if (false) return", expect: /60-day window/ },
  { group: 'rep', name: 'forged reviewer: anyone reviews someone else\'s booking', file: REPJ, suite: 'rep',
    from: "    if (b.customerUid !== uid) return { ok: false, code: 'permission-denied', why: 'Not your booking.' };", to: "", expect: /forged reviewer/ },
  { group: 'rep', name: 'forged provider: a venue booking whose owner does not own the venue', file: REPJ, suite: 'rep',
    from: "    if (!v || v.ownerId !== pre.ownerId) fail(", to: "    if (!v) fail(", expect: /forged provider/ },
  { group: 'rep', name: 'duplicate review for the same booking', file: REPJ, suite: 'rep',
    from: "    if (r.exists) { outcome = { alreadyReviewed: true, reviewId }; return; }", to: "", expect: /duplicate review/ },
  { group: 'rep', name: 'self-review', file: REPJ, suite: 'rep',
    from: "  if (ownerUid === uid) fail('permission-denied', 'You cannot review your own business.');", to: "", expect: /self-review is refused/ },
  { group: 'rep', name: 'a fractional / out-of-range rating accepted', file: REPJ, suite: 'rep',
    from: "  if (!(rating >= 1 && rating <= 5) || String(rating) !== String(Number(d.rating))) fail(", to: "  if (false) fail(", expect: /non-integer or out-of-range/ },
  { group: 'rep', name: 'someone else edits a review', file: REPJ, suite: 'rep',
    from: "  if (pre.customerUid !== uid) fail('permission-denied', 'Only the author can edit a review.');", to: "", expect: /nobody else can edit/ },
  { group: 'rep', name: 'response impersonation: another provider replies', file: PVO, suite: 'rep',
    from: "  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your review.');", to: "", expect: /another provider cannot reply/ },
  { group: 'rep', name: 'unauthorized moderation (a non-admin hides reviews)', file: REPJ, suite: 'rep',
    from: "_adminH.repAdminModerate = async (req) => {\n  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');", to: "_adminH.repAdminModerate = async (req) => {", expect: /non-admin cannot moderate/ },
  { group: 'rep', name: 'unauthorized deletion (an ordinary admin removes a review)', file: REPJ, suite: 'rep',
    from: "  if (action === 'remove' && !_isSuper(req)) fail(", to: "  if (false) fail(", expect: /admin cannot REMOVE/ },
  { group: 'rep', name: 'moderation leaves the hidden review in the public rating', file: REPJ, suite: 'rep',
    from: "    if (wasCounted !== counted) _stageAggregate(", to: "    if (false) _stageAggregate(", expect: /HIDE → excluded/ },
  { group: 'rep', name: 'a report changes the rating', file: REPJ, suite: 'rep',
    from: "    txn.update(rRef, { reportCount: _FV().increment(1), lastReportedAt: _FV().serverTimestamp() });", to: "    txn.update(rRef, { reportCount: _FV().increment(1), lastReportedAt: _FV().serverTimestamp() });\n    txn.set(_ref(r.data().entityType || 'provider', r.data().entityId), { rating: 1 }, { merge: true });", expect: /does NOT change the rating/ },
  { group: 'rep', name: 'private follower enumeration (anyone lists followers)', file: REPJ, suite: 'rep',
    from: "  if (ent.ownerUid !== uid) fail('permission-denied', 'Only the profile owner can see its followers.');", to: "", expect: /cannot list a provider's followers/ },
  { group: 'rep', name: 'follower privacy ignored (every follower named)', file: REPJ, suite: 'rep',
    from: "    if (f.showMe !== true) { hidden++; continue; }", to: "", expect: /ONLY followers who opted in/ },
  { group: 'rep', name: 'the public review carries the booking id', file: REPJ, suite: 'rep',
    from: "    .map((r) => ({ id: r.publicId || publicReviewId(r.id),", to: "    .map((r) => ({ id: r.id,", expect: /OPAQUE id|no uid \/ booking id/ },
  { group: 'rep', name: 'share URL leaks the account id', file: REPJ, suite: 'rep',
    from: "  let url = `${BASE_URL}/p.html?h=${encodeURIComponent(h)}`;", to: "  let url = `${BASE_URL}/provider-profile.html?uid=${encodeURIComponent(ent.id)}`;", expect: /HANDLE — no uid/ },
  { group: 'rep', name: 'share-count manipulation (no once-per-day limit)', file: REPJ, suite: 'rep',
    from: "    if (!e.exists || ev.exists) return;\n    txn.create(evRef,", to: "    if (!e.exists) return;\n    txn.set(evRef,", expect: /once per person per day/ },
  { group: 'rep', name: 'a share event counts as a follower', file: REPJ, suite: 'rep',
    from: "    txn.set(eRef, { shareCount: (Number(e.data().shareCount) || 0) + 1 }, { merge: true });", to: "    txn.set(eRef, { shareCount: (Number(e.data().shareCount) || 0) + 1, followerCount: (Number(e.data().followerCount) || 0) + 1 }, { merge: true });", expect: /never moves followers or ratings/ },
  { group: 'rep', rules: true, name: 'a provider edits their own rating / follower count (rules)', file: RULES, suite: 'rules',
    from: "  'rating','reviewCount','ratingSum','ratingDist','followerCount','shareCount','shareHandle','repV','followV','reputationUpdatedAt', 'jobsCompleted']));", to: "  'jobsCompleted']));", expect: /writes their own rating|inflates their own follower count/ },
  { group: 'rep', rules: true, name: 'a client writes a server-counted follow directly (rules)', file: RULES, suite: 'rules', all: true,
    from: "  && !followId.matches('.*--(provider|venue|creator|shop)--.*')", to: "", expect: /PROVIDER follow directly|server-counted follow/ },
  { group: 'rep', rules: true, name: 'a stranger reads provider review records (rules)', file: RULES, suite: 'rules',
    from: "  match /providerReviews/{reviewId} {\n  allow read:  if isAdmin() || (isAuthed() && (resource.data.customerUid == request.auth.uid || resource.data.providerId == request.auth.uid));", to: "  match /providerReviews/{reviewId} {\n  allow read:  if isAuthed();", expect: /stranger reads a provider review/ },
  { group: 'rep', rules: true, name: 'the provider edits / deletes the customer\'s review (rules)', file: RULES, suite: 'rules',
    from: "  match /providerReviews/{reviewId} {\n  allow read:  if isAdmin() || (isAuthed() && (resource.data.customerUid == request.auth.uid || resource.data.providerId == request.auth.uid));\n  allow write: if false;", to: "  match /providerReviews/{reviewId} {\n  allow read:  if isAdmin() || (isAuthed() && (resource.data.customerUid == request.auth.uid || resource.data.providerId == request.auth.uid));\n  allow write: if isAuthed() && resource.data.providerId == request.auth.uid;", expect: /edits the customer's rating|deletes a bad review/ },
  { group: 'rep', rules: true, name: 'moderation data readable by any user (rules)', file: RULES, suite: 'rules',
    from: "  match /reputationAudit/{id} {\n  allow read:  if isAdmin();", to: "  match /reputationAudit/{id} {\n  allow read:  if isAuthed();", expect: /reads the moderation audit/ },
  { group: 'rep', rules: true, name: 'share-count manipulation from the client (rules)', file: RULES, suite: 'rules',
    from: "  match /shareEvents/{id} {\n  allow read:  if isAdmin();\n  allow write: if false;", to: "  match /shareEvents/{id} {\n  allow read:  if isAdmin();\n  allow write: if isAuthed();", expect: /writes a share event/ },
  { group: 'rep', browser: true, name: 'an unknown follower count rendered as 0', file: REPUI, suite: 'repb',
    from: "      followers = s ? s.followerCount : null;", to: "      followers = s ? (s.followerCount || 0) : 0;", expect: /never an invented 0/ },
  { group: 'rep', browser: true, name: 'the share message claims "copied" when nothing left the page', file: REPUI, suite: 'repb',
    from: "      else if (navigator.clipboard) { await navigator.clipboard.writeText(r.url); copied = true; }", to: "      else if (navigator.clipboard) { copied = true; }", expect: /HANDLE link/ },
  { group: 'rep', browser: true, name: 'the Report button is dead (reason select unresolved)', file: REPUI, suite: 'repb',
    from: "        const reason = b.closest(\"details\").querySelector(\"[data-reason]\").value;", to: "        const reason = host.querySelector(`[data-reason=\"${CSS.escape(b.dataset.report)}\"]`).value;", expect: /reports a review with a controlled reason/ },

  /* ── share sheet · share cards · provider share link (2026-09-27, CHANGELOG 210) ── */
  { group: 'share', browser: true, name: 'a product name is parsed as HTML in the share sheet', file: SHR, suite: 'share',
    from: "var meta = el('div'); meta.appendChild(el('p', 'ss-name', name));", to: "var meta = el('div'); var pn = el('p', 'ss-name'); pn.innerHTML = name; meta.appendChild(pn);", expect: /renders as TEXT|nothing executed/ },
  { group: 'share', browser: true, name: 'the share-sheet image accepts any URL scheme', file: SHR, suite: 'share',
    from: "var safeImg = /^(https:\\/\\/|\\/(?!\\/)|assets\\/)/i.test(String(image)) ? String(image) : FALLBACK_IMG;", to: "var safeImg = String(image);", expect: /image falls back to the SOKONI logo|never fetched/ },
  { group: 'share', browser: true, name: 'a caller-supplied rating is drawn on the share card (the hard-coded 5 stars return)', file: SOC, suite: 'share',
    from: "if(!opts||opts.ratingVerified!==true||!isFinite(r)", to: "if(!opts||!isFinite(r)", expect: /draws NO stars|invented stars/ },
  { group: 'share', browser: true, name: 'a rating with no reviews is drawn', file: SOC, suite: 'share',
    from: "||!isFinite(n)||n<1) return null;", to: ") return null;", expect: /no reviews still draws nothing/ },
  { group: 'share', browser: true, name: 'an off-site share URL is accepted on the card', file: SOC, suite: 'share',
    from: "  if(/^https:\\/\\/(www\\.)?mysokoni\\.co\\.ke\\//i.test(u)) return u;", to: "  if(/^https:\\/\\//i.test(u)) return u;", expect: /off-site shareURL is refused/ },
  { group: 'share', browser: true, name: 'the card ignores the caller\'s shareURL (store.html?id=<productId>)', file: SOC, suite: 'share',
    from: "  var u=String((sd&&(sd.url||sd.shareURL))||'');", to: "  var u=String((sd&&sd.url)||'');", expect: /caller's SOKONI shareURL/ },
  { group: 'share', browser: true, name: 'the share link carries the provider uid', file: REPJ, suite: 'share',
    from: "  let url = `${BASE_URL}/p.html?h=${encodeURIComponent(h)}`; let title = ent.name;", to: "  let url = `${BASE_URL}/provider-profile.html?uid=${encodeURIComponent(ent.id)}`; let title = ent.name;", expect: /HANDLE link/ },
  { group: 'share', browser: true, name: 'the handle lands on a uid address', file: REPJ, suite: 'share',
    from: "  const path = type === 'provider' ? `/provider-profile.html?h=${encodeURIComponent(h)}${sv}`", to: "  const path = type === 'provider' ? `/provider-profile.html?uid=${encodeURIComponent(id)}${sv}`", expect: /lands by handle/ },
  { group: 'share', browser: true, name: 'the public profile cannot open a handle link (dead link)', file: PPF, suite: 'share',
    from: "    if (!uid && handle) return resolveHandle();\n", to: "", expect: /identity · verified|offering · availability/ },
  { group: 'share', browser: true, name: 'the provider QR goes back to the uid address', file: PON, suite: 'share',
    from: "  const { url: qrData } = await require('./reputation').shareLink({ type: 'provider', id: uid, serviceId });", to: "  const qrData = `https://mysokoni.co.ke/provider-profile.html?uid=${uid}`;", expect: /QR/ },
  { group: 'share', browser: true, name: 'the dashboard share link goes back to /providers?p= (read by no page)', file: PDB, suite: 'share',
    from: "    try{const r=await SokoniRep.share({type:'provider',id:u.uid,serviceId:id||undefined,title:s?s.name:undefined});", to: "    try{const pid=(_data&&_data.profile&&_data.profile.providerId)||'PRV-X';const url=location.origin+'/providers?p='+encodeURIComponent(pid)+(id?'&s='+encodeURIComponent(id):'');await navigator.clipboard.writeText(url);const r={copied:true,url};", expect: /dashboard Share makes a HANDLE link/ },

  /* ── MiniShop follows: ONE authority (CHANGELOG 211) ── */
  { group: 'shopfollow', name: 'a shop owner follows their own shop (count self-inflation)', file: REPJ, suite: 'shopa',
    from: "  if (ent.ownerUid === uid) fail('failed-precondition', 'You cannot follow your own profile.');", to: "", expect: /can NOT follow their own shop/ },
  { group: 'shopfollow', name: 'the shop owner is taken from the doc id, not shops.sellerUid (owner check bypassed)', file: REPJ, suite: 'shopa',
    from: "    owner: (id, d) => d.sellerUid || d.ownerUid || d.ownerId || id, name: (d) => d.name || d.storeName || d.businessName },", to: "    owner: (id) => id, name: (d) => d.name || d.storeName || d.businessName },", expect: /can NOT follow their own shop/ },
  { group: 'shopfollow', name: 'duplicate shop follow inflation (a second key for the same shop by owner uid)', file: REPJ, suite: 'shopf',
    from: "    if (q.size === 1) { s = q.docs[0]; id = s.id; }", to: "    if (q.size === 1) { s = q.docs[0]; }", expect: /ONE canonical shop|OWNER uid/ },
  { group: 'shopfollow', name: 'unfollow by owner uid misses the canonical record (count never decreases)', file: REPJ, suite: 'shopf',
    from: "  if (!_idOk(d.id)) fail('invalid-argument', 'Unknown profile.');\n  const id = await _canonId(type, d.id);\n  const fRef = _db().collection(COL.FOLLOWS).doc(followId(uid, type, id));\n  const eRef = _ref(type, id);\n  const eSnap = await eRef.get();", to: "  if (!_idOk(d.id)) fail('invalid-argument', 'Unknown profile.');\n  const id = String(d.id);\n  const fRef = _db().collection(COL.FOLLOWS).doc(followId(uid, type, id));\n  const eRef = _ref(type, id);\n  const eSnap = await eRef.get();", expect: /unfollow by that uid/ },
  { group: 'shopfollow', name: 'the retired followShop writes its second store again', file: MSJ, suite: 'shopa',
    from: "    const following = !!r.following; const followerCount = typeof r.followerCount === 'number' ? r.followerCount : null;\n", to: "    const following = !!r.following; const followerCount = typeof r.followerCount === 'number' ? r.followerCount : null;\n    await _db().collection('shopFollowers').doc(`${shopId}_${uid}`).set({ shopId, uid });\n", expect: /no legacy shopFollowers|no longer writes shopFollowers/ },
  { group: 'shopfollow', name: 'the public storefront shows the retired minishopConfig counter', file: MSJ, suite: 'shopf',
    from: "        followerCount: _shopFollowers(shopRaw),\n", to: "        followerCount: configRaw.followerCount,\n", expect: /UNKNOWN|AUTHORITY's count/ },
  { group: 'shopfollow', name: 'an unknown follower count becomes 0 on the public storefront', file: MSJ, suite: 'shopf',
    from: "      const followerCount = config.followerCount;   /* null = unknown, rendered \"—\" — never an invented 0 */", to: "      const followerCount = config.followerCount ?? 0;", expect: /UNKNOWN/ },
  { group: 'shopfollow', name: 'a stale owner-era followerCount leaks through the shop doc', file: MSJ, suite: 'shopf',
    from: "      if (_shopFollowers(shopRaw) === null) delete shop.followerCount;\n", to: "", expect: /UNKNOWN/ },
  { group: 'shopfollow', name: 'owner analytics reads the retired counter', file: MSJ, suite: 'shopf',
    from: "    const followerCount = _shopFollowers(shopData);   /* the reputation authority's count, or null */", to: "    const followerCount = ((await db.collection('minishopConfig').doc(shopId).get()).data() || {}).followerCount ?? 0;", expect: /getMinishopAnalytics/ },
  { group: 'shopfollow', browser: true, name: 'the storefront Follow button sends the opposite operation', file: MSUI, suite: 'shopf',
    from: "op: wasFollowing ? 'repUnfollow' : 'repFollow'", to: "op: wasFollowing ? 'repFollow' : 'repUnfollow'", expect: /signed-in Follow/ },
  { group: 'shopfollow', browser: true, name: 'the storefront loads no auth (every shopper sent to sign-in)', file: MSH, suite: 'shopf',
    from: "<script src=\"/firebase.js\" type=\"module\"></script>\n", to: "", expect: /signed-in Follow/ },
  { group: 'shopfollow', browser: true, name: 'the seller page follows by DISPLAY NAME again', file: SPUB, suite: 'shopf',
    from: "  const _spShopKey = sellerId || window._spSellerUid || '';", to: "  const _spShopKey = sellerId || window._spSellerUid || sellerName;", expect: /NAME-only seller link offers no Follow/ },
  { group: 'shopfollow', name: 'migration guesses an AMBIGUOUS shop name', file: MIGR, suite: 'shopf',
    from: "    if (hits.length > 1) { out.ambiguous.push({ follow: f.id, name: d.entityName || d.entityId, shops: hits.length }); continue; }\n", to: "", expect: /REPORTED, never guessed|nothing for the ambiguous/ },
  { group: 'shopfollow', name: 'migration carries an owner\'s self-follow', file: MIGR, suite: 'shopf',
    from: "    if (_shopOwner(shopId, sd) === uid) { out.self.push({ from, shopId }); return false; }\n", to: "", expect: /REPORTED, never guessed|nothing for the ambiguous/ },
  { group: 'shopfollow', name: 'migration DRY RUN writes', file: MIGR, suite: 'shopf',
    from: "    if (!o.apply) return true;\n    const ref = db.collection('follows').doc(_fid(uid, 'shop', shopId));", to: "    const ref = db.collection('follows').doc(_fid(uid, 'shop', shopId));", expect: /DRY RUN/ },
  { group: 'shopfollow', rules: true, name: 'a client writes a SHOP follow directly (rules)', file: RULES, suite: 'rules', all: true,
    from: "followId.matches('.*--(provider|venue|creator|shop)--.*')", to: "followId.matches('.*--(provider|venue|creator)--.*')", expect: /SHOP follow/ },
  { group: 'shopfollow', rules: true, name: 'a shop owner writes their follower count (rules)', file: RULES, suite: 'rules',
    from: "  'packagingNote','delMethod','delTime','zones','updatedAt']));", to: "  'packagingNote','delMethod','delTime','zones','updatedAt','followerCount']));", expect: /shop owner inflates/ },
];

const argv = process.argv.slice(2);
const noRules = argv.includes('--no-rules');
const noBrowser = argv.includes('--no-browser');
const onlyGroup = (argv.find((a) => a.startsWith('--group=')) || '').slice(8) || null;
const onlyName = (() => { const v = (argv.find((x) => x.startsWith('--only=')) || '').slice(7); return v ? new RegExp(v, 'i') : null; })();   /* re-run named attacks */

function run(suite) {
  const [cmd, args] = SUITES[suite];
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function apply(src, m) {
  const edits = m.edits || [{ from: m.from, to: m.to }];
  let out = src;
  for (const e of edits) {
    const n = out.split(e.from).length - 1;
    if (n === 0 || (n > 1 && !m.all)) return { error: `anchor found ${n}×: ${e.from.slice(0, 60)}` };
    out = out.split(e.from).join(e.to);
  }
  return { out };
}

/* Every sabotaged file's exact bytes BEFORE the run: the proof of restoration does not depend on what
   is committed (a slice can be verified before its single commit). */
/* `also` (optional): a SECOND file mutated together with the first — for a defence that is layered across two
   files, where removing either layer alone is (correctly) not a vulnerability. Hashed and restored like the first. */
const BEFORE = new Map([...new Set(M.flatMap((m) => (m.also ? [m.file, m.also.file] : [m.file])))].map((f) => [f, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')]));
const tally = { CAUGHT: 0, 'CAUGHT-OTHER': 0, MISSED: 0, CRASHED: 0, 'NO-ANCHOR': 0, SKIPPED: 0 };
const used = new Set();
for (const m of M) {
  if ((m.rules && noRules) || (m.browser && noBrowser) || (onlyGroup && m.group !== onlyGroup) || (onlyName && !onlyName.test(m.name))) { tally.SKIPPED++; continue; }
  used.add(m.suite);
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file);
  /* CRLF files: match the anchors in the file's own line endings. */
  const crlf = orig.includes(Buffer.from('\r\n'));
  const fix = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  const mm = { ...m, from: m.from && fix(m.from), to: m.to != null ? fix(m.to) : m.to, edits: m.edits && m.edits.map((e) => ({ from: fix(e.from), to: fix(e.to) })) };
  const res = apply(orig.toString('utf8'), mm);
  if (res.error) { tally['NO-ANCHOR']++; console.log(`  ?  NO-ANCHOR     ${m.name}   [${res.error}]`); continue; }
  let file2 = null, orig2 = null, res2 = null;
  if (m.also) {
    file2 = path.join(ROOT, m.also.file); orig2 = fs.readFileSync(file2);
    const crlf2 = orig2.includes(Buffer.from('\r\n'));
    const fix2 = (s) => (crlf2 ? s.replace(/\r?\n/g, '\r\n') : s);
    res2 = apply(orig2.toString('utf8'), { from: fix2(m.also.from), to: fix2(m.also.to) });
    if (res2.error) { tally['NO-ANCHOR']++; console.log(`  ?  NO-ANCHOR     ${m.name} (also)   [${res2.error}]`); continue; }
  }
  let verdict;
  try {
    fs.writeFileSync(file, res.out);
    if (file2) fs.writeFileSync(file2, res2.out);
    const r = run(m.suite);
    /* suites mark a failed check as "FAIL" or "✗" (test-legal-compliance) — both are detections */
    const failLines = r.out.split('\n').filter((l) => /^\s+(FAIL|✗)\s/.test(l));
    if (/HARNESS CRASHED|^CRASH/m.test(r.out) && failLines.length === 0) verdict = 'CRASHED';
    else if (r.code === 0) verdict = 'MISSED';
    else if (failLines.some((l) => m.expect.test(l))) verdict = 'CAUGHT';
    else verdict = failLines.length ? 'CAUGHT-OTHER' : 'CRASHED';
    tally[verdict]++;
    const mark = verdict === 'CAUGHT' ? '✓' : verdict === 'CAUGHT-OTHER' ? '~' : '✗';
    console.log(`  ${mark}  ${verdict.padEnd(13)} [${m.group}] ${m.name}` + (verdict !== 'CAUGHT' ? `   [${(failLines[0] || r.out.split('\n').slice(-3).join(' ')).trim().slice(0, 140)}]` : ''));
  } finally {
    fs.writeFileSync(file, orig);
    if (file2) fs.writeFileSync(file2, orig2);
  }
}

console.log('\n  post-restore:');
let green = true;
for (const s of used) {
  const r = run(s);
  const t = (r.out.match(/\d+ passed, \d+ failed/) || ['?'])[0];
  console.log(`    ${s.padEnd(9)} ${r.code === 0 ? 'GREEN' : 'RED'}  ${t}`);
  if (r.code !== 0) green = false;
}
const changed = [...BEFORE].filter(([f, h]) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex') !== h).map(([f]) => f);
const clean = changed.length === 0;
console.log(`    tree      ${clean ? 'byte-identical to the pre-run content for every sabotaged file (sha-256)' : 'DIRTY — restore failed: ' + changed.join(', ')}`);
console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
const ok = tally.MISSED === 0 && tally.CRASHED === 0 && tally['NO-ANCHOR'] === 0 && green && clean;
process.exit(ok ? 0 : 1);
