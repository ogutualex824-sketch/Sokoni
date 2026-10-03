#!/usr/bin/env node
/* EDUCATION E2 — the educator Courses panel on provider-dashboard (sokoni-education-courses.js).
 *   node scripts/test-education-courses-ui.js        BASE=80ba267 node scripts/test-education-courses-ui.js (must FAIL)
 * Part P: the dashboard wiring follows b2's module pattern (data-hc-module gated + hidden, panel, P.show mount, deferred
 * script). Part M EXECUTES the module in a vm with stub callables: it renders the server's list (escaped), sends only
 * course fields (never an owner / status), says nothing until the server answered, and shows "—" when unavailable. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\neducation courses panel   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const PD = read('provider-dashboard.html');
ck('P-1', /<div class="sb-item" data-hc-module="eduCourses" hidden aria-hidden="true" onclick="P\.show\('educourses',this\)">/.test(PD), 'the Courses item is gated by the server module eduCourses and hidden by default (fail closed)');
ck('P-2', /id="panel-educourses"/.test(PD) && /id="eduCoursesList"/.test(PD), 'the Courses panel exists');
ck('P-3', /if\(id==='educourses'&&window\.SokoniEducationCourses\)SokoniEducationCourses\.mount\(_q\('eduCoursesList'\)\);/.test(PD), 'P.show mounts the module');
ck('P-4', /<script src="sokoni-education-courses\.js" defer><\/script>/.test(PD), 'the module script is loaded (deferred)');
ck('P-5', !/var panels=\[[^\]]*educourses/.test(PD), 'no hash deep-link to Courses (a URL cannot open a panel the server did not grant)');
ck('P-6', /function _applyHash/.test(PD) && /data-hc-module="leads"/.test(PD), 'CONTROL: b2\'s existing wiring is intact');

const SRC = read('sokoni-education-courses.js');
const sent = []; let reply = null;
const mkEl = () => { const e = { innerHTML: '', _h: null, addEventListener: (t, h) => { e._h = h; }, querySelector: () => null }; return e; };
const G = { firebase: { functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); return { data: await reply(n, d) }; } }) }, alert() {} };
let M = null;
try { vm.runInNewContext(SRC, { window: G, Object, String, Number, Promise, JSON, Math, Array, document: {} }); M = G.SokoniEducationCourses; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
(async () => {
  if (M) {
    const el = mkEl();
    reply = (n) => (n === 'manageMyCourses' ? { courses: [{ courseId: 'c1', title: '<img src=x onerror=1>', status: 'draft', lessonCount: 3, price: 0 },
      { courseId: 'c2', title: 'Physics', status: 'published', lessonCount: 8, price: 1500, reviewNote: null }, { courseId: 'c3', title: 'Chem', status: 'draft', reviewNote: '<b>add outlines</b>' }] } : { ok: true });
    await M.mount(el);
    const H = el.innerHTML;
    ck('M-1', /In review|Draft/.test(H) && /Published/.test(H) && !/<img src=x/.test(H) && /&lt;img/.test(H), 'renders the server\'s list with statuses; titles escaped', H.slice(0, 200));
    ck('M-2', /data-edu-submit="c1"/.test(H) && !/data-edu-submit="c2"/.test(H) && !/data-edu-edit="c2"/.test(H), 'only DRAFTS offer Edit / Submit (a published course cannot be edited from here)');
    ck('M-3', /SOKONI review note: &lt;b&gt;add outlines/.test(H), 'the review note is shown, escaped');
    ck('M-4', /KES 1,500/.test(H) && /Free/.test(H), 'price shown as stated by the server');
    /* submit */
    sent.length = 0;
    const btn = { disabled: false, textContent: '', getAttribute: () => 'c1', closest: (s) => (s === '[data-edu-submit]' ? btn : null) };
    el._h({ target: { closest: (s) => (s === '[data-edu-submit]' ? btn : null) } });
    await new Promise((r) => setTimeout(r, 5));
    ck('M-5', sent.some(([n, d]) => n === 'publishCourse' && d.courseId === 'c1' && d.action === 'submit' && Object.keys(d).length === 2), 'Submit sends ONLY {courseId, action:"submit"} — no owner, no status', sent);
    /* create: the payload */
    sent.length = 0;
    const vals = { title: 'Algebra', description: 'A long enough description here', category: 'technology', level: 'beginner', lessonCount: '4', price: '0' };
    const box = { getAttribute: () => '', querySelector: (q) => { const m = /data-f="(\w+)"/.exec(q); if (m) return { value: vals[m[1]] }; return { textContent: '' }; } };
    const sv = { disabled: false, textContent: '', closest: (s) => (s === '[data-edu-form]' ? box : null) };
    el.querySelector = (q) => (q === '[data-edu-formslot]' ? { innerHTML: '' } : null);
    el._h({ target: { closest: (s) => (s === '[data-edu-save]' ? sv : null) } });
    await new Promise((r) => setTimeout(r, 5));
    const create = sent.find(([n]) => n === 'createCourse');
    ck('M-6', !!create && Object.keys(create[1]).sort().join() === 'category,description,lessonCount,level,price,title', 'Create sends ONLY course fields — never instructorUid / ownerType / status', create && Object.keys(create[1]));
    /* unavailable */
    reply = () => { throw new Error('Only an approved SOKONI teacher or institution can manage courses.'); };
    const el2 = mkEl(); await M.mount(el2);
    ck('M-7', /\(—\)/.test(el2.innerHTML) && /approved SOKONI teacher/.test(el2.innerHTML) && !/data-edu-new/.test(el2.innerHTML), 'refused / unavailable: "—" and the server\'s reason, and NO create button', el2.innerHTML);
  } else {
    for (let i = 1; i <= 7; i++) ck('M-' + i, false, 'module present');
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
