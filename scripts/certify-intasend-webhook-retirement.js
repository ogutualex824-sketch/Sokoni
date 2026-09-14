'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   RETIRING `intasendWebhook` — THE HANDLER INTASEND NEVER CALLED.

   Two IntaSend receivers existed. `webhookIntasend` (786 lines) takes every production callback;
   `intasendWebhook` (260 lines) was a strict subset that received 49 requests in 180 days and
   answered every single one 401 or 405. IntaSend's own server — 157.245.201.212 — called the
   live handler fourteen times with 200s and **never once** called the retired one. The only
   traffic it ever saw came from two Kenyan addresses running the `curl` commands printed in this
   repository's own runbooks.

   THE POINT OF THIS GATE IS NOT THE EXPORT. Removing a function is easy; what keeps a
   decommission alive is the PROSE. D1 removed Daraja's callback URLs and left the instructions
   telling merchants to register them, and a later gate had to come back and finish it. So §5
   asserts every instruction is gone — 8 registration/URL surfaces the census found, plus 13
   OPERATIONAL ones it missed: runbook commands, log queries and a monitoring alert. One of those
   was `firebase deploy --only functions:intasendWebhook`, which now fails — and an on-call
   engineer would have met that failure during an incident.

   DELIBERATELY KEPT: the historical record. The July 2026 migration narrative in
   WEBHOOK_FIX_RUNBOOK.md — including "decommission intasendWebhook (stub or undeploy)" as a
   PLANNED step — is evidence, not instruction. This gate completes that plan; erasing the plan
   would erase the reason.

   REPOSITORY RETIREMENT IS NOT PRODUCTION DELETION. The deployed Cloud Run service stays until a
   separate, explicitly authorised action removes it.

   Run:  node scripts/certify-intasend-webhook-retirement.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(14) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(14) + m + (x ? '\n                   ' + String(x).slice(0, 240) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(14) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 80)));

const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } };
const strip = (s) => (s || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

/* BASELINE — resolved from history, so this suite works before AND after its own commit.
   `~1` NOT `^`: execSync goes through cmd.exe on Windows, where `^` is the escape character and
   is silently eaten, which would measure the gate against itself. */
function baseline() {
  /* Ask HEAD, not the working tree. The working tree already has the removal applied, so testing
     it reported "committed" while the removal was still unstaged — and the history search then
     found the commit that ADDED the handler years ago, whose `~1` does not exist. The question
     is about COMMIT state, so it must be asked of a commit. */
  let idxHead = '';
  try { idxHead = execSync('git show HEAD:functions/index.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) {}
  if (/exports\.intasendWebhook\s*=/.test(idxHead)) return { ref: 'HEAD', committed: false };
  try {
    const out = execSync('git log --format=%H -S"exports.intasendWebhook = onRequest" -- functions/index.js',
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
    const newest = out.split('\n').filter(Boolean)[0];
    if (!newest) return { ref: 'HEAD', committed: false };
    return { ref: newest + '~1', committed: true, at: newest };
  } catch (_) { return { ref: 'HEAD', committed: false }; }
}
const BASE = baseline();
const baseFile = (p) => { try { return execSync('git show ' + BASE.ref + ':' + p, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { return null; } };

function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); this check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

function blockOf(src, name) {
  if (!src) return null;
  const i = src.indexOf(name);
  if (i < 0) return null;
  const next = src.slice(i + name.length).search(/\n(exports\.|async function |function )/);
  return next < 0 ? src.slice(i) : src.slice(i, i + name.length + next);
}

/** Every tracked file a browser or an operator could act on. Enumerated, never hand-listed. */
function trackedFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).filter((f) => !f.startsWith('node_modules/'));
}

const IDX = read('functions/index.js');
const IDX_S = strip(IDX);

function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  intasendWebhook RETIREMENT — CERTIFICATION');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('  baseline: ' + BASE.ref + (BASE.committed ? '  (retired at ' + BASE.at.slice(0, 7) + ')' : '  (not yet committed)'));

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('1  THE EXPORT AND ITS DEPLOYMENT SURFACES ARE GONE');

  check('A1-1', !/exports\.intasendWebhook/.test(IDX),
    'exports.intasendWebhook is absent from functions/index.js');
  check('A1-2', !/intasendWebhook/.test(IDX_S.replace(/webhookIntasend/g, '')),
    '…and no code in index.js references it (comments excluded — the retirement note is allowed)');

  {
    const pkg = read('functions/package.json');
    check('A1-3', pkg && !/functions:intasendWebhook/.test(pkg),
      'the deploy:payment npm script no longer deploys it');
    check('A1-4', pkg && /functions:webhookIntasend/.test(pkg),
      '…and names the live handler instead — the script still deploys A webhook');
    let json = null; try { json = JSON.parse(pkg); } catch (_) {}
    check('A1-5', json !== null, 'functions/package.json is still valid JSON');
  }
  check('A1-6', !/intasendWebhook/.test(read('deploy-batches.ps1') || ''),
    'deploy-batches.ps1 no longer lists it');
  check('A1-7', !/intasendWebhook/.test(read('scripts/batch_deploy.sh') || ''),
    'scripts/batch_deploy.sh no longer lists it');
  check('A1-8', !/intasendWebhook/.test(read('sokoni-endpoints.js') || ''),
    'the client endpoint registry no longer offers it');
  check('A1-9', /webhookIntasend|webhookMpesa/.test(read('scripts/batch_deploy.sh') || ''),
    'CONTROL: the deploy script still lists other webhooks — entries were removed, not the file emptied');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('2  THE LIVE HANDLER IS THE SOLE RECEIVER, AND IS INTACT');

  {
    const wiBase = blockOf(baseFile('functions/index.js'), 'exports.webhookIntasend');
    const wiNow = blockOf(IDX, 'exports.webhookIntasend');
    if (!wiBase) { blocked('B2-0', 'cannot read webhookIntasend at ' + BASE.ref); }
    else {
      check('B2-1', wiNow === wiBase,
        'webhookIntasend is BYTE-IDENTICAL to the pre-retirement baseline — nothing leaked into it');
    }
    check('B2-2', /exports\.webhookIntasend\s*=\s*onRequest/.test(IDX),
      'it is still an onRequest endpoint');
    const exports_ = [...IDX.matchAll(/^exports\.(\w*[Ii]ntasend\w*)\s*=/gm)].map((m) => m[1]);
    check('B2-3', exports_.filter((e) => /^(webhookIntasend|intasendWebhook)$/.test(e)).length === 1
      && exports_.includes('webhookIntasend'),
      'exactly ONE IntaSend webhook export remains, and it is webhookIntasend', exports_.join(', '));
    check('B2-4', wiNow && /_associatePosQrCallback\(/.test(wiNow),
      'P3-A\'s POS QR association survives inside it');
    check('B2-5', wiNow && /finalizeB2CPayoutFromWebhook/.test(wiNow),
      'B2C payout settlement remains reachable through the surviving webhook');
    check('B2-6', wiNow && /_finalizeWalletTopUp/.test(wiNow) && /_holdServiceBookingPayment/.test(wiNow),
      '…so do wallet top-ups and the service-booking hold');
    check('B2-7', wiNow && /timingSafeEqual/.test(wiNow),
      '…and the challenge authentication — no security behaviour was lost');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('3  NOTHING UNIQUE WAS LOST — measured against the baseline, not asserted');

  {
    const base = baseFile('functions/index.js');
    const removed = blockOf(base, 'exports.intasendWebhook');
    const live = blockOf(IDX, 'exports.webhookIntasend');
    if (!removed) { blocked('C3-0', 'cannot read the retired handler at ' + BASE.ref); }
    else {
      const cols = (t) => new Set([...t.matchAll(/collection\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]));
      const lost = [...cols(removed)].filter((c) => !cols(live).has(c));
      check('C3-1', lost.length === 0,
        'every collection the retired handler touched is still touched by the live one', lost.join(', '));
      check('C3-2', cols(removed).size >= 5,
        'CONTROL: the retired handler really did touch collections (' + cols(removed).size + ') — the comparison is not vacuous');

      const helpers = (t) => new Set([...t.matchAll(/\b(_[A-Za-z][A-Za-z0-9_]*|wallet\.[A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
      const lostH = [...helpers(removed)].filter((h) => !helpers(live).has(h));
      check('C3-3', lostH.length === 0,
        'every helper it called is still called by the live one', lostH.join(', '));

      check('C3-4', removed.split('\n').length < live.split('\n').length,
        'the retired handler was the SMALLER of the two ('
        + removed.split('\n').length + ' vs ' + live.split('\n').length + ' lines) — a subset, not a peer');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('4  THE NAME COLLISION IS UNTOUCHED');

  {
    /* functions/pos-terminal-live.js defines `_intasendWebhook` — an UNRELATED POS card-terminal
       vendor driver on posTerminalTransactions. A name-based sweep deletes it. */
    const ptl = read('functions/pos-terminal-live.js');
    const ptlBase = baseFile('functions/pos-terminal-live.js');
    check('D4-1', ptl !== null && ptlBase !== null && ptl === ptlBase,
      'functions/pos-terminal-live.js is byte-identical to the baseline');
    check('D4-2', ptl && /async function _intasendWebhook\(/.test(ptl),
      '…and its unrelated `_intasendWebhook` vendor driver still exists');
    check('D4-3', ptl && /posTerminalTransactions/.test(ptl),
      '…still operating on posTerminalTransactions, which is what makes it a different thing');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('5  THE INSTRUCTIONS ARE GONE — the actual point of this gate');

  {
    const files = trackedFiles();
    const ALLOWED_HISTORY = [
      'CHANGELOG.md', 'docs/CHANGELOG.md',
      'docs/INTASEND_WEBHOOK_RETIREMENT_CENSUS.md',
      'docs/P3A_CENSUS_INTASEND_POS_ASSOCIATION.md',
      'scripts/certify-intasend-webhook-retirement.js',
      'scripts/certify-p3a-pos-qr-association.js',
      'scripts/certify-p3-matchback-removal.js',
      '.fnlist.txt', 'firestore.rules.bak',
    ];

    /* (a) NOBODY IS TOLD TO REGISTER OR CALL THE URL — enumerated repo-wide. */
    const urlHits = files.filter((f) => /cloudfunctions\.net\/intasendWebhook/.test(read(f) || ''))
      .filter((f) => !ALLOWED_HISTORY.includes(f));
    check('E5-1', urlHits.length === 0,
      'ZERO files publish the intasendWebhook URL — all 8 registration surfaces retired', urlHits.join(', '));

    /* (b) NO OPERATIONAL COMMAND NAMES IT — the 13 the census missed. */
    const cmd = /functions:intasendWebhook|--only intasendWebhook|service_name="intasendWebhook"|deploy.{0,30}intasendWebhook/;
    const cmdHits = files.filter((f) => cmd.test(read(f) || '')).filter((f) => !ALLOWED_HISTORY.includes(f));
    check('E5-2', cmdHits.length === 0,
      'ZERO runbook commands, log queries or deploy lines name it — `firebase deploy --only '
      + 'functions:intasendWebhook` would now FAIL, during an incident', cmdHits.join(', '));

    /* (c) NO MONITORING ALERT WATCHES A FUNCTION THAT CANNOT FIRE. */
    const alertHits = files.filter((f) => /alert|monitor/i.test(f) && /intasendWebhook/.test(read(f) || ''))
      .filter((f) => !ALLOWED_HISTORY.includes(f));
    check('E5-3', alertHits.length === 0,
      'no monitoring alert is keyed on the retired function', alertHits.join(', '));

    /* (d) THE TWO ACTIVE INTENTIONS TO REPOINT PRODUCTION AT IT ARE WITHDRAWN. */
    const rider = read('docs/RIDER_EARNINGS_AUTHORITY.md') || '';
    check('E5-4', !/is repointed to `\/intasendWebhook`\. \*\*This work therefore gates that change\.\*\*/.test(rider),
      'RIDER_EARNINGS_AUTHORITY no longer gates on a repoint to the retired endpoint');
    check('E5-5', /never happen|RETIRED|retired/.test(rider),
      '…and says so explicitly rather than silently dropping the claim');

    const cp = read('scripts/certify-payment.js') || '';
    /* STRIPPED. The replacement comment explains what the old claim was, so an unstripped check
       matched its own explanation and reported the claim still present. Certification machinery
       reads itself unless you make it read only code. */
    const cpCode = strip(cp);
    check('E5-6', !/Repoint it at \/intasendWebhook/.test(cpCode),
      'certify-payment.js no longer tells an operator to repoint production at the dead endpoint');
    check('E5-7', !/only intasendWebhook writes this field/.test(cpCode)
      && !/intasendWebhook fired/.test(cpCode),
      '…and its "endpoint discriminator" claim is gone from the CODE — it was FALSE, both handlers wrote webhookReceivedAt');
    check('E5-8', /webhookIntasend/.test(cp),
      '…and it now names the live receiver');

    /* (e) CONTROL — the history that must SURVIVE. */
    const rb = read('docs/WEBHOOK_FIX_RUNBOOK.md') || '';
    check('E5-9', /decommission/.test(rb) && /intasendWebhook \(stub or undeploy\)/.test(rb),
      'CONTROL: the July 2026 migration record survives — this gate COMPLETES a plan recorded '
      + 'then, and erasing the plan would erase the reason');
    check('E5-10', /RETIRED 2026-09-14/.test(rb),
      '…and the runbook now records the retirement against that plan');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('6  PROTECTED RAILS AND PRIOR GATES');

  {
    const base = baseFile('functions/index.js');
    if (!base) { blocked('F6-0', 'cannot read index.js at ' + BASE.ref); }
    else {
      for (const n of ['exports.darajaSTKCallback', 'exports.webhookMpesa', 'exports.verifyIntasendPayment']) {
        const a = blockOf(base, n), b = blockOf(IDX, n);
        if (a === null) { blocked('F6-' + n, n + ' not found at baseline'); continue; }
        check('F6-' + n.replace('exports.', ''), a === b, n + ' byte-identical to the baseline');
      }
    }
    for (const f of ['functions/mpesa-c2b.js', 'functions/pos-qr.js',
      'functions/shared/pos-qr-association.js', 'functions/shared/intasend-verify.js',
      'functions/shared/stk-gateway.js', 'functions/shared/pos-payment-ownership.js']) {
      const a = baseFile(f), b = read(f);
      check('F6-' + f.replace(/.*\//, ''), a !== null && a === b, f + ' byte-identical — P1/P2/P3/P3-A untouched');
    }
    check('F6-noDaraja', !/darajaSTKPush|sendTestSTKPush|validateDarajaCredentials/.test(IDX_S),
      'no retired Daraja outbound callable was reintroduced — D1 is not reopened');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('7  NO HISTORICAL RECORD IS TOUCHED');

  {
    /* Scope to THIS GATE'S OWN FILES. A diff over `functions/ scripts/ *.js` swept in every
       dirty file in the repository — other agents' suspension work is full of legitimate
       `FieldValue.delete()` calls — and reported them as this gate's deletions. "Does the
       repository contain X" is never the question; "did THIS CHANGE add X" is.
       `functions/index.js` is shared, so only hunks carrying this gate's markers are read. */
    const OWNED = [
      'functions/package.json', 'deploy-batches.ps1', 'scripts/batch_deploy.sh',
      'sokoni-endpoints.js', 'docs/GO_LIVE_CHECKLIST.md', 'DISASTER_RECOVERY_PLAYBOOK.md',
      'docs/WEBHOOK_FIX_RUNBOOK.md', 'INFRA_CHECKLIST.md', 'docs/RIDER_EARNINGS_AUTHORITY.md',
      'scripts/certify-payment.js', 'scripts/verify-webhook-authority.js',
      'docs/CB05_MONITORING_CHECKLIST.md', 'docs/DISASTER_RECOVERY_GUIDE.md',
      'docs/deployment/DISASTER_RECOVERY.md', 'docs/deployment/INCIDENT_RESPONSE.md',
      'docs/runbooks/incident-response.md',
    ];
    let added = [];
    for (const f of OWNED) {
      const fd = execSync('git diff ' + BASE.ref + ' -- ' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      added = added.concat(fd.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')));
    }
    {
      /* index.js: only this gate's hunks. */
      const fd = execSync('git diff ' + BASE.ref + ' -- functions/index.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const hs = []; let c = null;
      fd.split('\n').forEach((l) => { if (l.startsWith('@@')) { if (c) hs.push(c); c = [l]; } else if (c) c.push(l); });
      if (c) hs.push(c);
      const M = /intasendWebhook|RETIRED 2026-09-14|157\.245\.201\.212/;
      hs.forEach((h) => {
        const b = h.filter((l) => /^[+-]/.test(l)).join('\n');
        if (M.test(b)) added = added.concat(h.filter((l) => l.startsWith('+') && !l.startsWith('+++')));
      });
    }
    check('G7-0', added.length > 20,
      'CONTROL: this gate does add lines (' + added.length + ') — the deletion checks below are not vacuous');
    check('G7-1', !added.some((l) => /\.delete\(\)|deleteDoc|batch\.delete|bulkWriter/.test(l)),
      'this gate adds no Firestore deletion of any kind');
    check('G7-2', !added.some((l) => /collection\(["'](payments|posPayments|commissionLedger|paymentIntents)["']\)\s*\.doc\([^)]*\)\s*\.(set|update)/.test(l)),
      'nor any write to a payment or ledger document');
    check('G7-3', !added.some((l) => /migrat|backfill/i.test(l) && /payments|ledger/i.test(l)),
      'nor a migration over historical payment records');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('8  ATTRIBUTION — other agents\' work');

  {
    const MINE = /intasendWebhook|RETIRED 2026-09-14|webhookIntasend/;
    for (const f of ['seller.html', 'pos.js', 'pos.html', 'pos-setup.html', 'functions/pos-zero-friction.js', 'admin-os.html']) {
      const diff = execSync('git diff HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const mine = diff.split('\n').filter((l) => l.startsWith('+') && MINE.test(l));
      check('H8-' + f.replace(/.*\//, ''), mine.length === 0, f + ' carries none of this gate\'s markers');
    }
    const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const theirs = staged.filter((f) => ['seller.html', 'pos.js', 'pos.html', 'pos-setup.html', 'functions/pos-zero-friction.js', 'admin-os.html'].includes(f));
    check('H8-staged', theirs.length === 0, 'no file carrying another agent\'s work is staged', theirs.join(', '));

    /* index.js hunks: classify and require zero mixed. */
    const d = execSync('git diff ' + BASE.ref + ' -- functions/index.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const hs = []; let cur = null;
    d.split('\n').forEach((l) => { if (l.startsWith('@@')) { if (cur) hs.push(cur); cur = [l]; } else if (cur) cur.push(l); });
    if (cur) hs.push(cur);
    const M = /intasendWebhook|RETIRED 2026-09-14|157\.245\.201\.212/;
    const T = /expectCents|paidCents|stk-intent-enforcement|_stkEnf|POS \/ TILL COMMISSION RAIL|pos-commission-rail|CANONICAL MERCHANT SUBSCRIPTION|merchantSubscriptions/;
    let mine = 0, theirsN = 0, mixed = 0, unknown = 0;
    hs.forEach((h) => {
      const body = h.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n');
      const m = M.test(body), t = T.test(body);
      if (m && t) mixed++; else if (m) mine++; else if (t) theirsN++; else unknown++;
    });
    check('H8-mixed', mixed === 0,
      'index.js hunks from the baseline: ' + mine + ' mine / ' + theirsN + ' theirs / ' + unknown
      + ' unclassified / ' + mixed + ' MIXED');
    check('H8-unknown', unknown === 0,
      'every index.js hunk is classified — an unclassified hunk must never be staged on a guess');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('9  SABOTAGE');

  sab('X9-1', 'restoring the retired export', IDX,
    IDX.replace('exports.webhookIntasend = onRequest(',
      'exports.intasendWebhook = onRequest({}, async () => {});\nexports.webhookIntasend = onRequest('),
    (s) => /exports\.intasendWebhook\s*=/.test(s));

  sab('X9-2', 'republishing the registration URL', 'clean text',
    'Register https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook as your webhook',
    (s) => /cloudfunctions\.net\/intasendWebhook/.test(s));

  sab('X9-3', 'restoring a runbook deploy command', 'clean runbook',
    'firebase deploy --only functions:intasendWebhook',
    (s) => /functions:intasendWebhook/.test(s));

  sab('X9-4', 'restoring a log query against the dead service', 'clean runbook',
    'resource.labels.service_name="intasendWebhook"',
    (s) => /service_name="intasendWebhook"/.test(s));

  sab('X9-5', 'restoring the false endpoint discriminator', read('scripts/certify-payment.js') || '',
    (read('scripts/certify-payment.js') || '').replace('NOT AN ENDPOINT DISCRIMINATOR',
      'THE ENDPOINT DISCRIMINATOR — only intasendWebhook writes this field'),
    (s) => /only intasendWebhook writes this field/.test(s));

  sab('X9-6', 'deleting the UNRELATED POS terminal driver', read('functions/pos-terminal-live.js') || '',
    (read('functions/pos-terminal-live.js') || '').replace('async function _intasendWebhook(', 'async function _removed_(' ),
    (s) => !/async function _intasendWebhook\(/.test(s));

  sab('X9-7', 'losing B2C settlement from the surviving webhook', IDX,
    IDX.replace(/if \(await wallet\.finalizeB2CPayoutFromWebhook\(db, r, state, req\.body\)\) \{/, 'if (false) {'),
    (s) => { const w = blockOf(s, 'exports.webhookIntasend') || ''; return !/finalizeB2CPayoutFromWebhook/.test(w); });

  sab('X9-8', 'losing the P3-A association with the retirement', IDX,
    IDX.replace('await _associatePosQrCallback(apiRef, state, checkoutId, "webhookIntasend");', ''),
    (s) => { const w = blockOf(s, 'exports.webhookIntasend') || ''; return !/_associatePosQrCallback\(/.test(w); });

  sab('X9-9', 'erasing the historical migration record', 'decommission intasendWebhook (stub or undeploy)',
    'decommission REDACTED', (s) => !/intasendWebhook \(stub or undeploy\)/.test(s));

  sab('X9-10', 'deleting historical payment documents', 'clean diff',
    '+      await db.collection("payments").doc(ref).delete();',
    (s) => /\.delete\(\)|deleteDoc/.test(s));

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('10  CONTROLS');

  check('K10-1', /cloudfunctions\.net\/webhookIntasend/.test(read('functions/package.json') || ''),
    'CONTROL: package.json still carries a registration URL — it was REPOINTED, not deleted');
  check('K10-2', !/cloudfunctions\.net\/intasendWebhook/.test(read('functions/package.json') || ''),
    '…and it is the live one');
  check('K10-3', /intasendWebhook/.test(read('docs/WEBHOOK_FIX_RUNBOOK.md') || ''),
    'CONTROL: the runbook still MENTIONS the name — history is preserved, so E5-2 is discriminating '
    + 'between instruction and record, not blanket-deleting the word');
  check('K10-4', (read('CHANGELOG.md') || '').includes('intasendWebhook'),
    'CONTROL: the changelog still names it — a retirement must remain traceable');

  return finish();
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ intasendWebhook RETIREMENT: GREEN' : '❌ NOT GREEN'));
  console.log('  Repository retirement only. The deployed Cloud Run service is NOT removed.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

try { main(); }
catch (e) { console.error('\n  ✖ SUITE CRASHED — failing closed, NOT passing.\n  ' + (e && e.stack || e)); clearTimeout(WATCHDOG); process.exit(2); }
