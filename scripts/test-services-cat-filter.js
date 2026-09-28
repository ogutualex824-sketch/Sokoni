/* test-services-cat-filter.js — services.html ?cat= links find approved providers under their C1 category.
 *
 * Executes the REAL filter block extracted from services.html (renderProviders' category filter) over provider
 * cards shaped exactly as SokoniProviders.normalize() returns them (category = the C1 key, displayCategory = the
 * provider's own words).
 *
 *   node scripts/test-services-cat-filter.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-services-cat-filter.js  # 4e9607b (before) — failures ARE the defects
 *
 * PROVES
 *   S1  an approved DJ (C1 artist_creator) is listed under ?cat=entertainment AND ?cat=dj — the Entertainment hub's
 *       own links (it was invisible: every link word matched nothing once cards carried the C1 key)
 *   S2  ?cat=mc lists the MC and NOT the DJ (narrowing within the category works)
 *   S3  ?cat=plumbing lists the plumber and not the electrician (both C1 trades)
 *   S4  own words never PLACE a provider: a `trades` provider calling itself "dj" is NOT listed under ?cat=dj
 *   S5  a C1 key passes straight through (?cat=artist_creator)
 *   S6  PINNED TO THE AUTHORITY: wherever C1 classifies a link word, the table agrees with C1 exactly
 *   S7  no dead link: every services.html?cat= word used by ANY page resolves (table entry or C1 key)
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = '4e9607b';
const CPM = !!process.env.COUNTERPROOF;
const BCAT = require(path.join(ROOT, 'functions/business-category.js'));
const html = CPM ? cp.execFileSync('git', ['show', BASE + ':services.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })
  : fs.readFileSync(path.join(ROOT, 'services.html'), 'utf8');

const startMark = CPM ? '  const CAT_ALIASES = {' : '  const CAT_TO_C1 = {';
const s = html.indexOf(startMark), e = html.indexOf('  /* Filter by search */', s);
if (s < 0 || e < 0) { console.log('CRASH filter block not found'); process.exit(2); }
const filterSrc = html.slice(s, e);
const run = (providers, activeCat) => new Function('providers', 'activeCat', filterSrc + '\nreturn providers;')(providers.slice(), activeCat);
const tableOf = () => (CPM ? {} : new Function(filterSrc.slice(0, filterSrc.indexOf('  const NARROW')) + '\nreturn CAT_TO_C1;')());

const card = (name, c1, own) => ({ name, category: c1, categories: [c1], displayCategory: own, serviceType: own, skills: [] });
const DJ = card('DJ Bambino', 'artist_creator', 'dj');
const MC = card('MC Jay', 'artist_creator', 'mc');
const PHOTO = card('Lens KE', 'artist_creator', 'photographer');
const PLUMB = card('Pipe Pro', 'trades', 'plumbing');
const ELEC = card('Volt Fix', 'trades', 'electrical');
const FAKE = card('Not A DJ', 'trades', 'dj');
const ALL = [DJ, MC, PHOTO, PLUMB, ELEC, FAKE];
const names = (a) => a.map((p) => p.name);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
console.log('\nSOURCE: ' + (CPM ? 'services.html @ ' + BASE + ' (before) — failures below ARE the defects' : 'fix (working tree)'));

const ent = names(run(ALL, 'entertainment')), dj = names(run(ALL, 'dj'));
ck('S1  approved DJ listed under ?cat=entertainment AND ?cat=dj', ent.includes('DJ Bambino') && dj.includes('DJ Bambino'), { entertainment: ent, dj });
const mc = names(run(ALL, 'mc'));
ck('S2  ?cat=mc lists the MC, not the DJ', mc.includes('MC Jay') && !mc.includes('DJ Bambino'), mc);
const pl = names(run(ALL, 'plumbing'));
ck('S3  ?cat=plumbing lists the plumber, not the electrician', pl.includes('Pipe Pro') && !pl.includes('Volt Fix'), pl);
ck('S4  own words never place a provider (trades "dj" not under ?cat=dj)', !dj.includes('Not A DJ'), dj);
const key = names(run(ALL, 'artist_creator'));
ck('S5  a C1 key passes through (?cat=artist_creator)', key.includes('DJ Bambino') && key.includes('MC Jay') && !key.includes('Pipe Pro'), key);

/* every ?cat= word any page links to */
const files = cp.execFileSync('git', ['ls-files', '*.html', '*.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => f && !/^(functions|scripts|docs|tests?)\//.test(f) && f !== 'demo-seed.js');
const words = new Set();
for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/services\.html\?cat=([A-Za-z0-9_&%-]+)/g)) words.add(decodeURIComponent(m[1]).toLowerCase());
const T = tableOf();
const disagree = [];
for (const w of words) {
  const r = BCAT.categoryFromApplication({ category: w }, 'provider').category || BCAT.categoryFromApplication({ categoryLabel: w }, 'provider').category;
  if (r && !(T[w] && T[w].length === 1 && T[w][0] === r)) disagree.push(w + '→C1:' + r + ' table:' + JSON.stringify(T[w] || null));
}
ck('S6  pinned to C1: wherever C1 classifies a link word, the table agrees', !CPM && disagree.length === 0, CPM ? 'no table' : disagree);
const dead = [...words].filter((w) => !(T[w] || BCAT.isCategory(w)));
ck('S7  no dead link: every ?cat= word used by any page resolves', dead.length === 0, { words: words.size, dead });

console.log(`\n${pass} passed, ${fail} failed`);
if (CPM) console.log('(counter-proof: failures here ARE the defects this slice removes)');
process.exit(fail ? 1 : 0);
