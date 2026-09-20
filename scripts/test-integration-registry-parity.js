/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION REGISTRY PARITY — the contract holding two inventories together
   scripts/test-integration-registry-parity.js                             (RC-1)

   `firebase deploy --only functions` uploads functions/ and nothing else, so the
   backend cannot require the browser catalogue — the trap already documented in
   auth-policy.js and shop-offers.js. The inventory therefore exists twice:

       sokoni-integration-catalogue.js   the console's catalogue  (browser)
       functions/integration-registry.js the backend's registry   (deployed)

   A drift between them would have the console describing one estate while the
   backend reports another. This suite is the contract: entry for entry, both
   sides must declare the SAME integrations, with the SAME category, the SAME
   lifecycle status and the SAME required secrets — and a divergence in EITHER
   direction fails, including an entry added to one side only.

   THE CONTROL MATTERS MORE THAN THE COMPARISON
   ---------------------------------------------
   Comparing two lists proves nothing if the extractor silently drops rows. The
   first draft of this extraction dropped `africastalking` because its name uses
   double quotes, which would have reported a live, fully-configured SMS rail as
   absent from the catalogue. So the parse is checked against the count of ids
   the file literally declares before any comparison is believed.
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

const CAT_SRC = fs.readFileSync(path.join(ROOT, 'sokoni-integration-catalogue.js'), 'utf8');
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));

/* ── Parse the browser catalogue ──────────────────────────────────────────── */
const DECLARED_IDS = (CAT_SRC.match(/^      id: '/gm) || []).length;
function parseCatalogue () {
  const re = /^      id: '([a-z0-9-]+)', name: (?:'([^']*)'|"([^"]*)")/gm;
  let m; const rows = [];
  while ((m = re.exec(CAT_SRC))) {
    rows.push({ id: m[1], name: m[2] !== undefined ? m[2] : m[3], at: m.index });
  }
  const str = (seg, k) => {
    const r = seg.match(new RegExp(k + ": (?:'([^']*)'|\"([^\"]*)\")"));
    return r ? (r[1] !== undefined ? r[1] : r[2]) : null;
  };
  const arr = (seg, k) => {
    const r = seg.match(new RegExp(k + ':\\s*\\[([^\\]]*)\\]'));
    return r ? r[1].split(',').map(x => x.replace(/['"\s]/g, '')).filter(Boolean) : [];
  };
  rows.forEach((e, i) => {
    const seg = CAT_SRC.slice(e.at, (rows[i + 1] || { at: CAT_SRC.length }).at);
    e.category = str(seg, 'category');
    e.status   = str(seg, 'status');
    e.vendor   = str(seg, 'vendor');
    e.secrets  = arr(seg, 'secrets');
    delete e.at;
  });
  return rows;
}
const cat = parseCatalogue();

console.log('══════════════════════════════════════════════════════════════════');
console.log('  INTEGRATION REGISTRY PARITY (RC-1)');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE EXTRACTOR IS TRUSTWORTHY BEFORE ITS OUTPUT IS BELIEVED ────────── */
head('1 - controls');
{
  ok('POSITIVE CONTROL — every id the catalogue declares was parsed',
     cat.length === DECLARED_IDS, cat.length + ' of ' + DECLARED_IDS);
  ok('control — the catalogue is non-trivial', DECLARED_IDS >= 30, DECLARED_IDS + ' entries');
  ok('control — every parsed row carries category and status',
     cat.every(e => e.category && e.status));

  /* The specific row a single-quote-only parser drops. Named, so a regression
     in the parser fails HERE rather than silently shrinking the comparison. */
  const at = cat.find(e => e.id === 'africastalking');
  ok('control — the double-quoted-name entry is parsed', !!at && /Africa/.test(at.name),
     at ? at.name : 'DROPPED');

  /* INVERTING CONTROL — a parser that cannot fail is not a parser. */
  const broken = (CAT_SRC.match(/^      id: "/gm) || []).length;
  ok('control — no entry uses a spelling this parser cannot see', broken === 0,
     broken + ' unparseable id declarations');
}

/* ── 2. SAME SET OF INTEGRATIONS ──────────────────────────────────────────── */
head('2 - both inventories declare the same integrations');
{
  const catIds = cat.map(e => e.id).sort();
  const regIds = registry.INTEGRATIONS.map(e => e.id).sort();
  ok('same count', catIds.length === regIds.length,
     'catalogue ' + catIds.length + ' · registry ' + regIds.length);

  const onlyCat = catIds.filter(i => regIds.indexOf(i) === -1);
  const onlyReg = regIds.filter(i => catIds.indexOf(i) === -1);
  ok('nothing in the catalogue is missing from the registry',
     onlyCat.length === 0, onlyCat.join(' ') || 'none');
  ok('nothing in the registry is absent from the catalogue',
     onlyReg.length === 0, onlyReg.join(' ') || 'none');

  /* INVERTING CONTROL — prove the set comparison can actually fail. */
  const planted = regIds.concat(['ghost-integration']).sort();
  ok('INVERTING CONTROL — an entry on one side only IS detected',
     planted.filter(i => catIds.indexOf(i) === -1).length === 1);
}

/* ── 3. SAME FACTS PER INTEGRATION ────────────────────────────────────────── */
head('3 - category, lifecycle and required secrets agree');
{
  const diffs = [];
  cat.forEach(c => {
    const r = registry.byId(c.id);
    if (!r) { diffs.push(c.id + ':absent'); return; }
    if (r.category !== c.category) diffs.push(c.id + ':category ' + c.category + '/' + r.category);
    if (r.status !== c.status)     diffs.push(c.id + ':status ' + c.status + '/' + r.status);
    const a = (c.secrets || []).slice().sort().join(',');
    const b = (r.requiredSecrets || []).slice().sort().join(',');
    if (a !== b) diffs.push(c.id + ':secrets [' + a + ']/[' + b + ']');
  });
  ok('every entry agrees on category, status and required secrets',
     diffs.length === 0, diffs.slice(0, 4).join(' · ') || 'all ' + cat.length + ' agree');

  /* Named spot-checks, so a wholesale corruption of both sides cannot pass by
     agreeing with itself. */
  const isc = registry.byId('intasend-collections');
  ok('IntaSend collections requires its two keys',
     isc && isc.requiredSecrets.slice().sort().join(',') === 'INTASEND_API_KEY,INTASEND_PRIVATE_KEY',
     isc ? isc.requiredSecrets.join(',') : 'absent');
  const fs2 = registry.byId('firestore');
  ok('Firestore declares no named secret — service-account auth, not a gap',
     fs2 && fs2.requiredSecrets.length === 0);
}

/* ── 4. DARAJA IS ABSENT FROM BOTH ────────────────────────────────────────── */
head('4 - Daraja is not a SOKONI payment integration');
{
  const hay = (e) => (e.id + ' ' + (e.vendor || '') + ' ' + (e.name || '')).toLowerCase();
  ok('no Daraja entry in the registry',
     !registry.INTEGRATIONS.some(e => /daraja/.test(hay(e))));
  ok('no Daraja entry in the catalogue', !cat.some(e => /daraja/.test(hay(e))));
  ok('no Daraja secret is declared REQUIRED by any integration',
     !registry.INTEGRATIONS.some(e => (e.requiredSecrets || []).some(s => /DARAJA/i.test(s))));

  /* Its credentials still exist in Secret Manager. That must NOT pull it back
     into the inventory — presence of a key is not evidence of an integration. */
  ok('control — IntaSend IS the declared payment vendor',
     registry.INTEGRATIONS.filter(e => e.category === 'payments' && e.status === 'live')
       .every(e => e.vendor === 'IntaSend'),
     registry.INTEGRATIONS.filter(e => e.category === 'payments' && e.status === 'live')
       .map(e => e.vendor).join(','));
}

/* ── 5. THE REGISTRY CARRIES NO SECRET VALUES ─────────────────────────────── */
head('5 - the registry is names-only');
{
  const raw = fs.readFileSync(path.join(ROOT, 'functions/integration-registry.js'), 'utf8');
  ok('no long opaque literal that could be a key',
     !/['"][A-Za-z0-9_\-]{32,}['"]/.test(raw.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('no assigned credential value', !/(api[_-]?key|secret|token)\s*:\s*['"][^'"]{12,}['"]/i
     .test(raw.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('control — it DOES carry secret NAMES, which are not sensitive',
     /INTASEND_API_KEY/.test(raw));
}

console.log('\n  what this suite does NOT prove');
console.log('  SCOPE     parity of DECLARATIONS only. Whether a declared secret exists is');
console.log('            scripts/test-integration-status.js; whether a provider works is RC-3.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
