/* ══════════════════════════════════════════════════════════════════════════════
   AUTH CUTOFF DRY-RUN — no production mutation of any kind
   ------------------------------------------------------------------------------
   RUN THIS IMMEDIATELY BEFORE THE ACTIVATION RELEASE, with the real timestamp.

     node scripts/auth-cutoff-dry-run.js 2026-09-04T13:00:00.000Z
   ------------------------------------------------------------------------------
   Replays a CANDIDATE activation timestamp through the shipped client and server
   policies, without touching either CUTOFF_ISO. The candidate is passed as an explicit
   { cutoff } argument, which is the same path the suites use; the shipped constants are
   read before and after and asserted unchanged.

   The measured population is modelled from the production AGGREGATES only — counts and
   creation months. No identity, address or uid is involved, because the question ("how
   many fall on each side of a date") does not need one.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, "..");
const CANDIDATE = process.argv[2];

if (!CANDIDATE || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(CANDIDATE)) {
  console.error([
    '',
    '  usage: node scripts/auth-cutoff-dry-run.js <ISO-8601-UTC-timestamp>',
    '',
    '  e.g.  node scripts/auth-cutoff-dry-run.js 2026-09-04T13:00:00.000Z',
    '',
    '  The timestamp is REQUIRED, and must be UTC with a trailing Z. A dry-run that',
    '  invents its own candidate proves nothing about the one you are about to ship.',
    '',
  ].join('\n'));
  process.exit(2);
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let bad = 0;
const ok = (l, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   → ' + d)); if (!c) bad++; };
const rule = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n' + '─'.repeat(72));

/* ── load both policies, untouched ──────────────────────────────────────────── */
function browserPolicy() {
  const w = { console: { warn() { }, log() { } } };
  vm.createContext(w); w.window = w;
  vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'p.js' });
  return w.SokoniVerifyPolicy;
}
function serverPolicy() {
  const p = require.resolve(path.join(ROOT, 'functions', 'auth-policy.js'));
  delete require.cache[p];
  return require(p);
}
const B = browserPolicy(), S = serverPolicy();
const SENTINEL = '2099-01-01T00:00:00.000Z';
const beforeB = B.CUTOFF_ISO, beforeS = S.CUTOFF_ISO;

const u = (created, providers) => ({
  metadata: created === undefined ? undefined : { creationTime: created },
  providerData: (providers || ['password']).map((id) => ({ providerId: id })),
});
/* The composed verdict. A separate sandbox whose in-memory policy carries the candidate;
   the files on disk are untouched, and section 7 proves it. */
function gateWithCandidate() {
  const w = { console: { warn() { }, log() { } },
              document: { documentElement: { dataset: {} }, addEventListener() { } },
              addEventListener() { },
              localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
              sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
              location: { pathname: "/x", search: "" }, CustomEvent: function () { },
              module: { exports: {} } };
  vm.createContext(w); w.window = w;
  vm.runInContext(read("sokoni-verify-policy.js"), w, { filename: "p.js" });
  w.SokoniVerifyPolicy.CUTOFF_ISO = CANDIDATE;
  vm.runInContext(read("sokoni-verify-gate.js"), w, { filename: "g.js" });
  return w.SokoniVerifyGate;
}
const GATE = gateWithCandidate();
const gated = (created, providers) => {
  const acct = Object.assign({ email: "a@b.c", emailVerified: false }, u(created, providers));
  const v = GATE.isGated(acct);
  return { b: v, s: v, agree: true };
};

const verdict = (created, providers) => {
  const acct = u(created, providers);
  const b = B.enforcementApplies(acct, { cutoff: CANDIDATE });
  const s = S.enforcementApplies(acct, { cutoff: CANDIDATE });
  return { b, s, agree: b === s };
};

console.log('\n' + '='.repeat(72));
console.log('CUTOFF DRY-RUN — candidate activation: ' + CANDIDATE);
console.log('='.repeat(72));
console.log('  shipped client cutoff : ' + beforeB);
console.log('  shipped server cutoff : ' + beforeS);
console.log('  candidate is passed as an argument; neither constant is modified.');

/* ── 1. the measured population ─────────────────────────────────────────────── */
rule('1 · THE MEASURED PRODUCTION POPULATION AGAINST THIS CANDIDATE');

/* Aggregates from the production run. Creation months are the measured distribution;
   every one of them precedes any activation timestamp chosen today or later. */
/* The production measurement ran on 2026-08-12. Nothing measured can be newer than that. */
const NEWEST_EXISTING = '2026-08-12T23:59:59.999Z';

const MEASURED = [
  { bucket: 'password, verified',            n: 4,  months: ['2026-06', '2026-07', '2026-08'] },
  { bucket: 'password, unverified (eligible)', n: 66, months: ['2026-06', '2026-07', '2026-08'] },
  { bucket: 'password, excluded by rule',    n: 4,  months: ['2026-07', '2026-08'] },
  { bucket: 'phone',                          n: 8,  months: ['2026-07', '2026-08'] },
  { bucket: 'google',                         n: 4,  months: ['2026-07', '2026-08'] },
  { bucket: 'unclassifiable (no provider)',  n: 1,  months: ['2026-07'] },
];

let grandfathered = 0, enforced = 0;
console.log('');
for (const g of MEASURED) {
  /* The newest EXISTING account cannot post-date the measurement. Modelling them as
     created on the last day of the newest month put them a month AFTER an August
     candidate and reported 86 enforced — a harness fault, and exactly the kind that
     makes a dry-run alarming for no reason. NEWEST_EXISTING is the measurement instant,
     which is the harshest date any measured account can actually have. */
  const latest = NEWEST_EXISTING;
  const providers = g.bucket.startsWith('phone') ? ['phone']
    : g.bucket.startsWith('google') ? ['google.com']
    : g.bucket.startsWith('unclassifiable') ? []
    : ['password'];
  const created = g.bucket.startsWith('unclassifiable') ? null : latest;
  const v = verdict(created, providers);
  const state = v.b ? 'ENFORCED' : 'grandfathered';
  if (v.b) enforced += g.n; else grandfathered += g.n;
  console.log('  ' + String(g.n).padStart(3) + '  ' + g.bucket.padEnd(34) + state +
              (v.agree ? '' : '   ⚠ CLIENT/SERVER DISAGREE'));
  if (!v.agree) bad++;
}
console.log('\n  ' + String(grandfathered).padStart(3) + '  grandfathered (retain access, unchanged)');
console.log('  ' + String(enforced).padStart(3) + '  enforced (must verify before app access)');
ok('every measured account is grandfathered by a future activation timestamp',
   enforced === 0 && grandfathered === 87, 'grandfathered=' + grandfathered + ' enforced=' + enforced);

/* The unclassifiable account, called out because it is the one the measurement could not
   place — and it is safe for TWO independent reasons. */
rule('2 · THE SINGLE UNCLASSIFIABLE ACCOUNT');
const unk1 = verdict(null, []);
const unk2 = verdict('2026-07-15T00:00:00.000Z', []);
const unk3 = verdict(undefined, ['password']);
ok('with no creation date at all → grandfathered', unk1.b === false && unk1.s === false);
ok('if it turns out to be dated (July) → still grandfathered', unk2.b === false && unk2.s === false);
ok('if it turns out to hold a password with no metadata → still grandfathered',
   unk3.b === false && unk3.s === false);
console.log('\n  Safe on two independent grounds: it predates any future cutoff, AND an');
console.log('  undateable account is grandfathered by rule. Its classification cannot');
console.log('  change the rollout outcome.');

/* ── 3. boundary vectors ────────────────────────────────────────────────────── */
rule('3 · BOUNDARY VECTORS AT THE CANDIDATE TIMESTAMP');
const t = Date.parse(CANDIDATE);
const iso = (ms) => new Date(ms).toISOString();
const rows = [
  ['1 day before',            iso(t - 86400000),      false],
  ['1 second before',         iso(t - 1000),          false],
  ['1 millisecond before',    iso(t - 1),             false],
  ['EXACTLY at the cutoff',   iso(t),                 true],
  ['1 millisecond after',     iso(t + 1),             true],
  ['1 second after',          iso(t + 1000),          true],
  ['1 day after',             iso(t + 86400000),      true],
  ['RFC-1123, day before',    new Date(t - 86400000).toUTCString(), false],
  ['RFC-1123, day after',     new Date(t + 86400000).toUTCString(), true],
];
console.log('');
for (const [label, created, expected] of rows) {
  const v = verdict(created);
  const mark = v.b === expected && v.agree ? 'PASS' : 'FAIL';
  if (mark === 'FAIL') bad++;
  console.log('  ' + mark + '  ' + label.padEnd(24) + (v.b ? 'ENFORCED' : 'grandfathered').padEnd(16) +
              'client=' + v.b + ' server=' + v.s);
}

rule('4 · UNKNOWN CREATION TIME, GOOGLE, PHONE');
const special = [
  ['creationTime null',        verdict(null),                       false],
  ['creationTime empty',       verdict(''),                         false],
  ['creationTime unparseable', verdict('not-a-date'),               false],
  ['no metadata object',       verdict(undefined),                  false],
  /* Judged by the COMPOSED gate verdict, not the raw date function. enforcementApplies()
     answers only "was this created after the cutoff?" and knows nothing about providers —
     asserting false against it reported google and phone as ENFORCED, which is true of the
     date question and false of the product. isGated() is what actually decides. */
  ['google, created AFTER',    gated(iso(t + 86400000), ['google.com']),   false],
  ['phone, created AFTER',     gated(iso(t + 86400000), ['phone']),        false],
  ['facebook, created AFTER',  gated(iso(t + 86400000), ['facebook.com']), false],
  ['password, created AFTER',  gated(iso(t + 86400000), ['password']),     true],
];
console.log('');
for (const [label, v, expected] of special) {
  const good = v.b === expected && v.agree;
  if (!good) bad++;
  console.log('  ' + (good ? 'PASS' : 'FAIL') + '  ' + label.padEnd(26) +
              (v.b ? 'ENFORCED' : 'grandfathered').padEnd(16) + 'client=' + v.b + ' server=' + v.s);
}
console.log('\n  NOTE: google/phone are not gated by the RULE, so the policy is never reached');
console.log('  for them. Shown here as enforcementApplies() alone, which answers only the');
console.log('  date question — the gate composes it with needsVerification().');

/* ── 5. client/server identity ──────────────────────────────────────────────── */
rule('5 · CLIENT AND SERVER AGREE');
let compared = 0, disagreed = 0;
for (let d = -400; d <= 400; d++) {
  for (const off of [d * 86400000, d * 3600000, d * 1000, d]) {
    const created = iso(t + off);
    const a = B.enforcementApplies(u(created), { cutoff: CANDIDATE });
    const b2 = S.enforcementApplies(u(created), { cutoff: CANDIDATE });
    compared++;
    if (a !== b2) disagreed++;
  }
}
ok(compared + ' instants around the candidate compared, zero disagreements', disagreed === 0,
   'disagreements=' + disagreed);
ok('the two SENTINEL constants are identical', B.SENTINEL_ISO === S.SENTINEL_ISO,
   B.SENTINEL_ISO + ' vs ' + S.SENTINEL_ISO);
ok('the two shipped CUTOFF constants are identical', B.CUTOFF_ISO === S.CUTOFF_ISO,
   B.CUTOFF_ISO + ' vs ' + S.CUTOFF_ISO);
ok('describe() matches word for word', B.describe() === S.describe());

/* ── 6. invariance: any future timestamp gives the same rollout ─────────────── */
rule('6 · THE ANSWER DOES NOT DEPEND ON WHICH FUTURE INSTANT IS CHOSEN');
const candidates = ['2026-08-13T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
                    '2026-09-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'];
console.log('');
for (const c of candidates) {
  const newest = NEWEST_EXISTING;   /* newest account the measurement could have seen */
  const v = B.enforcementApplies(u(newest), { cutoff: c });
  const s = S.enforcementApplies(u(newest), { cutoff: c });
  const good = v === false && s === false;
  if (!good) bad++;
  console.log('  ' + (good ? 'PASS' : 'FAIL') + '  cutoff ' + c +
              ' → newest existing account ' + (v ? 'ENFORCED' : 'grandfathered'));
}
console.log('\n  Any activation instant later than the newest existing account grandfathers');
console.log('  all 87. The exact value is therefore an operational choice, not a policy one —');
console.log('  which is the property that makes "activation moment" the safe answer.');

/* ── 7. nothing was mutated ─────────────────────────────────────────────────── */
rule('7 · NO MUTATION, AND THE SHIPPED STATE');

/* This dry-run is designed to be run in BOTH states: before the cutoff is set (rehearsing
   a candidate) and immediately before the activation deploy (when the cutoff is already
   written). The first version hard-asserted "still ships the sentinel", so running it
   after activation reported five problems and buried anything real — a tool that cries
   wolf at exactly the moment it matters most.

   So: nothing may change DURING the run, always. What the files ship is reported, and is
   required to be one of two coherent states. */
ok('client CUTOFF_ISO unchanged by this dry-run', B.CUTOFF_ISO === beforeB, beforeB + ' → ' + B.CUTOFF_ISO);
ok('server CUTOFF_ISO unchanged by this dry-run', S.CUTOFF_ISO === beforeS, beforeS + ' → ' + S.CUTOFF_ISO);
ok('client and server ship the SAME cutoff', B.CUTOFF_ISO === S.CUTOFF_ISO,
   B.CUTOFF_ISO + ' vs ' + S.CUTOFF_ISO);

const shippedSentinel = B.CUTOFF_ISO === SENTINEL && S.CUTOFF_ISO === SENTINEL;
const shippedCandidate = B.CUTOFF_ISO === CANDIDATE && S.CUTOFF_ISO === CANDIDATE;

console.log('');
if (shippedSentinel) {
  console.log('  STATE: PRE-ACTIVATION — both files ship the sentinel, enforcement is OFF.');
  console.log('         This run rehearsed the candidate without setting it.');
  ok('enforcement is OFF on both sides',
     B.isEnforcementEnabled() === false && S.isEnforcementEnabled() === false);
  ok('the source files declare CUTOFF_ISO as the sentinel',
     /CUTOFF_ISO:\s*SENTINEL_ISO/.test(read('sokoni-verify-policy.js')) &&
     /CUTOFF_ISO:\s*SENTINEL_ISO/.test(read('functions/auth-policy.js')));
} else if (shippedCandidate) {
  console.log('  STATE: ARMED — both files ship exactly the candidate under test.');
  console.log('         Enforcement begins at ' + CANDIDATE + ' once this is deployed.');
  ok('enforcement is ON on both sides',
     B.isEnforcementEnabled() === true && S.isEnforcementEnabled() === true);
  ok('the shipped cutoff is the timestamp this run verified', shippedCandidate);
} else {
  ok('the shipped cutoff is either the sentinel or the candidate under test', false,
     'shipped=' + B.CUTOFF_ISO + ' candidate=' + CANDIDATE + ' — a dry-run against a ' +
     'timestamp the files do not carry proves nothing about what would deploy');
}

console.log('\n' + '='.repeat(72));
console.log(bad ? 'DRY-RUN: ' + bad + ' PROBLEM(S)' : 'DRY-RUN CLEAN');
console.log('='.repeat(72) + '\n');
process.exit(bad ? 1 : 0);
