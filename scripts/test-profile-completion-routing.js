/* ══════════════════════════════════════════════════════════════════════════════
   PROFILE COMPLETION — STEP ROUTING CERTIFICATION
   scripts/test-profile-completion-routing.js

   THE DEFECT THIS PINS
   The "Add physical address" completion step routed to `account-centre.html`. That page
   has NO address field — its only occurrence of the word is the label "Email Address". So
   the single actionable link for the step led somewhere that could not satisfy it.

   The step is satisfied server-side by
       user.address || user.location || verif.addressVerified          (profile-engine.js)
   and `location` is edited in this page's own inline editor. So the destination is the
   Profile edit surface, exactly as the `location` step already routes.

   WHAT THIS IS NOT
   This does not add a saved-address book, a collection, or any checkout change, and it does
   not reinterpret `location` as a formal postal address. Buyer address management does not
   exist anywhere in this codebase — that remains a product/architecture gap, recorded but
   NOT repaired here.

   HOW IT IS ASSERTED
   The step renderer is extracted from the page and EXECUTED against a stub DOM, so what is
   proven is the markup the page actually emits for each step.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
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

/* ── 1. THE ADDRESS STEP ────────────────────────────────────────────────────── */
head('1 - the address step routes to the Profile edit surface');
{
  const out = renderSteps([{ id: 'address', label: 'Add physical address', done: false }]);

  ok('it is rendered as an actionable row', /pi-step/.test(out) && /Fix/.test(out), out.slice(0, 120));
  /* The on-page convention: '#edit' is special-cased into the inline editor, NOT an anchor. */
  ok('it opens the inline editor', /onclick="toggleInlineEdit\(\)"/.test(out));
  ok('it is NOT an anchor to another page', !/<a href=/.test(out), out.slice(0, 160));
  ok('and specifically not to account-centre', !/account-centre/.test(out));

  /* CONTROL — a step that legitimately lives elsewhere still navigates. */
  const email = renderSteps([{ id: 'email', label: 'Verify email address', done: false }]);
  ok('control — the email step still navigates off-page',
     /<a href="account-centre\.html#verification"/.test(email));
  ok('control — and does not open the inline editor',
     !/toggleInlineEdit/.test(email));
}

/* ── 2. THE FIELD THAT SATISFIES IT IS ON THIS PAGE ─────────────────────────── */
head('2 - the destination can actually satisfy the step');
{
  /* The server's own condition. */
  const cond = (engine.match(/id:'address'[^}]*done:\s*([^}]+)\}/) || [])[1] || '';
  ok('control — the server condition was read', cond.length > 10, cond.trim());
  ok('it is satisfied by user.location', /user\.location/.test(cond));

  /* And that field is edited here. */
  ok('the inline editor has a location input', /id="ieLocationInput"/.test(html));
  ok('the editor is opened by toggleInlineEdit', /function toggleInlineEdit\(/.test(html));
  ok('toggleInlineEdit populates the location field',
     /ieLocationInput'\)\.value = escHtml\(_user\.location/.test(html));
  /* Saving it persists — the same path the location step already relies on. */
  const save = extractFn(html, 'saveInlineEdit') || '';
  ok('saving persists location', /if\(location\) _user\.location = location;/.test(save));
  ok('and sends it to the server', /location:\s*location/.test(save));

  /* The page account-centre.html was pointing at has no address field at all. */
  const ac = fs.readFileSync(path.join(ROOT, 'account-centre.html'), 'utf8');
  const addressHits = (ac.match(/address/gi) || []).length;
  ok('account-centre.html has no address field', !/id="[^"]*[Aa]ddress[^"]*"/.test(ac),
     addressHits + ' textual mentions, none a field');
}

/* ── 3. NOTHING ELSE MOVED ──────────────────────────────────────────────────── */
head('3 - every other destination is unchanged');
{
  const map = (html.match(/var HREFS = \{[\s\S]*?\};/) || [''])[0];
  ok('control — the destination map was found', map.length > 100);

  const expected = {
    photo: '#edit', cover: '#edit', bio: '#edit', name: '#edit', location: '#edit', role: '#edit',
    email: 'account-centre.html#verification', phone: 'account-centre.html#verification',
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
  ok('address is now the on-page sentinel', /address:'#edit'/.test(map));

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

console.log('\n  what this suite does NOT prove');
console.log('  OUT OF SCOPE  There is no buyer address book anywhere in this codebase: no');
console.log('                addresses collection in firestore.rules, no saved-address UI,');
console.log('                and checkout collects a free-text address per order. That is a');
console.log('                product/architecture gap, deliberately NOT addressed here.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
