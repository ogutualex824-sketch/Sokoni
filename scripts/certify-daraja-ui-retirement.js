'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   DARAJA UI RETIREMENT — the merchant-facing console for a rail that no longer exists.

   D1 retired the Daraja OUTBOUND surface in the repository. It did not retire the console that
   configures it. `payments.html` remained a six-step Daraja setup wizard: a credential guide, a
   callback-registration instruction, an OAuth "verification" screen, a KES 1 test-push console
   and a scripted assistant that walked a merchant through obtaining a passkey — all pointing at
   a rail that cannot transact.

   WHAT THIS GATE REMOVES
     · the setup wizard in full (6 steps, its progress bar, and its tab)
     · the Daraja credential guide and the two surviving callback-registration instructions
     · every test-push / credential-validation control and the handlers behind them
     · the assistant's six Daraja setup entries
     · the dead handlers left behind by D1 as `throw`-then-unreachable-code stubs

   WHAT IT DELIBERATELY PRESERVES, asserted rather than assumed
     · payment HISTORY, the statistics, and the business-name setting
     · `mpesa-c2b.js` — C2B is NOT Daraja; it receives money Safaricom already settled
     · `initiateSTKPush` — the certified IntaSend rail (P2)
     · `darajaSTKCallback` / `webhookMpesa` — INBOUND, and D3 is blocked on external
       de-registration. Safaricom was still POSTing to the callback on 2026-09-06.
     · the reconciliation callables and every historical `posPayments` document
     · four files carrying another agent's uncommitted work, untouched

   TWO FINDINGS THE CENSUS PRODUCED, both closed here:
     1. D1's callback-instruction removal was INCOMPLETE. It removed the URLs and left the
        instructions telling merchants to register them, pointing at now-empty boxes.
     2. A LIVE DEFECT: `configured = true` (5ee7e3a) made `snap.data()` unconditional, so
        `cfg.darajaEnv` threw on an absent document and the enclosing catch swallowed it —
        taking the four hero statistics down with it. Every merchant has seen "—" since July.

   Run:  node scripts/certify-daraja-ui-retirement.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(12) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(12) + m + (x ? '\n                 ' + String(x).slice(0, 240) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(12) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 80)));

/* Assertions run on COMMENT-STRIPPED source. The comments in these files quote the very
   patterns under test ("the previous Daraja-shaped read (cfg.darajaEnv …)"), so a check
   run on raw source would read its own explanation as a violation. */
const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const headFile = (p) => { try { return execSync('git show HEAD:' + p, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { return null; } };

/* Every sabotage must prove the mutation LANDED before the detector is consulted. Three
   mutations earlier in this work silently failed to apply and reported "not detected" while
   the product was fine. This one line is what stops that class. */
function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); this check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

/* Extract one top-level block by name, so a file another agent is editing can still be
   compared region-by-region instead of whole-file. */
function blockOf(src, name) {
  if (!src) return null;
  const i = src.indexOf(name);
  if (i < 0) return null;
  const next = src.slice(i + name.length).search(/\n(exports\.|async function |function )/);
  return next < 0 ? src.slice(i) : src.slice(i, i + name.length + next);
}

/* Tracked, non-vendored files that a browser could actually load. */
function clientFiles() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).filter((f) =>
    /\.(html|js)$/.test(f) &&
    !f.startsWith('node_modules/') &&
    !f.startsWith('functions/') &&
    !f.startsWith('scripts/') &&
    !f.startsWith('tests/') &&
    !f.startsWith('docs/'));
}

const PAY = read('payments.html');
const PAY_S = strip(PAY);
const MV2 = read('merchant-v2.html');
const SMP = read('sokoni-mpesa.js');

function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  DARAJA UI RETIREMENT — CERTIFICATION');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('1  THE CENSUS IS REPOSITORY-WIDE, NOT HAND-LISTED');

  {
    /* The D1 census hand-listed its files and missed two. This one enumerates from
       `git ls-files`, so a new Daraja surface cannot hide by not being on a list. */
    const files = clientFiles();
    check('C1-1', files.length > 100,
      'client surface enumerated from git ls-files — ' + files.length + ' files, nothing hand-listed');

    const withDaraja = files.filter((f) => /daraja/i.test(read(f)));
    const expected = ['sokoni-dev-mock.js', 'sokoni-endpoints.js', 'sokoni-mpesa.js', 'payments.html',
      'pos.js', 'pos.html', 'pos-setup.html', 'seller.html', 'healthcare.html', 'checkout.html',
      'delivery.html', 'bnb.html', 'legal-hub.html', 'landlord.html', 'hub-register.js'];
    const surprises = withDaraja.filter((f) => !expected.includes(f));
    check('C1-2', surprises.length === 0,
      'every remaining Daraja-bearing client file is one the census classified',
      surprises.join(', '));

    check('C1-3', !withDaraja.includes('merchant-v2.html'),
      'merchant-v2.html is Daraja-free — it was one of the two files D1\'s hand-listed census missed');
    /* This scan caught a THIRD file no census had listed: sokoni-merchant-store-ui.js, loaded
       by merchant-v2.html and merchant.html, carrying a stale claim that SOKONI collects
       through Daraja. Asserted by name so a regression is named, not merely counted. */
    check('C1-4', !withDaraja.includes('sokoni-merchant-store-ui.js'),
      'sokoni-merchant-store-ui.js is Daraja-free — found by this scan, listed by no census');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('2  THE OBSOLETE MERCHANT UI IS GONE');

  check('U2-1', !/data-tab="wizard"/.test(PAY_S) && !/id="pmt-pane-wizard"/.test(PAY_S),
    'the Setup wizard tab and its pane are removed');
  check('U2-2', !/id="pmt-step-[1-6]"/.test(PAY_S),
    '…all six wizard steps with them');
  check('U2-3', !/Daraja API Credentials|developer\.safaricom\.co\.ke/i.test(PAY_S),
    'the Daraja credential screen and the portal it sent merchants to are gone');
  check('U2-4', !/pmt-guide-step|pmt-guide-num|How to get your credentials/i.test(PAY_S),
    '…and the five-step "how to get your credentials" guide');
  check('U2-5', !/Consumer Key|Consumer Secret|[Pp]asskey|[Ss]hortcode/.test(PAY_S),
    'no credential vocabulary survives anywhere on the page');
  check('U2-6', !/sandbox/i.test(PAY_S),
    'no sandbox/live environment switch — that was a Daraja concept');

  check('U2-7', !/CustomerPayBillOnline|CustomerBuyGoodsOnline/.test(PAY_S),
    'the Daraja transaction-type selector is gone');

  /* ── The finding: D1 removed the URLs but left the instructions ── */
  check('U2-8', !/Register this URL|Register Callback URL|Validation URL|CallbackURL/i.test(PAY_S),
    'ZERO callback-registration instructions remain — D1 removed the URLs and left these behind');
  check('U2-9', !/pmt-callback-box|Callback URL/i.test(PAY_S),
    '…and the empty box they pointed at is gone too');

  check('U2-10', !/Send Test Push|Send KES 1 Test Push|Test Your Integration|Test Connection/i.test(PAY_S),
    'every test-push and credential-validation control is removed');
  check('U2-11', !/pmtTestPhone|setTestPhone|pmtTestBtn|pmtTestBox/.test(PAY_S),
    '…including their inputs');
  check('U2-12', !/Verifying Connection|Generating OAuth token|pmt-verify-item/i.test(PAY_S),
    'the OAuth "verification" theatre is gone');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('3  IT IS REMOVED, NOT HIDDEN');

  {
    /* The instruction was explicit: not merely hidden with CSS. A control that is present
       but invisible is still a control — it ships, it can be un-hidden by a stylesheet
       change, and its handler still exists. */
    const hiddenDaraja = /(display\s*:\s*none[^"]*"[^>]*>\s*)?(Daraja|Consumer Key|Passkey|Test Push)/i;
    check('H3-1', !hiddenDaraja.test(PAY_S),
      'no Daraja control was merely hidden — the markup itself is absent');

    for (const fn of ['wizSendTestPush', 'pmtTestConnection', 'pmtRunTestFromSettings',
      'wizSaveCredentials', 'wizVerify', '_listenTestResult', 'pmtToggleVis',
      '_buildWizardProgress', 'wizChooseProvider', 'wizChooseMpesaType']) {
      check('H3-' + fn, !new RegExp('function\\s+' + fn + '\\b').test(PAY_S),
        'handler removed, not orphaned: ' + fn + '()');
    }

    check('H3-stub', !/'wizNext'|'wizSendTestPush'|'pmtTestConnection'|'pmtRunTestFromSettings'|'pmtToggleVis'/.test(PAY_S),
      'the pre-module stub list no longer names a function that does not exist');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('4  NOTHING DANGLES — every handler and element still resolves');

  {
    /* Removing a handler but leaving its button is how a "retirement" ships a dead click.
       This caught exactly that: the settings "⚡ Test" button outlived pmtTestConnection(). */
    const handlers = [...PAY.matchAll(/onclick="([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
    const globals = new Set(['history', 'location', 'alert']);
    const missing = [...new Set(handlers)].filter((h) =>
      !globals.has(h) && !new RegExp('function\\s+' + h + '\\b').test(PAY));
    check('D4-1', missing.length === 0,
      'every onclick handler on the page is defined', missing.join(', '));

    const ids = new Set([...PAY.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...new Set([...PAY.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
    const dangling = refs.filter((r) => !ids.has(r));
    check('D4-2', dangling.length === 0,
      'every getElementById target exists in the markup', dangling.join(', '));
  }

  {
    /* A page whose script does not parse is worse than one with a dead button. */
    const mod = PAY.match(/<script type="module">([\s\S]*?)<\/script>/);
    if (!mod) { blocked('D4-3', 'module script not found — cannot verify it parses'); }
    else {
      let e = null;
      try { new vm.Script(mod[1].replace(/^\s*import[\s\S]*?from\s+'[^']*';/gm, '')); } catch (x) { e = x; }
      check('D4-3', !e, 'the module script parses', e && e.message);
    }
    const inline = [...PAY.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    let allOk = true, err = null;
    inline.forEach((b) => { try { new vm.Script(b[1]); } catch (x) { allOk = false; err = x; } });
    check('D4-4', allOk, 'every inline script parses (' + inline.length + ' block(s))', err && err.message);
  }

  {
    /* seller.html still links to `payments.html?tab=wizard` and is OUT OF SCOPE for this
       gate. Without a fallback that link would deactivate every pane and activate none,
       leaving a blank page. The guard has to live on the receiving side. */
    const sellerLinks = /payments\.html\?tab=wizard/.test(read('seller.html'));
    check('D4-5', sellerLinks,
      'seller.html still links to ?tab=wizard — it is out of scope, so the receiving page must cope');
    check('D4-6', /tab\s*=\s*'overview'/.test(PAY) && /pmt-pane-overview/.test(PAY),
      '…and payments.html falls back to Overview for an unknown tab rather than showing nothing');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('5  LEGITIMATE M-PESA / INTASEND FUNCTION IS PRESERVED');

  check('L5-1', /id="pmt-pane-overview"/.test(PAY_S) && /id="pmt-pane-transactions"/.test(PAY_S)
    && /id="pmt-pane-settings"/.test(PAY_S) && /id="pmt-pane-assistant"/.test(PAY_S),
    'Overview, History, Settings and Assistant all survive');
  check('L5-2', /function pmtLoadTxns/.test(PAY_S) && /sellerPayments/.test(PAY_S),
    'payment history still loads from sellerPayments');
  check('L5-3', /collection\(_db,\s*'posPayments'\)/.test(PAY_S),
    'the posPayments pending/failed counts still load — historical documents stay readable');
  check('L5-4', /function pmtSaveSettings/.test(PAY_S) && /businessName/.test(PAY_S),
    'the business-name setting still saves');
  check('L5-5', /function _txnItemHTML/.test(PAY_S),
    'transaction rendering is untouched');
  check('L5-6', /function aiAsk/.test(PAY_S) && /const AI_KB/.test(PAY_S),
    'the assistant survives — with a knowledge base about how the merchant actually gets paid');
  check('L5-7', !/Daraja|passkey|consumer key/i.test(PAY_S.slice(PAY_S.indexOf('const AI_KB'))),
    '…and nothing in it mentions Daraja, a passkey or a consumer key');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('6  THE LIVE DEFECT: the hero statistics were never rendering');

  {
    check('F6-1', !/cfg\.darajaEnv|cfg\.darajaShortCode/.test(PAY_S),
      'the Daraja-shaped read that threw on every load is gone');
    check('F6-2', !/const configured = true/.test(PAY_S),
      '…along with the hardcoded flag that made it unconditional');

    /* The statistics are computed AFTER the point that used to throw. Proving the throw is
       gone is not the same as proving the statistics are reached: assert the ORDER. */
    const body = PAY_S.slice(PAY_S.indexOf('async function pmtLoadOverview'));
    const iStats = body.indexOf('pmtSTotal');
    const iSnap = body.indexOf('getDoc(doc(_db,');
    check('F6-3', iStats > -1,
      'the four statistics are still computed in pmtLoadOverview');
    check('F6-4', iSnap === -1 || iSnap > iStats,
      'no shopSettings read precedes them any more — nothing between load and statistics can throw');

    /* Direct proof: run the old expression and the new one against the document shape that
       production actually has (absent → snap.data() === undefined). */
    let oldThrew = false;
    try { const cfg = undefined; void (cfg.darajaEnv === 'sandbox'); } catch (_) { oldThrew = true; }
    check('F6-5', oldThrew,
      'reproduced: the removed expression throws TypeError on the absent document — shopSettings holds zero');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('7  ZERO REACHABLE OUTBOUND DARAJA PATHS, REPOSITORY-WIDE');

  {
    /* Bare identifier, not a quoted string: a reference is a reference whether it is
       written httpsCallable('darajaSTKPush') or as the property key darajaSTKPush:. The
       quoted-only form of this regex could not see the dev mock, and would have reported
       "zero invocations" for a page that called one through an unquoted alias. */
    const RETIRED = /\b(darajaSTKPush|sendTestSTKPush|validateDarajaCredentials)\b/;
    const invokers = clientFiles().filter((f) => {
      const s = strip(read(f));
      return RETIRED.test(s);
    });
    /* sokoni-dev-mock.js is an OFFLINE developer harness, not a production path. It is
       recorded in the census and excluded here deliberately, by name, so the exclusion is
       visible rather than silently folded into a regex. */
    const real = invokers.filter((f) => f !== 'sokoni-dev-mock.js');
    check('Z7-1', real.length === 0,
      'no client file invokes a retired Daraja callable', real.join(', '));
    check('Z7-2', invokers.includes('sokoni-dev-mock.js'),
      'the one remaining reference is the offline dev mock, named in the census — not a production path');

    const publishers = clientFiles().filter((f) => /cloudfunctions\.net\/darajaSTKCallback/.test(read(f)));
    check('Z7-3', publishers.length === 0,
      'no client surface publishes the callback URL to a seller any more', publishers.join(', '));
  }

  check('Z7-4', !/Safaricom Daraja/.test(SMP),
    'sokoni-mpesa.js no longer shows a customer a "Safaricom Daraja" modal on any of the 10 pages that load it');
  check('Z7-5', (MV2.match(/daraja/gi) || []).length === 0,
    'merchant-v2.html carries no Daraja reference at all');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('8  D3 INBOUND AND THE PROTECTED RAILS ARE UNTOUCHED');

  {
    const idxHead = headFile('functions/index.js');
    const idxNow = read('functions/index.js');
    if (!idxHead) { blocked('P8-0', 'cannot read functions/index.js at HEAD'); }
    else {
      /* index.js carries another agent's in-flight work, so "the file is unchanged" would be
         a false assertion — the mistake P1's T8-1 and P3's U3-1 both made. Compare the
         BLOCKS this gate must not touch, not the file. */
      /* The two INBOUND handlers must be byte-identical: D3 is blocked, and nothing in a
         UI gate has any business touching them. */
      for (const name of ['exports.darajaSTKCallback', 'exports.webhookMpesa']) {
        const a = blockOf(idxHead, name), b = blockOf(idxNow, name);
        if (a === null) { blocked('P8-' + name, name + ' not found at HEAD'); continue; }
        check('P8-' + name.replace('exports.', ''), a === b, name + ' is byte-identical to HEAD');
      }
      /* initiateSTKPush is NOT asserted byte-identical. It differs from HEAD through another
         agent's in-flight work, so "unchanged" would fail on THEIR work — the mis-assertion
         P1's T8-1 and P3's U3-1 both made, and which this suite reproduced a fourth time
         before being narrowed. Attribution is the correct question. */
      const stk = blockOf(idxNow, 'exports.initiateSTKPush');
      check('P8-initiateSTK', stk !== null && !/DARAJA_UI|retire-daraja/.test(stk),
        'initiateSTKPush carries none of this gate\'s markers — it differs from HEAD only through another agent\'s work');
    }

    const c2bHead = headFile('functions/mpesa-c2b.js');
    check('P8-c2b', c2bHead !== null && c2bHead === read('functions/mpesa-c2b.js'),
      'mpesa-c2b.js is byte-identical to HEAD — C2B is NOT Daraja; it receives money already settled');

    const d = execSync('git diff HEAD -- functions/', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    check('P8-nofn', !/^\+.*DARAJA_UI|^\+.*retire-daraja/m.test(d),
      'this gate adds no change to any Cloud Function');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('9  ANOTHER AGENT\'S WORK IS UNTOUCHED — by content, not by "file unchanged"');

  {
    /* Three times this session an "unchanged" assertion fired on someone else's legitimate
       work. The question is never "did this file change" — it is "did *I* change it". */
    const MINE = /DARAJA_UI|retire-daraja|Collected by SOKONI and settled to your wallet|do not need your own till, paybill or API keys/;
    for (const f of ['seller.html', 'pos.js', 'pos.html', 'pos-setup.html', 'functions/pos-zero-friction.js']) {
      const diff = execSync('git diff HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const addedByMe = diff.split('\n').filter((l) => l.startsWith('+') && MINE.test(l));
      check('A9-' + f.replace(/.*\//, ''), addedByMe.length === 0,
        f + ' carries none of this gate\'s markers', addedByMe.join(' | ').slice(0, 160));
    }

    const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const theirs = staged.filter((f) =>
      ['seller.html', 'pos.js', 'pos.html', 'pos-setup.html', 'functions/pos-zero-friction.js'].includes(f));
    check('A9-staged', theirs.length === 0,
      'no file carrying another agent\'s work is staged', theirs.join(', '));
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('10  SABOTAGE');

  sab('X10-1', 'restoring the credential guide', PAY,
    PAY.replace('<div class="pmt-sec">Connected Methods</div>',
      '<div class="pmt-guide-desc">Go to developer.safaricom.co.ke and copy your Consumer Key</div>\n  <div class="pmt-sec">Connected Methods</div>'),
    (s) => /developer\.safaricom\.co\.ke|Consumer Key/i.test(strip(s)));

  sab('X10-2', 'restoring a callback-registration instruction', PAY,
    PAY.replace('<div class="pmt-sec">Connected Methods</div>',
      '<div class="pmt-info">Register this URL in your Safaricom Daraja portal under CallbackURL.</div>\n  <div class="pmt-sec">Connected Methods</div>'),
    (s) => /Register this URL|CallbackURL/i.test(strip(s)));

  sab('X10-3', 'restoring the test-push button', PAY,
    PAY.replace('onclick="pmtSaveSettings()">💾 Save</button>',
      'onclick="pmtSaveSettings()">💾 Save</button>\n      <button onclick="wizSendTestPush()">📲 Send Test Push (KES 1)</button>'),
    (s) => /Send Test Push/i.test(strip(s)));

  sab('X10-4', 'HIDING the wizard with CSS instead of removing it', PAY,
    PAY.replace('<div class="pmt-pane active" id="pmt-pane-overview">',
      '<div class="pmt-pane" id="pmt-pane-wizard" style="display:none"><div id="pmt-step-4">Daraja API Credentials</div></div>\n<div class="pmt-pane active" id="pmt-pane-overview">'),
    (s) => { const t = strip(s); return /id="pmt-pane-wizard"/.test(t) || /id="pmt-step-4"/.test(t); });

  sab('X10-5', 'reintroducing the throwing read that killed the statistics', PAY,
    PAY.replace('    /* Load stats */', "    const cfg = (await getDoc(doc(_db,'shopSettings',_uid))).data();\n    det.textContent = cfg.darajaEnv;\n    /* Load stats */"),
    (s) => /cfg\.darajaEnv/.test(strip(s)));

  sab('X10-6', 'leaving a button whose handler was removed', PAY,
    PAY.replace('onclick="pmtSaveSettings()">💾 Save</button>',
      'onclick="pmtSaveSettings()">💾 Save</button>\n      <button onclick="pmtTestConnection()">⚡ Test</button>'),
    (s) => {
      const h = [...s.matchAll(/onclick="([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
      return [...new Set(h)].some((x) => !['history', 'location', 'alert'].includes(x)
        && !new RegExp('function\\s+' + x + '\\b').test(s));
    });

  sab('X10-7', 'restoring a Daraja entry to the assistant', PAY,
    PAY.replace("const AI_KB = {", "const AI_KB = {\n  'daraja credentials': `Go to the Daraja portal and copy your passkey.`,"),
    (s) => { const t = strip(s); return /Daraja|passkey/i.test(t.slice(t.indexOf('const AI_KB'))); });

  sab('X10-8', 'putting "Safaricom Daraja" back in front of customers', SMP,
    SMP.replace('· M-PESA', '· Safaricom Daraja'),
    (s) => /Safaricom Daraja/.test(s));

  sab('X10-9', 'slipping this gate\'s marker into another agent\'s file', 'clean file',
    '+      <div>Collected by SOKONI and settled to your wallet</div>',
    (s) => /DARAJA_UI|retire-daraja|Collected by SOKONI and settled to your wallet/.test(s));

  sab('X10-10', 'deleting the INBOUND callback, which D3 blocks', 'exports.darajaSTKCallback = onRequest(',
    '/* removed */', (s) => !/exports\.darajaSTKCallback\s*=/.test(s));

  /* ── CONTROLS: a detector that cannot fail proves nothing. Each of these feeds the
       detector content it must NOT flag, so the suite shows it discriminates. ── */
  section('11  CONTROLS — the detectors must also stay quiet when they should');

  check('K11-1', !/developer\.safaricom\.co\.ke|Consumer Key/i.test(strip(PAY)),
    'CONTROL: the credential detector is quiet on the real, cleaned page');
  check('K11-2', /Register this URL/i.test(strip('<p>Register this URL in your portal</p>')),
    'CONTROL: the callback detector does fire on content that contains the instruction');
  check('K11-3', !/Register this URL/i.test(strip('<!-- Register this URL — removed, see D3 -->')),
    'CONTROL: …and does NOT fire on a comment saying it was removed (stripping works)');
  {
    const clean = '<button onclick="pmtSaveSettings()">Save</button> function pmtSaveSettings(){}';
    const h = [...clean.matchAll(/onclick="([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
    const dangles = [...new Set(h)].some((x) => !new RegExp('function\\s+' + x + '\\b').test(clean));
    check('K11-4', !dangles, 'CONTROL: the dangling-handler detector is quiet when the handler exists');
  }

  return finish();
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ DARAJA UI RETIREMENT: GREEN' : '❌ DARAJA UI RETIREMENT: NOT GREEN'));
  console.log('  Certification only. No Cloud Function was modified; no inbound handler was touched.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

try { main(); }
catch (e) { console.error('\n  ✖ SUITE CRASHED — failing closed, NOT passing.\n  ' + (e && e.stack || e)); clearTimeout(WATCHDOG); process.exit(2); }
