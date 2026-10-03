#!/usr/bin/env node
/* EDUCATION E2 — the company's own shell (education-enterprise.html + sokoni-education-enterprise.js).
 *   node scripts/test-education-enterprise-shell.js        BASE=21da8ed node scripts/test-education-enterprise-shell.js (must FAIL)
 * Owner: "like merchant-v2.html with the side bar". EXECUTES the module in a vm against stub server answers: the sidebar
 * is the server's module list (AVAILABLE opens, NOT_IMPLEMENTED says Soon and does nothing), the company sees display
 * names only, no provider tools exist here, unknown renders "—", and the page self-updates. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\neducation enterprise shell   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HTML = read('education-enterprise.html');
ck('F-1', /<aside class="side" id="entSide"/.test(HTML) && /id="entMenu"/.test(HTML) && /id="entScrim"/.test(HTML) && /@media \(min-width:900px\)\{[\s\S]*grid-template-columns:var\(--rail-w\) minmax\(0,1fr\)/.test(HTML),
  'the merchant-v2 frame: sidebar rail (drawer on phone, grid rail at >=900px), header menu button, scrim');
ck('F-2', /<script src="\/sw-register\.js" defer><\/script>/.test(HTML), 'the page self-updates (sw-register.js — it does not load shared-header, like merchant-v2)');
ck('F-3', /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover">/.test(HTML) && /overflow-x:hidden/.test(HTML), 'mobile: viewport + no sideways page scroll');

const SRC = read('sokoni-education-enterprise.js');
const els = {}; const ids = ['entNav', 'entRoot', 'entTitle', 'entCoName', 'entSide', 'entScrim', 'entMenu', 'entInviteLabel', 'entInviteOut'];
const mk = (id) => { const cls = new Set(); const attrs = {}; return { id, innerHTML: '', textContent: '', value: '', classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k], addEventListener: (t, h) => { (els['_h_' + id] = h); } }; };
ids.forEach((i) => { els[i] = mk(i); });
const document = { getElementById: (i) => els[i] || null, body: Object.assign(mk('body'), { addEventListener: (t, h) => { els._click = h; } }) };
const sent = []; let reply = null; let authCb = null;
const G = { location: { hash: '', href: '' }, history: { replaceState() {} }, alert() {},
  firebase: { auth: () => ({ onAuthStateChanged: (cb) => { authCb = cb; } }), functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); return { data: await reply(n, d) }; } }) } };
let M = null; try { vm.runInNewContext(SRC, { window: G, document, Object, String, Promise, JSON, Math, Array }); M = G.SokoniEducationEnterprise; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const WS = (state) => ({ enterprise: state ? { state, companyName: 'Acme <Ltd>', modules: Object.fromEntries(['employees', 'training', 'programmes', 'enrolments', 'liveClasses', 'providers', 'bookings', 'payments', 'receipts', 'wallet', 'reports', 'messages', 'roles', 'companyProfile', 'settings']
  .map((k) => [k, { state: ['employees', 'training', 'companyProfile'].includes(k) ? 'AVAILABLE' : 'NOT_IMPLEMENTED' }])) } : null });
const tick = () => new Promise((r) => setTimeout(r, 5));
(async () => {
  if (!M) { for (let i = 1; i <= 9; i++) ck('S-' + i, false, 'module present'); }
  else {
    M.init();
    reply = (n, d) => (n === 'educationWorkspace' ? WS('ACTIVE') : d.op === 'overview' ? { company: { companyName: 'Acme <Ltd>', staffSeats: 40 }, counts: { activeLearners: 2, openInvites: 1 } }
      : d.op === 'assignments' ? { assignments: [{ assignmentId: 'acme__e1', displayName: '<b>Achieng</b>', label: 'Sales', status: 'active', profile: { goals: 'secret' } }] }
      : d.op === 'inviteList' ? { invites: [{ code: 'ABCDEFGH23', label: null, status: 'open' }] } : { ok: true, code: 'ZZZZZZZZ22', expiresInDays: 14 });
    authCb({ uid: 'acme' }); await tick(); await tick();
    const NAV = els.entNav.innerHTML;
    ck('S-1', /data-ent-nav="employees"(?![^>]*aria-disabled)/.test(NAV) && /data-ent-nav="payments" aria-disabled="true"/.test(NAV) && /<span class="tag">Soon<\/span>/.test(NAV) && /class="side-group">People/.test(NAV),
      'the sidebar is the SERVER\'s module list: built items open, unbuilt ones are disabled and tagged "Soon", grouped like merchant-v2');
    ck('S-2', !/Courses|Teachers|Storefront|Earnings|Rate cards|Publish/i.test(NAV), 'no provider tools in the company shell (courses / teachers / storefront / earnings)');
    ck('S-3', els.entCoName.textContent === 'Acme <Ltd>' && /Staff in training<\/span><b>2/.test(els.entRoot.innerHTML), 'overview: company name (as text) + counts from the server');
    M.go('payments');
    ck('S-4', /Staff in training/.test(els.entRoot.innerHTML), 'clicking a "Soon" module changes nothing (the server state is the gate)');
    M.go('employees');
    const E = els.entRoot.innerHTML;
    ck('S-5', /&lt;b&gt;Achieng/.test(E) && !/<b>Achieng/.test(E) && !/secret/.test(E) && /data-ent-end="acme__e1"/.test(E), 'employees: the display name (escaped) + its own label only — even a leaked extra field is never rendered', E.slice(0, 200));
    ck('S-6', els.entTitle.textContent === 'Employees' && /class="nav-item on" data-ent-nav="employees"/.test(els.entNav.innerHTML), 'the header title and the active sidebar item follow the view');
    M.go('training'); sent.length = 0;
    els._click({ target: { closest: (s) => (s === '[data-ent-invite]' ? { disabled: false } : null) } }); await tick(); await tick();
    const inv = sent.find(([n, d]) => n === 'educationEnterprise' && d.op === 'inviteCreate');
    ck('S-7', !!inv && Object.keys(inv[1]).sort().join() === 'label,op', 'creating an invite sends only {op, label} — never a learner account', inv);
    reply = (n) => (n === 'educationWorkspace' ? WS(null) : {});
    await M._load();
    ck('S-8', /not a SOKONI-verified company/.test(els.entRoot.innerHTML) && /data-ent-apply/.test(els.entRoot.innerHTML) && els.entNav.innerHTML === '', 'a non-company account: told why, offered the application, NO sidebar');
    reply = () => { throw new Error('down'); };
    await M._load();
    ck('S-9', /unavailable right now \(—\)/.test(els.entRoot.innerHTML) && els.entNav.innerHTML === '', 'server unavailable: "—", nothing inferred');
  }
  /* the learner side of the consent */
  const ED = read('sokoni-education.js');
  ck('L-1', /op: 'joinCompany', code/.test(ED) && /Your company sees only your name/.test(ED) && /data-assignment-id=/.test(ED), 'the learner panel lets an employee redeem their company code, see their companies and leave');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
