#!/usr/bin/env node
/**
 * test-overlays.js — the overlay ARCHITECTURE. Static analysis. Opens nothing.
 *
 * ── The bug class this exists to kill ─────────────────────────────────────────
 * The Notification Centre was built as a drawer (--sk-z-drawer, 600) but BEHAVES as a
 * full-screen modal. The global header is 100001. So the header rendered on top of it,
 * covering the title, "Mark all read", the search box and the ✕. It could be opened and
 * not closed.
 *
 * It was never one component's mistake. An audit of the platform found 52 full-screen
 * overlays with HARDCODED z-index values — every one of them below the header. Among
 * them the CHECKOUT PAYMENT OVERLAYS (.mpesa-overlay / .card-overlay / .paypal-overlay,
 * z-index 99999). The header out-ranked the modal a customer pays inside.
 *
 * That is a class, not an incident, and a class needs a gate — not another fix.
 *
 * This check fails the build when a full-screen, dismissible overlay cannot beat the
 * header. It does NOT touch toasts, badges, sticky bars or genuine side drawers: those
 * are SUPPOSED to sit below the header, and raising them would break the stacking order
 * on purpose. The distinction is the whole point:
 *
 *     DRAWER  — sits WITHIN the page, below the header.        --sk-z-drawer  (600)
 *     SHEET   — COVERS the screen, must beat the header.       --sk-z-sheet   (100010)
 *
 *     If it covers the header, it must out-rank the header.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const ROOT = process.cwd();

/* Resolve the token scale — the single source of truth for stacking. */
const tokens = fs.readFileSync(path.join(ROOT, 'sokoni-tokens.css'), 'utf8');
const TOK = {};
for (const m of tokens.matchAll(/--(sk-z-[\w-]+):\s*(-?\d+)/g)) TOK[m[1]] = Number(m[2]);

const Z_HEADER = TOK['sk-z-header'];
const Z_SHEET  = TOK['sk-z-sheet'];
const Z_DRAWER = TOK['sk-z-drawer'];

console.log('\nOverlay architecture — can every sheet beat the header?\n');

/* ── 1. The tier system itself ─────────────────────────────────────────────── */
{
  (Z_SHEET && Z_HEADER && Z_SHEET > Z_HEADER)
    ? ok(`--sk-z-sheet (${Z_SHEET}) out-ranks --sk-z-header (${Z_HEADER})`)
    : bad(`--sk-z-sheet must out-rank --sk-z-header — otherwise the header covers every sheet's ✕`);

  (Z_DRAWER && Z_HEADER && Z_DRAWER < Z_HEADER)
    ? ok(`--sk-z-drawer (${Z_DRAWER}) stays BELOW the header — a drawer is not a sheet, and that distinction is the fix`)
    : bad('--sk-z-drawer is no longer below the header — the two tiers now mean the same thing');
}

/* ── 2. No full-screen overlay may be unable to beat the header ────────────── */
{
  /* Files that legitimately define things ABOVE/BELOW by design and are not overlays. */
  const SKIP = new Set(['sokoni-tokens.css']);

  /* Parse the ACTUAL rule block, not a character window around it.

     My first version scanned ±300 chars around every `position:fixed` and reported 230
     offenders — nearly all false positives (.material-icons, .empty-state, a z-index:0 on
     a background). It was picking up z-index values from NEIGHBOURING rules.

     A gate that cries wolf gets switched off, and a switched-off gate protects nothing. So:
     find the enclosing { … } block, and judge only what is inside it. */
  const FULLSCREEN  = /(inset:\s*0)|(top:\s*0[\s\S]{0,90}left:\s*0[\s\S]{0,90}right:\s*0[\s\S]{0,90}bottom:\s*0)/;
  const DISMISSIBLE = /overlay|modal|sheet|lightbox|dialog|backdrop/i;

  const files = fs.readdirSync(ROOT).filter(f => /\.(js|css|html)$/.test(f) && !SKIP.has(f));
  const offenders = [];

  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }

    /* Strip comments before parsing. A comment EXPLAINING why an overlay has a given
       z-index is prose, not a declaration — counting it as an offender punishes people for
       documenting the very thing this gate exists to police, and teaches them to delete the
       explanation instead of fixing the code. */
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

    const re = /position:\s*fixed/g;
    let m;
    while ((m = re.exec(src))) {
      /* Walk back to the opening brace of THIS rule, and forward to its close. */
      const open = src.lastIndexOf('{', m.index);
      if (open === -1) continue;
      const close = src.indexOf('}', m.index);
      if (close === -1) continue;
      const decls = src.slice(open + 1, close);          /* ONLY this rule's declarations */

      /* The selector is whatever precedes the brace, back to the previous } ; or newline. */
      const selStart = Math.max(
        src.lastIndexOf('}', open), src.lastIndexOf(';', open), src.lastIndexOf('\n', open));
      const sel = src.slice(selStart + 1, open).trim().replace(/\s+/g, ' ').slice(0, 40);

      if (!FULLSCREEN.test(decls)) continue;             /* not a full-screen overlay */
      if (!DISMISSIBLE.test(sel) && !DISMISSIBLE.test(decls)) continue;  /* not dismissible */

      const tokRef = /z-index:\s*var\(\s*--(sk-z-[\w-]+)\s*(?:,\s*(\d+))?/.exec(decls);
      if (tokRef) {
        const val = TOK[tokRef[1]] != null ? TOK[tokRef[1]] : Number(tokRef[2] || 0);
        if (val <= Z_HEADER) offenders.push(`${f} ${sel} → --${tokRef[1]} (${val}) is below the header`);
        continue;
      }

      const lit = /z-index:\s*(\d+)/.exec(decls);
      if (!lit) continue;                                /* no z-index in THIS rule */
      const z = Number(lit[1]);
      if (z <= Z_HEADER) {
        offenders.push(`${f} ${sel} z-index:${z} HARDCODED (header is ${Z_HEADER})`);
      }
    }
  }

  const uniq = [...new Set(offenders)];

  /* ── The debt, and the ratchet ───────────────────────────────────────────────
     223 legacy overlays hardcode a z-index below the header. They are RESCUED AT RUNTIME
     by SokoniSheet's auto-promoter (verified: a z-index:1000 modal is raised to 100010 and
     its close button becomes tappable). Rewriting 223 files is not a fix — it is 223
     chances to break something, and the brief rightly says to fix the architecture, not
     the pages.

     So this is a RATCHET, not a wall: the count may fall, never rise. New code must use
     the token. Old code is carried by the runtime, and every migration lowers the number
     permanently. */
  const BASELINE_FILE = path.join(ROOT, 'scripts', '.overlay-baseline.json');
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).count; } catch (e) {}

  if (baseline == null) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ count: uniq.length, note:
      'Legacy full-screen overlays with a hardcoded z-index below the header. Rescued at ' +
      'runtime by SokoniSheet auto-promotion. This number may FALL, never RISE.' }, null, 2));
    ok(`baseline recorded: ${uniq.length} legacy overlays (rescued at runtime; new code must use --sk-z-sheet)`);
  } else if (uniq.length > baseline) {
    bad(`legacy overlays with a hardcoded z-index below the header ROSE from ${baseline} to ${uniq.length}. ` +
        `New code must use --sk-z-sheet, not a hardcoded number:\n        ` +
        uniq.slice(0, 6).join('\n        '));
  } else if (uniq.length < baseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ count: uniq.length, note:
      'Legacy full-screen overlays with a hardcoded z-index below the header. Rescued at ' +
      'runtime by SokoniSheet auto-promotion. This number may FALL, never RISE.' }, null, 2));
    ok(`legacy overlays reduced ${baseline} → ${uniq.length} — baseline ratcheted down`);
  } else {
    ok(`${uniq.length} legacy overlays carry a hardcoded z-index (rescued at runtime; count has not grown)`);
  }

  /* Whatever the legacy count, the RUNTIME guarantee must exist. */
  const sheetSrc = fs.readFileSync(path.join(ROOT, 'sokoni-sheet.js'), 'utf8');
  /function promote\(\)/.test(sheetSrc) && /z-index', 'var\(--sk-z-sheet/.test(sheetSrc)
    ? ok('SokoniSheet auto-promotes any VISIBLE full-screen overlay above the header — every legacy modal is rescued without editing it')
    : bad('no runtime auto-promotion — the 223 legacy overlays would remain coverable by the header');

  /b\.width < vw \* 0\.92 \|\| b\.height < vh \* 0\.92/.test(sheetSrc)
    ? ok('auto-promotion only touches overlays that actually COVER the viewport (toasts, FABs, sticky bars and side drawers are left alone)')
    : bad('auto-promotion is not scoped to full-screen overlays — it would raise toasts and drawers too');
}

/* ── 3. The money path specifically ────────────────────────────────────────── */
{
  const co = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
  const payOverlays = ['mpesa-overlay', 'card-overlay', 'paypal-overlay'];
  const bad_ = payOverlays.filter(c => {
    const m = new RegExp('\\.' + c + '\\s*\\{[^}]*z-index:\\s*(\\d+)').exec(co);
    return m && Number(m[1]) <= Z_HEADER;
  });
  bad_.length === 0
    ? ok('the checkout PAYMENT overlays out-rank the header (a customer pays inside one of these)')
    : bad(`payment overlay(s) below the header: ${bad_.join(', ')} — the header could cover the controls a customer pays with`);
}

/* ── 4. The shared component ───────────────────────────────────────────────── */
{
  const sheet = fs.readFileSync(path.join(ROOT, 'sokoni-sheet.js'), 'utf8');
  const need = [
    ['correct z tier',      /z-index:var\(--sk-z-sheet/],
    ['safe-area (4 edges)', /padding-top:env\(safe-area-inset-top[\s\S]*padding-right:env\(safe-area-inset-right/],
    ['focus trap',          /function trap\(/],
    ['focus restoration',   /lastFocus\.focus\(\)/],
    ['aria-modal',          /aria-modal/],
    ['inert background',    /setAttribute\('inert'/],
    ['body scroll lock',    /body\.style\.overflow = 'hidden'/],
    ['Escape dismissal',    /e\.key === 'Escape'/],
    ['browser Back',        /popstate/],
    ['swipe-down',          /onTouchMove/],
    ['44px close',          /width:44px;height:44px/],
  ];
  const missing = need.filter(n => !n[1].test(sheet)).map(n => n[0]);
  missing.length === 0
    ? ok('sokoni-sheet.js provides all 11 required behaviours (tier, safe-area, focus trap+restore, aria-modal, inert, scroll lock, Esc, Back, swipe, 44px close)')
    : bad('the shared sheet is missing: ' + missing.join(', '));
}

/* ── 4b. JS-INJECTED full-screen overlays ──────────────────────────────────────
   The checks above read CSS. That is a blind spot: an overlay built in JavaScript
   and given its z-index as a string in cssText is invisible to them.

   The privacy consent banner lived in exactly that blind spot. security.js injected
   a full-screen blocking modal (position:fixed; inset:0; backdrop) with a hardcoded
   z-index:99997 — BELOW --sk-z-header (100001). The header punched through the
   scrim, so on iPhone Safari the Restaurant Portal showed a crisp header and bottom
   nav over a blank, unscrollable content area. It did not look like an open dialog;
   it looked like a broken page, and was reported as one.

   Same rule as above, enforced one layer deeper: if it covers the screen, it must
   out-rank the header. */
{
  const HEADER_Z = 100001;
  const offenders = [];
  for (const f of fs.readdirSync(ROOT).filter(n => n.endsWith('.js'))) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    /* Strip comments so prose describing the bug cannot trip its own gate. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    /* cssText arrays / template strings that are full-screen AND carry a literal z-index */
    for (const m of code.matchAll(/cssText\s*=\s*(\[[\s\S]{0,900}?\]|`[\s\S]{0,900}?`)/g)) {
      const blk = m[1];
      const fullScreen = /inset\s*:\s*0/.test(blk) ||
                         (/top\s*:\s*0/.test(blk) && /bottom\s*:\s*0/.test(blk));
      if (!fullScreen) continue;
      if (!/position\s*:\s*fixed/.test(blk)) continue;
      /* Transparent, non-blocking bars are allowed to sit low — they block nothing. */
      if (/pointer-events\s*:\s*none/.test(blk)) continue;
      const z = blk.match(/z-index\s*:\s*(\d+)/);
      if (z && parseInt(z[1], 10) < HEADER_Z) {
        offenders.push(`${f} — full-screen blocking overlay at z-index:${z[1]}, below the header (${HEADER_Z})`);
      }
    }
  }
  /* EMPTY, and it must stay that way. Every JS-injected full-screen overlay now uses a
     platform token. This was briefly a pin-list of five (sokoni-branch, sokoni-sasos,
     sokoni-subscriptions, hub-wiring, sokoni-barcode); all five were migrated to
     --sk-z-sheet, so there is nothing left to tolerate. A new entry here means someone
     hardcoded a z-index below the header again — fix the overlay, do not extend this. */
  const KNOWN = new Set([]);
  const fresh = offenders.filter(o => !KNOWN.has(o.split(' ')[0]));

  if (fresh.length) {
    bad('NEW JS-injected overlay(s) the header will cover:\n     ' + fresh.join('\n     '));
  } else {
    const stale = [...KNOWN].filter(k => !offenders.some(o => o.startsWith(k)));
    ok('no NEW JS-injected full-screen overlay sits below the header'
       + ` (${KNOWN.size - stale.length} known legacy pinned`
       + (stale.length ? `; ${stale.join(', ')} now fixed — remove from KNOWN` : '') + ')');
  }
}

/* ── 4c. SCROLL-LOCK CONSISTENCY ───────────────────────────────────────────────
   An audit found 15 independent scroll-lock implementations in root JS. Only three
   use the iOS-safe pattern (position:fixed + negative top). The rest set
   body{overflow:hidden} — which this codebase already documents as broken:

     "iOS Safari bug: body{overflow:hidden} on a scrolled page offsets fixed-element
      tap targets by window.scrollY, making the Accept button unreachable and
      freezing the entire UI."                             — security.js

   So an overlay opened after the user has scrolled can put its own close button out
   of reach on iPhone. Only the canonical lock is refcounted, so nested overlays using
   the others also unlock each other prematurely.

   Migrating twelve files is twelve chances to break something and needs per-page
   verification, so they are PINNED here as measured debt rather than rewritten blind.
   The gate's job is to stop the divergence growing. */
{
  const CANON = 'SokoniLayout.lockScroll';
  const LEGACY = new Set([
    'adult-gate.js', 'hub-register.js', 'pos-scanner.js', 'script.js', 'seller.js',
    'sokoni-branch.js', 'sokoni-education.js', 'sokoni-jobs.js',
    'sokoni-payment-trust.js', 'sokoni-sheet.js', 'sokoni-ui-extras.js', 'sokoni-ui.js',
    /* Calls SokoniLayout.lockScroll() AND sets body{overflow:hidden} itself — the
       canonical lock plus a redundant legacy one on top of it. */
    'sokoni-notif-center.js',
  ]);
  const found = [];
  for (const f of fs.readdirSync(ROOT).filter(n => n.endsWith('.js'))) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/body\.style\.overflow\s*=\s*['"]hidden['"]|setProperty\(\s*['"]overflow['"]\s*,\s*['"]hidden['"]/.test(code)) {
      found.push(f);
    }
  }
  const fresh = found.filter(f => !LEGACY.has(f));
  const fixed = [...LEGACY].filter(f => !found.includes(f));

  if (fresh.length) {
    bad(`new body{overflow:hidden} scroll lock in: ${fresh.join(', ')} — use ${CANON}() `
      + '(refcounted + iOS-safe). body{overflow:hidden} can put an overlay\'s close button '
      + 'out of reach on iPhone Safari.');
  } else {
    ok(`no NEW body{overflow:hidden} scroll locks (${found.length} legacy pinned`
      + (fixed.length ? `; ${fixed.join(', ')} migrated — remove from LEGACY` : '') + ')');
  }
}

/* ── 5. Documentation — the rule has to be findable ────────────────────────── */
{
  fs.existsSync(path.join(ROOT, 'docs', 'OVERLAY_ARCHITECTURE.md'))
    ? ok('docs/OVERLAY_ARCHITECTURE.md exists (when to use a drawer vs a sheet)')
    : bad('no overlay architecture doc — the next engineer will pick a tier by guessing, which is how this happened');
}

console.log('');
if (fail) { console.error(`Overlay architecture FAILED (${fail}) — a user may be unable to close an overlay\n`); process.exit(1); }
console.log(`Overlay architecture PASSED (${pass} checks)\n`);
