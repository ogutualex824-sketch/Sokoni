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
  bcast:    ['node', ['scripts/test-seller-broadcast.js']],
  hubrev:   ['node', ['scripts/test-hub-reviews.js']],
  payer:    ['node', ['scripts/test-webhook-payer-credit.js']],
  integrity: ['node', ['scripts/test-money-integrity.js']],
  gateway:  ['node', ['scripts/test-sokoni-pay-gateway.js']],
  support:  ['node', ['scripts/test-in-app-support.js']],
  inapp:    ['node', ['scripts/test-in-app-booking-contact.js']],
  legal:    ['node', ['scripts/test-legal-in-app.js']],
  legalv:   ['node', ['scripts/test-legal-verification.js']],
  legalvrules: ['node', ['scripts/run-rules-suite.js', 'scripts/test-legal-verification-rules.js']],
  hcreq:    ['node', ['scripts/run-rules-suite.js', 'scripts/test-healthcare-request-rules.js']],
  hcadm:    ['node', ['scripts/test-healthcare-admin-authority.js']],
  hcclin:   ['node', ['scripts/test-healthcare-clinical-authority.js']],
  hcclinrules: ['node', ['scripts/run-rules-suite.js', 'scripts/test-healthcare-clinical-rules.js']],
  hcpub:    ['node', ['scripts/test-healthcare-public-projection.js']],
  posown:   ['node', ['scripts/test-pos-gate-behavioural.js']],
  hcplan:   ['node', ['scripts/test-healthcare-plan-commission.js']],
  hccat:    ['node', ['scripts/test-healthcare-category.js']],
  hccatrules: ['node', ['scripts/run-rules-suite.js', 'scripts/test-provider-identity-fields-rules.js']],
  hcdir:    ['node', ['scripts/test-healthcare-directory.js']],
  msgpart:  ['node', ['scripts/test-messages-participant-authority.js']],
  convrules: ['node', ['scripts/run-rules-suite.js', 'scripts/test-conversation-create-rules.js']],
  entcomms: ['node', ['scripts/test-ent-communications.js']],
  hcconv:   ['node', ['scripts/test-healthcare-conversations.js']],
  hcenq:    ['node', ['scripts/test-healthcare-enquiries.js']],
  hcws:     ['node', ['scripts/test-healthcare-workspace.js']],
  hcavail:  ['node', ['scripts/test-healthcare-availability.js']],
  hcavailrules: ['node', ['scripts/run-rules-suite.js', 'scripts/test-healthcare-availability-rules.js']],
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
const MV3 = 'functions/minishop-v3.js';
const NTF = 'functions/notify.js';
const IDX = 'functions/index.js';
const SCRJ = 'script.js';
const HCH = 'functions/healthcare-hub.js';
const LGH = 'functions/legal-hub.js';
const DGH = 'functions/digital-hub.js';
const HRT = 'functions/shared/hub-rating.js';
const RVJ = 'functions/reviews.js';
const UBX = 'unboxing.html';
const SPV = 'sports-venue.html';
const HSV = 'home-services.html';

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

  /* ── seller broadcast identity (CHANGELOG 212) ── */
  { group: 'broadcast', name: 'cross-seller broadcast: a forged shopId is not ownership-checked', file: MV3, suite: 'bcast',
    from: "  if (shopId) return { shopId, shop: await _assertShopOwner(shopId, uid) };", to: "  if (shopId) return { shopId, shop: (await _db().collection('shops').doc(shopId).get()).data() || {} };", expect: /forged shopId/ },
  { group: 'broadcast', name: 'forged sender name: the payload\'s name reaches followers', file: MV3, suite: 'bcast',
    from: "  const shopName = _san(shop.name || shop.storeName || 'A shop you follow', 80);", to: "  const shopName = _san((request.data || {}).sellerName || shop.name || shop.storeName || 'A shop you follow', 80);", expect: /SHOP RECORD|shop record says/i },
  { group: 'broadcast', name: 'forged link / logo: the caller\'s URL becomes the destination', file: MV3, suite: 'bcast',
    from: "  const deepLink = cfg.handle ?", to: "  const deepLink = (request.data || {}).url || (request.data || {}).logo ? String((request.data || {}).url) : cfg.handle ?", expect: /destination is the shop's own page/ },
  { group: 'broadcast', name: 'the owner is in the audience of their own announcement', file: MV3, suite: 'bcast',
    from: ".filter((u) => u && u !== uid)", to: ".filter(Boolean)", expect: /not the owner/ },
  { group: 'broadcast', name: 'unlimited broadcasts (no daily limit)', file: MV3, suite: 'bcast',
    from: "    if (used >= ANNOUNCE_MAX_PER_DAY) throw", to: "    if (false) throw", expect: /exactly 3|4th send/ },
  { group: 'broadcast', name: 'the rate limit is checked outside the transaction (race)', file: MV3, suite: 'bcast',
    from: "    const c = await tx.get(counterRef);", to: "    const c = await counterRef.get();", expect: /exactly 3/ },
  { group: 'broadcast', name: 'an ambiguous multi-shop seller is guessed (first shop)', file: MV3, suite: 'bcast',
    from: "  if (q.size === 1) return { shopId: q.docs[0].id, shop: q.docs[0].data() };", to: "  if (q.size >= 1) return { shopId: q.docs[0].id, shop: q.docs[0].data() };", expect: /ambiguous/ },
  { group: 'broadcast', name: 'a suspended shop can broadcast', file: MV3, suite: 'bcast',
    from: "  if (shop.suspended === true || ['suspended', 'banned', 'closed', 'deleted'].includes(String(shop.status || '').toLowerCase())) {", to: "  if (false) {", expect: /suspended shop cannot broadcast/ },
  { group: 'broadcast', name: 'shop announcements bypass the opt-in channel (sent as critical)', file: NTF, suite: 'bcast',
    from: "  shop_announcement:    { priority: 'marketing', category: 'promotions', smsTemplate: null },", to: "  shop_announcement:    { priority: 'critical', category: 'promotions', smsTemplate: null },", expect: /opt-in promotions/ },
  { group: 'broadcast', name: 'the legacy name-keyed trigger sends again', file: IDX, suite: 'bcast',
    from: "    const data = (event.data && event.data.data()) || {};\n", to: "    const data = (event.data && event.data.data()) || {};\n    await admin.messaging().sendEachForMulticast({ tokens: ['t1'], notification: { title: data.title || '' } });\n", expect: /NO FCM sent/ },
  { group: 'broadcast', name: 'the XSS-prone name-keyed listener is re-enabled', file: SCRJ, suite: 'bcast',
    from: "       the shop's identity from its record. */\n    return;\n", to: "       the shop's identity from its record. */\n", expect: /listener .* is inert/ },
  { group: 'broadcast', rules: true, name: 'unauthorized broadcast: a client writes sellerBroadcasts again (rules)', file: RULES, suite: 'rules',
    from: "  allow read:   if isAdmin();\n  allow create: if false;\n  allow delete: if isAdmin();\n  }\n  match /landlordProperties", to: "  allow read:   if isAdmin();\n  allow create: if isAuthed() && request.resource.data.sellerUid == request.auth.uid;\n  allow delete: if isAdmin();\n  }\n  match /landlordProperties", expect: /broadcasts AS another shop|cannot write a broadcast/ },
  { group: 'broadcast', rules: true, name: 'legacy forged broadcasts readable by every user again (rules)', file: RULES, suite: 'rules',
    from: "  match /sellerBroadcasts/{sellerName}/broadcasts/{broadcastId} {\n  allow read:   if isAdmin();", to: "  match /sellerBroadcasts/{sellerName}/broadcasts/{broadcastId} {\n  allow read:   if isAuthed();", expect: /reads legacy broadcast/ },

  /* ── hub review stores (CHANGELOG 213) ── */
  { group: 'hubreviews', name: 'health: the patient marks their own appointment completed (self-asserted eligibility)', file: HCH, suite: 'hubrev',
    from: "    if (status !== 'cancelled' && !isProviderSide) {", to: "    if (false) {", expect: /PATIENT can no longer/ },
  { group: 'hubreviews', name: 'health: a forged providerId is rated (one appointment rates ANY provider)', file: HCH, suite: 'hubrev',
    edits: [{ from: "    if (req.data.providerId && req.data.providerId !== appt.providerId) throw new HttpsError('permission-denied', 'This appointment was with a different provider.');\n", to: "" },
            { from: "    const ref = db().collection('healthProviders').doc(String(appt.providerId));", to: "    const ref = db().collection('healthProviders').doc(String(req.data.providerId || appt.providerId));" }], expect: /forged providerId/ },
  { group: 'hubreviews', name: 'health: an appointment is rated twice', file: HCH, suite: 'hubrev',
    from: "    if (appt.rated) throw new HttpsError('already-exists', 'Already rated');\n    if (req.data.providerId", to: "    if (req.data.providerId", expect: /second rating|CONCURRENT/ },
  { group: 'hubreviews', name: 'health: a provider rates themselves', file: HCH, suite: 'hubrev',
    from: "    if (appt.providerId === uid) throw new HttpsError('permission-denied', 'You cannot rate yourself.');\n", to: "", expect: /cannot rate themselves/ },
  { group: 'hubreviews', name: 'any number is a rating (4.5, 0, 6, "abc")', file: HRT, suite: 'hubrev',
    from: "  if (!Number.isInteger(n) || n < 1 || n > 5) throw", to: "  if (false) throw", expect: /is refused/ },
  { group: 'hubreviews', name: 'the aggregate is a rounded running average (drift) — not sum / count', file: HRT, suite: 'hubrev',
    from: "  const prevSum = Number.isFinite(Number(d && d.ratingSum)) ? Number(d.ratingSum)\n    : ", to: "  const prevSum = false ? 0\n    : ", expect: /SUM is kept exactly|sum \/ count/ },
  { group: 'hubreviews', name: 'legal: the client completes their own consultation', file: LGH, suite: 'hubrev',
    from: "  if (status !== 'cancelled' && c.providerId !== uid && !isAdm) {", to: "  if (false) {", expect: /CLIENT can no longer/ },
  { group: 'hubreviews', name: 'legal: a forged providerId is accepted', file: LGH, suite: 'hubrev',
    from: "    if (providerId && providerId !== c.providerId) throw new HttpsError('permission-denied', 'This consultation was with a different provider.');\n", to: "", expect: /forged providerId/ },
  { group: 'hubreviews', name: 'digital: an UNPAID purchase rates a product', file: DGH, suite: 'hubrev',
    from: "    if (pur.status !== 'completed') throw new HttpsError('failed-precondition', 'Only a paid purchase can be rated.');\n", to: "", expect: /UNPAID/ },
  { group: 'hubreviews', name: 'digital: one purchase rates ANY product', file: DGH, suite: 'hubrev',
    edits: [{ from: "    if (productId && productId !== pur.productId) throw new HttpsError('permission-denied', 'This purchase is for a different product.');\n", to: "" },
            { from: "    const productRef = db().collection('digitalProducts').doc(String(pur.productId));", to: "    const productRef = db().collection('digitalProducts').doc(String(productId || pur.productId));" }], expect: /DIFFERENT product/ },
  { group: 'hubreviews', name: 'digital: the seller rates their own product', file: DGH, suite: 'hubrev',
    from: "    if (pSnap.data().sellerUid === uid) throw new HttpsError('permission-denied', 'You cannot rate your own product.');\n", to: "", expect: /rate their own product/ },
  { group: 'hubreviews', name: 'unboxing: someone else\'s order verifies your review', file: RVJ, suite: 'hubrev',
    from: "    if ((o.buyerUid || o.userId || o.uid) !== uid) throw new HttpsError('permission-denied', 'That order is not yours.');\n", to: "", expect: /someone else's order/ },
  { group: 'hubreviews', name: 'unboxing: an undelivered order verifies', file: RVJ, suite: 'hubrev',
    from: "    if (!['delivered', 'completed'].includes(String(o.status || '').toLowerCase())) throw", to: "    if (false) throw", expect: /undelivered order/ },
  { group: 'hubreviews', name: 'unboxing: one order verifies many reviews', file: RVJ, suite: 'hubrev',
    from: "    if (cs.exists && cs.data().reviewId !== reviewId) throw new HttpsError('already-exists', 'That order already verifies another review.');\n", to: "", expect: /ONE review/ },
  { group: 'hubreviews', browser: true, name: 'unboxing: the invented DEMO reviews return to the live wall', file: UBX, suite: 'hubrev',
    from: "  return [...local,...fsOnly];", to: "  return [...local,...fsOnly,...DEMO];", expect: /NO invented demo/ },
  { group: 'hubreviews', browser: true, name: 'unboxing: the author self-declares "verified" again', file: UBX, suite: 'hubrev',
    from: "    likes:0,\n    liked:false,\n", to: "    likes:0,\n    liked:false,\n    verified:!!orderId,\n", expect: /NO client "verified"/ },
  { group: 'hubreviews', browser: true, name: 'sports: a review kept in this browser and shown as posted', file: SPV, suite: 'hubrev',
    from: "  closeModal('reviewModal');\n  (window._skToast||alert)('Reviews open after a completed SOKONI booking. Nothing was posted.');\n  return;", to: "  localStorage.setItem('spt_rv_' + VN_ID, JSON.stringify([{ author: name, rating: 5, body }]));\n  closeModal('reviewModal');\n  (window._skToast||alert)('Thank you for your review!');\n  return;", expect: /sports-venue.*honest/ },
  { group: 'hubreviews', browser: true, name: 'home services: "Thank you" for a review that was never saved', file: HSV, suite: 'hubrev',
    from: "  if(msgEl){msgEl.textContent='Reviews open after a completed SOKONI booking — this provider cannot be reviewed yet.';", to: "  if(msgEl){msgEl.textContent='✅ Thank you for your review!';", expect: /home-services.*honest/ },
  { group: 'hubreviews', rules: true, name: 'a client writes a health review directly (rules)', file: RULES, suite: 'rules',
    from: "  match /healthReviews/{docId} {\n  allow read:   if true;\n  allow create: if false;", to: "  match /healthReviews/{docId} {\n  allow read:   if true;\n  allow create: if claimsOwner();", expect: /HEALTH review/ },
  { group: 'hubreviews', rules: true, name: 'a client writes a digital freelance review directly (rules)', file: RULES, suite: 'rules',
    from: "  match /digitalReviews/{docId} {\n  allow read:   if true;\n  allow create: if false;", to: "  match /digitalReviews/{docId} {\n  allow read:   if true;\n  allow create: if isAuthed() && request.resource.data.reviewerUid == request.auth.uid;", expect: /DIGITAL freelance review/ },
  { group: 'hubreviews', rules: true, name: 'an unboxing review self-marked verified (rules)', file: RULES, suite: 'rules',
    from: "  && !request.resource.data.keys().hasAny(['verified','orderVerified','orderVerifiedAt','likes','status','approved','featured']);", to: ";", expect: /self-marked|seeded with likes/ },
  { group: 'hubreviews', rules: true, name: 'CSAT against a rider who was not assigned (rules)', file: RULES, suite: 'rules',
    from: "  && get(/databases/$(database)/documents/packageRequests/$(ratingId)).data.get('assignedDriverId', '') == request.resource.data.riderId\n", to: "", expect: /NOT assigned/ },
  { group: 'hubreviews', rules: true, name: 'CSAT before the delivery is finished (rules)', file: RULES, suite: 'rules',
    from: "  && (get(/databases/$(database)/documents/packageRequests/$(ratingId)).data.get('status', '') in ['delivered', 'buyer_confirmed', 'completed']\n  || get(/databases/$(database)/documents/packageRequests/$(ratingId)).data.get('buyerConfirmedAt', null) != null);", to: ";", expect: /not finished/ },
  { group: 'hubreviews', rules: true, name: 'CSAT under any doc id (duplicate ratings) (rules)', file: RULES, suite: 'rules',
    from: "  && ratingId == request.resource.data.deliveryRef\n", to: "", expect: /deliveryRef names ANOTHER delivery|doc id that is not the delivery/ },
  { group: 'hubreviews', rules: true, name: 'a driver writes their own rating (rules)', file: RULES, suite: 'rules',
    from: "  && request.resource.data.uid == request.auth.uid\n  && noAdminFields() && noRatingAggOnUpdate()\n  && (!request.resource.data.keys().hasAny(['lat','lng'])", to: "  && request.resource.data.uid == request.auth.uid\n  && noAdminFields()\n  && (!request.resource.data.keys().hasAny(['lat','lng'])", expect: /driver writes their own rating|inflates the rating counters/ },
  { group: 'hubreviews', rules: true, name: 'a lawyer listing is created with its own rating (rules)', file: RULES, suite: 'rules',
    from: "  match /lawyers/{docId} {\n  allow read:   if true;\n  allow create: if false;", to: "  match /lawyers/{docId} {\n  allow read:   if true;\n  allow create: if claimsOwner() && noAdminFields();", expect: /lawyer listing is created with a rating|self-publishes a lawyer directory card/ },

  /* ── C1: the payer is never their own earner (CHANGELOG 214) ── */
  { group: 'payer', name: 'the webhook credits the PAYER when no earner is attributed (the old fallback)', file: 'functions/index.js', suite: 'payer',
    from: "        const _sellerId  = _explicitEarner || (_payerIsMerchant ? payData.uid : null);", to: "        const _sellerId  = _explicitEarner || payData.uid;", expect: /NO wallet is credited/ },
  { group: 'payer', name: 'a merchant-initiated POS charge is no longer credited to the merchant', file: 'functions/index.js', suite: 'payer',
    from: "        const _payerIsMerchant = _POS_MERCHANT_INITIATED.has(String(category || \"\").toLowerCase());", to: "        const _payerIsMerchant = false;", expect: /merchant-initiated POS/ },
  { group: 'payer', name: 'an unattributed payment is held again on every replay (duplicate review entries)', file: 'functions/index.js', suite: 'payer',
    from: "            if (!snap.exists || snap.data().settlementStatus === \"UNATTRIBUTED_HOLD\" || snap.data().walletCreditedAt) return false;", to: "            if (!snap.exists) return false;\n            txn.set(db.collection(\"commissionReviewQueue\").doc(), { ref: apiRef, dup: true });", expect: /exactly ONE review entry/ },

  /* ── money integrity: nothing says paid / confirmed without a server-confirmed payment (CHANGELOG 215) ── */
  { group: 'integrity', browser: true, name: 'bnb: a simulated "Payment confirmed!" confirms an unpaid stay', file: 'bnb.html', suite: 'integrity',
    from: "    if(_btn){ _btn.disabled = false; _btn.textContent = 'Confirm Booking'; }\n    showNotif('Booking with SOKONI Pay is being enabled for this stay — nothing was booked or charged.', 'error');", to: "    setTimeout(()=>{ showNotif('✅ Payment confirmed!', 'success'); _finalise(null); }, 1000);", expect: /no stay is written|nothing was booked or charged/ },
  { group: 'integrity', browser: true, name: 'car-hub: "STK push sent" when none was, rental recorded', file: 'car-hub.html', suite: 'integrity',
    from: "  if(msgEl){ msgEl.textContent = \"Car rentals with SOKONI Pay are being enabled — nothing was booked or charged.\"; msgEl.style.color = \"#ff9800\"; }", to: "  const bookings=getBookings();bookings.unshift({id:'BKX',carId:currentBookingCarId,status:'active'});saveBookings(bookings);\n  if(msgEl){ msgEl.textContent = \"✅ Booking confirmed! M-Pesa STK push sent — enter your PIN.\"; }", expect: /no rental is recorded|never "STK push sent"/ },
  { group: 'integrity', browser: true, name: 'landlord: a simulated 3-second "Payment Confirmed" marks rent paid', file: 'landlord.html', suite: 'integrity',
    from: "    btn.disabled = false;\n    resultEl.innerHTML = '<span style=\"color:#ff9800;\">Rent collection with SOKONI Pay is being enabled", to: "    setTimeout(()=>{ const props=getData(); const u=props[0].units[0]; u.rentHistory=[{month:getCurrentMonth(),paid:true,amount:u.rent,method:'mpesa'}]; saveData(props); }, 1000);\n    btn.disabled = false;\n    resultEl.innerHTML = '<span style=\"color:#ff9800;\">Rent collection with SOKONI Pay is being enabled", expect: /NEVER marked paid/ },
  { group: 'integrity', name: 'impact: an uncharged checkout donation is recorded as completed money', file: 'functions/impact.js', suite: 'integrity',
    from: "frequency: 'one-time', status: 'pledged', paymentStatus: 'not_collected',", to: "frequency: 'one-time', status: 'completed', paymentStatus: 'not_collected',", expect: /PLEDGE/ },
  { group: 'integrity', name: 'impact: the Foundation ledger is credited for money never collected', file: 'functions/impact.js', suite: 'integrity',
    from: "      if (false) {   /* ledger + totals only once the donation is actually charged */", to: "      if (true) {", expect: /LEDGER is not credited|PLEDGE/ },
  { group: 'integrity', rules: true, name: 'a guest creates a confirmed stay again (rules)', file: RULES, suite: 'rules',
    from: "  && request.resource.data.status == 'requested'\n", to: "  && request.resource.data.status in ['requested','confirmed']\n", expect: /CONFIRMED BnB stay/ },

  /* ── SOKONI Pay gateway: server-priced only, every enabled IntaSend method, no WhatsApp (CHANGELOG 216) ── */
  { group: 'gateway', browser: true, name: 'the gateway charges a CLIENT price when no server purpose is given', file: 'sokoni-pay.js', suite: 'gateway',
    from: "          /* No server price → no payment. */\n          $(\"spAmount\").textContent = \"—\";\n          say(\"This payment isn't available on SOKONI Pay yet — nothing was charged.\", \"#ff9800\");\n          return;", to: "          intent = { ref: genRef(\"SKN\"), amount: Math.round(Number(options.serviceTotal || options.depositAmount || 200)) };", expect: /refused/ },
  { group: 'gateway', browser: true, name: 'the page\'s amount overrides the server\'s price', file: 'sokoni-pay.js', suite: 'gateway',
    from: "          intent = { ref: String(r.ref || r.paymentIntentId), amount: Math.round(Number(r.amount)) };", to: "          intent = { ref: String(r.ref || r.paymentIntentId), amount: Math.round(Number(options.depositAmount || r.amount)) };", expect: /SERVER's/ },
  { group: 'gateway', browser: true, name: 'the gateway unlocks BEFORE the server confirms the payment', file: 'sokoni-pay.js', suite: 'gateway',
    from: "        say(\"📲 Enter your M-PESA PIN on \"+phone+\" — waiting for confirmation…\", \"#fbbf24\");\n", to: "        if(options.onSuccess) options.onSuccess(intent.ref);\n        say(\"📲 Enter your M-PESA PIN on \"+phone+\" — waiting for confirmation…\", \"#fbbf24\");\n", expect: /onSuccess never fires/ },
  { group: 'gateway', browser: true, name: 'card / bank shown whether or not the server enables them (a faked method)', file: 'sokoni-pay.js', suite: 'gateway',
    from: "            .then((m)=>{ if(m && m.hosted) hostedBtn.style.display = \"block\"; })", to: "            .then(()=>{ hostedBtn.style.display = \"block\"; })", expect: /only M-PESA is offered/ },
  { group: 'gateway', browser: true, name: 'waConnect hands the booking to WhatsApp again', file: 'sokoni-pay.js', suite: 'gateway',
    from: "  const uid = opts.providerUid || opts.providerId || null;", to: "  window.open(\"https://wa.me/\"+String(providerPhone||\"\").replace(/^0/,\"254\")+\"?text=\"+encodeURIComponent(message||\"\"),\"_blank\");\n  const uid = opts.providerUid || opts.providerId || null;", expect: /never wa\.me/ },

  /* ── support stays in the app (CHANGELOG 217) ── */
  { group: 'support', browser: true, name: 'a footer sends users to SOKONI\'s WhatsApp again', file: 'faq.html', suite: 'support',
    from: '<a href="/support.html#ticket" aria-label="SOKONI Support" title="SOKONI Support">💬</a>', to: '<a href="https://wa.me/254705726803" aria-label="WhatsApp" title="WhatsApp">📱</a>', expect: /links SOKONI's WhatsApp numbers/ },
  { group: 'support', browser: true, name: 'support.html#ticket no longer opens the ticket form (dead deep link)', file: 'support.html', suite: 'support',
    from: "(function(){ function go(){ if (location.hash === '#ticket'", to: "(function(){ function go(){ if (false && location.hash === '#ticket'", expect: /opens the in-app ticket form/ },

  /* ── booking & contact stay in the app on server-ready pages (CHANGELOG 218) ── */
  { group: 'inapp', browser: true, name: 'premium sellers are contacted on WhatsApp again', file: 'product.js', suite: 'inapp',
    from: "        contactSellerInApp();\n        return;", to: "        window.open('https://wa.me/254722000000?text=hi', '_blank');\n        return;", expect: /no WhatsApp hand-off|never wa\.me/ },
  { group: 'inapp', browser: true, name: 'the premium path calls itself (the shared-name recursion)', file: 'product.js', suite: 'inapp',
    from: "        contactSellerInApp();\n        return;", to: "        contactSellerWhatsApp();\n        return;", expect: /never a recursion/ },
  { group: 'inapp', browser: true, name: 'cleaning books over WhatsApp again', file: 'cleaning.html', suite: 'inapp',
    from: "  if (selectedProv && selectedProv.uid) {\n    location.href = 'provider-profile.html?uid=' + encodeURIComponent(selectedProv.uid);", to: "  if (selectedProv && selectedProv.uid) {\n    window.open('https://wa.me/254711000000?text=book', '_blank');", expect: /cleaner's SOKONI profile|no WhatsApp hand-off/ },
  { group: 'inapp', browser: true, name: 'services falls back to the client-priced gateway', file: 'services.html', suite: 'inapp',
    from: "  (window._skToast||alert)('Booking is loading — please try again in a moment. Nothing was charged.');\n  return;\n}", to: "  if(typeof SokoniPay !== 'undefined') SokoniPay.bookNow({ providerName: p.name, category: p.category || 'default' }, function(){});\n  return;\n}", expect: /never the client-priced gateway/ },
  { group: 'inapp', browser: true, name: 'business services are booked on WhatsApp again', file: 'business.html', suite: 'inapp',
    from: "      <button type=\"button\" class=\"biz-service-book\" onclick=\"bizMessage()\"", to: "      <a href=\"https://wa.me/${waNum}?text=${waMsg}\" target=\"_blank\"></a><button type=\"button\" class=\"biz-service-book\" onclick=\"bizMessage()\"", expect: /no WhatsApp hand-off|no WhatsApp contact link/ },

  /* ── the Legal Hub books, registers and talks inside SOKONI (CHANGELOG 219) ── */
  { group: 'legal', browser: true, name: "the page cannot see the signed-in user again (window._sokoniUser set by nothing)", file: 'legal-hub.html', suite: 'legal',
    from: "  Object.defineProperty(window, '_sokoniUser', { configurable: true, get() {", to: "  Object.defineProperty(window, '_sokoniUser_OFF', { configurable: true, get() {", expect: /sees the signed-in user|IS the server record/ },
  { group: 'legal', browser: true, name: "a failed booking is reported as sent", file: 'legal-hub.html', suite: 'legal',
    from: "    if(m){ m.innerHTML = '⚠️ We could not send this request to the advocate, so it is <strong>not booked</strong>. '+", to: "    if(m){ m.innerHTML = '✅ Request sent. '+", expect: /not booked/ },
  { group: 'legal', browser: true, name: "the local record promotes itself to confirmed", file: 'legal-hub.html', suite: 'legal',
    from: "st[i].status = result.status || 'pending';", to: "st[i].status = 'confirmed';", expect: /SERVER status/ },
  { group: 'legal', browser: true, name: "the booking modal searches localStorage only again", file: 'legal-hub.html', suite: 'legal',
    from: "function _openConsultModal(id){\n  const l=_findLawyer(id);if(!l)return;", to: "function _openConsultModal(id){\n  const l=getLawyers().find(x=>x.id===id);if(!l)return;", expect: /opens the request modal/ },
  { group: 'legal', browser: true, name: "a confirmed appointment goes to WhatsApp again", file: 'legal-hub.html', suite: 'legal',
    from: "`<a href=\"messages.html?with=${encodeURIComponent(a.lawyerId)}\" class=\"appt-btn\"", to: "`<a href=\"https://wa.me/254703480154?text=q\" class=\"appt-btn\"", expect: /never WhatsApp|no WhatsApp hand-off/ },
  { group: 'legal', browser: true, name: "the firm registration shows success without waiting for the save", file: 'legal-hub.html', suite: 'legal',
    from: "    try { await window.SokoniDB.saveApplication(firmData); }", to: "    try { window.SokoniDB.saveApplication(firmData).catch(function(){}); }", expect: /fails: NO success/ },

  /* ── Legal Verification Authority: SOKONI admin + LSK → one predicate (CHANGELOG 220) ── */
  { group: 'legalv', browser: true, name: "client sets adminApproved / lskVerified / bookable on its own Legal record (rules opened)", file: "firestore.rules.build", suite: "legalvrules",
    from: "  match /legalProviders/{providerId} {\n  allow read:  if isAdmin() || (isAuthed() && request.auth.uid == providerId);\n  allow write: if false;", to: "  match /legalProviders/{providerId} {\n  allow read:  if isAdmin() || (isAuthed() && request.auth.uid == providerId);\n  allow write: if isAuthed() && request.auth.uid == providerId;", expect: /cannot set adminApproved|cannot set lskVerified|cannot set bookable/ },
  { group: 'legalv', browser: true, name: "forged LSK evidence written by the advocate (private verification opened)", file: "firestore.rules.build", suite: "legalvrules",
    from: "  match /legalVerifications/{uid} {\n  allow read:  if isAdmin();\n  allow write: if false;", to: "  match /legalVerifications/{uid} {\n  allow read:  if isAdmin();\n  allow write: if isAuthed();", expect: /cannot write the private verification/ },
  { group: 'legalv', browser: true, name: "fake Legal identity: clients may self-publish a lawyer card again", file: "firestore.rules.build", suite: "legalvrules",
    from: "  match /lawyers/{docId} {\n  allow read:   if true;\n  allow create: if false;", to: "  match /lawyers/{docId} {\n  allow read:   if true;\n  allow create: if isAuthed();", expect: /self-publish a lawyer card/ },
  { group: 'legalv', browser: true, name: "client-sent practiceStatus / verification is copied at registration", file: "functions/legal-hub.js", suite: "legalv",
    from: "    status: 'pending_review',\n    verification: {", to: "    status: 'pending_review', ...(req.data.verification ? { verification: req.data.verification } : {}),\n    _unused: {", expect: /registration ignores injected/ },
  { group: 'legalv', browser: true, name: "duplicate Legal identity: an active provider of another kind is merged", file: "functions/legal-verification.js", suite: "legalv",
    from: "  return 'conflict';     /* an active provider of another kind", to: "  return 'linked';     /* an active provider of another kind", expect: /never merged/ },
  { group: 'legalv', browser: true, name: "bookable=true trusted from the stored flag", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (!lp) return { bookable: false, code: 'NOT_REGISTERED' };", to: "  if (!lp) return { bookable: false, code: 'NOT_REGISTERED' };\n  if (lp.bookable === true || (lp.verification && lp.verification.eligibility && lp.verification.eligibility.bookable === true)) return { bookable: true, code: null };", expect: /forged: verified:true \/ bookable:true/ },
  { group: 'legalv', browser: true, name: "unapproved advocate is eligible (admin gate removed)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (a !== 'approved') return { bookable: false, code: 'ADMIN_' + a.toUpperCase() };", to: "", expect: /admin pending · LSK verified|ONLY the fully eligible|advB/ },
  { group: 'legalv', browser: true, name: "LSK-unverified advocate is eligible (LSK status gate removed)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (ls !== 'verified') return { bookable: false, code: 'LSK_' + ls.toUpperCase() };", to: "", expect: /LSK pending|LSK Suspended|advA/ },
  { group: 'legalv', browser: true, name: "inactive advocate is eligible (practising-status gate removed)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (l.practiceStatus !== 'Active') return { bookable: false, code: 'LSK_NOT_ACTIVE' };", to: "", expect: /practice Inactive/ },
  { group: 'legalv', browser: true, name: "an Inactive practising status maps to verified", file: "functions/legal-verification.js", suite: "legalv",
    from: "const PRACTICE_TO_LSK = { Active: 'verified', Inactive: 'failed',", to: "const PRACTICE_TO_LSK = { Active: 'verified', Inactive: 'verified',", expect: /LSK Inactive → failed/ },
  { group: 'legalv', browser: true, name: "stale verification stays bookable (validity check removed)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (!(Number(l.validUntilMs) > t)) return { bookable: false, code: 'LSK_STALE' };", to: "", expect: /stale|advF/ },
  { group: 'legalv', browser: true, name: "a client-sent source is accepted (manual passed off as automated)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  return _recordLsk(_db(), { uid, actor, source: SOURCES.OFFICIAL_SOURCE_MANUAL,", to: "  return _recordLsk(_db(), { uid, actor, source: d.source || SOURCES.OFFICIAL_SOURCE_MANUAL,", expect: /source is the MANUAL official-source path/ },
  { group: 'legalv', browser: true, name: "forged P.105: the registered-number binding is removed", file: "functions/legal-verification.js", suite: "legalv",
    from: "    if (registered !== p105Number) throw", to: "    if (false && registered !== p105Number) throw", expect: /forged P\.105/ },
  { group: 'legalv', browser: true, name: "forged LSK name passes (name match always true)", file: "functions/legal-verification.js", suite: "legalv",
    from: "    const matched = nameMatches(lp.name, verifiedName);", to: "    const matched = true;", expect: /forged LSK name/ },
  { group: 'legalv', browser: true, name: "forged LSK status is accepted (any string)", file: "functions/legal-verification.js", suite: "legalv",
    from: "  return PRACTICE_STATUSES.find((p) => p.toLowerCase() === k) || null;", to: "  return PRACTICE_STATUSES.find((p) => p.toLowerCase() === k) || (k ? 'Active' : null);", expect: /forged status/ },
  { group: 'legalv', browser: true, name: "forged audit reference: the client-supplied evidence becomes the audit ref", file: "functions/legal-verification.js", suite: "legalv",
    from: "    out = Object.assign({ lsk: summary, auditRef: eventRef.id }, res);", to: "    out = Object.assign({ lsk: summary, auditRef: evidenceRef || eventRef.id }, res);", expect: /audit reference is the server/ },
  { group: 'legalv', browser: true, name: "a non-admin can record another advocate's LSK verification", file: "functions/legal-verification.js", suite: "legalv",
    from: "_adminH.legalAdminRecordLsk = async (req) => {\n  const actor = _requireAdmin(req);", to: "_adminH.legalAdminRecordLsk = async (req) => {\n  const actor = (req.auth && req.auth.uid) || null;", expect: /cannot record LSK verification|cannot change another advocate/ },
  { group: 'legalv', browser: true, name: "admin impersonation: a numeric role claim is accepted", file: "functions/legal-verification.js", suite: "legalv",
    from: "  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');", to: "  if (!ADMIN.isAdmin(req) && !(Number(req.auth.token && req.auth.token.role) >= 4)) throw new HttpsError('permission-denied', 'Administrators only.');", expect: /numeric role 4\) cannot record/ },
  { group: 'legalv', browser: true, name: "Mode A pretends an LSK integration exists and answers Active", file: "functions/lsk-adapter.js", suite: "legalv",
    from: "function available() { return STATUS.available; }\n\nasync function lookup(/* p105Number */) {\n  throw new HttpsError('unavailable', STATUS.reason, { code: 'LSK_INTEGRATION_UNAVAILABLE' });\n}", to: "function available() { return true; }\n\nasync function lookup(p105Number) {\n  return { p105Number, name: 'KAMAU WANJIRU', practiceStatus: 'Active', checkedAtMs: Date.now(), reference: 'fabricated' };\n}", expect: /NOT AVAILABLE \/ NOT AUTHORIZED and writes nothing|no endpoint/ },
  { group: 'legalv', browser: true, name: "a client-written approved application is honoured (decision authority bypassed)", file: "functions/application-lifecycle.js", suite: "legalv",
    from: "    if (!authority.ok) {", to: "    if (false && !authority.ok) {", expect: /client-written "approved" application grants nothing/ },
  { group: 'legalv', browser: true, name: "application approval without a Legal registry update (legal delegated again)", file: "functions/application-lifecycle.js", suite: "legalv",
    from: "const DELEGATED_ROLES = { event_organizer: 'events' };", to: "const DELEGATED_ROLES = { legal: 'legalProviders', event_organizer: 'events' };", expect: /records the SOKONI decision on the Legal record|no longer delegates legal/ },
  { group: 'legalv', browser: true, name: "Legal registry update without authorization: approveLegalProvider writes active again", file: "functions/legal-hub.js", suite: "legalv",
    from: "  requireAuth(req);\n  throw new HttpsError('failed-precondition',\n    'Advocate approval has moved", to: "  requireAuth(req);\n  await db().collection('legalProviders').doc(String(req.data.providerId)).set({ status: 'active', verification: { admin: { status: 'approved' } } }, { merge: true });\n  throw new HttpsError('failed-precondition',\n    'Advocate approval has moved", expect: /retired approveLegalProvider refuses/ },
  { group: 'legalv', browser: true, name: "T.M.M listed: the directory filters on legacy status only", file: "functions/legal-hub.js", suite: "legalv",
    from: "  let providers = snap.docs.filter(d => LV.eligibility(d.data(), now).bookable).map(d => _publicAdvocate(d.data(), now));", to: "  let providers = snap.docs.map(d => _publicAdvocate(d.data(), now));", expect: /T\.M\.M is never listed|not the suspended|unapproved advocate is not listed|not listed/ },
  { group: 'legalv', browser: true, name: "the public projection leaks the licence number and phone", file: "functions/legal-hub.js", suite: "legalv",
    from: "  return { providerId: p.providerId, name: p.name, firmName: p.firmName,", to: "  return { providerId: p.providerId, name: p.name, firmName: p.firmName, licenseNumber: p.licenseNumber, phone: p.phone,", expect: /never the licence number|public projection only/ },
  { group: 'legalv', browser: true, name: "the canonical availability authority stops asking the Legal authority", file: "functions/ent-availability.js", suite: "legalv",
    from: "  if (!code) code = await require('./legal-verification').bookingGate(_db(), id, p);", to: "", expect: /refused by the canonical availability authority|self-declared "Lawyer"/ },
  { group: 'legalv', browser: true, name: "Legal booking switched on before the payment slice", file: "functions/legal-verification.js", suite: "legalv",
    from: "const LEGAL_BOOKING_ENABLED = false;", to: "const LEGAL_BOOKING_ENABLED = true;", expect: /refused too while Legal payment is not connected/ },
  { group: 'legalv', browser: true, name: "a quarantined identity (T.M.M) is re-created by an approval", file: "functions/legal-verification.js", suite: "legalv",
    from: "    if (qS.exists) throw new Error(", to: "    if (false && qS.exists) throw new Error(", expect: /nor be re-created by an AdminOS approval/ },
  { group: 'legalv', browser: true, name: "T.M.M's legacy card appears in site search again", file: "sokoni-firestore-search.js", suite: "legalv",
    from: "    title: d => (d.projectedBy === 'legal-verification' && d.name) || '',", to: "    title: d => d.name || '',", expect: /never appears in site search/ },
  { group: 'legalv', browser: true, name: "the AdminOS panel offers a bookable toggle", file: "sokoni-aos-legal.js", suite: "legalv",
    from: "<p data-eligibility>${ELIG(a.eligibility)}", to: "<p data-eligibility><label><input type=\"checkbox\" name=\"bookable\"> bookable</label>${ELIG(a.eligibility)}", expect: /no control that sets|no control anywhere sets/ },

  /* ── Healthcare security slice 1: patient requests belong to the patient (CHANGELOG 221) ── */
  { group: 'hcreq', browser: false, name: "forged patient / requester uid (owner binding removed)", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return claimsOwner() && noAdminFields()\n  && !request.resource.data.keys().hasAny(healthRecipientFields());", to: "  return isAuthed() && noAdminFields()\n  && !request.resource.data.keys().hasAny(healthRecipientFields());", expect: /forged patient uid|forged requester uid/ },
  { group: 'hcreq', browser: false, name: "arbitrary provider / pharmacy uid nominated (recipient check removed)", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return claimsOwner() && noAdminFields()\n  && !request.resource.data.keys().hasAny(healthRecipientFields());", to: "  return claimsOwner() && noAdminFields();", expect: /arbitrary provider uid|arbitrary pharmacy uid/ },
  { group: 'hcreq', browser: false, name: "pharmacy uid no longer a recipient field", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return ['providerId', 'pharmacyId', 'facilityId',", to: "  return ['providerId', 'facilityId',", expect: /arbitrary pharmacy uid/ },
  { group: 'hcreq', browser: false, name: "a nominated provider reads the patient's request again", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);\n  }\n  function healthRequestPatientUpdate", to: "  return isAdmin() || (isAuthed() && (resource.data.uid == request.auth.uid || resource.data.providerId == request.auth.uid || resource.data.pharmacyId == request.auth.uid));\n  }\n  function healthRequestPatientUpdate", expect: /can no longer read it/ },
  { group: 'hcreq', browser: false, name: "cross-patient read (owner check removed from read)", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);\n  }\n  function healthRequestPatientUpdate", to: "  return isAdmin() || isAuthed();\n  }\n  function healthRequestPatientUpdate", expect: /cross-patient read/ },
  { group: 'hcreq', browser: false, name: "provider reassignment / cross-user mutation (patient-update owner check removed)", file: "firestore.rules.build", suite: 'hcreq',
    from: "  return isAuthed() && resource.data.uid == request.auth.uid && uidUnchanged() && noAdminFields()\n  && !request.resource.data.diff(resource.data).affectedKeys().hasAny(healthRecipientFields())", to: "  return isAuthed() && uidUnchanged() && noAdminFields()", expect: /cross-patient write|reassign/ },
  { group: 'hcreq', browser: false, name: "the patient self-completes a request (status gate removed)", file: "firestore.rules.build", suite: 'hcreq',
    from: "  && (!request.resource.data.diff(resource.data).affectedKeys().hasAny(['status'])\n  || request.resource.data.status == 'cancelled');", to: "  && true;", expect: /self-confirm/ },
  { group: 'hcreq', browser: false, name: "unauthenticated / anonymous emergency report", file: "firestore.rules.build", suite: 'hcreq',
    from: "  match /healthEmergency/{docId} {\n  allow read:   if healthRequestRead();\n  allow create: if healthRequestCreate();", to: "  match /healthEmergency/{docId} {\n  allow read:   if healthRequestRead();\n  allow create: if true;", expect: /healthEmergency: (unauthenticated|forged requester uid)/ },
  { group: 'hcreq', browser: false, name: "the emergency requester rewrites the report", file: "firestore.rules.build", suite: 'hcreq',
    from: "  match /healthEmergency/{docId} {\n  allow read:   if healthRequestRead();\n  allow create: if healthRequestCreate();\n  allow update: if isAdmin();", to: "  match /healthEmergency/{docId} {\n  allow read:   if healthRequestRead();\n  allow create: if healthRequestCreate();\n  allow update: if isAdmin() || healthRequestPatientUpdate() || (isAuthed() && resource.data.uid == request.auth.uid);", expect: /cannot rewrite an emergency report|healthEmergency: the patient cannot reassign/ },

  /* ── Healthcare security slice 2: the canonical admin authority (CHANGELOG 222) ── */
  { group: 'hcadm', browser: false, name: "the retired standalone approval is revived (admin sets status active)", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "  requireAuth(req);\n  throw new HttpsError('failed-precondition',\n    'Healthcare provider approval is made in AdminOS", to: "  requireAuth(req);\n  if (ADMIN.isAdmin(req) || Number(req.auth.token.role) >= 4) { await db().collection('healthProviders').doc(String(req.data.providerId)).update({ status: 'active', reviewedBy: req.auth.uid }); return { ok: true }; }\n  throw new HttpsError('failed-precondition',\n    'Healthcare provider approval is made in AdminOS", expect: /approveHealthProvider refuses|nothing was written/ },
  { group: 'hcadm', browser: false, name: "the retired healthcare dashboard is revived", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "  requireAuth(req);\n  throw new HttpsError('failed-precondition', 'Healthcare administration is in AdminOS.'", to: "  requireAuth(req);\n  if (ADMIN.isAdmin(req)) return { pendingProviders: 1 };\n  throw new HttpsError('failed-precondition', 'Healthcare administration is in AdminOS.'", expect: /getHealthDashboard refuses/ },
  { group: 'hcadm', browser: false, name: "old numeric role claim spoof accepted as admin", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "  const isAdmin = ADMIN.isAdmin(req);", to: "  const isAdmin = ADMIN.isAdmin(req) || Number(req.auth.token && req.auth.token.role) >= 4;", expect: /numeric role 4 cannot read another provider/ },
  { group: 'hcadm', browser: false, name: "forged admin identity accepted (truthy instead of the canonical claim)", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "  const isAdmin = ADMIN.isAdmin(req);", to: "  const isAdmin = ADMIN.isAdmin(req) || !!(req.auth.token && (req.auth.token.admin || req.auth.token.isAdmin || req.auth.token.superAdmin));", expect: /forged admin token/ },
  { group: 'hcadm', browser: false, name: "unauthorized caller changes an appointment it is not party to", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "    if (appt.patientUid !== uid && appt.providerId !== uid && !isAdm) {", to: "    if (false && appt.patientUid !== uid && appt.providerId !== uid && !isAdm) {", expect: /cannot change an appointment it is not party to|not even cancel it/ },
  { group: 'hcadm', browser: false, name: "a caller-supplied patientUid reads another patient's records", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "  const targetUid = uid;", to: "  const targetUid = req.data.patientUid || uid;", expect: /cannot read another patient's records|no admin reads a patient/ },
  { group: 'hcadm', browser: false, name: "provider self-approval: registration accepts a client status", file: "functions/healthcare-hub.js", suite: 'hcadm',
    from: "    status: 'pending',\n    rating: 0, ratingCount: 0,\n    totalAppointments: 0,", to: "    status: req.data.status || 'pending',\n    rating: 0, ratingCount: 0,\n    totalAppointments: 0,", expect: /ignores injected status/ },
  { group: 'hcadm', browser: false, name: "client setting approved on a health application is honoured", file: "functions/application-lifecycle.js", suite: 'hcadm',
    from: "    if (!authority.ok) {", to: "    if (false && !authority.ok) {", expect: /client-written "approved" health application grants nothing/ },

  /* ── Healthcare security slice 3: clinical writes need a clinical relationship (CHANGELOG 223) ── */
  { group: 'hcclin', browser: false, name: "arbitrary patientUid accepted for a record", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "      recordId: ref.id, patientUid: basis.patientUid, providerId: uid,", to: "      recordId: ref.id, patientUid: d.patientUid || basis.patientUid, providerId: uid,", expect: /record: arbitrary patientUid is IGNORED/ },
  { group: 'hcclin', browser: false, name: "arbitrary patient on a prescription", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "      prescriptionId: ref.id, patientUid: basis.patientUid, providerId: uid,", to: "      prescriptionId: ref.id, patientUid: d.patientUid || basis.patientUid, providerId: uid,", expect: /prescription: arbitrary patientUid is IGNORED/ },
  { group: 'hcclin', browser: false, name: "forged provider: another provider's booking accepted", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  if (!b || b.providerId !== uid || !b.customerUid || b.customerUid === uid) throw deny();", to: "  if (!b || !b.customerUid || b.customerUid === uid) throw deny();", expect: /forged provider/ },
  { group: 'hcclin', browser: false, name: "a non-healthcare (unrelated) booking accepted", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  if (b.commissionHub !== 'healthcare') throw deny();", to: "", expect: /non-healthcare booking|no hub/ },
  { group: 'hcclin', browser: false, name: "cancelled / declined / pending booking accepted (status gate removed)", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  if (!CLINICAL_STATUSES.includes(b.status) || !CLINICAL_PAID.includes(b.paymentStatus)) throw deny();", to: "  if (!CLINICAL_PAID.includes(b.paymentStatus)) throw deny();", expect: /declined booking|no-show booking|pending booking/ },
  { group: 'hcclin', browser: false, name: "unpaid / refunded booking accepted (payment gate removed)", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  if (!CLINICAL_STATUSES.includes(b.status) || !CLINICAL_PAID.includes(b.paymentStatus)) throw deny();", to: "  if (!CLINICAL_STATUSES.includes(b.status)) throw deny();", expect: /UNPAID booking|refunded booking/ },
  { group: 'hcclin', browser: false, name: "refunded counted as paid", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "const CLINICAL_PAID = ['paid_held', 'settled'];", to: "const CLINICAL_PAID = ['paid_held', 'settled', 'refunded'];", expect: /refunded booking/ },
  { group: 'hcclin', browser: false, name: "provider identity gate removed", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  if (!pSnap.exists || pSnap.data().status !== 'active') throw new HttpsError('permission-denied', 'Active provider account required');", to: "", expect: /unapproved provider identity|unregistered provider|NO_CLINICAL|patient themselves/ },
  { group: 'hcclin', browser: false, name: "replayed record creation duplicates (idempotency removed)", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "    if (ex.exists) { out = { recordId: ref.id, idempotent: true }; return; }", to: "", expect: /record: a replayed request/ },
  { group: 'hcclin', browser: false, name: "forged audit actor taken from the request", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "    _audit(t, { actor: uid, action: 'record_create',", to: "    _audit(t, { actor: d.actor || uid, action: 'record_create',", expect: /record: one audit row/ },
  { group: 'hcclin', browser: false, name: "clinical content leaks into the audit", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "    _audit(t, { actor: uid, action: 'record_create',", to: "    _audit(t, { diagnosis: d.diagnosis, actor: uid, action: 'record_create',", expect: /audit carries NO clinical content/ },
  { group: 'hcclin', browser: false, name: "a prescription is written without an audit row", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "    _audit(t, { actor: uid, action: 'prescription_create',", to: "    void (0) && _audit(t, { actor: uid, action: 'prescription_create',", expect: /prescription: one audit row/ },
  { group: 'hcclin', browser: false, name: "a caller-supplied patientUid reads another patient's records", file: "functions/healthcare-hub.js", suite: "hcclin",
    from: "  const targetUid = uid;", to: "  const targetUid = req.data.patientUid || uid;", expect: /reads nothing of the patient's/ },
  { group: 'hcclin', browser: false, name: "the records index is dropped", file: "firestore.indexes.json", suite: "hcclin",
    from: "\"collectionGroup\": \"healthRecords\"", to: "\"collectionGroup\": \"healthRecordsX\"", expect: /exactly one index/ },
  { group: 'hcclin', browser: false, name: "admins read clinical records directly again (rules)", file: "firestore.rules.build", suite: "hcclinrules",
    from: "  match /healthRecords/{recordId} {\n  allow read:  if isAuthed() && resource.data.patientUid == request.auth.uid;", to: "  match /healthRecords/{recordId} {\n  allow read:  if isAuthed() && (resource.data.patientUid == request.auth.uid || isAdmin());", expect: /ADMIN cannot read clinical content/ },
  { group: 'hcclin', browser: false, name: "cross-provider read of prescriptions (rules)", file: "firestore.rules.build", suite: "hcclinrules",
    from: "  match /healthPrescriptions/{rxId} {\n  allow read:  if isAuthed() && resource.data.patientUid == request.auth.uid;", to: "  match /healthPrescriptions/{rxId} {\n  allow read:  if isAuthed();", expect: /cross-provider read|cross-patient read/ },
  { group: 'hcclin', browser: false, name: "client-created audit event (rules)", file: "firestore.rules.build", suite: "hcclinrules",
    from: "  match /healthClinicalAudit/{auditId} {\n  allow read:  if isAdmin();\n  allow write: if false;", to: "  match /healthClinicalAudit/{auditId} {\n  allow read:  if isAdmin();\n  allow write: if isAuthed();", expect: /client-created audit event/ },

  /* ── Healthcare security slice 4: the public provider projection (CHANGELOG 224) ── */
  { group: 'hcpub', browser: false, name: "the full provider record is returned again", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "  return _publicHealthProvider(snap.data());", to: "  return snap.data();", expect: /only whitelisted fields|no licence number/ },
  { group: 'hcpub', browser: false, name: "the licence number and phone join the projection", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "    sokoniApproved: p.status === 'active',\n  };", to: "    sokoniApproved: p.status === 'active', licenseNumber: p.licenseNumber, phone: p.phone,\n  };", expect: /only whitelisted fields|no licence number|whitelist the code exports/ },
  { group: 'hcpub', browser: false, name: "the list returns raw documents", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "  let providers = snap.docs.map(d => _publicHealthProvider(d.data()));", to: "  let providers = snap.docs.map(d => d.data());", expect: /getHealthProviders: only whitelisted/ },
  { group: 'hcpub', browser: false, name: "search returns raw documents", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "    .map(_publicHealthProvider);", to: "    .map((p) => p);", expect: /searchHealthProviders: only whitelisted/ },
  { group: 'hcpub', browser: false, name: "malformed ids reach Firestore (validation removed)", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) {", to: "  if (!providerId) {", expect: /malformed providerId/ },
  { group: 'hcpub', browser: false, name: "a pending provider is served publicly", file: "functions/healthcare-hub.js", suite: 'hcpub',
    from: "  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Provider not found');\n  /* the same public projection", to: "  if (!snap.exists) throw new HttpsError('not-found', 'Provider not found');\n  /* the same public projection", expect: /pending\) provider is not found/ },

  /* ── POS: every line and the customer must belong to the selling shop (CHANGELOG 225) ── */
  { group: 'posown', browser: false, name: "the ownership predicate trusts the till (any product counts as ours)", file: "functions/pos-zero-friction.js", suite: 'posown',
    from: "    const _ownerOfProduct = (p) => String((p && (p.shopId || p.sellerUid)) || '');", to: "    const _ownerOfProduct = (p) => String(merchantId);", expect: /E1 |E4 / },
  { group: 'posown', browser: false, name: "an ownerless product is assumed to be ours", file: "functions/pos-zero-friction.js", suite: 'posown',
    from: "    const _ownerOfProduct = (p) => String((p && (p.shopId || p.sellerUid)) || '');", to: "    const _ownerOfProduct = (p) => String((p && (p.shopId || p.sellerUid)) || merchantId);", expect: /E4 / },
  { group: 'posown', browser: false, name: "the legacy sellerUid owner is ignored (older own products refused — till outage)", file: "functions/pos-zero-friction.js", suite: 'posown',
    from: "    const _ownerOfProduct = (p) => String((p && (p.shopId || p.sellerUid)) || '');", to: "    const _ownerOfProduct = (p) => String((p && p.shopId) || '');", expect: /E5 / },
  { group: 'posown', browser: false, name: "another shop's customer credited / debited on this sale (customer guard removed)", file: "functions/pos-zero-friction.js", suite: 'posown',
    from: "      if (custSnap && custSnap.exists && !require('./pos-customer-scope').ownsCustomer(custSnap.id, custSnap.data(), merchantId)) {", to: "      if (false) {", expect: /E7 |E8 / },

  /* ── Healthcare plans are platform revenue (CHANGELOG 226) ── */
  { group: 'hcplan', browser: false, name: "the plan alias is removed (5% default, 95% owed to the subscriber)", file: "functions/commission-config.js", suite: 'hcplan',
    from: "  healthcare_subscription: 'subscriptions',", to: "", expect: /whole amount is SOKONI revenue|resolves to the EXISTING/ },
  { group: 'hcplan', browser: false, name: "plans priced as healthcare services (5%) instead of platform revenue", file: "functions/commission-config.js", suite: 'hcplan',
    from: "  healthcare_subscription: 'subscriptions',", to: "  healthcare_subscription: 'healthcare',", expect: /whole amount is SOKONI revenue|resolves to the EXISTING/ },
  { group: 'hcplan', browser: false, name: "a separate Healthcare plan rate is invented", file: "functions/commission-config.js", suite: 'hcplan',
    from: "  subscriptions:    { pct: 100,", to: "  healthcare_subscription: { pct: 50, fixedKES: 0, _was: 'invented' },\n  subscriptions:    { pct: 100,", expect: /no RATES entry was added/ },

  /* ── Healthcare provider category (CHANGELOG 227) ── */
  { group: 'hccat', browser: false, name: "the provider re-files their own healthcare category (update protection removed)", file: "firestore.rules.build", suite: "hccatrules",
    from: "'healthcare','legalProviderId','provisionedBy','legalVerification']));", to: "]));", expect: /cannot re-file|cannot set provisionedBy|cannot set legalProviderId|cannot set legalVerification/ },
  { group: 'hccat', browser: false, name: "a new provider creates themselves with a category (create protection removed)", file: "firestore.rules.build", suite: "hccatrules",
    from: "&& !request.resource.data.keys().hasAny(['healthcare','legalProviderId','provisionedBy','legalVerification']);", to: ";", expect: /cannot CREATE their record|nor with provisionedBy/ },
  { group: 'hccat', browser: false, name: "an unknown application is GUESSED into a category", file: "functions/healthcare-category.js", suite: "hccat",
    from: "  return found.size === 1 ? [...found][0] : null;", to: "  return found.size === 1 ? [...found][0] : 'clinician';", expect: /UNCLASSIFIED/ },
  { group: 'hccat', browser: false, name: "an ambiguous application picks one category", file: "functions/healthcare-category.js", suite: "hccat",
    from: "  return found.size === 1 ? [...found][0] : null;", to: "  return found.size >= 1 ? [...found][0] : null;", expect: /pharmacy.*Doctor|UNCLASSIFIED/ },
  { group: 'hccat', browser: false, name: "a non-admin classifies a provider", file: "functions/healthcare-admin.js", suite: "hccat",
    from: "  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');", to: "", expect: /non-admin cannot classify|numeric role 4 claim cannot classify|non-admin cannot list/ },
  { group: 'hccat', browser: false, name: "a plumber is classified as a healthcare provider", file: "functions/healthcare-admin.js", suite: "hccat",
    from: "    if (!p.healthcare) throw new HttpsError('failed-precondition', 'This provider was not approved as a healthcare provider.');", to: "", expect: /plumber can never be classified/ },
  { group: 'hccat', browser: false, name: "a classification is not audited", file: "functions/healthcare-admin.js", suite: "hccat",
    from: "      action: 'healthcare_classify', targetUid: uid, performedBy: actor,", to: "      action: 'x', targetUid: uid, performedBy: actor,", expect: /adminAudit trail/ },
  { group: 'hccat', browser: false, name: "a re-approval overwrites the admin classification", file: "functions/application-lifecycle.js", suite: "hccat",
    from: "    if (!(prior && prior.source === 'admin' && HCAT.isCategory(prior.category))) {", to: "    if (true) {", expect: /never overwrites the admin classification/ },

  /* ── Legal panel date (CHANGELOG 228) ── */
  { group: 'legalv', browser: true, name: 'the Legal panel sends noon again (a same-morning LSK check is refused as future)', file: 'sokoni-aos-legal.js', suite: 'legalv',
    from: "Date.parse(f.checkedAt.value + 'T00:00:00+03:00')", to: "Date.parse(f.checkedAt.value + 'T12:00:00+03:00')", expect: /start of the chosen Nairobi day/ },

  /* ── Healthcare directory: real, approved providers only (CHANGELOG 229) ── */
  { group: 'hcdir', browser: true, name: "an unclassified (self-described) provider is listed", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "  if (!HCAT.categoryOf(p)) return false;\n", to: "", expect: /UNCLASSIFIED health provider|discoverability predicate itself refuses/ },
  { group: 'hcdir', browser: true, name: "an unapproved (pending) provider is listed", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "  if (!['active', 'approved'].includes(p.status)) return false;\n", to: "", expect: /pending provider/ },
  { group: 'hcdir', browser: true, name: "a suspended / non-public provider is listed", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "  if (p.suspended === true || p.isPublic === false || p.searchable === false) return false;\n", to: "", expect: /suspended provider|non-public provider|non-searchable/ },
  { group: 'hcdir', browser: true, name: "the private phone leaks into the public projection", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "    acceptsBookings: p.acceptsBookings !== false,\n  };", to: "    acceptsBookings: p.acceptsBookings !== false, phone: p.phone,\n  };", expect: /only whitelisted fields|no phone/ },
  { group: 'hcdir', browser: true, name: "an owner-written rating is shown (not reputation-derived)", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "  const hasRep = p.repV != null && Number(p.reviewCount) > 0 && Number.isFinite(Number(p.rating));", to: "  const hasRep = Number.isFinite(Number(p.rating));", expect: /rating appears only when/ },
  { group: 'hcdir', browser: true, name: "sample providers are manufactured when the registry is empty", file: "functions/healthcare-directory.js", suite: 'hcdir',
    from: "  return rows.slice(0, lim);", to: "  return (rows.length ? rows : [{ providerId: 'sample1', name: 'Aga Khan Hospital', category: 'facility', categoryLabel: 'Clinic', rating: 4.9, reviewCount: 312, acceptsBookings: true }]).slice(0, lim);", expect: /empty registry returns an empty directory/ },
  { group: 'hcdir', browser: true, name: "the client renders a forged / unsafe provider id", file: "sokoni-health-directory.js", suite: 'hcdir',
    from: "    if (!p || !ID_RE.test(String(p.providerId || ''))) return '';      /* never render a link we cannot trust */", to: "    if (!p) return '';", expect: /forged \/ unsafe providerId/ },
  { group: 'hcdir', browser: true, name: "the contact link goes to WhatsApp instead of SOKONI messages", file: "sokoni-health-directory.js", suite: 'hcdir',
    from: "<a class=\"hc-book-btn hc-btn-alt\" href=\"provider-profile.html?uid=${id}&amp;ask=1\">", to: "<a class=\"hc-book-btn hc-btn-alt\" href=\"https://wa.me/254700000000\">", expect: /every link is built from the server providerId|no WhatsApp/ },
  { group: 'hcdir', browser: true, name: "a server failure is shown as an empty (successful) directory", file: "sokoni-health-directory.js", suite: 'hcdir',
    from: "      setStatus('error', (e && e.message) || 'Something went wrong.');", to: "      state.rows = []; render();", expect: /server error shows an error with retry/ },

  /* ── Conversations: server-derived participants, no client create (CHANGELOG 230) ── */
  { group: 'msgauth', browser: false, name: "participants taken from the client again (a victim seated beside the caller)", file: "functions/messages.js", suite: "msgpart",
    from: "  const participantUids = _partiesOf(transactionType, txSnap.data());", to: "  const participantUids = Array.isArray(req.data.participantUids) ? req.data.participantUids : _partiesOf(transactionType, txSnap.data());", expect: /forged participantUids DENIED|stranger is in NO written participant list|participants are the transaction parties/ },
  { group: 'msgauth', browser: false, name: "the client conversation-create rule is reopened", file: "firestore.rules.build", suite: "convrules",
    from: "  match /conversations/{convId} {\n  function isParticipant() {\n  return isAuthed() && request.auth.uid in resource.data.participants;\n  }\n  allow read: if isParticipant();\n  allow update: if isParticipant()\n  && request.resource.data.diff(resource.data)\n  .affectedKeys().hasOnly(['lastMessage','lastMessageAt','lastSenderId','unread']);\n  allow create: if false;", to: "  match /conversations/{convId} {\n  function isParticipant() {\n  return isAuthed() && request.auth.uid in resource.data.participants;\n  }\n  allow read: if isParticipant();\n  allow update: if isParticipant()\n  && request.resource.data.diff(resource.data)\n  .affectedKeys().hasOnly(['lastMessage','lastMessageAt','lastSenderId','unread']);\n  allow create: if isAuthed() && request.auth.uid in request.resource.data.participants;", expect: /DENIED/ },
  { group: 'msgauth', browser: false, name: "a server-anchored type is no longer refused as such (Entertainment / Healthcare booking chats)", file: "functions/messages.js", suite: "entcomms",
    from: "  if (SERVER_ANCHORED.has(transactionType)) {\n    throw new HttpsError('permission-denied', 'This conversation is opened from the booking itself.');\n  }\n  if (!PARTY_FIELDS[transactionType]) {", to: "  if (!PARTY_FIELDS[transactionType]) {", expect: /client cannot create an enquiry conversation/ },

  /* ── Healthcare consultation conversations (CHANGELOG 231) ── */
  { group: 'hcconv', browser: false, name: "forged relationship: hc_booking is no longer server-anchored", file: "functions/messages.js", suite: 'hcconv',
    from: "const SERVER_ANCHORED = new Set(['ent_booking', 'ent_enquiry', 'hc_booking']);", to: "const SERVER_ANCHORED = new Set(['ent_booking', 'ent_enquiry']);", expect: /createConversation refuses hc_booking/ },
  { group: 'hcconv', browser: false, name: "an unpaid booking counts as a clinical relationship", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "CLINICAL_STATUSES.includes(b.status) && CLINICAL_PAID.includes(b.paymentStatus);", to: "CLINICAL_STATUSES.includes(b.status);", expect: /unpaid booking/ },
  { group: 'hcconv', browser: false, name: "any provider booking counts (hub check removed)", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "  return !!b && b.commissionHub === 'healthcare' && CLINICAL_STATUSES", to: "  return !!b && CLINICAL_STATUSES", expect: /gen booking|ent booking|any other hub is NOT/ },
  { group: 'hcconv', browser: false, name: "the send gate is not consulted (relationship never re-read)", file: "functions/messages.js", suite: 'hcconv',
    from: "      await require('./healthcare-conversations').assertCanSend(db, conv, req.auth.uid, type === 'text' ? text : null);", to: "", expect: /RELATIONSHIP_ENDED|RATE_LIMITED|DUPLICATE/ },
  { group: 'hcconv', browser: false, name: "a reassigned provider keeps messaging (party re-check removed)", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "  if (uid !== booking.customerUid && uid !== booking.providerId) {", to: "  if (false) {", expect: /reassigned/ },
  { group: 'hcconv', browser: false, name: "no rate limit", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "    if (count >= LIMITS.perHour) {", to: "    if (false) {", expect: /RATE_LIMITED/ },
  { group: 'hcconv', browser: false, name: "no duplicate suppression", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "    if (d && d.exists && now - (Number(d.data().atMs) || 0) < LIMITS.duplicateWindowMs) {", to: "    if (false) {", expect: /DUPLICATE/ },
  { group: 'hcconv', browser: false, name: "a cancelled / refunded booking keeps an open chat (end not detected)", file: "functions/healthcare-conversations.js", suite: 'hcconv',
    from: "  if (isEnded(after)) return", to: "  if (false) return", expect: /read-only/ },
  { group: 'hcconv', browser: false, name: "the push shows the clinical message text again", file: "functions/messages.js", suite: 'hcconv',
    from: "        const clinical = conv.transactionType === 'hc_booking';", to: "        const clinical = false;", expect: /neither the text nor the sender/ },

  /* ── Healthcare public enquiries (CHANGELOG 232) ── */
  { group: 'hcenq', browser: false, name: "healthcare is inferred from free text (a self-described \"Clinic\")", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: "return !!(p.exists && require('./healthcare-category').categoryOf(p.data()));", to: "return !!(p.exists && (require('./healthcare-category').categoryOf(p.data()) || /clinic|hospital|pharmacy/i.test(String(p.data().category || ''))));", expect: /self-described/ },
  { group: 'hcenq', browser: false, name: "call requests are offered for healthcare providers", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: "callRequestsOpen: !hc && verifiedOk", to: "callRequestsOpen: verifiedOk", expect: /NO call requests/ },
  { group: 'hcenq', browser: false, name: "a healthcare call request is accepted", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: "    if (await _isHealthcare(providerUid)) fail('failed-precondition', 'Calls with healthcare providers are not available on SOKONI yet. Continue in the conversation.', { code: 'CALLS_DISABLED' });\n", to: "", expect: /call request to a healthcare provider is refused/ },
  { group: 'hcenq', browser: false, name: "Entertainment topics are accepted for a healthcare provider", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: "|| (hc && !HC_CATEGORIES.includes(category))", to: "", expect: /Entertainment-only topic is refused/ },
  { group: 'hcenq', browser: false, name: "the healthcare enquiry conversation is not tagged", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: ", hc ? { hub: 'healthcare' } : {}) });", to: ", {}) });", expect: /tagged hub|carries neither the text/ },
  { group: 'hcenq', browser: false, name: "a healthcare enquiry push shows the message text", file: "functions/messages.js", suite: 'hcenq',
    from: " || (conv.metadata && conv.metadata.hub === 'healthcare');", to: ";", expect: /carries neither the text/ },
  { group: 'hcenq', browser: false, name: "the clinical-privacy notice is dropped", file: "functions/ent-enquiries.js", suite: 'hcenq',
    from: "clinicalNotice: hc ? HC_NOTICE : null,", to: "clinicalNotice: null,", expect: /clinical-privacy notice/ },

  /* ── Healthcare category-aware workspace (CHANGELOG 233) ── */
  { group: 'hcws', browser: false, name: "providerRequestShop drops the category gate", file: "functions/provider-shop.js", suite: 'hcws',
    from: "  if (!HW.allows(hcCategory, cap.capabilities, 'posTill')) {", to: "  if (false) {", expect: /clinician on a paid plan is REFUSED/ },
  { group: 'hcws', browser: false, name: "a clinician is offered a Till", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "  clinician:    Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: true,  posTill: false,", to: "  clinician:    Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: true,  posTill: true,", expect: /NEVER offered to a clinician/ },
  { group: 'hcws', browser: false, name: "free text makes an account Healthcare", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "  const healthcare = !!(prov.healthcare && typeof prov.healthcare === 'object');", to: "  const healthcare = !!(prov.healthcare && typeof prov.healthcare === 'object') || /clinic|pharm/i.test(String(prov.category || ''));", expect: /free-text "Clinic" is NOT/ },
  { group: 'hcws', browser: false, name: "shop survival ignores the shop owner", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "    hasShop = sh.exists && String((sh.data() || {}).ownerId || '') === String(uid) && String((sh.data() || {}).status || '') === 'active';", to: "    hasShop = sh.exists;", expect: /owned by someone else confers nothing/ },
  { group: 'hcws', browser: false, name: "an existing shop overrides the category", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "      || (hasShop && SHOP_OPS.includes(op) && matrixFor(category)[op] === true);", to: "      || (hasShop && SHOP_OPS.includes(op));", expect: /never overrides the CATEGORY/ },
  { group: 'hcws', browser: false, name: "a lapsed plan takes the Till from a practice that has a Shop", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "      || (hasShop && SHOP_OPS.includes(op) && matrixFor(category)[op] === true);", to: "      || false;", expect: /keeps its Till, products and inventory/ },
  { group: 'hcws', browser: false, name: "a pharmacy roster is labelled Customers", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "    customersLabel: 'Patients',", to: "    customersLabel: category === 'pharmacy' ? 'Customers' : 'Patients',", expect: /labelled "Patients" for EVERY category/ },
  { group: 'hcws', browser: false, name: "the patient roster is plan-gated", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "const PLAN_GATED = Object.freeze({ posTill: 'shopRequestable',", to: "const PLAN_GATED = Object.freeze({ patients: 'shopRequestable', posTill: 'shopRequestable',", expect: /never plan-gated/ },
  { group: 'hcws', browser: false, name: "the workspace answers for data.uid", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "    return workspaceFor(getFirestore(), uid);", to: "    return workspaceFor(getFirestore(), (req.data && req.data.uid) || uid);", expect: /answers for the CALLER only/ },
  { group: 'hcws', browser: false, name: "an unwired POS section is listed", file: "functions/healthcare-workspace.js", suite: 'hcws',
    from: "const WIRED_SECTIONS = Object.freeze([]);", to: "const WIRED_SECTIONS = Object.freeze(['pos', 'products', 'inventory', 'delivery', 'staff']);", expect: /no dead ends/ },
  { group: 'hcws', browser: false, name: "the banner renders the label unescaped", file: "sokoni-health-workspace.js", suite: 'hcws',
    from: "'<div class=\"hc-ws-head\"><span class=\"hc-ws-cat\">' + esc(w.label) + '</span>'", to: "'<div class=\"hc-ws-head\"><span class=\"hc-ws-cat\">' + w.label + '</span>'", expect: /escaped/ },

  /* ── Healthcare availability through the ONE authority (CHANGELOG 234) ── */
  { group: 'hcavail', browser: false, name: "a Healthcare provider updates its availability directly (rules)", file: "firestore.rules.build", suite: "hcavailrules",
    from: "  allow update: if isAuthed() && request.auth.uid == uid && !hcProvider();", to: "  allow update: if isAuthed() && request.auth.uid == uid;", expect: /updating its own availability DENIED/ },
  { group: 'hcavail', browser: false, name: "a Healthcare provider writes a closure override directly (rules)", file: "firestore.rules.build", suite: "hcavailrules",
    from: "  allow write: if isAuthed() && request.auth.uid == uid && !hcProvider();\n  }\n  }", to: "  allow write: if isAuthed() && request.auth.uid == uid;\n  }\n  }", expect: /closure override DENIED/ },
  { group: 'hcavail', browser: false, name: "the rules recognise no Healthcare provider (predicate always false)", file: "firestore.rules.build", suite: "hcavailrules",
    from: "  && ('healthcare' in get(/databases/$(database)/documents/providers/$(uid)).data);", to: "  && false;", expect: /DENIED/ },
  { group: 'hcavail', browser: false, name: "the lock goes the other way: every provider loses its direct write", file: "firestore.rules.build", suite: "hcavailrules",
    from: "  allow update: if isAuthed() && request.auth.uid == uid && !hcProvider();", to: "  allow update: if false;", expect: /photographer still updates/ },
  { group: 'hcavail', browser: false, name: "the legacy healthcare booking path is restored", file: "functions/healthcare-hub.js", suite: "hcavail",
    from: "  requireAuth(req);\n  throw new HttpsError('failed-precondition',\n    'Appointments are booked from the provider page on SOKONI. Nothing was booked.',", to: "  requireAuth(req);\n  await db().collection('healthSlotLocks').doc('x_' + Date.now()).set({ at: 1 });\n  throw new HttpsError('failed-precondition',\n    'Appointments are booked from the provider page on SOKONI. Nothing was booked.',", expect: /writes no appointment and no slot lock/ },
  { group: 'hcavail', browser: false, name: "the booking pre-check doubles the buffer again", file: "functions/booking-service.js", suite: "hcavail",
    from: "    const overlapCount = existing.filter(b => startTs < Number(b.endTs) + bufMs && endTs > Number(b.startTs) - bufMs).length;", to: "    const overlapCount = existing.filter(b => rc.pairOverlaps(startTs, endTs, b.startTs, b.endTs, bufMs, bufMs)).length;", expect: /agree on every slot/ },
  { group: 'hcavail', browser: false, name: "the booking pre-check ignores buffers", file: "functions/booking-service.js", suite: "hcavail",
    from: "    const overlapCount = existing.filter(b => startTs < Number(b.endTs) + bufMs && endTs > Number(b.startTs) - bufMs).length;", to: "    const overlapCount = existing.filter(b => startTs < Number(b.endTs) && endTs > Number(b.startTs)).length;", expect: /buffer refuses 10:30|agree on every slot/ },
  { group: 'hcavail', browser: false, name: "the dashboard block-a-date writes Firestore directly", file: "sokoni-health-workspace.js", suite: "hcavail",
    from: "      return close(d, 'Blocked', 'Date blocked: ' + d);", to: "      return firebase.firestore().collection('providerAvailability').doc('me').collection('overrides').doc(d).set({ closed: true });", expect: /NOTHING was written|block a date/ },
  { group: 'hcavail', browser: false, name: "vacation is sent without an end date", file: "sokoni-health-workspace.js", suite: "hcavail",
    from: "      return call('setVacationMode', { active: true, startDate: start, endDate: end })", to: "      return call('setVacationMode', { active: true, startDate: start })", expect: /start AND an end date/ },
  { group: 'hcavail', browser: false, name: "a success toast before the server answered", file: "sokoni-health-workspace.js", suite: "hcavail",
    from: "      busy('Saving…');\n      return call('addAvailabilityOverride', { date: date, closed: true, label: label })\n        .then(function () { done(); say(okMsg); refresh(); }, function (e) { done(); failed(e); });", to: "      say(okMsg);\n      return call('addAvailabilityOverride', { date: date, closed: true, label: label })\n        .then(function () { done(); refresh(); }, function (e) { done(); failed(e); });", expect: /server refusal shows an error and no success/ },
  { group: 'hcavail', browser: false, name: "the editor keeps the page's direct-write sheet", file: "sokoni-health-workspace.js", suite: "hcavail",
    from: "      AvE.open = function () {", to: "      AvE._unused = function () {", expect: /editor opens the server-backed|NOTHING was written/ },
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
