/* catalogue.html deep-linking and shell embedding.

   Merchant V2 opens the Services route as
       catalogue.html?tab=services&shell=merchant
   in an iframe (merchant-v2.html:1417). Two things must then be true, and
   neither is about the catalogue MODEL — this slice changes none of it:

     the Services tab is already selected at first paint
     the page does not draw a second header on top of the shell's

   The page is a browser document, so these run against its SOURCE plus the
   extracted pure helpers, exercised in a minimal DOM stub. What cannot be
   asserted without a browser is stated as such rather than faked.
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'catalogue.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};

/* Extract _initialTab exactly as written and run it against a stubbed
   location — testing the real source, not a re-typed copy of it. */
function initialTabFor(search) {
  const src = html.match(/const VALID_TABS = \[[^\]]*\];\s*function _initialTab\(\)\{[\s\S]*?\n\}/);
  if (!src) throw new Error('could not extract _initialTab from catalogue.html');
  const fn = new Function('location', 'URLSearchParams',
    src[0] + '; return _initialTab();');
  return fn({ search }, URLSearchParams);
}

console.log('\n── The deep link selects the tab ──');
ck('?tab=services opens Services', initialTabFor('?tab=services') === 'services');
ck('?tab=products opens Products', initialTabFor('?tab=products') === 'products');
ck('?tab=all opens All', initialTabFor('?tab=all') === 'all');
ck('the merchant-v2 link exactly as the route writes it',
   initialTabFor('?tab=services&shell=merchant') === 'services');
ck('order of params does not matter',
   initialTabFor('?shell=merchant&tab=services') === 'services');

console.log('\n── A bad tab shows the catalogue, not an empty one ──');
ck('no tab at all ⇒ all', initialTabFor('') === 'all');
ck('an unknown tab falls back to all', initialTabFor('?tab=widgets') === 'all');
ck('an empty tab falls back to all', initialTabFor('?tab=') === 'all');
/* Inverting control: the fallback is a fallback, not a constant. */
ck('…and a VALID tab is still honoured', initialTabFor('?tab=services') === 'services');

console.log('\n── The highlight is synced from state, not assumed ──');
{
  ck('a _syncTabs helper exists', /function _syncTabs\(\)/.test(html));
  ck('…and render() calls it, so first paint is correct',
     /function render\(\)\{[\s\S]{0,80}_syncTabs\(\)/.test(html));
  ck('…driven by VALID_TABS rather than a second hard-coded list',
     /VALID_TABS\[i\]===st\.tab/.test(html));
  ck('st.tab is seeded from the URL', /tab:_initialTab\(\)/.test(html));
}

console.log('\n── Switching a tab keeps the URL honest ──');
{
  ck('the URL is updated on tab change', /history\.replaceState/.test(html));
  ck('…with replaceState, not pushState (a filter is not a nav step)',
     !/history\.pushState/.test(html));
  ck('…and "all" clears the param rather than writing tab=all',
     /if\(t==='all'\) u\.searchParams\.delete\('tab'\)/.test(html));
}

console.log('\n── Shell embedding ──');
{
  ck('the flag is set before first paint (inline, in <head>)',
     html.indexOf('in-merchant-shell') < html.indexOf('<style>'),
     'inline script precedes the stylesheet');
  ck('?shell=merchant is honoured', /get\('shell'\) === 'merchant'/.test(html));
  ck('being framed is ALSO honoured',
     /window\.parent && window\.parent !== window/.test(html));
  ck('…either is sufficient', /declared \|\| framed/.test(html));
  ck('the detection cannot throw the page over', /catch \(_\) \{ \/\* never block/.test(html));
}

console.log('\n── Only DUPLICATED chrome is hidden ──');
{
  ck('the page header is hidden in the shell',
     /html\.in-merchant-shell header\{display:none\}/.test(html));
  ck('the toolbar is de-stickied (the shell owns the scroll container)',
     /html\.in-merchant-shell \.bar\{position:static/.test(html));
  /* The reason the route exists must survive. */
  ck('the tabs are NOT hidden', !/in-merchant-shell[^}]*\.tabs\{display:none/.test(html));
  ck('the grid is NOT hidden', !/in-merchant-shell[^}]*\.grid\{display:none/.test(html));
  ck('the Add button is NOT hidden', !/in-merchant-shell[^}]*\.addbtn\{display:none/.test(html));
  ck('search is NOT hidden', !/in-merchant-shell[^}]*\.search\{display:none/.test(html));
}

console.log('\n── The route and the page agree ──');
{
  require(path.join(root, 'sokoni-merchant-routes.js'));
  const svc = globalThis.SokoniMerchantRoutes.ROUTES.find((r) => r.id === 'services');
  ck('the contract route exists', !!svc);
  const src = (svc && svc.src) || '';
  ck('…points at catalogue.html', /^catalogue\.html/.test(src), src);
  const qs = src.split('?')[1] || '';
  const p = new URLSearchParams(qs);
  ck('…carries tab=services', p.get('tab') === 'services', src);
  ck('…carries shell=merchant', p.get('shell') === 'merchant', src);
  /* The end-to-end claim: what the route writes, the page reads. */
  ck('the page resolves the route\'s own query string to Services',
     initialTabFor('?' + qs) === 'services', qs);
}

console.log('\n── Deep-linking stayed OUT of the catalogue model ──');
{
  /* This was a `git diff HEAD` check, and it died the moment its own slice
     was committed — the diff went empty and the positive control caught it,
     for the second time in this workstream. A boundary assertion that only
     holds while the work is uncommitted is not a boundary assertion.

     The durable property is a SEPARATION OF CONCERNS: routing and shell
     embedding are page concerns, and the model must know nothing about
     either. That stays true forever, not just until the next commit. */
  const model = fs.readFileSync(path.join(root, 'sokoni-catalogue-model.js'), 'utf8');
  const nav   = fs.readFileSync(path.join(root, 'sokoni-merchant-nav.js'), 'utf8');
  ck('the model knows nothing about query strings',
     !/URLSearchParams|location\.search|history\.|\?tab=/.test(model));
  ck('the model knows nothing about the shell', !/in-merchant-shell|shell=merchant/.test(model));
  ck('the nav module knows nothing about either',
     !/URLSearchParams|in-merchant-shell/.test(nav));
  ck('…and the PAGE owns both', /URLSearchParams/.test(html) && /in-merchant-shell/.test(html));
  /* Positive control: the scan reads real files, so "knows nothing" cannot
     pass against an empty read. */
  ck('…the model file was actually read',
     /function applyEdit/.test(model), model.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOT asserted here (needs a browser): that the iframe actually');
console.log('  renders without the header. Verify visually before deploy.\n');
process.exit(fail ? 1 : 0);
