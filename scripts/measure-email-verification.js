/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — email-verification population measurement   (pre-deployment, READ ONLY)
   ------------------------------------------------------------------------------
   Answers one question: if the Slice 3 gate were switched on today, how many existing
   accounts would be held at the challenge, and are they concentrated in older signups?

   WHY IT LOADS THE SHIPPED GATE INSTEAD OF COUNTING emailVerified
   --------------------------------------------------------------
   "Unverified accounts" and "accounts the gate would hold" are NOT the same set. Phone
   accounts have emailVerified false forever and are never gated. Google accounts are not
   gated. Accounts with no email are not gated. A count of emailVerified === false would
   therefore report a number far larger than the population at risk, and the grandfathering
   decision would be made against a figure that means nothing.

   So this reads sokoni-verify-gate.js — the file that ships — and asks
   needsVerification() about each account, exactly as the browser will. If the rule ever
   changes, this measurement changes with it, because there is only one rule.

   READ ONLY, AND STRUCTURALLY SO
   ------------------------------
   The only Admin call is auth().listUsers(). There is no Firestore handle, no updateUser,
   no setCustomUserClaims, no delete. --verify-readonly prints every admin.* call the file
   makes so that claim can be checked rather than believed.

   NO PERSONAL DATA LEAVES THIS SCRIPT
   -----------------------------------
   Output is aggregate only: counts and month buckets. No email address, no uid, no display
   name — not in the console output and not in the JSON. SOKONI is ODPC-registered
   (630-8669-F056); a CSV of every unverified address would be a data-protection problem
   created in order to make a scheduling decision, and the decision does not need it.

   USAGE
     GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
       node scripts/measure-email-verification.js [--json out.json] [--months 24]

     node scripts/measure-email-verification.js --verify-readonly     (no credentials used)
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

/* ── self-audit: prove read-only without needing credentials ─────────────────── */
if (has('verify-readonly')) {
  const src = fs.readFileSync(__filename, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  /* Scan what the ADMIN SDK is asked to do — not the whole file. A body-wide search for
     ".set(" flags this script's own Map bookkeeping and says nothing about Firebase, which
     is a guard that cries wolf until someone stops reading it.

     Two checks, both narrow enough to mean something:
       1. every admin.auth() method used must be on the allowed list
       2. no data-plane handle may be opened at all */
  const authMethods = [...new Set(
    (code.match(/admin\s*\.\s*auth\s*\(\s*\)\s*\.\s*([A-Za-z]+)/g) || [])
      .map((m) => m.replace(/[\s\S]*\.\s*/, '')))];
  const ALLOWED = ['listUsers', 'getUser', 'getUserByEmail'];   /* all read-only */
  const badMethods = authMethods.filter((m) => !ALLOWED.includes(m));

  const handles = [...new Set(
    (code.match(/admin\s*\.\s*(firestore|database|storage|messaging|remoteConfig)/g) || [])
      .map((m) => m.replace(/[\s\S]*\.\s*/, '')))];

  const topLevel = [...new Set((code.match(/admin\s*\.\s*([A-Za-z]+)/g) || [])
    .map((m) => m.replace(/[\s\S]*\.\s*/, '')))];

  console.log('admin surface used by this file');
  console.log('  top level     : ' + (topLevel.join(', ') || '(none)'));
  console.log('  auth methods  : ' + (authMethods.join(', ') || '(none)'));
  console.log('  data handles  : ' + (handles.join(', ') || '(none)'));

  const problems = []
    .concat(badMethods.map((m) => 'auth().' + m + ' is not on the read-only allow list'))
    .concat(handles.map((h) => 'opens a ' + h + ' handle'));

  console.log(problems.length
    ? '\nNOT READ-ONLY:\n  ' + problems.join('\n  ')
    : '\nREAD-ONLY — the only Admin calls are initializeApp and auth().' +
      authMethods.join('/') + '. No Firestore, database, storage or messaging handle is\n' +
      'opened, and no user-mutating method appears anywhere.');
  process.exit(problems.length ? 1 : 0);
}

/* ── the rule, loaded from the file that ships ───────────────────────────────── */
function loadGateRule() {
  const sandbox = {
    window: null, document: null, localStorage: null, sessionStorage: null,
    console: { log() { }, warn() { } }, module: { exports: {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-verify-gate.js'), 'utf8'),
                  sandbox, { filename: 'sokoni-verify-gate.js' });
  const api = sandbox.SokoniVerifyGate;
  if (!api || typeof api.needsVerification !== 'function') {
    throw new Error('sokoni-verify-gate.js did not publish needsVerification — refusing to ' +
                    'guess the rule.');
  }
  return api.needsVerification;
}

/* ── credentials ─────────────────────────────────────────────────────────────── */
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error(
    '\n[measure-email-verification] No credentials.\n\n' +
    '  Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n' +
    '  (or point FIREBASE_AUTH_EMULATOR_HOST at an emulator to rehearse).\n\n' +
    '  To check this script is read-only WITHOUT credentials:\n' +
    '    node scripts/measure-email-verification.js --verify-readonly\n');
  process.exit(2);
}

const admin = require(require.resolve('firebase-admin', { paths: [path.join(ROOT, 'functions')] }));
admin.initializeApp();

const MONTHS = Number(arg('months', 24)) || 24;
const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');

(async function main() {
  const needsVerification = loadGateRule();

  const tally = {
    scanned: 0,
    passwordAccounts: 0,        /* has a password provider */
    gated: 0,                   /* the gate would hold these — the number that matters */
    passwordVerified: 0,
    /* Everything the gate deliberately does not touch, so the totals reconcile and nobody
       has to wonder where the missing accounts went. */
    notGated: { google: 0, phone: 0, otherFederated: 0, noEmail: 0, noProvider: 0 },
    byMonth: new Map(),         /* month → { total, gated } */
    oldestGated: null, newestGated: null,
    disabledGated: 0,
  };

  function bucket(rec, isGated) {
    const created = rec.metadata && rec.metadata.creationTime
      ? new Date(rec.metadata.creationTime) : null;
    if (!created || isNaN(created)) return;
    const k = monthKey(created);
    const b = tally.byMonth.get(k) || { total: 0, gated: 0 };
    b.total++; if (isGated) b.gated++;
    tally.byMonth.set(k, b);
    if (isGated) {
      const t = created.getTime();
      if (!tally.oldestGated || t < tally.oldestGated) tally.oldestGated = t;
      if (!tally.newestGated || t > tally.newestGated) tally.newestGated = t;
    }
  }

  let pageToken;
  process.stdout.write('scanning');
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const rec of page.users) {
      tally.scanned++;

      /* Shape the record the way the browser sees a Firebase User, then ask the shipped
         rule. Nothing is copied out of it beyond these three fields. */
      const ids = (rec.providerData || []).map((p) => p && p.providerId).filter(Boolean);
      const asUser = { email: rec.email || null, emailVerified: !!rec.emailVerified,
                       providerData: (rec.providerData || []) };
      const isGated = needsVerification(asUser);

      const hasPassword = ids.includes('password');
      if (hasPassword) {
        tally.passwordAccounts++;
        if (rec.emailVerified) tally.passwordVerified++;
      }
      if (isGated) {
        tally.gated++;
        if (rec.disabled) tally.disabledGated++;
      } else if (!hasPassword) {
        if (ids.includes('phone')) tally.notGated.phone++;
        else if (ids.includes('google.com')) tally.notGated.google++;
        else if (ids.length) tally.notGated.otherFederated++;
        else tally.notGated.noProvider++;
      } else if (!rec.email) {
        tally.notGated.noEmail++;
      }

      bucket(rec, isGated);
      if (tally.scanned % 5000 === 0) process.stdout.write('.');
    }
    pageToken = page.pageToken;
  } while (pageToken);
  process.stdout.write('\n');

  /* ── report ────────────────────────────────────────────────────────────────── */
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
  const months = [...tally.byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, MONTHS);

  const line = '─'.repeat(64);
  console.log('\n' + line);
  console.log('EMAIL VERIFICATION — POPULATION AT THE GATE');
  console.log(line);
  console.log('  accounts scanned                 ' + tally.scanned);
  console.log('  password/email accounts          ' + tally.passwordAccounts);
  console.log('    verified                       ' + tally.passwordVerified +
              '   (' + pct(tally.passwordVerified, tally.passwordAccounts) + ')');
  console.log('    WOULD BE GATED                 ' + tally.gated +
              '   (' + pct(tally.gated, tally.passwordAccounts) + ' of password accounts, ' +
              pct(tally.gated, tally.scanned) + ' of all)');
  if (tally.disabledGated) {
    console.log('      of which already disabled    ' + tally.disabledGated +
                '   (cannot sign in anyway)');
  }
  console.log('\n  never gated, by design');
  console.log('    phone accounts                 ' + tally.notGated.phone);
  console.log('    google accounts                ' + tally.notGated.google);
  console.log('    other federated                ' + tally.notGated.otherFederated);
  console.log('    password account, no email     ' + tally.notGated.noEmail);
  console.log('    no provider on record          ' + tally.notGated.noProvider);

  if (tally.oldestGated) {
    console.log('\n  gated accounts created between   ' +
                new Date(tally.oldestGated).toISOString().slice(0, 10) + '  and  ' +
                new Date(tally.newestGated).toISOString().slice(0, 10));
  }

  console.log('\n' + line);
  console.log('BY MONTH CREATED (newest first) — is this concentrated in older accounts?');
  console.log(line);
  console.log('  month      total    gated    gated%   ');
  const widest = months.reduce((m, [, b]) => Math.max(m, b.total), 0) || 1;
  for (const [m, b] of months) {
    const bar = '█'.repeat(Math.round((b.gated / widest) * 24));
    console.log('  ' + m + '   ' + String(b.total).padStart(6) + '   ' +
                String(b.gated).padStart(6) + '   ' + pct(b.gated, b.total).padStart(6) +
                '   ' + bar);
  }

  /* ── trustworthiness check ──────────────────────────────────────────────────
     The whole measurement rests on providerData telling us which accounts carry a
     password. An account whose providerData is empty is unclassifiable: it may well be a
     password account, and it would be counted as "not gated" — so a project with many of
     them produces a reassuringly small number that means nothing.

     This is not hypothetical. The emulator rehearsal for this script seeded accounts whose
     provider list did not survive the import, and the report cheerfully announced ZERO
     accounts at risk. A number that is confidently wrong is worse than no number, so the
     script says so instead of letting the figure be quoted. */
  const unclassifiable = tally.notGated.noProvider;
  const unclassPct = tally.scanned ? unclassifiable / tally.scanned : 0;
  if (unclassifiable > 0) {
    console.log('\n' + line);
    console.log(unclassPct >= 0.02 ? 'DO NOT QUOTE THIS NUMBER YET' : 'CAVEAT');
    console.log(line);
    console.log('  ' + unclassifiable + ' account(s) (' + pct(unclassifiable, tally.scanned) +
                ') have NO provider on record, so they could not be classified.');
    console.log('  They are counted as "not gated", which may be wrong: an imported account');
    console.log('  can hold a password without listing the provider. The true at-risk figure');
    console.log('  is therefore somewhere between ' + tally.gated + ' and ' +
                (tally.gated + unclassifiable) + '.');
    if (unclassPct >= 0.02) {
      console.log('\n  That is more than 2% of the population. Resolve it before using this');
      console.log('  measurement to make the grandfathering decision.');
    }
  }

  console.log('\n' + line);
  console.log('READ THIS BEFORE DECIDING');
  console.log(line);
  console.log('  This is a COUNT, not a recommendation. Nothing has been grandfathered and');
  console.log('  no cutoff date is encoded anywhere — that decision is deliberately not in');
  console.log('  the gate. The gate and the verification screen must deploy together.');
  console.log('  Accounts that never sign in again are still counted here; this is the');
  console.log('  population at risk, not the population that will actually be affected.\n');

  const out = arg('json', null);
  if (out) {
    /* Aggregates only — deliberately no per-account rows. */
    const payload = {
      measuredAt: new Date().toISOString(),
      rule: 'sokoni-verify-gate.js needsVerification()',
      scanned: tally.scanned,
      passwordAccounts: tally.passwordAccounts,
      passwordVerified: tally.passwordVerified,
      gated: tally.gated,
      gatedPctOfPasswordAccounts: tally.passwordAccounts ? tally.gated / tally.passwordAccounts : null,
      disabledGated: tally.disabledGated,
      notGated: tally.notGated,
      gatedCreatedRange: tally.oldestGated
        ? { from: new Date(tally.oldestGated).toISOString(), to: new Date(tally.newestGated).toISOString() }
        : null,
      byMonth: Object.fromEntries([...tally.byMonth.entries()].sort()),
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log('  aggregates written to ' + out + ' (no addresses, no uids)\n');
  }
})().catch((e) => {
  console.error('\n[measure-email-verification] failed:', e && e.message);
  process.exit(1);
});
