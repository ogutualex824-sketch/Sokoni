#!/usr/bin/env node
/* EDUCATION E2 — the institution Programmes panel (sokoni-education-programmes.js on provider-dashboard).
 *   node scripts/test-education-programmes-ui.js        BASE=a51215b node scripts/test-education-programmes-ui.js (must FAIL)
 * P: wiring in b2's module pattern (eduProgrammes-gated, hidden by default, no hash deep-link). M: the module in a vm —
 * renders the server's list escaped, sends only programme fields (never an owner), "—" when refused. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\neducation programmes panel   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const PD = read('provider-dashboard.html');
ck('P-1', /<div class="sb-item" data-hc-module="eduProgrammes" hidden aria-hidden="true" onclick="P\.show\('eduprogrammes',this\)">/.test(PD), 'Programmes is gated by eduProgrammes (institutions only) and hidden by default');
ck('P-2', /id="panel-eduprogrammes"/.test(PD) && /if\(id==='eduprogrammes'&&window\.SokoniEducationProgrammes\)SokoniEducationProgrammes\.mount\(_q\('eduProgrammesList'\)\);/.test(PD) && /<script src="sokoni-education-programmes\.js" defer><\/script>/.test(PD), 'panel + mount + deferred script');
ck('P-3', !/var panels=\[[^\]]*eduprogrammes/.test(PD) && /data-hc-module="eduCourses"/.test(PD), 'no hash deep-link; CONTROL: the Courses wiring is intact');
const SRC = read('sokoni-education-programmes.js');
const sent = []; let reply = null;
const mkEl = () => { const e = { innerHTML: '', _h: null, addEventListener: (t, h) => { e._h = h; }, querySelector: () => null }; return e; };
const G = { firebase: { functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); return { data: await reply(n, d) }; } }) }, alert() {} };
let M = null; try { vm.runInNewContext(SRC, { window: G, Object, String, Number, Promise, JSON, Math, Array }); M = G.SokoniEducationProgrammes; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
(async () => {
  if (M) {
    const el = mkEl();
    reply = (n, d) => (n === 'manageMyProgrammes' ? { programmes: [{ programmeId: 'p1', title: '<img src=x>', status: 'active', courseIds: ['c1'] }] }
      : { courses: [{ courseId: 'c1', title: 'Networks <b>', status: 'published' }] });
    await M.mount(el);
    const H = el.innerHTML;
    ck('M-1', /&lt;img src=x&gt;/.test(H) && /Networks &lt;b&gt;/.test(H) && /Active/.test(H) && /data-pg-status="draft"/.test(H), 'renders programmes + their course titles escaped; an active one offers Deactivate', H.slice(0, 200));
    sent.length = 0;
    const vals = { title: 'Diploma', level: 'diploma', durationWeeks: '52' };
    const box = { getAttribute: () => '', querySelector: (q) => { const m = /data-f="(\w+)"/.exec(q); return m ? { value: vals[m[1]] } : { textContent: '' }; }, querySelectorAll: () => [{ value: 'c1' }] };
    el.querySelector = (q) => (q === '[data-pg-formslot]' ? { innerHTML: '' } : null);
    el._h({ target: { closest: (s) => (s === '[data-pg-save]' ? { disabled: false, closest: () => box } : null) } });
    await new Promise((r) => setTimeout(r, 5));
    const c = sent.find(([n, d]) => n === 'manageMyProgrammes' && d.op === 'create');
    ck('M-2', !!c && Object.keys(c[1].programme).sort().join() === 'courseIds,durationWeeks,level,title' && !('ownerUid' in c[1]), 'create sends ONLY programme fields — never an owner / institution id', c && c[1]);
    reply = () => { throw new Error('Only an approved SOKONI institution can manage programmes.'); };
    const el2 = mkEl(); await M.mount(el2);
    ck('M-3', /\(—\)/.test(el2.innerHTML) && /approved SOKONI institution/.test(el2.innerHTML) && !/data-pg-new/.test(el2.innerHTML), 'refused: "—" + the server\'s reason, no create button');
  } else { for (let i = 1; i <= 3; i++) ck('M-' + i, false, 'module present'); }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
