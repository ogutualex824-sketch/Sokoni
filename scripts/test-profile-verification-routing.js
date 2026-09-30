/* ══════════════════════════════════════════════════════════════════════════════
   PROFILE VERIFICATION — ENTRY-POINT ROUTING CERTIFICATION
   scripts/test-profile-verification-routing.js

   THE DEFECT THIS PINS
   The verified-phone flow on profile.html is complete and correct, and was UNREACHABLE
   from every surface that offers it. Four entry points all led to account-centre.html,
   whose verification panel only DISPLAYS status — zero `type="tel"` inputs, zero
   phone-auth calls, zero sendEmailVerification calls — and whose own "Start Verification"
   button returns to `profile.html#verify`, a hash with no matching panel. So the journey
   was a closed loop that never reached the flow:

       completion step "Verify phone number"  ─┐
       completion step "Verify email address" ─┼─> account-centre.html#verification
       verification badge grid (phone)        ─┘        └─> profile.html#verify ─> no-op

   All four now reach the existing canonical entry points — _pvStartPhone() and
   _pvSendEmail() — which were already on this page and already correct.

   WHAT THIS IS NOT
   No new phone writer, no new verification mechanism, no second authority. Firebase Auth
   remains the verification authority; success still flows exclusively
   _pvVerifyCode -> _pvPersistPhone. This is routing, and nothing else.

   KNOWN GAP, DELIBERATELY NOT REPAIRED HERE
   The `address` completion step has the identical dead-end shape on this lineage and is
   outside this slice. Section 3 PINS it so it stays visible.

   HOW IT IS ASSERTED
   Renderers and the router are extracted from the page and EXECUTED against stub DOM /
   location objects, so what is proven is the behaviour the page actually produces — not
   the presence of source text.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const html = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
const engine = fs.readFileSync(path.join(ROOT, 'functions', 'profile-engine.js'), 'utf8');

function extractFn (src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const LOAD_SRC = extractFn(html, '_loadCompletion');

/* Run the real renderer over a set of steps and return the markup for the list. */
function renderSteps (steps) {
  let listHTML = '';
  const el = (set) => ({ set innerHTML (v) { set(v); }, get innerHTML () { return ''; },
                         style: {}, textContent: '' });
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'piStepsList') return el(v => { listHTML = v; });
        if (id === 'piRecoList')  return el(() => {});
        return { style: {}, textContent: '', set innerHTML (v) {}, get innerHTML () { return ''; } };
      },
    },
    _esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    slugify: (s) => String(s).toLowerCase().replace(/\s+/g, '-'),
    toggleInlineEdit: () => {},
  };
  /* eslint-disable no-new-func */
  const f = new Function('sandbox', 'with (sandbox) {' + LOAD_SRC + '\n return _loadCompletion; }');
  f(sandbox)({ percent: 50, done: 5, total: 10, steps, recommendations: [] });
  return listHTML;
}

/* Run the real verification-badge grid renderer and return its markup. Extracted from
   _piLoadCard's _render(), which is nested too deeply to pull out as a named function, so
   the source span is sliced and EXECUTED — what is proven is the markup the page emits. */
const GRID_SRC = (() => {
  const s = html.indexOf('var VERIF_HREF = {');
  if (s === -1) return null;
  const e = html.indexOf("}).join('');", s);
  return e === -1 ? null : html.slice(s, e + 12);
})();

function renderBadges (verifications) {
  let gridHTML = '';
  const sandbox = {
    grid: { set innerHTML (v) { gridHTML = v; }, get innerHTML () { return ''; } },
    data: { verifications },
    VERIF_MAP: [
      { k: 'email', icon: 'E', label: 'Email' },
      { k: 'phone', icon: 'P', label: 'Phone' },
      { k: 'identity', icon: 'I', label: 'Identity' },
      { k: 'bank', icon: 'B', label: 'Bank' },
    ],
  };
  /* eslint-disable no-new-func */
  const f = new Function('sandbox', 'with (sandbox) {' + GRID_SRC + '\n return grid.innerHTML; }');
  f(sandbox);
  return gridHTML;
}

/* ── Execute the real hash router ──────────────────────────────────────────────
   Returns what it DID for a given hash: which tab it switched to, and whether it
   reached the verified-phone entry point. Executed, not inspected. */
const HASH_SRC = extractFn(html, '_openTabFromHash');

/* The router's two lookup tables, read from the PAGE rather than restated here, so the
   test cannot drift from what actually ships. */
const MOVED_SRC  = (html.match(/var _MOVED_TABS = \{[^}]*\};/) || [''])[0];
const ACTION_SRC = (html.match(/var _ACTION_HASHES = \{[^}]*\};/) || [''])[0];

function routeHash (hash, opts) {
  const o = opts || {};
  const calls = { switchTab: [], verifyEntry: 0, replaced: [] };
  const sandbox = {
    location: { hash, replace: (u) => calls.replaced.push(u) },
    switchTab: (k, f) => calls.switchTab.push(k),
    document: {
      /* the page's real panels; 'verify' is deliberately absent */
      getElementById: (id) => (o.panels || ['panel-overview', 'panel-orders', 'panel-identity'])
        .indexOf(id) !== -1 ? {} : null,
    },
    window: {
      _pvOpenVerifyFromHash: o.noHandler ? undefined : () => { calls.verifyEntry++; },
    },
  };
  /* eslint-disable no-new-func */
  new Function('sandbox', 'with (sandbox) {' + MOVED_SRC + '\n' + ACTION_SRC + '\n' +
    HASH_SRC + '\n _openTabFromHash(); }')(sandbox);
  return calls;
}

/* ── Execute the '#verify' entry-point handler ─────────────────────────────────
   Proves the two gates (auth readiness, already-verified) behave, and that the only
   thing it can ever reach is the canonical _pvStartPhone. */
const VERIFY_SRC = (html.match(/window\._pvOpenVerifyFromHash = function\(\)\{[\s\S]*?\n  \};/) || [''])[0];

function runVerifyEntry (user) {
  const calls = { startPhone: 0, listeners: [], removed: 0 };
  const win = {};
  const sandbox = {
    /* a getter lets a test flip null -> signed-in between the defer and the re-entry */
    _pvUser: typeof user === 'function' ? user : () => user,
    window: win,
    document: {
      addEventListener: (ev, fn) => calls.listeners.push({ ev, fn }),
      removeEventListener: () => { calls.removed++; },
    },
  };
  win._pvStartPhone = () => { calls.startPhone++; };
  /* eslint-disable no-new-func */
  new Function('sandbox', 'with (sandbox) {' + VERIFY_SRC + '\n window._pvOpenVerifyFromHash(); }')(sandbox);
  calls.fire = () => {
    const l = calls.listeners.find(x => x.ev === 'sokoniAuthReady');
    if (l) l.fn();
  };
  return calls;
}

/* Every step the SERVER can emit, read from profile-engine.js rather than restated. */
const SERVER_STEPS = [...engine.matchAll(/\{\s*id:\s*'([a-z]+)'\s*,\s*label:\s*'([^']+)'/g)]
  .map(m => ({ id: m[1], label: m[2] }));

console.log('══════════════════════════════════════════════════════════════════');
console.log('  PROFILE COMPLETION — STEP ROUTING');
console.log('══════════════════════════════════════════════════════════════════');

head('0 - the pieces');
{
  ok('control — _loadCompletion extracted', !!LOAD_SRC && LOAD_SRC.length > 300);
  ok('control — the server step list was read', SERVER_STEPS.length >= 8,
     SERVER_STEPS.length + ' steps');
  ok('control — address is one of them', SERVER_STEPS.some(s => s.id === 'address'));
}

/* ── 3. NOTHING ELSE MOVED ──────────────────────────────────────────────────── */
head('3 - every other destination is unchanged');
{
  const map = (html.match(/var HREFS = \{[\s\S]*?\};/) || [''])[0];
  ok('control — the destination map was found', map.length > 100);

  const expected = {
    photo: '#edit', cover: '#edit', bio: '#edit', name: '#edit', location: '#edit', role: '#edit',
    email: '#email', phone: '#phone',
    identity: 'account-centre.html#verification', bank: 'account-centre.html#verification',
    kra: 'account-centre.html#verification', business: 'account-centre.html#verification',
    merchant: 'account-centre.html#verification', legal: 'account-centre.html#legal',
    skills: 'professional-profile.html', cert: 'professional-profile.html',
  };
  let drift = [];
  Object.keys(expected).forEach(k => {
    const re = new RegExp(k + ":\\s*'([^']*)'");
    const got = (map.match(re) || [])[1];
    if (got !== expected[k]) drift.push(k + ': ' + got + ' (expected ' + expected[k] + ')');
  });
  ok('no other step destination changed', drift.length === 0, drift.join(' · '));
  /* NOT a sentinel on this lineage. The `address` step still points at account-centre.html,
     which has no address field — the same dead-end class, repaired on another lineage and
     NOT ported here because it is outside this slice. Pinned so the gap is visible rather
     than forgotten, and so porting that fix later trips this assertion deliberately. */
  ok('KNOWN GAP pinned — address still routes off-page on this lineage',
     /address:'account-centre\.html'/.test(map));

  /* EVERY server step must still have SOME destination — no dead ends. */
  const missing = SERVER_STEPS.filter(s => !new RegExp(s.id + ":\\s*'").test(map)).map(s => s.id);
  ok('every server-emitted step has a destination', missing.length === 0, missing.join(','));
}

/* ── 4. A DONE STEP IS NOT A LINK ───────────────────────────────────────────── */
head('4 - a completed step offers no action');
{
  const done = renderSteps([{ id: 'address', label: 'Add physical address', done: true }]);
  ok('a completed address step has no Fix link', !/Fix/.test(done));
  ok('and is marked done', /pi-step done/.test(done));
}

/* ── 5. THE PHONE STEP REACHES THE ONLY FLOW THAT CAN SATISFY IT ───────────────
   Same defect class as the address step, and it survived that repair. The step is
   satisfied by `phoneVerified`, which ONLY _pvPersistPhone() sets, and that runs only
   after Firebase confirms an SMS code. account-centre.html cannot satisfy it: it has no
   tel input and no phone-auth call, and its own button bounces back to a dead hash. */
head('5 - the phone step opens the existing verification flow');
{
  const out = renderSteps([{ id: 'phone', label: 'Verify phone number', done: false }]);

  /* (1) a user WITHOUT a verified number gets an actionable entry point */
  ok('an unverified user gets an actionable row', /pi-step/.test(out) && /Fix/.test(out));
  ok('it opens the existing modal in place', /onclick="window\._pvStartPhone&&window\._pvStartPhone\(\)"/.test(out));
  ok('it is NOT an anchor to another page', !/<a href=/.test(out), out.slice(0, 160));
  ok('and specifically not to account-centre', !/account-centre/.test(out));
  ok('the row is keyboard reachable', /role="button"/.test(out) && /tabindex="0"/.test(out));

  /* (2) a user WITH a verified number is not prompted at all */
  const done = renderSteps([{ id: 'phone', label: 'Verify phone number', done: true }]);
  ok('a verified user gets NO prompt', !/Fix/.test(done) && !/_pvStartPhone/.test(done));
  ok('and the step reads as done', /pi-step done/.test(done));

  /* the entry point the markup names must actually exist and be the real flow */
  ok('window._pvStartPhone is exposed', /window\._pvStartPhone\s*=\s*function/.test(html));
  ok('it delegates to the existing _pvStartPhone', /window\._pvStartPhone\s*=\s*function\(\)\{\s*return _pvStartPhone\(\);/.test(html));
  ok('which opens the verify modal', /function _pvStartPhone\(\)\{[\s\S]{0,300}?_pvOpenModal\(/.test(html));
}

head('5a - the destination account-centre.html could never satisfy it');
{
  const ac = fs.readFileSync(path.join(ROOT, 'account-centre.html'), 'utf8');
  ok('it has no tel input', !/type="tel"/i.test(ac));
  ok('it has no phone-auth call',
     !/linkWithPhoneNumber|signInWithPhoneNumber|PhoneAuthProvider/.test(ac));
  /* control — profile.html DOES have both, so the assertions above can distinguish */
  ok('control — profile.html has the phone-auth call', /linkWithPhoneNumber/.test(html));
  ok('control — profile.html has a tel input', /type="tel"/i.test(html));
  /* and its own escape hatch is a dead hash */
  ok("its button points at profile.html#verify", /profile\.html#verify/.test(ac));
  ok('for which profile.html has NO panel', !/id="panel-verify"/.test(html));
}

/* ── 5b. THE EMAIL STEP — THE SAME DEAD END, CONFIRMED THEN REPAIRED ──────────
   Asserted rather than assumed: account-centre.html contains no sendEmailVerification
   call at all, so the step it was pointed at could not send the link it asks for. */
head('5b - the email step reaches the only flow that can send the link');
{
  const ac = fs.readFileSync(path.join(ROOT, 'account-centre.html'), 'utf8');
  ok('account-centre.html cannot send a verification email',
     !/sendEmailVerification|verifyBeforeUpdateEmail/.test(ac));
  ok('its email row is display-only', /_setVerif\('verifEmailBadge'/.test(ac));
  /* control — profile.html CAN send it, so the assertion above discriminates */
  ok('control — profile.html sends the verification email', /sendEmailVerification/.test(html));

  const out = renderSteps([{ id: 'email', label: 'Verify email address', done: false }]);
  ok('an unverified user gets an actionable row', /pi-step/.test(out) && /Fix/.test(out));
  ok('it sends the link from this page', /onclick="window\._pvSendEmail&&window\._pvSendEmail\(\)"/.test(out));
  ok('it no longer navigates to account-centre', !/account-centre/.test(out));
  ok('the row is keyboard reachable', /role="button"/.test(out) && /tabindex="0"/.test(out));

  const done = renderSteps([{ id: 'email', label: 'Verify email address', done: true }]);
  ok('a verified user gets NO prompt', !/Fix/.test(done) && !/_pvSendEmail/.test(done));

  ok('window._pvSendEmail is exposed', /window\._pvSendEmail\s*=\s*function/.test(html));
  /* The server shows this step to phone-only accounts (its condition is emailVerified,
     not "has an email"), so the no-email case must not be a silent dead tap. */
  const wrap = (html.match(/window\._pvSendEmail = function\(\)\{[\s\S]*?\n  \};/) || [''])[0];
  ok('control — the wrapper was extracted', wrap.length > 80);
  ok('it handles an account with no email', /!u\.email/.test(wrap));
  ok('and tells the user rather than failing silently', /_pvToast\(/.test(wrap));
  ok('the server step does NOT require an email to exist',
     /id:'email'[^}]*done:\s*!!\(verif\.emailVerified \|\| user\.emailVerified\)/.test(engine));
}

/* ── 5c. THE VERIFICATION BADGE GRID — THE THIRD INSTANCE ────────────────────── */
head('5c - the phone badge opens the flow instead of the status page');
{
  /* The grid is rendered inside _piLoadCard's _render(); assert on the source, since the
     renderer is not independently extractable. */
  const mapSrc = (html.match(/var VERIF_HREF = \{[\s\S]*?\};/) || [''])[0];
  ok('control — the badge destination map was found', mapSrc.length > 100);
  ok('phone uses the on-page sentinel', /phone:'#phone'/.test(mapSrc));
  ok('identity still navigates off-page',
     /identity:'account-centre\.html#verification'/.test(mapSrc));
  ok('bank still navigates off-page', /bank:'account-centre\.html#verification'/.test(mapSrc));

  const onpage = (html.match(/var VERIF_ONPAGE = \{[^}]*\};/) || [''])[0];
  ok('the sentinel maps to the existing modal',
     /'#phone':\s*'window\._pvStartPhone&&window\._pvStartPhone\(\)'/.test(onpage));

  /* ── executed, not read: the markup the page actually emits ── */
  ok('control — the grid renderer was extracted', !!GRID_SRC && GRID_SRC.length > 400);

  const unver = renderBadges({ email: false, phone: false, identity: false, bank: false });
  ok('control — the phone badge was located in the output', /Phone/.test(unver));

  /* An UNVERIFIED phone badge opens the flow here rather than navigating. */
  ok('the unverified phone badge opens the modal',
     /<div class="pi-verif-item" role="button" tabindex="0"[^>]*onclick="window\._pvStartPhone&&window\._pvStartPhone\(\)"/.test(unver));
  ok('it is not an anchor to the status page',
     !/<a href="account-centre\.html#verification"[^>]*>(?:(?!<\/a>).)*?>Phone</s.test(unver));

  /* CONTROL — a badge that legitimately lives off-page still navigates. */
  ok('control — the identity badge still navigates',
     /<a href="account-centre\.html#verification"[^>]*>(?:(?!<\/a>).)*?>Identity</s.test(unver));
  ok('control — no stray sentinel leaked into an href', !/href="#phone"/.test(unver));

  /* An already-VERIFIED phone badge must NOT re-open the verify modal. */
  const ver = renderBadges({ email: true, phone: true, identity: true, bank: true });
  ok('a verified phone badge does not open the modal', !/_pvStartPhone/.test(ver));
  ok('it falls back to the status page',
     /<a href="account-centre\.html#verification"[^>]*>(?:(?!<\/a>).)*?>Phone</s.test(ver));
  ok('and is marked done', /pi-verif-item done/.test(ver));
}

/* ── 5d. THE '#verify' ACTION HASH — THE LAST DEAD ROUTE ──────────────────────
   account-centre.html's "Start Verification" button sends people to profile.html#verify.
   There is no panel-verify, so _openTabFromHash fell through and did nothing. Asserted by
   EXECUTING the router, not by reading it. */
head('5d - profile.html#verify reaches the verified-phone entry point');
{
  ok('control — the hash router was extracted', !!HASH_SRC && HASH_SRC.length > 100);
  ok('control — there is still no panel-verify in the page', !/id="panel-verify"/.test(html));

  const verify = routeHash('#verify');
  ok('#verify reaches the verify entry point', verify.verifyEntry === 1,
     'entry called ' + verify.verifyEntry + 'x');
  ok('and does NOT try to switch to a non-existent tab', verify.switchTab.length === 0,
     verify.switchTab.join(','));

  /* CONTROLS — ordinary tab hashes are untouched. */
  const orders = routeHash('#orders');
  ok('control — a real tab hash still switches tabs', orders.switchTab.join('') === 'orders');
  ok('control — and does not reach the verify entry', orders.verifyEntry === 0);

  /* This lineage's router has no _DEFAULT_TAB: an empty hash is a no-op by design. */
  const empty = routeHash('');
  ok('control — an empty hash does nothing on this lineage',
     empty.switchTab.length === 0 && empty.verifyEntry === 0 && empty.replaced.length === 0);

  /* CONTROL — the _MOVED_TABS redirects must still win. The verify branch is ordered
     after them, so adding it must not have shadowed a redirect. */
  const moved = routeHash('#listings');
  ok('control — a moved tab still redirects', moved.replaced.join('') === 'merchant.html');
  ok('control — and does not reach the verify entry', moved.verifyEntry === 0);
  const moved2 = routeHash('#reviews');
  ok('control — the second moved tab still redirects', moved2.replaced.join('') === 'merchant.html');

  const bogus = routeHash('#nosuchthing');
  ok('control — an unknown hash still does nothing', bogus.switchTab.length === 0 &&
     bogus.verifyEntry === 0);

  /* Defensive: if the handler has not been defined yet, the router must not throw. */
  let threw = false;
  try { routeHash('#verify', { noHandler: true }); } catch (_) { threw = true; }
  ok('a missing handler does not throw', !threw);
}

head('5e - the #verify handler gates on auth readiness and verified state');
{
  ok('control — the handler was extracted', VERIFY_SRC.length > 200);

  /* signed in, NOT verified -> opens the canonical modal */
  const fresh = runVerifyEntry({ uid: 'u1' });
  ok('an unverified signed-in user reaches _pvStartPhone', fresh.startPhone === 1);

  /* ALREADY verified -> must not open. Every other entry point gates the same way, and
     linkWithPhoneNumber on a linked account throws auth/provider-already-linked. */
  const done = runVerifyEntry({ uid: 'u1', phoneNumber: '+254700000000' });
  ok('a verified user does NOT get the modal', done.startPhone === 0);
  ok('and no listener is left behind', done.listeners.length === 0);

  /* NOT signed in yet -> defer, then proceed. _openTabFromHash runs at load, so this is
     the common case arriving from account-centre, not an edge case. */
  let u = null;
  const pending = runVerifyEntry(() => u);
  ok('an unresolved auth state does not open the modal yet', pending.startPhone === 0);
  ok('it waits on sokoniAuthReady',
     pending.listeners.filter(l => l.ev === 'sokoniAuthReady').length === 1);
  u = { uid: 'u1' };
  pending.fire();
  ok('and opens it once auth resolves', pending.startPhone === 1);
  ok('the one-shot listener removes itself', pending.removed === 1);

  /* the event name must match what firebase.js actually dispatches, on document */
  const fb = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
  ok("firebase.js dispatches sokoniAuthReady on document",
     /document\.dispatchEvent\(new CustomEvent\('sokoniAuthReady'/.test(fb));

  /* routing only — the handler must not be a second writer */
  ok('the handler writes nothing', !/setDoc|updateDoc|phoneVerified/.test(VERIFY_SRC));
  ok('and reaches verification only via the canonical entry point',
     /window\._pvStartPhone\(\)/.test(VERIFY_SRC) &&
     !/linkWithPhoneNumber|_pvPersistPhone|_pvOpenModal/.test(VERIFY_SRC));
}

/* ── 6. ONLY A CONFIRMED CODE MAKES A NUMBER CANONICAL ─────────────────────── */
head('6 - an entered number does not become canonical; only a verified one does');
{
  const persist = extractFn(html, '_pvPersistPhone') || '';
  const send    = extractFn(html, '_pvSendCode')     || '';
  const verify  = extractFn(html, '_pvVerifyCode')   || '';
  const start   = extractFn(html, '_pvStartPhone')   || '';
  ok('control — all four functions extracted',
     !!persist && !!send && !!verify && !!start);

  /* typing a number and requesting a code must persist NOTHING */
  ok('requesting a code does not persist', !/_pvPersistPhone/.test(send));
  ok('requesting a code does not write Firestore', !/setDoc|updateDoc/.test(send));
  ok('opening the modal does not persist', !/_pvPersistPhone|setDoc/.test(start));

  /* the ONLY persist call is downstream of a successful confirm() */
  ok('verification persists', /_pvPersistPhone/.test(verify));
  ok('and only AFTER confirm() resolves',
     /_pvConfirm\.confirm\(code\)[\s\S]*?\.then\(function\(\)\{\s*return _pvPersistPhone/.test(verify));
  const beforeConfirm = verify.slice(0, verify.indexOf('_pvConfirm.confirm('));
  ok('nothing persists before confirm()', !/_pvPersistPhone/.test(beforeConfirm));

  /* dismissal writes nothing */
  const close = (html.match(/window\._pvCloseModal = function\(\)\{[^\n]*\};/) || [''])[0];
  ok('control — the close handler was found', close.length > 40);
  ok('dismissing the modal writes nothing', !/setDoc|updateDoc|_pvPersistPhone/.test(close));
  /* The step list is a PULL surface: it has no dismiss control, so there is no dismissal
     state to invent or persist. Asserted against the real renderer, not by assumption. */
  const phoneRow = renderSteps([{ id: 'phone', label: 'Verify phone number', done: false }]);
  ok('the rendered step carries no dismiss control',
     !/dismiss/i.test(phoneRow) && !/pi6-resume-close/.test(phoneRow));
  ok('the renderer persists nothing', !/localStorage|setDoc|updateDoc/.test(LOAD_SRC));
  /* control — the detector finds a dismiss control where one genuinely exists */
  ok('control — the detector catches the resume bar\'s dismiss control',
     /dismiss/i.test('<button class="pi6-resume-close" aria-label="Dismiss">'));
}

/* ── 7. EXACTLY ONE WRITER, AND NOT THE LEGACY FIELD ───────────────────────── */
head('7 - one authority, canonical field only');
{
  const persist = extractFn(html, '_pvPersistPhone') || '';
  /* exactly one Firestore write of the canonical field on the whole page */
  const writes = (html.match(/phoneNumber:\s*phone/g) || []).length;
  ok('exactly one canonical write site in profile.html', writes === 1, writes + ' found');
  ok('it targets users/{uid}', /doc\(window\.firebaseDB,\s*'users',\s*u\.uid\)/.test(persist));
  ok('it sets phoneVerified', /phoneVerified:\s*true/.test(persist));
  ok('it sets phoneVerifiedAt', /phoneVerifiedAt:\s*m\.serverTimestamp\(\)/.test(persist));
  ok('it merges rather than replacing', /\{\s*merge:\s*true\s*\}/.test(persist));

  /* the legacy field is not revived: no bare `phone:` property key is written */
  ok('it does NOT write the legacy `phone` field', !/\bphone\s*:/.test(persist));
  /* control — the same regex DOES catch a legacy write */
  ok('control — the legacy-field detector works', /\bphone\s*:/.test("{ phone: '+2547' }"));
  /* control — and does not false-positive on the canonical name */
  ok('control — and ignores phoneNumber:', !/\bphone\s*:/.test("{ phoneNumber: x }"));
}

/* ── 8. NOTIFICATION BEHAVIOUR IS UNTOUCHED ────────────────────────────────── */
head('8 - notify.js and sms-service.js are not involved');
{
  const notify = fs.readFileSync(path.join(ROOT, 'functions', 'notify.js'), 'utf8');
  const sms    = fs.readFileSync(path.join(ROOT, 'functions', 'sms-service.js'), 'utf8');
  ok('control — both senders were read', notify.length > 1000 && sms.length > 1000);

  /* this change adds no coupling to the senders */
  ok('notify.js does not know the step sentinels',
     !/#phone/.test(notify) && !/#email/.test(notify));
  ok('sms-service.js does not know them',
     !/#phone/.test(sms) && !/#email/.test(sms));
  ok('neither references the profile entry points',
     !/_pvStartPhone|_pvSendEmail/.test(notify) && !/_pvStartPhone|_pvSendEmail/.test(sms));

  ok('sms-service still owns the provider seam', /atSendSMS\(/.test(sms));

  /* The honest assertion is that THIS change touched neither sender — proven against git,
     not by asserting a feature. */
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  ok('control — the changed-file list was read', Array.isArray(changed));
  ok('functions/notify.js is not modified by this change',
     changed.indexOf('functions/notify.js') === -1, changed.join(' · '));
  ok('functions/sms-service.js is not modified', changed.indexOf('functions/sms-service.js') === -1);
  ok('no WhatsApp file is modified', !changed.some(f => /whatsapp/i.test(f)));
  ok('no payment function is modified',
     !changed.some(f => /payment|intasend|daraja|payout|wallet/i.test(f)));
  ok('no Firebase Auth surface is modified',
     changed.indexOf('firebase.js') === -1 && changed.indexOf('auth.js') === -1);

  /* RECORDED, NOT REPAIRED — a lineage gap, not something this slice introduced.
     notify.js here gates SMS on a caller-supplied `phone` argument; the fallback to
     users/{uid}.phoneNumber exists on another lineage and is NOT ported. Capture being
     reachable does not by itself make a message send on this lineage. */
  ok('KNOWN GAP pinned — notify.js here has no users/{uid}.phoneNumber fallback',
     !/phoneNumber/.test(notify));
  ok('and still gates SMS on the caller-supplied phone argument',
     /wantSms && t\.smsTemplate && phone/.test(notify));
}

console.log('\n  what this suite does NOT prove');
console.log('  NOT PROVEN    Browser rendering. Every assertion here executes the page\'s own');
console.log('                renderers and router against stubs. That proves the markup and the');
console.log('                routing decisions; it does not prove the page loads clean in a');
console.log('                real browser, nor that a real SMS arrives.');
console.log('  OUT OF SCOPE  The `address` step has the same dead-end shape on this lineage');
console.log('                (routes to account-centre.html, which has no address field). It is');
console.log('                PINNED in section 3, not repaired — a separate slice.');
console.log('  UNCHANGED     notify.js, sms-service.js, WhatsApp, payment functions and the');
console.log('                OTP architecture are untouched; section 8 asserts the senders.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
