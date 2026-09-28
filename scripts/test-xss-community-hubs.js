#!/usr/bin/env node
/* test-xss-community-hubs.js — stored XSS, slice 2: the hubs that had NO escaper at all.
 *   community.html (posts, replies, trending, groups) · fitness-hub.html (classes, clubs) ·
 *   home-services.html (provider grid) · unboxing.html (photo reviews) · reviews.html (review cards)
 *
 *   node scripts/test-xss-community-hubs.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-xss-community-hubs.js  # the same files @ 4e9607b — failures ARE the defects
 *
 * Why these are cross-user: communityPosts / communityGroups (any signed-in user creates; anyone may append replies),
 * fitness_classes / fitness_clubs, homeServiceProviders, unboxingReviews and reviews are all publicly readable and
 * author-written. Method as in test-xss-product-surfaces: the REAL render code, tagged hostile values, Chromium parse
 * with JavaScript disabled, every executable context reported with the field that leaked. Controls require the real
 * content (names, prices, buttons) to render — an empty string cannot pass.
 */
'use strict';
const X = require('./lib/xss-probe');
const CPM = !!process.env.COUNTERPROOF;
const read = X.reader('4e9607b', CPM);
const { ck, st } = X.makeCk();
const H = X.H;
/* the canonical escaper is loaded from security.js at its CURRENT version in both modes — the defect under test is
   whether the page CALLS it, not what it does */
const escapeHTML = X.runWith('(function(){ ' + X.extractFrom(require('fs').readFileSync(require('path').join(X.ROOT, 'security.js'), 'utf8'), 'function escapeHTML(str){') + ' return escapeHTML; })()', {});
const leaks = (hits) => hits.map((h) => h.ctx + (h.field ? ' ← field ' + h.field : ''));
async function probeCase(name, html, mustContain) {
  const [hits] = await X.probe([html]);
  const miss = (mustContain || []).filter((s) => !html.includes(s));
  ck(name, hits.length === 0 && !miss.length, hits.length ? leaks(hits) : { missing: miss, sample: String(html).slice(0, 160) });
}
const run = (code, scope) => { try { return X.runWith(code, Object.assign({ escapeHTML, window: {} }, scope)); } catch (e) { return 'ERR ' + e.message; } };

(async () => {
  console.log('\nSOURCE: ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));

  /* ── community.html ── */
  {
    const C = read('community.html');
    const post = { id: H(1), title: H(2), author: H(3), date: H(4), product: H(5), body: H(6), type: 'discussion', likes: 2, helpful: 1,
      authorUid: H(7), replies: [{ author: H(8), time: H(9), text: H(10) }] };
    const feed = X.extractFrom(C, 'feed.innerHTML = filtered.map(p => {');
    const html = run('(function(){ const feed = {}; const filtered = [__p];\n' + feed + ').join("");\nreturn feed.innerHTML; })()', {
      __p: post, user: { uid: 'someone-else' }, TYPE_META: { discussion: { badge: 'b', label: 'Discussion' } },
      localStorage: { getItem: () => null }, ContactGuard: { sanitiseForDisplay: (t) => t } });
    await probeCase('CM1 community feed: post id, title, author, date, product, body, follow button, replies', html, ['cm-post', 'Discussion', 'Send']);
    const trend = X.tplAt(C, 'trendEl.innerHTML = top.map((p,i)=>`');
    await probeCase('CM2 community trending: post id and title', run('(function(){ const top = [__p]; return top.map((p,i)=>' + trend + ').join(""); })()', { __p: post }), ['cm-trend-item']);
    const groups = X.extractFrom(C, 'grid.innerHTML = list.map(g => {');
    const g = { id: H(11), emoji: H(12), name: H(13), desc: H(14), members: 5, type: 'x' };
    await probeCase('CM3 community groups: id, emoji, name, description',
      run('(function(){ const grid = {}; const list = [__g]; const _myGroups = [];\n' + groups + ').join("");\nreturn grid.innerHTML; })()', { __g: g }), ['cc-group-card', 'Join']);
  }

  /* ── fitness-hub.html ── */
  {
    const F = read('fitness-hub.html');
    const cls = X.tplAt(F, 'function renderClasses() {');
    const c = { id: H(20), name: H(21), instructor: H(22), type: H(23), loc: H(24), time: H(25), duration: H(26), slots: H(27), level: H(28), phone: H(29), fee: 500, emoji: H(30) };
    await probeCase('FT1 fitness classes: every field, book + WhatsApp buttons', run('(function(){ return [__c].map(c=>' + cls + ').join(""); })()', { __c: c }), ['cls-card', 'KES 500']);
    const clubs = X.tplAt(F, 'function renderClubs() {');
    const cl = { emoji: H(31), name: H(32), members: H(33), desc: H(34), meet: H(35), loc: H(36), phone: H(37) };
    await probeCase('FT2 fitness clubs: every field, join button', run('(function(){ return [__c].map(c=>' + clubs + ').join(""); })()', { __c: cl }), ['cm-card', 'Join Club']);
  }

  /* ── home-services.html ── */
  {
    const HS = read('home-services.html');
    const tpl = X.tplAt(HS, 'grid.innerHTML=list.map(p=>`');
    const p = { id: H(40), name: H(41), emoji: H(42), specialty: H(43), area: H(44), exp: H(45), rating: H(46), jobs: H(47), bio: H(48), rate: H(49), phone: H(50), certified: false };
    await probeCase('HS1 home-services provider card: every field, WhatsApp + rate buttons', run('(function(){ return [__p].map(p=>' + tpl + ').join(""); })()', { __p: p }), ['hs-card', 'Rate']);
  }

  /* ── unboxing.html ── */
  {
    const U = read('unboxing.html');
    const cb = X.extractFrom(U, 'gallery.innerHTML=list.map((r,i)=>{');
    const r = { id: H(60), reviewer: H(61), rating: 4, product: H(62), comment: H(63), photos: ['data:image/png;base64,AAA" onerror="__xss(64)'], photoCount: H(65), likes: 3, category: 'x' };
    const r2 = Object.assign({}, r, { photos: [H(66)] });
    await probeCase('UB1 unboxing card: id, photo, placeholder, product, comment, reviewer, count',
      run('(function(){ const gallery = {}; const list = [__r, __r2];\n' + cb + ').join("");\nreturn gallery.innerHTML; })()', { __r: r, __r2: r2, AV_COLORS: ['#111'], CAT_EMOJIS: {} }), ['ub-card', 'ub-card-product']);
  }

  /* ── reviews.html ── */
  {
    const R = read('reviews.html');
    const fn = X.extractFrom(R, 'function _buildCard(r, idx){');
    const r = { id: H(70), name: H(71), target: H(72), comment: H(73), date: H(74), rating: 5, type: 'seller', helpful: 1 };
    await probeCase('RV1 review card: id, name, target, comment, date', run('(function(){ ' + fn + '\nreturn _buildCard(__r, 0); })()', { __r: r, avColor: () => '#111' }), ['review-card', 'rc-helpful']);
  }

  await X.close();
  console.log(`\n${st.pass} passed, ${st.fail} failed`);
  process.exit(st.fail ? 1 : 0);
})().catch(async (e) => { await X.close(); console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
