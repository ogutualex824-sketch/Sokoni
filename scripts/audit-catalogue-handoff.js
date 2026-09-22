/* ══════════════════════════════════════════════════════════════════════════════
   CATALOGUE / TENDER HANDOFF AUDIT
   ══════════════════════════════════════════════════════════════════════════════
   The eighteen questions of the handoff contract (§2), as something that RUNS
   rather than something someone remembers to ask.

   WHY IT EXISTS NOW, BEFORE THE HANDOFF. The catalogue/tender workstream's files
   are foreign and uncommitted. This suite does not touch them, does not read
   their implementation for anything but tracked-ness, and answers nothing on
   their behalf. What it does is fail loudly, per question, with the question
   printed — so the day the commit lands the audit is a command, not a memory.

   THE GATE IS git, NOT the filesystem. A file present on disk but untracked is
   still the other workstream's working copy: it can change or vanish under us,
   and building against it would be building against a moving target. So the
   handoff is defined as "tracked in the index", which is exactly the reviewable
   commit the brief asks for.

   VERDICTS: PASS / FAIL / UNPROVEN / NOT RUN / INCONCLUSIVE — never collapsed.
   Before the handoff every contract question is NOT RUN with its reason. That is
   the honest state; a green suite here before a handoff would be a lie.

   Run: node scripts/audit-catalogue-handoff.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const ROOT = path.join(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has  = f => fs.existsSync(path.join(ROOT, f));

let pass = 0, fail = 0, unproven = 0, notrun = 0, inconclusive = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS         ' : 'FAIL         ') + l + (d ? '   [' + String(d).slice(0, 100) + ']' : '')); ok ? pass++ : fail++; return ok; };
const up = (l, why) => { console.log('  UNPROVEN     ' + l + '\n                 ' + why); unproven++; };
const nr = (l, why) => { console.log('  NOT RUN      ' + l + '\n                 ' + why); notrun++; };
const inc = (l, why) => { console.log('  INCONCLUSIVE ' + l + '\n                 ' + why); inconclusive++; };
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Is the handoff here? ────────────────────────────────────────────────────── */
const OWNED_BY_THEM = [
  'sokoni-catalogue-model.js',
  'sokoni-pos-tender.js',
  'sokoni-pos-pay-console.js',
  'functions/shared/pos-service-pricing.js',
];
let tracked = null;
try {
  const out = cp.execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8 });
  tracked = out.split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
} catch (_) { tracked = null; }

console.log('\nCATALOGUE / TENDER HANDOFF AUDIT');
console.log('='.repeat(74));

head('0. Handoff state');
if (!tracked) {
  inc('handoff detection', 'git ls-files could not be read, so tracked-ness is unknown. ' +
      'This is NOT "no handoff" — it is no answer, and the rest of the suite is not run on a guess.');
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' UNPROVEN, ' +
              notrun + ' NOT RUN, ' + inconclusive + ' INCONCLUSIVE');
  process.exit(fail ? 1 : 0);
}
const state = OWNED_BY_THEM.map(f => ({
  file: f,
  onDisk: has(f),
  tracked: tracked.indexOf(f) > -1,
}));
state.forEach(s => console.log('  ' + (s.tracked ? 'COMMITTED' : s.onDisk ? 'untracked' : 'absent   ') + '  ' + s.file));
const HANDED_OFF = state.every(s => s.tracked);
const PARTIAL    = !HANDED_OFF && state.some(s => s.tracked);

ck('handoff is all-or-nothing (no partial commit)', !PARTIAL,
   PARTIAL ? 'SOME files committed and some not — auditing a half-landed contract would ' +
             'measure two different designs at once' : (HANDED_OFF ? 'complete' : 'none yet'));

/* ── The eighteen questions ─────────────────────────────────────────────────── */
const QUESTIONS = [
  ['A', 'What is the canonical catalogue collection?'],
  ['B', 'How is PRODUCT distinguished from SERVICE?'],
  ['C', 'What is the canonical non-stock/service flag?'],
  ['D', 'What is the canonical unit?'],
  ['E', 'How does variable pricing work?'],
  ['F', 'How does a service reach the till?'],
  ['G', 'How does a service reach Quick Pay?'],
  ['H', 'How does a service reach POS?'],
  ['I', 'How does a service reach Merchant V2?'],
  ['J', 'How does a service reach marketplace where permitted?'],
  ['K', 'What does productProjections write?'],
  ['L', 'What fields are projected?'],
  ['M', 'Which fields are authoritative vs projections?'],
  ['N', 'How is channel availability represented?'],
  ['O', 'How does inventory interpret service vs product?'],
  ['P', 'How does KRA/tax classification interpret service vs product?'],
  ['Q', 'How does receipt generation represent service lines?'],
  ['R', 'How does realtime propagate catalogue changes?'],
];

head('1. The handoff contract (§2 A-R)');
if (!HANDED_OFF) {
  QUESTIONS.forEach(([k, q]) => {
    nr(k + '. ' + q,
       'the catalogue/tender workstream has not produced a reviewable commit. Its files are ' +
       'untracked working copies, so any answer read from them could change or vanish. ' +
       'Answering from the UI would also be forbidden — the brief says "do not accept \'the UI ' +
       'supports it\' as the answer".');
  });
} else {
  /* The handoff HAS landed. Each question becomes a real trace against committed code.
     They are deliberately UNPROVEN-by-default rather than auto-passing: landing a commit
     answers none of them by itself, and a suite that went green on arrival would be the
     "declared ready because it renders" failure the brief names. */
  QUESTIONS.forEach(([k, q]) => {
    up(k + '. ' + q,
       'the commit has landed and this question is now ANSWERABLE, but it has not been ' +
       'answered — each needs a trace from UPLOAD -> CANONICAL RECORD -> PROJECTION -> ' +
       'POS/TILL -> QUICK PAY -> MARKETPLACE -> INVENTORY -> KRA -> RECEIPT -> REPORTING -> ' +
       'REALTIME, written into docs/MERCHANT_V2_PRODUCT_UPLOAD_ECOSYSTEM_2026-09-22.md ' +
       'under "Catalogue/Tender Handoff". Replace this line with the trace and its evidence.');
  });
}

/* ── What must remain true either way ───────────────────────────────────────── */
head('2. Invariants that hold before AND after the handoff');

/* d0443b8 field parity must survive. */
if (has('sokoni-merchant-products.js') && has('sokoni-merchant-data.js')) {
  const PM = R('sokoni-merchant-products.js'), MD = R('sokoni-merchant-data.js');
  const fk = (PM.match(/var FORM_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
  const collected = [...new Set(
    (fk.match(/'([a-zA-Z]+)'/g) || []).map(s => s.slice(1, -1))
      .concat((PM.match(/out\.([a-zA-Z]+)\s*=/g) || []).map(s => s.slice(4, -1).trim()))
  )];
  const pf = MD.slice(MD.indexOf('function _productFields'), MD.indexOf('function _validate'));
  const carried = [...new Set(
    (pf.match(/out\.([a-zA-Z]+)\s*=/g) || []).map(s => s.slice(4, -1).trim())
      .concat((pf.match(/'([a-zA-Z]+)'/g) || []).map(s => s.slice(1, -1)))
  )];
  const dropped = collected.filter(k => carried.indexOf(k) < 0);
  ck('d0443b8 field parity holds — no rendered-but-discarded field',
     dropped.length === 0, dropped.join(', ') || collected.length + ' collected, none dropped');
  ck('  CONTROL — both sides parsed', collected.length >= 20 && carried.length >= 20,
     'collected=' + collected.length + ' carried=' + carried.length);
  ['kebsCert', 'location', 'deliveryCost'].forEach(k =>
    ck('  seller.js parity preserved: ' + k, carried.indexOf(k) > -1));
}

/* productProjections must NOT have been widened without the owner's contracts. */
if (has('sokoni-merchant-data.js')) {
  const MD = R('sokoni-merchant-data.js');
  const proj = MD.slice(MD.indexOf('function productProjections'), MD.indexOf('function _writeMirrors'));
  ck('productProjections not widened ahead of the handoff',
     !/trackStock|listingType|variablePrice/.test(proj),
     'widening a mirror without knowing each consumer is the field-mapping divergence the ' +
     'writer\'s own header warns about');
}

/* One uploader. */
if (has('sokoni-merchant-routes.js')) {
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  const prod = C.get('products');
  ck('Products still opens the canonical editor (30208f3 preserved)',
     !!prod && prod.kind === 'native', prod && prod.kind);
  ck('no second uploader route appeared',
     !C.ROUTES.some(r => /upload|premium/i.test(r.id) && r.id !== 'pos-import'),
     C.ROUTES.filter(r => /upload|premium/i.test(r.id)).map(r => r.id).join(',') || 'none');
}

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' UNPROVEN, ' +
            notrun + ' NOT RUN, ' + inconclusive + ' INCONCLUSIVE');
console.log(HANDED_OFF
  ? '  HANDOFF PRESENT — the eighteen questions are answerable and UNANSWERED.'
  : '  NO HANDOFF YET — the eighteen questions are NOT RUN, and that is the correct state.');
process.exit(fail ? 1 : 0);
