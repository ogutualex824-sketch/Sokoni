#!/usr/bin/env node
/**
 * test-seller-dashboard.js — the Seller Dashboard tiles. Static + executed. Clicks nothing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Every quick-action tile on the Seller Dashboard — Add Product, Orders, Analytics,
 * KRA Tax, Marketing, Flash Sale, Messages, Visit Store, Team — was dead on any screen
 * wider than 768px. Tapping did nothing at all.
 *
 * The tiles call sdSwitchTab(...) from an inline onclick. sdSwitchTab was defined inside
 * an IIFE that began:
 *
 *     var isMobile = matchMedia('(max-width:768px)').matches;
 *     if (!isMobile) return;               ← bailed out above 768px
 *     ...
 *     window.sdSwitchTab = function(name){ ... }    ← never assigned
 *
 * The tiles render at EVERY width; the only function that could answer them existed
 * only on phones. Above 768px each tap threw a ReferenceError into the void.
 *
 * It produced NO uncaught error at page load — nothing appeared in the console until
 * you actually tapped a tile — which is why it presented as "the buttons just do
 * nothing" rather than as a crash.
 *
 * These checks execute the real IIFE, lifted verbatim out of seller.html, at four
 * viewports, and assert every tile resolves and routes.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const html = fs.readFileSync(path.resolve('seller.html'), 'utf8');

console.log('\nSeller Dashboard — tile interaction\n');

/* ── 1. The early-return that killed the tiles must be gone ─────────────────── */
{
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '');
  /* The IIFE may still compute isMobile — it must NOT return outright before
     assigning sdSwitchTab. */
  const iife = /SELLER DASHBOARD MOBILE TAB SYSTEM[\s\S]{0,400}/.exec(html);
  const bare = /var isMobile[^\n]*\n\s*if\s*\(\s*!isMobile\s*\)\s*return\s*;/.test(code);
  !bare
    ? ok('the bare `if(!isMobile) return;` is gone — the tab system no longer bails out above 768px')
    : bad('`if(!isMobile) return;` still short-circuits before sdSwitchTab is assigned — tiles dead on desktop');
}

/* ── 2. Execute the REAL IIFE at four viewports ─────────────────────────────── */
{
  /* Lift the mobile-tab <script> block out of seller.html verbatim. If the block moves
     or is renamed this test fails loudly rather than silently passing on nothing. */
  const start = html.indexOf('/* ══ SELLER DASHBOARD MOBILE TAB SYSTEM ══ */');
  if (start === -1) { bad('cannot find the mobile tab system block in seller.html'); }
  else {
    const end = html.indexOf('</script>', start);
    const src = html.slice(start, end);

    const TILES = ['products', 'orders', 'analyse', 'kra', 'market',
                   'flash', 'inbox', 'store', 'team', 'home', 'more'];

    /* showDashPage's real vocabulary, read off the sidebar in seller.html. */
    const KNOWN = new Set((html.match(/showDashPage\('([a-z-]+)'/g) || [])
      .map(s => s.replace(/showDashPage\('|'/g, '')));

    const VIEWPORTS = [
      { name: 'Desktop 1440',      w: 1440, mobile: false },
      { name: 'iPad 820',          w: 820,  mobile: false },
      { name: 'iPhone landscape',  w: 844,  mobile: false },
      { name: 'iPhone Safari 390', w: 390,  mobile: true  },
    ];

    for (const v of VIEWPORTS) {
      const routed = [];
      const els = new Map();
      const stubEl = () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } },
                              textContent: '', getAttribute(){ return null; }, scrollIntoView(){} });

      const sandbox = {
        console: { error(){}, warn(){}, log(){} },
        setTimeout: (f) => { try { f(); } catch (e) {} },
        document: {
          body: { classList: { add(){}, remove(){}, contains(){ return false; } }, style: {} },
          documentElement: { style: {} },
          getElementById: (id) => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
          querySelectorAll: () => [],
          querySelector: () => null,
          addEventListener(){},
        },
      };
      sandbox.window = sandbox;
      sandbox.window.scrollY = 0;
      sandbox.window.scrollTo = () => {};
      sandbox.window.addEventListener = () => {};
      sandbox.window.matchMedia = (q) => ({ matches: v.mobile && /max-width:\s*768px/.test(q) });
      /* Desktop path must delegate here. Record what it asks for. */
      sandbox.window.showDashPage = (page) => { routed.push(page); };

      let threw = null;
      try { vm.runInNewContext(src, sandbox, { timeout: 4000 }); }
      catch (e) { threw = e.message; }

      if (threw) { bad(`${v.name}: the tab-system block threw on load — ${threw}`); continue; }

      if (typeof sandbox.window.sdSwitchTab !== 'function') {
        bad(`${v.name}: window.sdSwitchTab is ${typeof sandbox.window.sdSwitchTab} — every tile is dead`);
        continue;
      }

      /* Every tile must invoke without throwing. */
      const broke = [];
      for (const t of TILES) {
        try { sandbox.window.sdSwitchTab(t); }
        catch (e) { broke.push(`${t}(${e.message.slice(0, 30)})`); }
      }

      if (broke.length) { bad(`${v.name}: tiles threw — ${broke.join(', ')}`); continue; }

      if (!v.mobile) {
        /* Desktop must have DELEGATED to showDashPage for every non-"more" tile. */
        const expected = TILES.length;
        routed.length >= expected - 1
          ? ok(`${v.name}: all ${TILES.length} tiles resolve and delegate to showDashPage (${routed.length} routed)`)
          : bad(`${v.name}: only ${routed.length}/${expected} tiles routed — some tiles still do nothing`);

        /* And every page name it asked for must actually be a page showDashPage knows. */
        const unknown = [...new Set(routed)].filter(p => !KNOWN.has(p));
        unknown.length === 0
          ? ok(`${v.name}: every routed page name is one showDashPage actually accepts`)
          : bad(`${v.name}: routes to page(s) showDashPage does not know: ${unknown.join(', ')} — the tile would open nothing`);
      } else {
        ok(`${v.name}: all ${TILES.length} tiles resolve (mobile tab system drives them)`);
      }
    }
  }
}

/* ── 3. The consent banner must not sit on top of the tiles ─────────────────── */
{
  const sec = fs.readFileSync(path.resolve('security.js'), 'utf8');
  /* It is position:fixed at bottom:0, z-index 99997. Without reserved space it swallows
     every tap at the foot of the viewport — on the dashboard that was the Messages and
     Marketing tiles, which looked normal and simply did not respond. */
  /* Assert the BEHAVIOUR — that the banner reserves body space — not that the code happens
     to sit within N characters of the banner's id. The old form searched a 3000-char window
     and broke the moment the implementation grew a comment, which is a test measuring
     source layout instead of behaviour. */
  /setProperty\(\s*['"]padding-bottom['"]/.test(sec)
    ? ok('the privacy banner reserves body space — it overlays no tile')
    : bad('the privacy banner is fixed at bottom:0 with no reserved space — it swallows taps on whatever is beneath it');

  /* Assert the BEHAVIOUR (the space comes back), not the spelling. security.js now sets
     the padding with `setProperty(..., 'important')` — a plain inline style lost to
     mobile.css's `!important` body rule — and releases it with removeProperty(). The old
     regex here pinned the assignment syntax, so a correct fix to the implementation broke
     the test. A test that only recognises one spelling of the right answer is a test that
     punishes people for improving the code. */
  /removeProperty\(\s*['"]padding-bottom['"]\s*\)|paddingBottom\s*=\s*['"]{2}/.test(sec)
    ? ok('the reserved space is released when the banner is dismissed')
    : bad('body padding is never released — a permanent gap after the banner is accepted');

  /* Body padding CANNOT move a fixed element — it is out of flow. The dashboard sidebar
     is position:fixed, so the banner sat on top of its last entries (Messages, Marketing)
     and ate those clicks no matter how much the body was padded. This is the subtle half
     of the bug: the obvious fix silently does nothing for fixed panels. */
  const css = fs.readFileSync(path.resolve('seller.css'), 'utf8');
  /--sk-consent-h/.test(sec)
    ? ok('the banner publishes its height as --sk-consent-h, so FIXED panels can subtract it')
    : bad('the banner does not publish its height — fixed panels cannot avoid it');

  /\.sidebar\{[\s\S]{0,400}?height:\s*calc\([^)]*--sk-consent-h/.test(css.replace(/\s*\/\*[\s\S]*?\*\/\s*/g, ''))
    ? ok('the fixed sidebar subtracts the banner height — its last entries stay clickable')
    : bad('the fixed sidebar ignores the banner — the banner covers its last entries and swallows those taps');
}

/* ── 4. Route integrity: every button must open the page it claims to ──────────
   The checks above proved the tiles RESOLVE and DELEGATE. They never proved the page
   name they delegate WITH actually exists — and check 2 validates routed names against a
   set scraped from the very same call sites, which is circular and can never fail.

   That blind spot shipped a P0. showDashPage does:

       const sections = DASH_PAGES[page] || DASH_PAGES.overview;

   so an unknown page is not an error — it silently renders Overview. DASH_PAGES had no
   'pos' key and no 'flash' key, so POS/Cashier and Flash Sale quietly showed the seller
   the Overview screen. The buttons fired, the handler ran, nothing appeared to happen.

   There are two route maps: the real one (seller.js, deferred, the one users get) and the
   pre-boot fallback in seller.html. They must both know every page the UI asks for, and
   they must not drift apart. */
{
  const js = fs.readFileSync(path.resolve('seller.js'), 'utf8');

  const mapKeys = (src, re) => {
    const m = src.match(re);
    if (!m) return null;
    return new Set([...m[0].matchAll(/^\s+([a-zA-Z]+)\s*:/gm)].map(x => x[1]));
  };

  const real = mapKeys(js,   /const DASH_PAGES\s*=\s*\{[\s\S]*?\n\};/);
  const fb   = mapKeys(html, /var PAGES\s*=\s*\{[\s\S]*?\n\s*\};/);

  if (!real) { bad('DASH_PAGES not found in seller.js — the live router is gone'); }
  if (!fb)   { bad('the pre-boot fallback PAGES map not found in seller.html'); }

  if (real && fb) {
    /* Every page the UI actually asks for must exist in the LIVE router. */
    const used = [...new Set([...html.matchAll(/showDashPage\(\s*'([a-zA-Z-]+)'/g)].map(x => x[1]))];
    const dead = used.filter(k => !real.has(k));
    dead.length === 0
      ? ok(`all ${used.length} showDashPage routes exist in the live router (seller.js)`)
      : bad(`route(s) missing from seller.js DASH_PAGES — these buttons SILENTLY render Overview: ${dead.join(', ')}`);

    /* And the fallback must not drift from the live router — that drift IS the bug. */
    const onlyReal = [...real].filter(k => !fb.has(k));
    const onlyFb   = [...fb].filter(k => !real.has(k));
    (onlyReal.length === 0 && onlyFb.length === 0)
      ? ok('the pre-boot fallback and the live router know exactly the same pages')
      : bad('route maps have DRIFTED — ' +
            (onlyFb.length   ? `only in the fallback: ${onlyFb.join(', ')}. ` : '') +
            (onlyReal.length ? `only in seller.js: ${onlyReal.join(', ')}.` : ''));

    /* POS specifically: on a phone the till must take the whole screen, not an iframe. */
    /page\s*===\s*"pos"[\s\S]{0,200}?location\.href\s*=\s*"pos\.html"/.test(js)
      ? ok('POS on mobile navigates to pos.html (the till needs the full screen)')
      : bad('POS on mobile does not navigate to pos.html — the button opens nothing usable on a phone');

    /* An unknown route must be loud, not silently render the wrong page. */
    /if\s*\(\s*!DASH_PAGES\[page\]\s*\)[\s\S]{0,120}console\.warn/.test(js)
      ? ok('an unknown route warns instead of silently falling back to Overview')
      : bad('an unknown route still falls back to Overview in silence — the next dead button will hide the same way');

    /* The router and the desktop stylesheet must be wired to each other.
       seller.html hides every section on desktop and reveals only `.desk-visible`:

           section[data-sdtab] { display: none; }
           section[data-sdtab].desk-visible { display: block !important; }

       The router only ever set inline display, and `display = ""` hands the element back to
       that `display:none` rule — so the section it was told to SHOW stayed hidden and POS
       opened a blank panel. Nothing applied the class at all. If the toggle goes, desktop
       silently blanks again. */
    /classList\.toggle\(\s*["']desk-visible["']/.test(js)
      ? ok('the router applies .desk-visible — the class the desktop stylesheet reveals on')
      : bad('the router no longer applies .desk-visible — on desktop every section it shows will stay display:none');

    /* And the hide must carry !important, because a shared stylesheet does:
         @media(min-width:769px){ .seller-stats,… { display:grid !important } }
       which outranks the router's inline display:none and leaves the Overview stat grid
       showing underneath every other page, including POS. */
    /section\[data-sdtab\]:not\(\.desk-visible\)[\s\S]{0,90}display:\s*none\s*!important/.test(html)
      ? ok('sections without .desk-visible are hidden with !important — Overview cannot bleed through')
      : bad('the :not(.desk-visible) hide rule is gone — a `display:grid !important` elsewhere will keep Overview on screen under every page');
  }

  /* Every section a route points at must actually exist in the page. A route naming a
     section that was renamed or deleted would open a blank screen. */
  if (real) {
    const ids = new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(x => x[1]));
    const dpBlock = js.match(/const DASH_PAGES\s*=\s*\{[\s\S]*?\n\};/)[0];
    const targets = [...new Set([...dpBlock.matchAll(/"([a-z0-9-]+-section|seller-stats|seller-dms)"/g)].map(x => x[1]))];
    const ghosts = targets.filter(t => !ids.has(t));
    ghosts.length === 0
      ? ok(`all ${targets.length} sections referenced by the router exist in seller.html`)
      : bad(`router points at section(s) that do not exist — those pages open blank: ${ghosts.join(', ')}`);
  }

  /* Only ONE live definition of the router. Four coexisted; the deferred one won, and
     nobody could tell which was real. */
  const defs = (html.match(/window\.showDashPage\s*=\s*function/g) || []).length +
               (js.match(/^function showDashPage/gm) || []).length;
  defs <= 2
    ? ok(`showDashPage has ${defs} definition(s) — the live router plus the pre-boot fallback`)
    : bad(`showDashPage has ${defs} competing definitions — whichever loads last wins and nobody can tell which is real`);
}

console.log('');
if (fail) { console.error(`Seller Dashboard FAILED (${fail}) — tiles may be dead\n`); process.exit(1); }
console.log(`Seller Dashboard PASSED (${pass} checks) — every tile resolves at every viewport\n`);
