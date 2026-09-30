#!/usr/bin/env node
'use strict';
/* ============================================================================
   Sign-up consent — onboarding.html (every "Create Free Account") records consent it asked for
   ----------------------------------------------------------------------------
   Census 2026-10-01 P0 #4: the canonical sign-up created accounts with no notice, no terms /
   privacy acceptance, no age confirmation and no consentRecords row.
     A  sokoni-consent-record.js (executed): required boxes unticked → no choices; marketing is
        separate and optional; record() writes ONE immutable consentRecords row + a profile
        snapshot, matching auth.js's POLICY_VERSION; skips a user already recorded for this
        version; refuses without required consent; a snapshot failure never hides the row
     B  onboarding.html wiring: the block is rendered for Create Account + Google + Phone; each
        handler requires the choices BEFORE creating/entering and records AFTER; a record
        failure is surfaced
     C  honesty: the legal gate fails CLOSED (module missing; service error); no "Uploaded ✓"
        for files that are never sent; no "3× more bookings" / "24-48 hours" claims
   node scripts/test-signup-consent.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  console.log('Sign-up consent\n');
  console.log('A. sokoni-consent-record.js (executed)');
  const boxes = { cnTerms: { checked: false }, cnPrivacy: { checked: false }, cnAge: { checked: false }, cnMkt: { checked: false } };
  const doc = { querySelector: (sel) => boxes[sel.replace('#', '')] || null };
  const ctx = { window: {}, document: doc, console, setTimeout, Date, Promise };
  ctx.window.window = ctx.window; ctx.globalThis = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src('sokoni-consent-record.js'), ctx);
  const R = ctx.window.SokoniConsentRecord;
  ck('A0 module loads', !!R && typeof R.record === 'function');
  const authPV = (src('auth.js').match(/const POLICY_VERSION = '([^']+)'/) || [])[1];
  ck('A1 policy version matches auth.js (' + authPV + ')', R.POLICY_VERSION === authPV);
  ck('A2 nothing ticked → no choices (cannot proceed)', R.readChoices(doc) === null);
  boxes.cnTerms.checked = true; boxes.cnAge.checked = true;
  ck('A3 terms + age but NOT privacy → still no choices (separate required acknowledgement)', R.readChoices(doc) === null);
  boxes.cnPrivacy.checked = true;
  const c1 = R.readChoices(doc);
  ck('A4 required boxes ticked → choices, marketing false by default', c1 && c1.terms && c1.privacy && c1.ageConfirmed && c1.marketing === false, c1);
  const html = R.blockHtml();
  ck('A5 block: every box unticked by default; marketing marked optional and separate',
    !/checked/.test(html) && /id="cnMkt"/.test(html) && /optional/.test(html) && /id="cnTerms" required/.test(html) && /id="cnPrivacy" required/.test(html) && /id="cnAge" required/.test(html));
  ck('A6 block links the Terms and the Privacy Policy', /href="terms\.html"/.test(html) && /href="privacy\.html"/.test(html));

  /* fake Firestore module (only what record() uses) */
  const rows = []; const docs = new Map(); let failSnapshot = false;
  const fakeFs = {
    doc: (db, c, id) => ({ c, id }), collection: (db, c) => ({ c }),
    getDoc: async (r) => ({ exists: () => docs.has(r.c + '/' + r.id), data: () => docs.get(r.c + '/' + r.id) }),
    addDoc: async (col, d) => { rows.push({ col: col.c, d }); return { id: 'r' + rows.length }; },
    setDoc: async (r, d) => { if (failSnapshot) throw Object.assign(new Error('denied'), { code: 'permission-denied' }); docs.set(r.c + '/' + r.id, { ...(docs.get(r.c + '/' + r.id) || {}), ...d }); },
    serverTimestamp: () => '__ts__',
  };
  const deps = { db: {}, fs: fakeFs };
  const r1 = await R.record({ uid: 'u1' }, 'onboarding-email', c1, deps);
  ck('A7 record() writes ONE consentRecords row with uid/source/policyVersion/terms/privacy/age/marketing',
    r1.recorded && rows.length === 1 && rows[0].col === 'consentRecords' && rows[0].d.uid === 'u1' && rows[0].d.policyVersion === authPV
    && rows[0].d.terms && rows[0].d.privacy && rows[0].d.ageConfirmed && rows[0].d.marketing === false && rows[0].d.source === 'onboarding-email', rows);
  ck('A8 and a users/{uid}.consent snapshot', (docs.get('users/u1') || {}).consent && docs.get('users/u1').consent.policyVersion === authPV);
  const r2 = await R.record({ uid: 'u1' }, 'onboarding-google', c1, deps);
  ck('A9 a returning user already recorded for this version is not re-recorded', r2.recorded === false && rows.length === 1, r2);
  let threw = null; try { await R.record({ uid: 'u2' }, 'x', { terms: true, privacy: false, ageConfirmed: true }, deps); } catch (e) { threw = e.message; }
  ck('A10 refuses to record without the required consent', !!threw && rows.length === 1, threw);
  failSnapshot = true;
  const r3 = await R.record({ uid: 'u3' }, 'onboarding-phone', { ...c1, marketing: true }, deps);
  ck('A11 a snapshot failure does not hide the append-only row (marketing true recorded as chosen)', r3.recorded && rows.length === 2 && rows[1].d.marketing === true);

  console.log('\nB. onboarding.html wiring');
  const ob = src('onboarding.html');
  ck('B1 loads sokoni-consent-record.js and renders the block before the "or" divider', /src="sokoni-consent-record\.js"/.test(ob) && ob.indexOf('id="cnWrap"') > ob.indexOf('id="fSu"') && ob.indexOf('id="cnWrap"') < ob.indexOf('class="divline"'));
  ck('B2 Create Account requires choices BEFORE createUser, records AFTER', /async function emailSU\(e\)\{e\.preventDefault\(\);const c=_choices\(\);if\(!c\)return;[\s\S]*createUserWithEmailAndPassword[\s\S]*_record\(cr\.user,'onboarding-email',c\)/.test(ob));
  ck('B3 Google requires choices before the popup, records after', /async function google\(\)\{const c=_choices\(\);if\(!c\)return;[\s\S]*signInWithPopup[\s\S]*_record\(cr&&cr\.user,'onboarding-google',c\)/.test(ob));
  ck('B4 Phone requires choices before sending the OTP and records after confirming', /async function sendOTP\(\)\{if\(!_choices\(\)\)return;/.test(ob) && /_conf\.confirm\(code\);\s*[\r\n]+\s*await _record\(_cr&&_cr\.user,'onboarding-phone'/.test(ob));
  ck('B5 a consent-record failure is shown to the user (never silent)', /could not save your consent choices/.test(ob));

  console.log('\nC. honesty');
  ck('C1 onboarding legal step fails CLOSED when the agreements module is missing', /if\(!window\.SokoniLegalGate\)\{_legalOk=false;/.test(ob) && !/_legalOk=true;return;/.test(ob));
  const gate = src('sokoni-legal-gate.js');
  ck('C2 the shared legal gate reports compliant:false (not true) when the service errors', /done\(false, \{ compliant: false, unavailable: true \}\)/.test(gate) && !/done\(true, \{ compliant: true, unavailable: true \}\)/.test(gate));
  ck('C3 no "Uploaded ✓" for files that are never sent', !/Uploaded ✓/.test(ob) && /Chosen · not sent yet/.test(ob));
  ck('C4 no "3× more bookings" / "24-48 hours" claims', !/3× more bookings|24-48 hours/.test(ob));

  console.log('\nD. legal gate retry (executed: service fails, then recovers)');
  {
    let calls = 0;
    const fb = { functions: () => ({ httpsCallable: () => async (data) => {
      calls++;
      if (calls === 1) throw new Error('unavailable');
      return { data: { compliant: true } };
    } }) };
    let btnHandler = null;
    const el = {
      innerHTML: '', style: {}, classList: { add() {}, remove() {} },
      querySelector: (sel) => (sel === '.slg-btn' ? { addEventListener: (ev, fn) => { if (ev === 'click') btnHandler = fn; } } : null),
      querySelectorAll: () => [],
    };
    const gctx = {
      window: {}, firebase: fb, console, setTimeout, Promise,
      document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, querySelector: () => null },
      navigator: { userAgent: 'test', language: 'en' },
    };
    gctx.window.window = gctx.window;
    vm.createContext(gctx);
    vm.runInContext(src('sokoni-legal-gate.js'), gctx);
    const results = [];
    gctx.window.SokoniLegalGate.mount(el, { role: 'provider', onComplete: (ok, meta) => results.push({ ok, meta }) });
    await new Promise((r) => setTimeout(r, 20));
    ck('D1 service error → onComplete(false, unavailable) and a "Try again" button (fail closed)',
      results.length === 1 && results[0].ok === false && results[0].meta.unavailable === true && /Try again/.test(el.innerHTML) && typeof btnHandler === 'function', results);
    if (btnHandler) btnHandler();
    await new Promise((r) => setTimeout(r, 20));
    ck('D2 "Try again" after the service recovers → onComplete(true) is called again (callers re-enable)',
      results.length === 2 && results[1].ok === true, results);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
