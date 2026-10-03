#!/usr/bin/env node
/* EDUCATION E1 (owner decisions 2026-10-03) — the ONE intake (hub-register.js) offers the education applicant types and
 * asks for exactly the documents the SERVER requires before it will approve.
 *   node scripts/test-education-intake.js        BASE=74474f3 node scripts/test-education-intake.js (must FAIL)
 *   SERVER=feat/education-applications-on-cbbce0c (default) — the lifecycle whose EDUCATION_REQUIRED is the contract.
 * CAT_QUESTIONS is EVALUATED (extracted and run in a vm), not pattern-matched; the server's required ids are read from
 * the server branch's application-lifecycle.js, so a rename on either side fails here. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\neducation intake   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HR = read('hub-register.js');
const block = (src, start) => { const i = src.indexOf(start); if (i < 0) return null; let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(j, k + 1); } return null; };
let CQ = {};
try { CQ = vm.runInNewContext('var Q = ' + block(HR, 'var Q = {') + '; (' + block(HR, 'var CAT_QUESTIONS = {') + ')'); } catch (e) { console.log('  (CAT_QUESTIONS not evaluable: ' + e.message + ')'); }
const SERVER = process.env.SERVER || 'feat/education-applications-on-cbbce0c';
const LC = execSync('git show ' + SERVER + ':functions/application-lifecycle.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const REQ = vm.runInNewContext('(' + block(LC, 'const EDUCATION_REQUIRED = Object.freeze({').replace(/^\{/, '{') + ')');
const TYPES = vm.runInNewContext('(' + block(LC, 'const EDUCATION_TYPES = Object.freeze({') + ')');
ck('S-0', REQ && REQ.enterprise && TYPES && TYPES['education-enterprise'] === 'enterprise', 'CONTROL: the server contract was read from ' + SERVER);

/* every education category the server types is offered by the intake */
const catIds = [...HR.matchAll(/\{ id:'([^']+)',\s*label:'[^']*',\s*hub:'education'/g)].map((m) => m[1]);
for (const id of Object.keys(TYPES)) ck('C-' + id, catIds.includes(id), 'the intake offers "' + id + '" under the education hub (server type ' + TYPES[id] + ')', catIds);

/* every server-required document is a REQUIRED question for every category of that type */
for (const [cat, type] of Object.entries(TYPES)) {
  const qs = CQ[cat] || [];
  for (const [field] of REQ[type] || []) {
    const q = qs.find((x) => x && x.id === field);
    ck('Q-' + cat + '-' + field, !!q && q.required === true, '"' + cat + '" asks for ' + field + ' as a REQUIRED answer (the server refuses approval without it)', qs.map((x) => x && x.id));
  }
}
ck('Q-kra', ((CQ['education-enterprise'] || []).find((q) => q.id === 'kraPin') || {}).max === 11, 'the enterprise KRA PIN field is capped at 11 characters (the server pattern)');

/* role, plan and the honest next step */
const submit = HR.slice(HR.indexOf('function _submit'));
ck('R-1', /var _requestedRole = cat === 'education-enterprise' \? 'buyer'/.test(submit), 'an enterprise declares requestedRole buyer (never provider)');
ck('R-2', /var plan\s+= cat === 'education-enterprise' \? 'free'/.test(submit), 'an enterprise never carries a paid listing plan (so no hub_registration charge is minted)');
ck('R-3', /pb\.style\.display = cat === 'education-enterprise' \? 'none'/.test(HR) && /id="sreg_planBox"/.test(HR), 'the plan picker is hidden for an enterprise (no price shown that it never pays)');
ck('R-4', /education-enterprise'\s*\n?\s*\? 'You will be notified when it is decided\. Once SOKONI verifies your company/.test(HR), 'the enterprise success screen promises verification, not a business dashboard');
ck('R-5', !Object.prototype.hasOwnProperty.call(CQ, 'driving-school') || !catIds.includes('driving-school'), 'CONTROL: driving schools stay with Car Hub (no second education driving-school category)');
let open = 0; for (const m of HR.matchAll(/<div|<\/div>/g)) open += m[0] === '<div' ? 1 : -1;
ck('R-6', open === 0, 'the intake markup stays balanced (<div> opened == closed)', open);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
