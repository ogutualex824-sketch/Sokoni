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
  /_sokoniPrivacyBanner[\s\S]{0,3000}?paddingBottom/.test(sec)
    ? ok('the privacy banner reserves body space — it overlays no tile')
    : bad('the privacy banner is fixed at bottom:0 with no reserved space — it swallows taps on whatever is beneath it');

  /paddingBottom\s*=\s*''/.test(sec)
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

console.log('');
if (fail) { console.error(`Seller Dashboard FAILED (${fail}) — tiles may be dead\n`); process.exit(1); }
console.log(`Seller Dashboard PASSED (${pass} checks) — every tile resolves at every viewport\n`);
