/* sabotage-entertainment.js — plant each attack the Entertainment slice must stop, run the suite
 * that owns it, and require the EXPECTED case to go red.
 *
 *   CAUGHT        suite failed, and on the expected case
 *   CAUGHT-OTHER  suite failed, but not on the expected case (counted caught, flagged)
 *   MISSED        suite stayed green — the control is inert
 *   CRASHED       suite crashed — not a detection
 *   NO-ANCHOR     the code to sabotage is gone — the mutation proves nothing
 *
 * Every file is restored byte-for-byte in `finally`; a post-restore run proves the tree is green
 * again. Run with the worktree QUIESCENT (no other suite running against these files).
 *
 *   node scripts/sabotage-entertainment.js              (all, incl. emulator rules + browser)
 *   node scripts/sabotage-entertainment.js --no-rules   (skip emulator mutations)
 *   node scripts/sabotage-entertainment.js --no-browser (skip the Chromium mutation)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITES = {
  event:    ['node', ['scripts/test-event-settlement.js']],
  registry: ['node', ['scripts/test-entertainment-registry.js']],
  rules:    ['node', ['scripts/run-entertainment-rules.js']],
  browser:  ['node', ['scripts/test-entertainment-browser.js']],
};
const ES = 'functions/event-settlement.js';
const POL = 'functions/shared/commercial-policy.js';
const SSP = 'functions/shared/self-settling-purposes.js';
const PP = 'functions/payment-purposes.js';
const RA = 'functions/role-authority.js';
const EA = 'functions/entertainment-admin.js';
const REG = 'functions/shared/entertainment-registry.js';
const HC = 'functions/hosted-checkout.js';
const EHUB = 'functions/entertainment-hub.js';
const RULES = 'firestore.rules.build';

const M = [
  /* ── money: the webhook, the rate, the basis ── */
  { group: 'money', name: 'webhook: event_ticket no longer self-settling (buyer credited)', file: SSP, suite: 'event',
    from: "new Set(['film_access', 'event_ticket'])", to: "new Set(['film_access'])", expect: /branch: NO wallet written|event_ticket is a self-settling purpose/ },
  { group: 'money', name: 'event commission charged on GROSS (provider fee not deducted first)', file: POL, suite: 'event',
    from: "commercialPolicyId: 'event_ticket_v1',\n    domain: 'entertainment', hubId: 'events', transactionType: 'ticket_sale',\n    basis: BASIS.NET_OF_PROVIDER_FEE,",
    to: "commercialPolicyId: 'event_ticket_v1',\n    domain: 'entertainment', hubId: 'events', transactionType: 'ticket_sale',\n    basis: BASIS.GROSS,",
    expect: /3 % of NET|commission = 3 % of \(gross − fee\)/ },
  { group: 'money', name: 'events priced at the PPV rate (a flattened entertainment rate)', file: POL, suite: 'event',
    from: "resolve: () => { const r = CC.resolveRate('event_tickets'); return { pct: r.pct, source: 'commission-config.RATES.event_tickets' }; },",
    to: "resolve: () => { const r = CC.resolveRate('ppv'); return { pct: r.pct, source: 'commission-config.RATES.event_tickets' }; },",
    expect: /Events 3 % per ticket|3 % of NET/ },
  { group: 'money', name: 'unreported provider fee assumed ZERO (commission booked on a guess)', file: ES, suite: 'event',
    from: "const fee = providerFee(ctx.payment || {});\n    const s = computeSettlement({ grossCents: ctx.amountCents, providerFeeCents: fee.cents });",
    to: "const fee = providerFee(ctx.payment || {});\n    const s = computeSettlement({ grossCents: ctx.amountCents, providerFeeCents: fee.cents == null ? 0 : fee.cents });",
    expect: /unreported fee: settlement FEE_UNREPORTED/ },
  /* ── release ── */
  { group: 'release', name: 'cancelled event still pays the organizer', file: ES, suite: 'event',
    from: "if (ev.status === 'cancelled') return { skipped: 'event_cancelled' };", to: '', expect: /cancelled event never releases/ },
  { group: 'release', name: 'release ignores an open refund request', file: ES, suite: 'event',
    from: "if (refSnap.exists && REFUND_OPEN.has(String(refSnap.data().status))) return { skipped: 'refund_open' };", to: '', expect: /open refund request blocks release/ },
  { group: 'release', name: 'release is not exactly-once (status guard removed)', file: ES, suite: 'event',
    from: "if (s.status !== SETTLEMENT.HELD) return { skipped: `status_${s.status}` };", to: "if (s.status === 'NEVER') return { skipped: 'x' };",
    expect: /replay release → skipped|FEE_UNREPORTED never releases/ },
  { group: 'release', name: 'organizer paid before the event has happened', file: ES, suite: 'event',
    from: "if (rel == null || nowMs < rel) return { skipped: 'not_due' };", to: '', expect: /not due before the event ends/ },
  /* ── refunds ── */
  { group: 'refund', name: 'refund after release silently ignored (no exception for a human)', file: ES, suite: 'event',
    from: "} else if (st === SETTLEMENT.RELEASED) {", to: "} else if (false) {", expect: /refund AFTER release → exception/ },
  { group: 'refund', name: 'partial refund revokes every ticket', file: ES, suite: 'event',
    from: "if (Number(amountCents) < Number(intent.amountCents)) {", to: "if (false) {", expect: /partial refund → exception, tickets untouched/ },
  /* ── pricing authority ── */
  { group: 'pricing', name: "pricer quotes another buyer's order", file: PP, suite: 'event',
    from: "if (o.buyerUid !== uid) fail('permission-denied', 'This order belongs to another account.');", to: '', expect: /another buyer's order refused by the pricer itself/ },
  { group: 'pricing', name: 'pricer trusts a client amount', file: PP, suite: 'event',
    from: "const cents = Math.round(Number(o.totalAmount) * 100);\n      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', 'Order has no payable total.');",
    to: "const cents = Math.round(Number(data.amount || o.totalAmount) * 100);\n      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', 'Order has no payable total.');",
    expect: /server amount = order total/ },
  { group: 'pricing', name: 'an already-paid order can be paid again', file: PP, suite: 'event',
    from: "if (o.status !== 'pending_payment') fail('failed-precondition', `Order is ${o.status || 'unknown'}, not awaiting payment.`);", to: '',
    expect: /already-paid order refused/ },
  /* ── expiry ── */
  { group: 'expiry', name: 'an in-flight PENDING payment is expired (buyer pays, seats gone)', file: ES, suite: 'event',
    from: "if (TERMINAL_PAID.has(ps) || ['PENDING', 'PROCESSING', 'INITIATED'].includes(ps)) return { skipped: `payment_${ps}` };",
    to: "if (TERMINAL_PAID.has(ps)) return { skipped: `payment_${ps}` };", expect: /PENDING payment is never expired/ },
  { group: 'expiry', name: 'late payment after expiry does not re-reserve seats', file: ES, suite: 'event',
    from: "if (wasExpired && tierSnap.exists) {", to: "if (false) {", expect: /seats re-reserved and an oversold alert/ },
  /* ── AdminOS authority ── */
  { group: 'admin', name: 'fee attestation downgraded to ordinary admin', file: ES, suite: 'event',
    from: "_adminH.eventAdminAttestFee = async (req) => {\n  const actor = _superAdmin(req);", to: "_adminH.eventAdminAttestFee = async (req) => {\n  const actor = _admin(req);",
    expect: /fee attest refuses an ordinary admin/ },
  { group: 'admin', name: 'event overview open to any signed-in user', file: ES, suite: 'event',
    from: "_adminH.eventAdminOverview = async (req) => {\n  _admin(req);", to: "_adminH.eventAdminOverview = async (req) => {\n  _uid(req);",
    expect: /eventAdminOverview refuses a plain user/ },
  { group: 'admin', name: 'listing moderation open to any signed-in user', file: EA, suite: 'registry',
    from: "_adminH.entAdminSetListingStatus = async (req) => {\n  const actor = _admin(req);",
    to: "_adminH.entAdminSetListingStatus = async (req) => {\n  const actor = (req.auth && req.auth.uid) || 'anon';",
    expect: /entAdminSetListingStatus refuses a plain user/ },
  { group: 'admin', name: 'moderation state machine: approve an already-active listing', file: EA, suite: 'registry',
    from: "approve: ['pending'], reject: ['pending'],", to: "approve: ['pending', 'active'], reject: ['pending'],", expect: /approve again refused/ },
  { group: 'admin', name: 'moderation without a reason', file: EA, suite: 'registry',
    from: "if (decision !== 'approve' && reason.length < 5) fail('invalid-argument', 'A reason is required.');", to: '', expect: /suspend without a reason refused/ },
  /* ── roles / approval ── */
  { group: 'roles', name: 'event_organizer falls back to provider (wrong role, wrong dashboard)', file: RA, suite: 'registry',
    from: "  event_organizer: 'event_organizer',\n});", to: "});", expect: /keeps its OWN key|approval grants users\.roles event_organizer/ },
  { group: 'roles', name: 'rejection leaves the organizer claim in place', file: RA, suite: 'registry',
    from: "if (role === 'event_organizer') claims.event_organizer = !!approved;", to: "if (role === 'event_organizer') claims.event_organizer = true;",
    expect: /rejection revokes the role AND the claim/ },
  { group: 'roles', name: 'registry: a category loses its dashboard (orphan)', file: REG, suite: 'registry',
    from: "      dashboard: { path: '/venue-manager.html', tier: TIER.PREMIUM },", to: "      dashboard: {},", expect: /no category is missing a lifecycle step/ },
  /* ── payment methods / legacy ── */
  { group: 'payment', name: 'hosted methods offered for a purpose that was never enabled', file: HC, suite: 'registry',
    from: "const hosted = cfg.enabled === true && Array.isArray(cfg.purposes) && cfg.purposes.includes(purpose) && proven.length > 0;",
    to: "const hosted = cfg.enabled === true && proven.length > 0;", expect: /enabled for film only → event_ticket still M-PESA only/ },
  { group: 'payment', name: 'legacy paid PPV reopened (pending_payment nothing completes)', file: EHUB, suite: 'registry',
    from: "  throw new HttpsError('failed-precondition',\n    'Paid entertainment is sold through Creator Hub. This listing cannot be purchased here.');",
    to: "  return { status: 'pending_payment' };", expect: /paid legacy PPV refused/ },
  /* ── rules (real emulator, served ruleset) ── */
  { group: 'rules', name: 'rules: client may mint entTickets again', file: RULES, suite: 'rules', rules: true,
    from: /match \/entTickets\/\{ticketId\} \{\s*allow create: if false;/, to: (m) => m.replace('allow create: if false;', 'allow create: if claimsOwner();'),
    expect: /client mints a VALID entTickets doc/ },
  { group: 'rules', name: 'rules: venue created active (review skipped)', file: RULES, suite: 'rules', rules: true,
    from: /match \/entVenues\/\{venueId\} \{\s*allow read:\s*if true;\s*allow create: if claimsOwner\(\) && request\.resource\.data\.get\('status', 'pending'\) == 'pending';/,
    to: (m) => m.replace(" && request.resource.data.get('status', 'pending') == 'pending'", ''), expect: /venue created ACTIVE/ },
  { group: 'rules', name: "rules: any user reads another organizer's settlement", file: RULES, suite: 'rules', rules: true,
    from: /match \/eventSettlements\/\{paymentRef\} \{\s*allow read:[^;]*;/, to: (m) => m.replace(/allow read:[^;]*;/, 'allow read: if isAuthed();'),
    expect: /stranger reads another organizer's settlement DENIED/ },
  /* ── browser ── */
  { group: 'browser', name: 'profile menu: horizontal fit removed (popup off-screen in a sidebar)', file: 'sokoni-dashboard-profile.js', suite: 'browser', browser: true,
    from: "if (r.left < 8) popup.classList.add('sk-left');", to: '', expect: /provider-dashboard @1024: menu opens fully inside the viewport/ },
];

const noRules = process.argv.includes('--no-rules');
const noBrowser = process.argv.includes('--no-browser');
const onlyGroup = (process.argv.find((a) => a.startsWith('--group=')) || '').slice(8) || null;
const onlyName = (process.argv.find((a) => a.startsWith('--match=')) || '').slice(8) || null;
function run(suite) {
  const [cmd, args] = SUITES[suite];
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function apply(src, m) {
  if (typeof m.from === 'string') {
    const n = src.split(m.from).length - 1;
    if (n !== 1) return { error: `anchor found ${n}×: ${m.from.slice(0, 60)}` };
    return { out: src.replace(m.from, m.to) };
  }
  if (!src.match(m.from)) return { error: `regex anchor not found: ${m.from}` };
  return { out: src.replace(m.from, m.to) };
}

const tally = { CAUGHT: 0, 'CAUGHT-OTHER': 0, MISSED: 0, CRASHED: 0, 'NO-ANCHOR': 0, SKIPPED: 0 };
for (const m of M) {
  if ((m.rules && noRules) || (m.browser && noBrowser) || (onlyGroup && m.group !== onlyGroup) || (onlyName && !m.name.includes(onlyName))) { tally.SKIPPED++; continue; }
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file);
  const res = apply(orig.toString('utf8'), m);
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
    console.log(`  ${mark}  ${verdict.padEnd(13)} ${m.name}` + (verdict !== 'CAUGHT' ? `   [${(failLines[0] || r.out.split('\n').slice(-3).join(' ')).trim().slice(0, 120)}]` : ''));
  } finally {
    fs.writeFileSync(file, orig);
  }
}

console.log('\n  post-restore:');
let green = true;
for (const s of ['event', 'registry'].concat(noRules ? [] : ['rules']).concat(noBrowser ? [] : ['browser'])) {
  const r = run(s);
  const t = (r.out.match(/\d+ passed, \d+ failed/) || ['?'])[0];
  console.log(`    ${s.padEnd(9)} ${r.code === 0 ? 'GREEN' : 'RED'}  ${t}`);
  if (r.code !== 0) green = false;
}
const clean = spawnSync('git', ['diff', '--quiet', '--', ...new Set(M.map((m) => m.file))], { cwd: ROOT }).status === 0;
console.log(`    tree      ${clean ? 'byte-identical to HEAD for every sabotaged file' : 'DIRTY — restore failed'}`);
console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
const ok = tally.MISSED === 0 && tally.CRASHED === 0 && tally['NO-ANCHOR'] === 0 && green && clean;
process.exit(ok ? 0 : 1);
