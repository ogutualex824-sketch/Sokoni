'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   PIN YAKO NI PRODUCT YAKO — certification.

   The protection exists so a buyer does not hand over the code that closes their order before
   they have checked what is in the box. Three things therefore have to be true, and each is
   checked for its own reason:

     1. IT IS REACHED. The screen was built and browser-certified on `release/merchant-launch-rc`
        and was absent from this branch entirely — present in history, missing from the product.
        So the first thing asserted is not that the file exists but that both success surfaces
        LOAD it and CALL it.
     2. IT SAYS THE WHOLE THING, IN BOTH LANGUAGES. Each page carries the full protection, not a
        summary pointing at the other; a buyer who reads only one must not get less.
     3. IT CANNOT CONFIRM A DELIVERY. It reads no PIN, invokes no callable and does not navigate.
        A protection screen that could complete the very action it warns about would be worse
        than none.

   Run:  node scripts/certify-pin-yako-protection.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 60s. Failing closed.\n');
  process.exit(2);
}, 60000);

let PASS = 0, FAIL = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(7) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(7) + m + (x ? '\n            ' + String(x).slice(0, 240) : '')); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

/* ── A DOM small enough to be honest about what it models ──────────────────────────────────── */
function makeDom() {
  const listeners = [];
  const mkEl = (cls) => {
    const el = {
      className: cls || '', innerHTML: '', parentNode: null, children: [],
      style: {}, focused: false,
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(ev, fn) { listeners.push({ el, ev, fn }); },
      focus() { el.focused = true; },
      querySelector(sel) {
        const want = sel.replace(/^\./, '');
        if (new RegExp('class="[^"]*\\b' + want + '\\b', 'i').test(el.innerHTML)
          || new RegExp('\\b' + want + '\\b').test(el.innerHTML)) {
          if (!el._q) el._q = {};
          if (!el._q[want]) el._q[want] = mkEl(want);
          return el._q[want];
        }
        return null;
      },
    };
    return el;
  };
  const body = mkEl('body');
  return {
    document: { body, createElement: (t) => mkEl('') },
    fire(el, ev, arg) { listeners.filter((l) => l.el === el && l.ev === ev).forEach((l) => l.fn(arg || {})); },
    listeners,
  };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  PIN YAKO NI PRODUCT YAKO — the buyer\'s protection');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  const MODJS = path.join(ROOT, 'sokoni-pin-protection.js');
  const MODCSS = path.join(ROOT, 'sokoni-pin-protection.css');
  if (!fs.existsSync(MODJS) || !fs.existsSync(MODCSS)) {
    bad('P0', 'the protection module is MISSING from this branch — the defect this suite exists to catch');
    return finish();
  }

  const dom = makeDom();
  const sandbox = { document: dom.document };
  global.window = sandbox;
  delete require.cache[require.resolve(MODJS)];
  require(MODJS);
  const P = sandbox.SokoniPinProtection;

  section('1  THE SCREEN EXISTS AND IS WHOLE');
  check('C1-1', !!P && typeof P.show === 'function' && typeof P.html === 'function',
    'the module exposes show() and html()');
  const H = P.html();
  const C = P.COPY;
  check('C1-2', H.indexOf(C.slogan) > -1 && C.slogan === 'PIN YAKO NI PRODUCT YAKO!', 'the slogan is present and unchanged');
  check('C1-3', (H.match(/dh-py-slogan/g) || []).length === 1,
    'the slogan appears ONCE, above the seam — it is the name of the protection, not a sentence inside either page');
  check('C1-4', /dh-py-en/.test(H) && /dh-py-sw/.test(H) && /dh-py-seam/.test(H),
    'the book has an English page, a Kiswahili page and a centre seam');

  section('2  EACH PAGE CARRIES THE WHOLE PROTECTION');
  check('C2-1', C.checks.length === 5, 'five checks are defined');
  {
    const missEn = C.checks.filter((c) => H.indexOf(c.en.replace(/'/g, '&#39;')) < 0 && H.indexOf(c.en) < 0);
    const missSw = C.checks.filter((c) => H.indexOf(c.sw) < 0);
    check('C2-2', missEn.length === 0, 'all five appear in ENGLISH', missEn.map((c) => c.en).join(' | '));
    check('C2-3', missSw.length === 0, 'all five appear in KISWAHILI', missSw.map((c) => c.sw).join(' | '));
  }
  check('C2-4', (H.match(/dh-py-check"/g) || []).length === 10, 'ten check rows rendered — five on each page, not five shared');
  check('C2-5', (H.match(/dh-py-warn"/g) || []).length === 2 && (H.match(/dh-py-rights/g) || []).length === 2,
    'the warning AND the rights statement appear on BOTH pages — a reader of either language gets the whole thing');
  /* The rendered markup is HTML-ESCAPED, so "seller's policy" appears as "seller&#39;s policy".
     Comparing against the raw copy would report the sentence missing when it is present and
     correctly escaped — the detector has to speak the same encoding the screen does. */
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  check('C2-6', H.indexOf(escHtml(C.en.rights)) > -1 && H.indexOf(escHtml(C.sw.rights)) > -1,
    'the rights sentence is stated in both languages');
  check('C2-6b', H.indexOf("seller's policy") === -1 && H.indexOf('seller&#39;s policy') > -1,
    'CONTROL — the copy really is escaped on the way out, so C2-6 is checking the rendered screen');
  check('C2-7', /warranty/i.test(C.en.rights) && /warranty/i.test(C.sw.rights),
    'both rights statements say the PIN does not remove warranty / refund / replacement rights');
  check('C2-8', C.en.lead !== C.sw.lead && C.en.warn !== C.sw.warn,
    'the two pages are genuinely two languages, not the same string twice');
  check('C2-9', /GOT IT/.test(C.action) && /NIMEELEWA/.test(C.action),
    'one action, labelled in both languages: "' + C.action + '"');

  section('3  IT CANNOT CONFIRM A DELIVERY');
  const SRC = strip(fs.readFileSync(MODJS, 'utf8'));
  check('S3-1', !/httpsCallable|getFunctions|fetch\s*\(|XMLHttpRequest/.test(SRC),
    'the module invokes NO callable and makes no network request');
  check('S3-2', !/location\s*\.\s*href|location\s*\.\s*assign|location\s*\.\s*replace/.test(SRC),
    'it does not navigate — the caller decides where the buyer goes');
  check('S3-3', !/\bpin\b\s*[:=]|proofPin|deliveryPin/i.test(SRC),
    'it neither reads nor holds a PIN');
  check('S3-4', /httpsCallable/.test('const c = httpsCallable(f, "x");'),
    'CONTROL — the callable detector fires when the pattern IS present');

  section('4  BEHAVIOUR — it acknowledges, and puts the page back as it found it');
  {
    dom.document.body.style.overflow = 'scroll';
    const p = P.show();
    const host = dom.document.body.children[0];
    check('B4-1', !!host && host.className === 'dh-py-screen', 'showing it mounts the screen');
    check('B4-2', dom.document.body.style.overflow === 'hidden', 'scroll is locked while it is up');
    const btn = host.querySelector('.dh-py-ok');
    check('B4-3', !!btn, 'the acknowledgement button is present');
    dom.fire(btn, 'click');
    const resolved = await p;
    check('B4-4', resolved === true, 'acknowledging RESOLVES — it returns, it does not confirm anything');
    check('B4-5', dom.document.body.children.length === 0, 'the screen is removed');
    check('B4-6', dom.document.body.style.overflow === 'scroll',
      'the previous scroll state is restored EXACTLY (was "scroll", now "' + dom.document.body.style.overflow + '")');
  }
  {
    dom.document.body.style.overflow = '';
    const p = P.show();
    const host = dom.document.body.children[0];
    dom.fire(host, 'keydown', { key: 'Escape' });
    const resolved = await p;
    check('B4-7', resolved === true && dom.document.body.children.length === 0,
      'Escape acknowledges too — trapping a reader inside a message they have read is an obstacle, not a protection');
  }

  section('5  REACHABILITY — is it actually wired to the surfaces a buyer lands on?');
  for (const page of ['checkout.html', 'success.html']) {
    const raw = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const src = strip(raw);
    check('R5-' + page + '-css', /sokoni-pin-protection\.css/.test(src), page + ' loads the stylesheet');
    check('R5-' + page + '-js', /sokoni-pin-protection\.js/.test(src), page + ' loads the module');
    check('R5-' + page + '-call', /SokoniPinProtection[\s\S]{0,80}?\.show\s*\(/.test(src),
      page + ' CALLS it — not merely loads it');
  }
  {
    const co = strip(fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8'));
    check('R5-1', co.indexOf('_showPinProtection()') > co.indexOf('overlay.style.display = "flex"'),
      'on checkout it fires AFTER the success overlay is shown — on top of a screen that already says the order worked');
    check('R5-2', /try\s*\{[\s\S]{0,160}SokoniPinProtection[\s\S]{0,160}catch/.test(co),
      'the call is best-effort — a protection screen that failed to load must never block an order already paid for');
  }

  section('6  SABOTAGE');
  {
    const co = strip(fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8'));
    const su = strip(fs.readFileSync(path.join(ROOT, 'success.html'), 'utf8'));
    sab('X6-1', 'dropping the script tag from checkout',
      co.replace(/sokoni-pin-protection\.js/g, 'x.js'), (s) => !/sokoni-pin-protection\.js/.test(s));
    sab('X6-2', 'loading the module but never calling it',
      co.replace(/P\.show\(\)/g, 'void 0'), (s) => !/SokoniPinProtection[\s\S]{0,80}?\.show\s*\(/.test(s));
    sab('X6-3', 'dropping the call from the standalone success page',
      su.replace(/P\.show\(\)/g, 'void 0'), (s) => !/SokoniPinProtection[\s\S]{0,80}?\.show\s*\(/.test(s));
    sab('X6-4', 'removing the Kiswahili page',
      P.html().replace(/dh-py-sw/g, 'dh-py-en'), (s) => !/dh-py-sw/.test(s));
    sab('X6-5', 'letting the screen invoke a callable',
      SRC.replace('function showPinProtection(opts) {', 'function showPinProtection(opts) { httpsCallable(f,"confirm")();'),
      (s) => /httpsCallable/.test(s));
  }

  return finish();
}

function sab(id, what, mutated, detector) {
  let flagged;
  try { flagged = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return flagged
    ? ok(id, 'SABOTAGE ' + what + ' → detected')
    : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS);
  console.log('  failed  : ' + FAIL);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  console.log('\n  ' + (FAIL === 0 ? '✅ PIN YAKO NI PRODUCT YAKO: GREEN' : '❌ NOT GREEN'));
  console.log('  Certification only. Nothing here deploys anything.\n');
  clearTimeout(WATCHDOG);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
