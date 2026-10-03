#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SECONDARY FIREBASE APPS — the defect class 81ca4f2 fixed two instances of
   ------------------------------------------------------------------------------
   App Check is attached to the DEFAULT Firebase app (firebase.js). A SECONDARY app —
   initializeApp(cfg, 'some-name') — does NOT inherit it, so every Firestore read or
   write made through that app leaves with no App Check token. Under enforcement it
   comes back PERMISSION_DENIED and the page's catch renders a friendly lie: a shop
   that exists reports "Could not load business", a booking that was never written
   reports success.

   81ca4f2 fixed business.html ('bizPage') and businesses.html ('bizDir'). A repo-wide
   scan then found the same pattern in 29 further files, including WRITE paths for
   bookings and leads (cln-write, elc-write, plm-write, cr-write, ch-write, hs-write,
   th-write, mkt-write, dh-wd) — money paths where a silent write failure is worse than
   a visible read failure.

   search.html was converted earlier for the same reason and its comment already names the
   rest of the class as "tracked separately, not changed here" — and confirms App Check IS
   enforced on firestore.googleapis.com, so these are live defects, not latent ones.

   THIS SUITE IS A RATCHET, NOT A CLEANUP. The 29 known files are recorded in BASELINE below
   and do not fail: converting them is a shipping change across 29 public surfaces, and it is
   being scheduled deliberately rather than smuggled in through a test. What fails is a NEW
   secondary app, or one appearing in a file not already on the list — so the class can only
   shrink. Remove a name from BASELINE as each file is converted; the suite fails if a BASELINE
   entry is stale, so the list cannot rot into fiction.

   Comments are stripped before scanning. business.html and businesses.html both still
   DESCRIBE the removed initializeApp(...) call in a comment explaining the fix, and a
   naive scan reports them as defective — the same trap 81ca4f2's own test called out:
   read the code, not the prose about the code.

     node scripts/test-secondary-firebase-apps.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 100) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
};

/* Finds `initializeApp(<config>, 'name')` — modular or compat — where <config> may be an
   INLINE OBJECT LITERAL, not just an identifier.

   SCANNER BLIND SPOT, found the hard way. The first version required the config argument to
   match [^,()]+, which cannot match an object literal because one is full of commas and
   braces. seller.html does exactly that:

       initializeApp({ apiKey:"…", authDomain:"…", … }, "revSnap")

   so it was reported CLEAN while creating a secondary app that reads commissionLedger with no
   App Check token — the very thing this suite exists to catch. A scanner that silently misses
   the shapes it was written for is worse than no scanner: it converts an unknown into a
   false assurance. Argument boundaries are now found by BALANCING brackets rather than by
   forbidding the characters that make a literal a literal. */
/* The scan is a TOKEN pass (scripts/lib/js-tokens.js), not a comment/string stripper.

   DETECTOR BLIND SPOT #2, found the hard way (2026-10-03). The first version stripped
   comments and strings with a hand-written quote-tracking state machine run over the WHOLE
   html file. It knew nothing about REGEX LITERALS. electrical.html's escaper

       const _esc = s => String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

   opened a "string" at the `"` inside /"/g, and from there the stripper was out of phase for
   the rest of the script: a real block comment in submitBooking survived as "string", then the
   `//` inside "https://www.gstatic.com/…" was taken as a line comment and swallowed the rest of
   the line — including `initializeApp(_cfg,"elc-write")`, a secondary app WRITING
   homeServiceBookings with no App Check token. The suite then reported electrical.html as
   FIXED and demanded its BASELINE entry be removed: a detector failure presented as progress.
   The fix is in the detector, never in the baseline.

   Now: inline <script> bodies a browser would execute are extracted (HTML comments skipped;
   non-JS types such as ld+json skipped), .js files are taken whole, and each is TOKENIZED —
   strings, templates with nested ${…}, regex literals and comments are all real tokens. A call
   is `initializeApp(` (bare or as `.initializeApp(` on any object) whose argument list has ≥2
   arguments and whose second argument is a single string (or substitution-free template)
   literal. Comments are not tokens, so prose that DESCRIBES the call cannot match; a string
   that CONTAINS the call text is one token, so it cannot match either.

   FAIL CLOSED: a script the tokenizer cannot lex is reported as a named FAIL row — an
   unanalysed file is an unknown, and an unknown is never rendered as "clean". The one
   distinction: if V8 itself refuses to compile the script, it is DEAD in the browser too (it
   runs nothing). That is ALSO a named FAIL row (owner 2026-10-03: a DEAD page is not
   release-ready), reported as a page defect rather than a detector gap — and its file is still
   treated as UNKNOWN (never "clean", never "stale"). */
const { extractInlineScripts, findSecondaryAppsInJs } = require('./lib/js-tokens');

/* When the tokenizer refuses a script, ask the JS ENGINE (V8, via node) whether it compiles.
     · V8 compiles it  → the tokenizer has a blind spot: FAIL, the file is unanalysed.
     · V8 refuses it too → the script is DEAD in the browser as well: it executes nothing, so it
       cannot create any app. That is a page defect (reported by name, below), not a hole in
       this detector — and the file's names are still UNKNOWN, so it is never called stale. */
const vm = require('vm');
const os = require('os');
const { spawnSync } = require('child_process');
function engineRejects(code, kind) {
  const tries = kind === 'module' ? ['module'] : kind === 'classic' ? ['classic'] : ['classic', 'module'];
  let why = '';
  for (const t of tries) {
    if (t === 'classic') {
      try { new vm.Script(code); return ''; } catch (e) { why = why || 'SyntaxError: ' + e.message; }
    } else {
      const tmp = path.join(os.tmpdir(), 'secapps-' + process.pid + '-' + Date.now() + '.mjs');
      fs.writeFileSync(tmp, code);
      try {
        const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
        if (r.status === 0) return '';
        const line = (r.stderr || '').split('\n').find((l) => /Error/.test(l));
        why = why || (line || 'node --check failed').trim();
      } finally { try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ } }
    }
  }
  return why;
}

/** File → { names, blind, dead }. blind/dead = [ "unit: reason" ] — never swallowed. */
function scanSource(file, src) {
  const names = new Set(), blind = [], dead = [];
  const units = /\.html$/i.test(file)
    ? extractInlineScripts(src).map((s) => ({ label: 'inline script #' + s.index + ' (body starts line ' + s.line + ')', code: s.code, kind: s.module ? 'module' : 'classic' }))
    : [{ label: 'file', code: src, kind: 'either' }];
  for (const u of units) {
    try { findSecondaryAppsInJs(u.code).forEach((n) => names.add(n)); }
    catch (e) {
      const engine = engineRejects(u.code, u.kind);
      if (engine) dead.push(u.label + ': ' + engine + ' [tokenizer: ' + e.message + ']');
      else blind.push(u.label + ': ' + e.message + ' — but V8 compiles it');
    }
  }
  return { names: [...names].sort(), blind, dead };
}

/* Known, accepted-for-now instances. file → sorted app names. */
const BASELINE = {
  'admin.html':                ['adm-flags'],
  'b2b.html':                  ['b2b-fee'],
  'business-os.html':          ['bos-load', 'bos-sync'],
  'car-hub.html':              ['ch-rt', 'ch-write'],
  'car-rental.html':           ['cr-write'],
  'cleaning.html':             ['cln-write'],
  'commerce-os.html':          ['commerce-os'],
  'developer-portal.html':     ['developer-portal'],
  'electrical.html':           ['elc-write'],
  'email-center.html':         ['email-center'],
  'event-hub.html':            ['event-hub'],
  'event-manager.html':        ['event-manager'],
  'executive-dashboard.html':  ['executive-dashboard'],
  'home-services.html':        ['hs-read', 'hs-write'],
  'legal-hub.html':            ['lh-lead'],
  'marketing.html':            ['mkt-write'],
  'plumbing.html':             ['plm-write'],
  'release-readiness.html':    ['release-readiness'],
  'revenue.html':              ['revenue-dash'],
  'security-center.html':      ['security-center'],
  /* Found only after the scanner blind spot above was fixed — its config is an inline object
     literal, which the first regex could not match. Identical at live 6ac58e6, so pre-existing
     and deferred with the rest, not an RC change. Worth flagging when this list is worked:
     seller.html loads the Firebase SDK TWICE (10.12.0 for this block, 10.12.2 via firebase.js),
     so revSnap is created on a different SDK instance from the one App Check initialises — two
     app registries in one document. It reads commissionLedger, so under enforcement the
     revenue snapshot silently renders nothing (the block ends in an empty catch). */
  'seller.html':               ['revSnap'],
  'sokoni-b2b.js':             ['b2b-fs'],
  'sokoni-featured.js':        ['sokoni-featured'],
  'sokoni-recommendations.js': ['sk-recs'],
  'tech-hub.html':             ['th-read', 'th-write'],
  'verification-admin.html':   ['sokoni-va'],
  'verification.html':         ['sokoni-verify'],
  'wholesale-portal.html':     ['wholesale-portal'],
};

/* Fixed by 81ca4f2 and asserted to STAY fixed — the whole point of the exercise. */
const MUST_BE_CLEAN = ['business.html', 'businesses.html', 'search.html'];

/* Optional: SECONDARY_APPS_REF=<commit> scans that commit's root files via `git show` instead
   of the working tree (e.g. to compare against the live hosting commit). No checkout needed. */
const REF = process.env.SECONDARY_APPS_REF || '';
if (REF && !/^[\w./-]+$/.test(REF)) { console.error('bad SECONDARY_APPS_REF'); process.exit(2); }
const { execFileSync } = require('child_process');
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const listRoot = () => (REF ? git(['ls-tree', '--name-only', REF]).split('\n').filter(Boolean) : fs.readdirSync(ROOT));
const readRoot = (f) => (REF ? git(['show', REF + ':' + f]) : fs.readFileSync(path.join(ROOT, f), 'utf8'));

console.log('\nSECONDARY FIREBASE APPS — App Check rides on the default app only' + (REF ? '   (ref ' + REF + ')' : '') + '\n');

/* ── detector self-test: the shapes that have fooled a scanner before ──────────────────────
   Each row is a fixture with a KNOWN answer. If the detector regresses to a quote-tracking
   stripper, row (1) goes red — that is the regression row for blind spot #2. */
/* (1) electrical.html as of e3e7274, verbatim: the _esc line (regex literals containing both
   quote characters) followed by the single-line submitBooking that creates 'elc-write'. */
const FX_ELECTRICAL =
  "const _esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&" +
  "gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');\nfunction submitBooking(){if(typeof Sok" +
  "oniSecurity!=='undefined'&&!SokoniSecurity.persistentRateLimit('elec_book',10,300000)){if(" +
  "msgEl){msgEl.textContent='⚠️ Too many attempts. Wait 5 min.';msgEl.style.color='#ff9800';}" +
  "return;};const name=document.getElementById('pgName')?.value.trim();const phone=document.g" +
  "etElementById('pgPhone')?.value.trim();const date=document.getElementById('pgDate')?.value" +
  ";const time=document.getElementById('pgTime')?.value;const address=document.getElementById" +
  "('pgAddress')?.value.trim();const notes=document.getElementById('pgNotes')?.value.trim();c" +
  "onst msgEl=document.getElementById('pgModalMsg');const services=[...document.querySelector" +
  "All('#pgChips .pg-chip.sel')].map(c=>c.dataset.svc).join(', ');if(!name||!phone||!address)" +
  "{if(msgEl){msgEl.textContent='⚠️ Please fill name, phone and address.';msgEl.style.color='" +
  "#ff6b6b';}return;}const id='ELC'+Date.now().toString().slice(-7);const msg=`Hi${selectedPr" +
  "ov?' '+selectedProv.name:''}! I found you on SOKONI and need an electrician.\\n\\n📋 Booking " +
  "ID: ${id}\\n👤 Name: ${name}\\n📞 Phone: ${phone}\\n⚡ Service: ${services||'General Electrical'" +
  "}\\n📅 Date: ${date||'TBD'} at ${time||'TBD'}\\n📍 Location: ${address}\\n${notes?'📝 Notes: '+n" +
  "otes+'\\n':''}\\nPlease confirm your availability. Thank you!`;(typeof SokoniPay!=='undefine" +
  "d'&&SokoniPay.waConnect?SokoniPay.waConnect((selectedProv?.phone||'0705726803').replace(/^" +
  "0/,'254').replace(/\\D/g,''),msg,{providerName:selectedProv?.name||'SOKONI Electricians',ca" +
  "tegory:'electrical',serviceDesc:services||'Electrical Service'}):void 0 /* no WhatsApp han" +
  "d-off (owner 2026-09-30) */);let _bks=[];try{_bks=JSON.parse(localStorage.getItem('sokoniB" +
  "ookings')||'[]');}catch(e){}; _bks.unshift({id,type:'electrical',service:services||'Genera" +
  "l Electrical',name,phone,date,time,address,notes,provider:selectedProv?.name||'Any Electri" +
  "cian',status:'requested',createdAt:new Date().toISOString()}); localStorage.setItem('sokon" +
  "iBookings',JSON.stringify(_bks.slice(0,100))); (async()=>{try{const {initializeApp,getApps" +
  "}=await import(\"https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js\");const {getFir" +
  "estore,collection,addDoc,serverTimestamp}=await import(\"https://www.gstatic.com/firebasejs" +
  "/10.12.0/firebase-firestore.js\");const _cfg={apiKey:\"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hz" +
  "VE\",authDomain: \"auth.mysokoni.co.ke\",projectId:\"sokoni-aeb26\",storageBucket:\"sokoni-aeb26" +
  ".firebasestorage.app\",messagingSenderId:\"24799054989\",appId:\"1:24799054989:web:e1cf6ca8c28" +
  "1bf1abf26c4\"};const _a=getApps().find(a=>a.name===\"elc-write\")||initializeApp(_cfg,\"elc-wr" +
  "ite\");await addDoc(collection(getFirestore(_a),'homeServiceBookings'),{id,hub:'electrical'" +
  ",service:services||'General Electrical',name,phone,date,time,address,notes,provider:select" +
  "edProv?.name||'Any Electrician',status:'pending',createdAt:serverTimestamp()});}catch(e){}" +
  "})(); if(window.SokoniInvoice)setTimeout(function(){SokoniInvoice.generate({type:'service'" +
  ",buyerName:name,buyerPhone:phone,items:[{name:services||'Electrical Service',category:'Ele" +
  "ctrical',qty:1,price:0}],subtotal:0,total:0,paymentMethod:'WhatsApp Booking',paymentRef:id" +
  ",sellerName:selectedProv?.name||'SOKONI Electricians',date:new Date().toISOString(),notes:" +
  "address});},700); if(msgEl){msgEl.innerHTML=`✅ Booking <strong style=\"color:#f59e0b;\">${_e" +
  "sc(id)}</strong> recorded in SOKONI.`;msgEl.style.color='#22c55e';}setTimeout(closeBooking" +
  ",3000);}";
const FIXTURES = [
  ['(1) electrical.html _esc + submitBooking (verbatim) → elc-write', FX_ELECTRICAL, ['elc-write']],
  ['(2) regex literal containing quotes before the call → detected',
    "const r = /'\"/g; const t = s.replace(/[\"']/g, ''); const a = initializeApp(cfg, 'rx-app'); // \"'", ['rx-app']],
  ['(3) template ${a?\'x\':\'y\'} (quotes inside a substitution) before the call → detected',
    "const m = `pre ${a ? 'x' : \"y\"} ${`nested ${b ? '}' : '{'}`} post`; const ap = initializeApp(cfg, \"tpl-app\");", ['tpl-app']],
  ['(4) the call inside comments → NOT detected',
    "/* initializeApp(cfg, 'blk-app') */ // initializeApp(cfg, 'line-app')\nconst x = 1;", []],
  ['(5) the call inside strings/templates → NOT detected',
    "const a = \"initializeApp(cfg, 'dq-app')\"; const b = 'initializeApp(c, \"sq-app\")'; const c = `initializeApp(c, 'tq-app')`;", []],
  ['(6) inline object-literal config (seller.html shape) → detected',
    "const app = firebase.initializeApp({ apiKey: \"k\", authDomain: \"a,b\", nested: { x: [1, 2] } }, \"revSnap\");", ['revSnap']],
];
console.log('── the detector finds the shapes it exists for (fixtures) ──');
for (const [label, code, want] of FIXTURES) {
  let got, err = '';
  try { got = [...new Set(findSecondaryAppsInJs(code))].sort(); } catch (e) { err = e.message; }
  ck(label, !err && JSON.stringify(got) === JSON.stringify([...want].sort()), err ? 'tokenize error: ' + err : 'got ' + JSON.stringify(got));
}
console.log('');

const files = listRoot()
  .filter((f) => /\.(html|js)$/.test(f))
  .filter((f) => !/^service-worker|^firebase-messaging-sw/.test(f))
  .sort();

const found = {};
const unanalysed = [];      /* [file, reason] — detector could not read/lex; V8 can → FAIL */
const deadScripts = [];     /* [file, reason] — V8 refuses too: dead in the browser */
const unknownFiles = new Set();
for (const f of files) {
  let src;
  try { src = readRoot(f); } catch (e) { unanalysed.push([f, 'unreadable — ' + e.message.split('\n')[0]]); unknownFiles.add(f); continue; }
  const r = scanSource(f, src);
  if (r.names.length) found[f] = r.names;
  r.blind.forEach((e) => { unanalysed.push([f, e]); unknownFiles.add(f); });
  r.dead.forEach((e) => { deadScripts.push([f, e]); unknownFiles.add(f); });
}

console.log('── every page/script was analysed (fail closed) ──');
if (!unanalysed.length) ck('every executable script tokenized (' + files.length + ' files scanned)', true);
for (const [f, why] of unanalysed) ck('NOT ANALYSED — ' + f + ' (unknown, never clean)', false, why);
/* OWNER RULE (2026-10-03): a DEAD page FAILS the run. A page whose JavaScript cannot execute is not
   release-ready, so it is a named FAIL row (non-zero exit), never a note. Its file also stays
   UNKNOWN below (never "clean", never "stale"). PASS = valid + scanner checks pass; KNOWN_PROBLEM =
   a BASELINE entry on an executable page; DEAD / NOT ANALYSED = failure. */
if (!deadScripts.length) ck('no DEAD page — every inline script compiles in V8', true);
for (const [f, why] of deadScripts) ck('DEAD — ' + f + ' — script does not compile in V8 (page defect; runs nothing)', false, why.slice(0, 160));
console.log('');

console.log('── the pages already converted must stay on the canonical app ──');
for (const f of MUST_BE_CLEAN) {
  ck(f + ' creates no secondary Firebase app', !found[f] && !unknownFiles.has(f),
     found[f] ? found[f].join(', ') : unknownFiles.has(f) ? 'UNKNOWN — not fully analysed' : '');
  const src = readRoot(f);
  ck(f + ' imports db from firebase.js', /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"]\.\/firebase\.js['"]/.test(src));
}

console.log('\n── no NEW secondary app may appear (ratchet) ──');
const newFiles = Object.keys(found).filter((f) => !BASELINE[f] && !MUST_BE_CLEAN.includes(f));
ck('no file outside the baseline creates a secondary app', newFiles.length === 0,
   newFiles.length ? newFiles.map((f) => f + ':' + found[f].join('/')).join('  ') : 'none');

const grew = [];
for (const f of Object.keys(BASELINE)) {
  const now = found[f] || [];
  const extra = now.filter((n) => !BASELINE[f].includes(n));
  if (extra.length) grew.push(f + ' +' + extra.join('/'));
}
ck('no baselined file gained an additional secondary app', grew.length === 0, grew.join('  ') || 'none');

console.log('\n── the baseline must describe reality, not history ──');
const stale = [];
for (const f of Object.keys(BASELINE)) {
  const now = found[f] || [];
  const gone = BASELINE[f].filter((n) => !now.includes(n));
  if (!gone.length) continue;
  /* Absence in a file that was not fully analysed is an UNKNOWN, not evidence of a fix — the
     exact mistake blind spot #2 made. Never ask for a baseline entry to be removed on it. */
  if (unknownFiles.has(f)) { console.log('  NOTE  ' + f + ': ' + gone.join('/') + ' not seen, but the file is not fully analysed (see DEAD / NOT ANALYSED) — entry kept, status unknown'); continue; }
  stale.push(f + ' no longer has ' + gone.join('/') + ' — remove it from BASELINE');
}
/* A converted file leaving its name in BASELINE would quietly re-permit the pattern there
   forever. Fixing a file must therefore also shrink the list. */
ck('no BASELINE entry is stale', stale.length === 0, stale.join('  |  ') || 'none');

const total = Object.keys(BASELINE).reduce((n, f) => n + BASELINE[f].length, 0);
console.log('\n' + '─'.repeat(70));
console.log('  OUTSTANDING: ' + Object.keys(BASELINE).length + ' files, ' + total + ' secondary apps still to convert.');
console.log('  Each one reads/writes Firestore with NO App Check token. The write paths');
console.log('  (cln-write, elc-write, plm-write, cr-write, ch-write, hs-write, th-write,');
console.log('  mkt-write) fail SILENTLY — a booking that was never stored still');
console.log('  reports success to the customer.');
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  x ' + f)); }
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
