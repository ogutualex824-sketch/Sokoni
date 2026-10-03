#!/usr/bin/env node
/* LEGAL HUB L3/L6 (hosting) — directory cards are discovery-only links to a real storefront; no fabricated ratings, fees,
 * advocates or stats; filters come from THE taxonomy; the storefront books through the canonical engine.
 * Executes the page's OWN functions (sliced from legal-hub.html) in a vm with a minimal DOM; storefront checks are static.
 *   node scripts/test-legal-hub-web.js        BASE=<ref> (pre-L3 must FAIL) */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = process.env.LEGAL_WEB_ROOT || path.join(__dirname, '..');
const read = (f) => process.env.BASE
  ? (() => { try { return cp.execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return ''; } })()
  : (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(JSON.stringify(got)).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nLegal Hub web — directory, cards, storefront   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const html = read('legal-hub.html'), prof = read('legal-profile.html'), taxSrc = read('sokoni-legal-taxonomy.js');
function slice(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } }
  return null;
}
/* minimal DOM: one grid + count + bars */
const EL = {};
const mk = (id) => (EL[id] = EL[id] || { id, innerHTML: '', textContent: '', hidden: false, dataset: {}, value: '', classList: { add() {}, remove() {} }, querySelectorAll: () => [], insertAdjacentHTML(_, h) { this.innerHTML += h; }, scrollIntoView() {} });
const ctx = { window: {}, console, document: { getElementById: (id) => mk(id), querySelectorAll: () => [] }, setTimeout: () => 0, location: { href: '' }, encodeURIComponent };
ctx.window = ctx; vm.createContext(ctx);
let loaded = true;
try {
  vm.runInContext(taxSrc, ctx);
  vm.runInContext('var lhEsc = function(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"})[c];});}; var _activeLawCat=""; var _fsLawyersCache=null; var RATE_LABELS={}; function isLawyerSaved(){return false;}', ctx);
  const ltLine = (html.match(/const LT = window\.SokoniLegalTaxonomy \|\| null;/) || [''])[0].replace('const LT', 'var LT');
  vm.runInContext(ltLine + '\n' + ['_lhAreaLabels', 'getLawyers', '_renderLawyerCards', '_lhRenderAreaBar', '_lhRenderGroupBar', '_updateStats', 'filterLawyers', 'renderLawyers', 'bookLawyer'].map((n) => slice(html, n) || ('/* missing ' + n + ' */')).join('\n'), ctx);
} catch (e) { loaded = false; console.log('  (load error: ' + e.message + ')'); }
if (!loaded || typeof ctx._renderLawyerCards !== 'function' || !ctx.SokoniLegalTaxonomy) { ck('W-0', false, 'page functions + generated taxonomy load'); done(); }

const A = { id: 'advA1234', entityType: 'advocate', name: 'Wanjiru Kamau', firm: '', practiceAreas: ['family-law', 'wills-succession'], practiceGroups: ['individuals'],
  skills: ['Family Law', 'Wills & Succession'], spec: 'Family Law · Wills & Succession', location: 'Nairobi', rate: null, rating: null, ratingCount: 0, bio: '<img src=x onerror=1>', verified: true, lskPractisingYear: 2026 };
const F = { id: 'firmB1234', entityType: 'firm', name: 'Otieno & Co Advocates', firm: '', practiceAreas: ['term-sheets'], practiceGroups: ['startups-sme'],
  skills: ['Term Sheets'], spec: 'Term Sheets', location: 'Kisumu', rate: 7500, rating: 4.6, ratingCount: 9, bio: '', verified: true };
ctx._renderLawyerCards([A, F]);
const grid = EL.lawyersGrid.innerHTML;
const cards = grid.split('<a class="lawyer-card"').slice(1);
ck('W1', cards.length === 2 && !/<button/i.test(grid) && cards[0].includes('href="legal-profile.html?id=advA1234"') && cards[1].includes('href="legal-profile.html?id=firmB1234"') && /aria-label="Wanjiru Kamau, advocate, LSK practising verified/.test(grid),
  'lawyer cards are ONE accessible link each to the storefront — no buttons inside (owner rule)', grid.slice(0, 400));
ck('W2', cards[0].includes('no reviews yet') && !/★ 5\.0|5\.0/.test(cards[0]) && cards[0].includes('Fee on request') && cards[1].includes('★ 4.6') && cards[1].includes('9 reviews') && cards[1].includes('KES 7,500')
  && !/<img src=x/.test(grid) && cards[1].includes('Law firm'),
  'honest card values: unrated → "no reviews yet" (never a default 5), unpriced → "Fee on request"; firm labelled; bio escaped');
const fsMap = slice(html, '_loadLawyersFs') || '';
ck('W3', !/consultationFee \|\| 5000|consultationFee \|\| 500\b|p\.rating \|\| 0|'Nairobi'/.test(fsMap) && /rate:\s+Number\(p\.consultationFee\) > 0 \? Number\(p\.consultationFee\) : null/.test(fsMap)
  && JSON.stringify(ctx.getLawyers()) === '[]' && !/sokoniServiceProviders|localStorage/.test((slice(html, 'getLawyers') || 'localStorage').replace(/\/\*[\s\S]*?\*\//g, '')),
  'no fabricated defaults (fee 5000 / deposit 500 / city "Nairobi" / rating 0) and NO localStorage advocates', fsMap.slice(0, 200));
ctx._fsLawyersCache = [A, F];
const run = async (cat) => { ctx._activeLawCat = cat; await ctx.renderLawyers(); return (EL.lawyersGrid.innerHTML.match(/legal-profile\.html\?id=(\w+)/g) || []).map((x) => x.split('=')[1]); };
(async () => {
  const all = await run(''), g = await run('group:startups-sme'), a = await run('area:family-law'), f = await run('firm:'), bad = await run('property');
  ck('W4', JSON.stringify(all) === '["advA1234","firmB1234"]' && JSON.stringify(g) === '["firmB1234"]' && JSON.stringify(a) === '["advA1234"]' && JSON.stringify(f) === '["firmB1234"]' && JSON.stringify(bad) === '[]'
    && /filterLawyers\('group:\$\{g\.id\}'/.test(html) && !/filterLawyers\('criminal'|filterLawyers\('human_rights'/.test(html),
    'filters: six taxonomy groups → areas, law firms; an unknown/legacy filter shows nothing (never everyone); no hand-typed category chips', { all, g, a, f, bad });
  ctx._updateStats([A, F]);
  ck('W5', EL.statRating.textContent === '4.6⭐' && EL.statCases.textContent === '—' && EL.statLawyers.textContent === '2',
    'stats: average over RATED advocates only; no invented case count ("—")', { r: EL.statRating.textContent, c: EL.statCases.textContent });
  ck('W6', !/bookLegalConsultation\s*['"(]|_lhCallCF\('bookLegalConsultation'/.test(html) && /function bookLawyer\(id\)\{\n  if \(id\) \{ location\.href = 'legal-profile\.html\?id='/.test(html)
    && !/onclick="bookLawyer\('\$\{l\.id\}'\)"/.test(html),
    'the hub never calls the retired money-less bookLegalConsultation; every Book path lands on the storefront; search hits are links, not buttons');
  /* storefront (static) */
  ck('S1', prof.includes("callable('getLegalProvider', { providerId: id })") && prof.includes('SokoniBookService.open(') && /\.where\('providerId', '==', id\)/.test(prof)
    && /s\.active === true && Number\(s\.price\) > 0/.test(prof) && prof.includes('<script src="sw-register.js" defer></script>') && prof.includes('<script src="sokoni-legal-taxonomy.js"></script>'),
    'storefront: server profile (eligible only) + ACTIVE priced rate cards; booking = canonical SokoniBookService; self-updates (sw-register)');
  ck('S2', !/tel:|wa\.me|whatsapp/i.test(prof) && !/licenseNumber|\.phone\b/.test(prof) && /No reviews yet/.test(prof) && /: '—'\) \+ '<\/dd>'/.test(prof)
    && /location\.origin \+ '\/legal-profile\.html\?id=' \+ encodeURIComponent\(id\)/.test(prof),
    'storefront privacy + honesty: no phone / licence / WhatsApp; unrated says so; unknown details "—"; Share carries only the public profile link');
  done();
})();
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); console.log('NOT proven here: a real browser render (memory floor) and a live booking.'); process.exit(fail ? 1 : 0); }
