#!/usr/bin/env node
/* Construction intake (owner 2026-10-03): every construction trade applies through the ONE intake (hub-register.js)
   with its own questions. CAT_QUESTIONS and the category list are EVALUATED in a vm (not pattern-matched), and the
   collector (_collectDetails) is executed against a stub DOM.
   Run: node scripts/test-construction-intake.js      BASE=<commit> to run against another tree (the base must FAIL). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nconstruction intake   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HR = read('hub-register.js');
const block = (src, start) => { const i = src.indexOf(start); if (i < 0) return null; let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(j, k + 1); } return null; };
let CQ = {};
try { CQ = vm.runInNewContext('var Q = ' + block(HR, 'var Q = {') + '; (' + block(HR, 'var CAT_QUESTIONS = {') + ')'); } catch (e) { console.log('  (CAT_QUESTIONS not evaluable: ' + e.message + ')'); }
const cats = (HR.match(/\{ id:'[a-z-]+',\s+label:'[^']+',\s+hub:'construction'/g) || []).map((m) => m.match(/id:'([a-z-]+)'/)[1]);
const CONSTRUCTION = ['hardware', 'contractor', 'construction-architect', 'construction-company', 'welding-fabrication', 'equipment-rental', 'construction-services', 'construction-transport'];
const q = (cat, id) => (CQ[cat] || []).find((x) => x.id === id);
const has = (cat, id, opts) => { const x = q(cat, id); return !!x && opts.every((o) => (x.options || []).indexOf(o) > -1); };

ck('K1', CONSTRUCTION.every((c) => cats.indexOf(c) > -1), 'every construction trade is a category in the ONE intake (hub construction)', cats);
ck('K2', CONSTRUCTION.every((c) => (CQ[c] || []).length > 0), 'every construction category has its own questions (no generic form)', CONSTRUCTION.filter((c) => !(CQ[c] || []).length));
ck('C1', has('contractor', 'contractorTypes', ['General building', 'Civil works', 'Road works', 'Electrical', 'Plumbing', 'Mechanical', 'Roofing', 'Painting', 'Flooring', 'Masonry', 'Concrete', 'Structural', 'Finishing']) && q('contractor', 'contractorTypes').required === true,
  'Register as a Contractor: all 13 contractor kinds, a required multi-select (each approved separately)');
ck('C2', ['companyRegNo', 'kraPin', 'ncaRegNo'].every((id) => q('construction-company', id) && q('construction-company', id).required === true), 'construction company: registration, KRA PIN and NCA number required');
ck('C3', has('welding-fabrication', 'services', ['Welding', 'Metal fabrication', 'Steel fabrication', 'Aluminium fabrication', 'Structural steel', 'Gates & grilles', 'Windows & doors', 'Custom fabrication']) && q('welding-fabrication', 'workshop').required,
  'welding / fabrication: all specialisations + workshop location');
ck('C4', has('hardware', 'materialCats', ['Cement', 'Steel', 'Timber', 'Tiles', 'Paint', 'Construction chemicals']) && q('hardware', 'delivery').required, 'material supplier: material categories + delivery capability');
ck('C5', has('equipment-rental', 'equipmentCats', ['Excavators & loaders', 'Cranes & lifting', 'Generators & compressors', 'Scaffolding']) && q('equipment-rental', 'ownership').required,
  'equipment rental: equipment categories + ownership / authorisation declared');
ck('C6', q('construction-architect', 'professionalRegNo') && q('construction-architect', 'professionalRegNo').required, 'architect / engineer / QS: professional registration number required');
const all = CONSTRUCTION.reduce((a, c) => a.concat((CQ[c] || []).map((x) => [c, x])), []);
ck('S1', !all.some(([, x]) => /verified|approved|status|badge/i.test(x.id)), 'no question lets an applicant declare themselves verified / approved');
ck('S2', all.every(([, x]) => x.type !== 'text' || (x.max > 0 && x.max <= 200)), 'every text answer is length-capped');
ck('S3', CONSTRUCTION.every((c) => { const ids = (CQ[c] || []).map((x) => x.id); return ids.length === new Set(ids).size; }), 'question ids are unique per category');

/* F — execute _collectDetails against a stub DOM */
const fn = HR.slice(HR.indexOf('function _qId('), HR.indexOf('\n', HR.indexOf('function _qId(')));
const collect = block(HR, 'function _collectDetails(cat)');
let r1 = null, r2 = null;
try {
  const dom = {}; const sb = { CAT_QUESTIONS: CQ, document: { getElementById: (id) => dom[id] || null } };
  vm.runInNewContext(fn + '\nfunction _collectDetails(cat)' + collect + '\nthis.c = _collectDetails;', sb);
  r1 = sb.c('contractor');                                       /* nothing ticked → refused */
  dom['sreg_q_contractorTypes_0'] = { checked: true }; dom['sreg_q_contractorTypes_2'] = { checked: true };
  dom['sreg_q_serviceArea'] = { value: 'Nairobi, Kiambu' };
  r2 = sb.c('contractor');
} catch (e) { r1 = { error: e.message }; }
ck('F1', r1 && r1.ok === false && /Contractor work/.test(r1.error), 'a contractor with no trade ticked is refused', r1);
ck('F2', r2 && r2.ok === true && r2.details.contractorTypes === 'General building, Road works', 'ticked trades are saved as the declared capabilities', r2);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
