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
  notify:   ['node', ['scripts/test-event-notifications.js']],
  rules:    ['node', ['scripts/run-entertainment-rules.js']],
  browser:  ['node', ['scripts/test-event-ops-browser.js']],
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
const EH_ = 'functions/event-hub.js';

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
  { group: 'fiscal', name: 'a pending sale shown as KRA-CONFIRMED with an invented receipt', file: FIS, suite: 'identity',
    from: "  if (!f.invoiceId || !inv) return { ...base, status: VIEW.PENDING };", to: "  if (!f.invoiceId || !inv) return { ...base, status: VIEW.CONFIRMED, receiptNumber: 'SOKONI-' + f.saleKey };",
    expect: /PENDING|no KRA field/ },
  { group: 'fiscal', name: 'a non-https KRA value rendered as an image / link', file: FIS, suite: 'identity',
    from: 'const _https = (u) => (typeof u === \'string\' && /^https:\\/\\/[^\\s"\'<>]+$/.test(u) ? u : null);', to: 'const _https = (u) => u || null;',
    expect: /non-https/ },
  { group: 'fiscal', name: 'free tickets fiscalised (a sale that never happened)', file: FIS, suite: 'identity',
    from: '  if (!(Number(grossCents) > 0)) return false;\n', to: '',
    expect: /free tickets → NO fiscal record/ },
  { group: 'fiscal', name: 'failed submissions retried without bound', file: FIS, suite: 'identity',
    from: '    .concat(errs.docs.filter((d) => (Number(d.data().attempts) || 0) < MAX_ATTEMPTS));', to: '    .concat(errs.docs);',
    expect: /bounded/ },
  { group: 'fiscal', name: 'fiscal state gates the ticket (unpaid-to-KRA ticket void)', file: FIS, suite: 'identity',
    from: '  if (f.status === REC.SUBMISSION_ERROR) return { ...base, status: VIEW.FAILED, reason: \'submission_error\' };',
    to: '  if (f.status === REC.SUBMISSION_ERROR) { require(\'firebase-admin/firestore\').getFirestore().doc(\'eventTickets/\' + (f.orderId || \'_\') + \'_k0\').set({ status: \'void\' }, { merge: true }); return { ...base, status: VIEW.FAILED, reason: \'submission_error\' }; }',
    expect: /ticket still valid|states are separate/ },
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
  { group: 'sales', name: 'cash below the total accepted', file: SALES, suite: 'sales',
    from: 'if (!(received >= grossCents)) fail(', to: 'if (false) fail(', expect: /cash below the total refused/ },
  { group: 'sales', name: 'another cashier may replay a sale key', file: SALES, suite: 'sales',
    from: 'if (c.actorUid !== actor.uid) fail(', to: 'if (false) fail(', expect: /another cashier cannot reuse the key/ },
  { group: 'sales', name: 'tier availability not checked (oversell)', file: SALES, suite: 'sales',
    from: "    if ((Number(t.quantity) || 0) - (Number(t.sold) || 0) < want) fail(", to: '    if (false) fail(', expect: /exactly 3 succeed|sold out/ },
  { group: 'sales', name: 'door commission priced at the POS rate (5 %) not events (3 %)', file: SALES, suite: 'sales',
    from: "POLICY.commissionCents('event_ticket', { grossCents, providerFeeCents: 0 })", to: "POLICY.commissionCents('pos_till', { grossCents, providerFeeCents: 0 })", expect: /3 %/ },
  { group: 'sales', name: 'release pays the organizer without netting door commission', file: ES, suite: 'sales',
    from: '    for (const r of recs) {', to: '    for (const r of []) {', expect: /nets outstanding door-sale commission|COLLECTED|collects PART/ },
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
];

const argv = process.argv.slice(2);
const noRules = argv.includes('--no-rules');
const noBrowser = argv.includes('--no-browser');
const onlyGroup = (argv.find((a) => a.startsWith('--group=')) || '').slice(8) || null;

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

const tally = { CAUGHT: 0, 'CAUGHT-OTHER': 0, MISSED: 0, CRASHED: 0, 'NO-ANCHOR': 0, SKIPPED: 0 };
const used = new Set();
for (const m of M) {
  if ((m.rules && noRules) || (m.browser && noBrowser) || (onlyGroup && m.group !== onlyGroup)) { tally.SKIPPED++; continue; }
  used.add(m.suite);
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file);
  /* CRLF files: match the anchors in the file's own line endings. */
  const crlf = orig.includes(Buffer.from('\r\n'));
  const fix = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  const mm = { ...m, from: m.from && fix(m.from), to: m.to != null ? fix(m.to) : m.to, edits: m.edits && m.edits.map((e) => ({ from: fix(e.from), to: fix(e.to) })) };
  const res = apply(orig.toString('utf8'), mm);
  if (res.error) { tally['NO-ANCHOR']++; console.log(`  ?  NO-ANCHOR     ${m.name}   [${res.error}]`); continue; }
  let verdict;
  try {
    fs.writeFileSync(file, res.out);
    const r = run(m.suite);
    const failLines = r.out.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
    if (/HARNESS CRASHED|^CRASH/m.test(r.out) && failLines.length === 0) verdict = 'CRASHED';
    else if (r.code === 0) verdict = 'MISSED';
    else if (failLines.some((l) => m.expect.test(l))) verdict = 'CAUGHT';
    else verdict = failLines.length ? 'CAUGHT-OTHER' : 'CRASHED';
    tally[verdict]++;
    const mark = verdict === 'CAUGHT' ? '✓' : verdict === 'CAUGHT-OTHER' ? '~' : '✗';
    console.log(`  ${mark}  ${verdict.padEnd(13)} [${m.group}] ${m.name}` + (verdict !== 'CAUGHT' ? `   [${(failLines[0] || r.out.split('\n').slice(-3).join(' ')).trim().slice(0, 140)}]` : ''));
  } finally {
    fs.writeFileSync(file, orig);
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
const clean = spawnSync('git', ['diff', '--quiet', '--', ...new Set(M.map((m) => m.file))], { cwd: ROOT }).status === 0;
console.log(`    tree      ${clean ? 'byte-identical to HEAD for every sabotaged file' : 'DIRTY — restore failed (or uncommitted edits in a sabotaged file)'}`);
console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
const ok = tally.MISSED === 0 && tally.CRASHED === 0 && tally['NO-ANCHOR'] === 0 && green && clean;
process.exit(ok ? 0 : 1);
