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
  /* ── L3b: application wizard, account views, retired legacy tabs ── */
  const acct = read('sokoni-legal-account.js');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const reg = strip(slice(html, 'registerLawyer') || '') ;
  ck('R1', /entityType: _lhRegType/.test(reg) && /practiceAreas: \[\.\.\._lhSel\]/.test(reg) && /_lhCallCF\('registerLegalProvider', data\)/.test(reg) && !/localStorage/.test(reg)
    && html.includes('id="lhTypeAdv"') && html.includes('id="lhTypeFirm"') && html.includes('id="lhAreaPicker"') && html.includes("onclick=\"lhAddOffice()\"")
    && !/KES 2,500|KES 5,500|Elite badge|firmPlan/.test(strip(html)),
    'ONE application wizard: Lawyer vs Law firm → registerLegalProvider (entityType + taxonomy practiceAreas); no localStorage copy; no sold "verified badge" plans');
  const chk = strip(slice(html, 'checkExistingApp') || '');
  ck('R2', /op: 'legalMyProfile'/.test(chk) && /a\.reviewReason/.test(chk) && /info_requested/.test(chk) && /legalResubmitApplication/.test(strip(slice(html, 'lhResubmit') || '')) && /legalUpdateProfile/.test(strip(slice(html, 'lhSaveProfile') || ''))
    && /this is not "no application"/.test(chk),
    'applicant status from the server (type, status, SOKONI reason, verification), resubmit only when asked, profile edits via legalUpdateProfile; a failed load is not "no application"');
  let ok3 = false, rows3 = {};
  try {
    const c2 = { window: {}, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null }, console, setTimeout, Promise };
    c2.window = c2; vm.createContext(c2); vm.runInContext(acct, c2);
    const A2 = c2.SokoniLegalAccount;
    const held = A2._rowHtml({ id: 'bk1', providerId: 'adv1', service: 'Legal consultation', price: 500000, paymentStatus: 'paid_held', status: 'confirmed', date: '2026-10-10', startTime: '10:00' }, { name: 'Wanjiru' });
    const unpaid = A2._rowHtml({ id: 'bk2', providerId: 'adv1', price: 500000, paymentStatus: 'pending', status: 'pending' }, { name: 'Wanjiru' });
    rows3 = { held, unpaid };
    ok3 = held.includes('data-lb-pin="bk1"') && held.includes('KES 5,000') && held.includes('data-lb-msg="bk1"') && held.includes('topic=refund')
      && !unpaid.includes('data-lb-pin') && !unpaid.includes('data-lb-msg') && unpaid.includes('Awaiting payment')
      && typeof c2.renderAppointments === 'function' && typeof c2.initProDashboard === 'function';
  } catch (e) { rows3 = { err: e.message }; }
  ck('A1', ok3 && /\.where\('customerUid', '==', u\.uid\)/.test(acct) && /p\.category === 'legal' \|\| p\.legalProviderId/.test(acct) && /op: 'getMyBookingPin'/.test(acct)
    && /SokoniBookService\.review\(\{ bookingId: id \}\)/.test(acct) && !/\.set\(|\.update\(|\.add\(|localStorage/.test(strip(acct)),
    'My legal bookings: canonical providerBookings (mine, Legal providers only); PIN button ONLY once paid & held; message/refund-request only on a real booking; module writes nothing', rows3);
  const comp = strip((html.split('id="lawpane-completion"')[1] || '').split('id="lawpane-appointments"')[0]);
  ck('A2', comp.length > 0 && !/<input|<form|522522|Paybill|submitCaseCompletion/i.test(comp) && /deducts its commission <strong>once<\/strong>/.test(comp)
    && html.includes('<script src="sokoni-legal-account.js" defer></script>') && html.includes("document.addEventListener('DOMContentLoaded', go, { once: true })")
    && /catch \(e\) \{ console\.warn\('\[Legal Hub\] tab '/.test(html),
    'the client-side "log case + pay 5% by Paybill" tab is gone (commission is deducted once at PIN settlement); legacy loaders replaced; tab restore waits for modules and cannot break navigation');
  const aos = read('sokoni-aos-legal.js'), aosHtml = read('admin-os.html');
  ck('AO1', aos.includes("call('legalAdminList', etype ? { view, entityType: etype } : { view })") &&aos.includes("chip(a.entityType === 'firm' ? 'LAW FIRM' : 'LAWYER')") && aos.includes('<option value=\"firm\">Law firms</option>')
    && aos.includes('declared advocate(s), not verified') && aosHtml.indexOf('sokoni-legal-taxonomy.js') > -1 && aosHtml.indexOf('sokoni-legal-taxonomy.js') < aosHtml.indexOf('sokoni-aos-legal.js') && aosHtml.includes('id=\"panel-legal\"'),
    'AdminOS Legal: lawyer vs law-firm column + filter, practice areas from the taxonomy, firm team shown as NOT verified; panel wired');
  const pd = read('provider-dashboard.html');
  ck('PD1', pd.includes("_isLawyer(){return !!(window.__sokoniWorkspace&&window.__sokoniWorkspace.category==='lawyer'&&window.SokoniLegalTaxonomy)}") && pd.includes("if(this._isLawyer()){const la=_q('svLegalArea').value;data.legalArea=la||null}")
    && pd.includes('id="svLegalAreaWrap" hidden') && pd.includes('<script src="sokoni-legal-taxonomy.js" defer></script>') && pd.includes('T.GROUPS.map(g=>'),
    'provider dashboard: Legal practice-area picker only for a server-classified lawyer workspace, options from the taxonomy, sent as legalArea (server re-validates)');
  done();
})();
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); console.log('NOT proven here: a real browser render (memory floor) and a live booking.'); process.exit(fail ? 1 : 0); }
