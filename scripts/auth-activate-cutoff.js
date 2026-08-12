/* ══════════════════════════════════════════════════════════════════════════════
   AUTH — set the enforcement cutoff on BOTH sides, atomically
   ------------------------------------------------------------------------------
   This is the one edit that turns email-verification enforcement on. It does not
   deploy, and it refuses to run without an explicit confirmation flag.

     node scripts/auth-activate-cutoff.js --check
     node scripts/auth-activate-cutoff.js 2026-09-04T13:00:00.000Z --confirm
     node scripts/auth-activate-cutoff.js --revert --confirm

   WHY A SCRIPT RATHER THAN TWO HAND-EDITS
   ---------------------------------------
   The cutoff lives in two files, because a functions deploy uploads only functions/
   and the deployed code cannot require the client copy. At activation, under release
   pressure, editing two constants by hand is precisely where one gets missed — and a
   client that enforces from Tuesday while the server thinks Thursday is a divergence
   the suites would catch only if someone remembered to run them. One input, both
   files, or neither.

   WHAT IT REFUSES
   ---------------
     · a timestamp that is not ISO-8601 UTC with a trailing Z
     · a HISTORICAL timestamp — the policy is "enforcement begins when we turn it on",
       not a retroactive restriction. Anything before the production measurement
       (2026-08-12) would silently convert grandfathering into a cutoff nobody chose.
     · a timestamp far in the future, which is a sentinel wearing a real date and
       would leave enforcement quietly off while looking active
     · running at all without --confirm

   AFTER RUNNING IT
   ----------------
     1. node scripts/auth-cutoff-dry-run.js <the same timestamp>
     2. the auth suites
     3. commit
     4. deploy hosting AND functions together — never the gate alone
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'sokoni-verify-policy.js');
const SERVER = path.join(ROOT, 'functions', 'auth-policy.js');
const SENTINEL = '2099-01-01T00:00:00.000Z';

/* The production measurement. A cutoff earlier than this cannot be an "activation
   moment" — it would be a retroactive rule applied to accounts already counted. */
const MEASUREMENT = '2026-08-12T00:00:00.000Z';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const stamp = argv.find((a) => /^\d{4}-\d{2}-\d{2}T/.test(a)) || null;

/* Both files declare the constant the same way, so one expression finds both. */
const DECL = /(CUTOFF_ISO:\s*)(SENTINEL_ISO|'[^']*')/;

function currentOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = DECL.exec(src);
  if (!m) throw new Error('cutoff declaration not found in ' + path.basename(file));
  return m[2] === 'SENTINEL_ISO' ? SENTINEL : m[2].slice(1, -1);
}

function report() {
  const c = currentOf(CLIENT), s = currentOf(SERVER);
  console.log('\n  client (sokoni-verify-policy.js) : ' + c);
  console.log('  server (functions/auth-policy.js): ' + s);
  console.log('  identical                        : ' + (c === s ? 'yes' : 'NO — DIVERGED'));
  console.log('  enforcement                      : ' +
              (c === SENTINEL && s === SENTINEL ? 'OFF (sentinel)' : 'ON'));
  console.log('');
  return c === s;
}

if (has('--check') || (!stamp && !has('--revert'))) {
  const same = report();
  if (!same) {
    console.error('  THE TWO CUTOFFS HAVE DIVERGED. Do not deploy. Re-run this script with a\n' +
                  '  single timestamp and --confirm to bring them back into agreement.\n');
    process.exit(1);
  }
  if (!has('--check')) {
    console.log('  usage: node scripts/auth-activate-cutoff.js <ISO-UTC-timestamp> --confirm');
    console.log('         node scripts/auth-activate-cutoff.js --revert --confirm\n');
  }
  process.exit(0);
}

/* ── write ──────────────────────────────────────────────────────────────────── */
const target = has('--revert') ? 'SENTINEL' : stamp;

if (!has('--revert')) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp || '')) {
    console.error('\n  Timestamp must be ISO-8601 UTC with milliseconds and a trailing Z,\n' +
                  '  e.g. 2026-09-04T13:00:00.000Z\n');
    process.exit(2);
  }
  const t = Date.parse(stamp);
  if (t < Date.parse(MEASUREMENT)) {
    console.error('\n  REFUSED: ' + stamp + ' predates the production measurement (' + MEASUREMENT + ').\n' +
                  '  The agreed policy is that enforcement begins when it is turned on. A cutoff\n' +
                  '  earlier than the measurement is a retroactive restriction, and would gate\n' +
                  '  accounts the grandfathering decision was made to protect.\n');
    process.exit(2);
  }
  const AHEAD_LIMIT = 90 * 86400000;
  if (t - Date.now() > AHEAD_LIMIT) {
    console.error('\n  REFUSED: ' + stamp + ' is more than 90 days away.\n' +
                  '  That is a sentinel wearing a real date — enforcement would read as ON while\n' +
                  '  being off in practice. Use --revert if you mean to disable enforcement.\n');
    process.exit(2);
  }
}

if (!has('--confirm')) {
  console.log('\n  DRY: would set the cutoff on BOTH files to ' +
              (target === 'SENTINEL' ? SENTINEL + ' (sentinel — enforcement OFF)' : target));
  report();
  console.log('  Re-run with --confirm to write.\n');
  process.exit(0);
}

/* Byte-safe: only the matched declaration is replaced, so mixed line endings and every
   untouched line survive exactly as they were. */
const replacement = target === 'SENTINEL' ? 'SENTINEL_ISO' : "'" + target + "'";
for (const file of [CLIENT, SERVER]) {
  const buf = fs.readFileSync(file);
  const src = buf.toString('latin1');
  if (!DECL.test(src)) throw new Error('cutoff declaration not found in ' + file);
  const out = src.replace(DECL, (_m, lead) => lead + replacement);
  fs.writeFileSync(file, Buffer.from(out, 'latin1'));
}

console.log('\n  WRITTEN.');
const agreed = report();
if (!agreed) {
  console.error('  The two files disagree after writing. Stop and inspect.\n');
  process.exit(1);
}
console.log('  NEXT, in order — none of which this script does for you:');
console.log('    1. node scripts/auth-cutoff-dry-run.js ' +
            (target === 'SENTINEL' ? '<any candidate>' : target));
console.log('    2. the auth suites (policy, policy-server, gate, screen, transitions,');
console.log('       signup, landing) plus challenge/dispatch on the emulators');
console.log('    3. commit');
console.log('    4. deploy hosting AND functions TOGETHER — never the gate alone\n');
