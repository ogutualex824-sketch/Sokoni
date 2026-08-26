/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT SHELL CAPABILITY GATE
   ══════════════════════════════════════════════════════════════════════════════
   Answers the ONE question that decides whether the certified route registry can
   be adopted without breaking the shell that is live today:

     if BOTH shells load the SAME certified registry,
     does any route open a blank panel?

   The registry prefers `kind:'native'` for eighteen destinations. Merchant v1
   has renderers for nine of them. Nine preferences it cannot honour is not a
   theoretical risk: v1's renderNative() ends in `console.error(...)` with no
   render at all, so an unhonoured preference is literally an empty panel with a
   line in a console the merchant will never open. That is the defect this gate
   exists to make impossible.

   HOW CAPABILITY IS MEASURED — and why it is not asked for.
   Each shell's native renderer set is derived by PARSING ITS OWN SOURCE: the
   body of renderNative(), plus the keys of its MODULES table where it has one.
   A shell is never asked what it can render, because a declaration drifts from
   the code the moment someone deletes a renderer and forgets the manifest. The
   gate measures the code. If a shell later declares a capability it does not
   have, this parse still reports the truth and the assertion still fails.

   NEGATIVE CONTROLS.
   A gate that cannot fail proves nothing. Three controls run every time and the
   suite FAILS if any of them passes-by-accident:
     NC1  a shell with an empty renderNative must measure ZERO capabilities
     NC2  a native route with no renderer and no legacy equivalent must withhold
     NC3  removing a known-good fallback must be DETECTED as a blank risk
   NC3 is the one that matters: it re-runs the real assertion against a
   deliberately broken map and requires it to fail. If NC3 ever passes, the
   blank-panel assertion has become vacuous and every other PASS here is worthless.

   Run: node scripts/test-merchant-capability.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT SHELL CAPABILITY GATE');
console.log('='.repeat(78));

const C   = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const CAP = require(path.join(ROOT, 'sokoni-merchant-capability.js'));

/* ── source parsing ───────────────────────────────────────────────────────────
   Take a balanced `{...}` block starting at the first `{` at or after `from`.
   Brace counting, not a regex, because both shells nest object literals and
   template-free string concatenation several levels deep inside these bodies. */
function balancedBlock (src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/* The native renderer set a shell ACTUALLY has, read out of its own source. */
function measureCapabilities (src, label) {
  const sigAt = src.search(/function\s+renderNative\s*\(/);
  if (sigAt < 0) return { ids: [], found: false, viaModules: false, label };

  const body = balancedBlock(src, sigAt);
  const ids  = new Set();

  /* `if (id === 'orders')` / `else if (id === 'revenue' || id === 'analytics')`.
     Anchored on a standalone `id` so `byId[id].status === 'planned'` — a real
     line in v1 — cannot be mistaken for a route capability. */
  for (const m of body.matchAll(/(?:^|[^.\w])id\s*===\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);

  /* A shell may dispatch a whole family through a module table. */
  const viaModules = /\bMODULES\s*\[\s*id\s*\]/.test(body);
  if (viaModules) {
    const modAt = src.search(/var\s+MODULES\s*=\s*\{/);
    if (modAt >= 0) {
      const block = balancedBlock(src, modAt);
      for (const m of block.matchAll(/^\s{4}'?([a-z][\w-]*)'?\s*:\s*\{/gm)) ids.add(m[1]);
    }
  }
  return { ids: [...ids].sort(), found: true, viaModules, label };
}

const NATIVE_ROUTES = C.ROUTES.filter(r => r.kind === 'native');

/* Blank risk = the shell would mount NOTHING. `withhold` is not a blank: the
   route leaves navigation entirely and a deep-link gets a named panel. It is
   only a blank if a shell shows a control for a route it cannot mount. */
function evaluate (routes, caps, capabilityOverride) {
  const cap  = capabilityOverride || CAP;
  const rows = routes.map(r => cap.negotiate(r, caps));
  const nav  = cap.projectNav(routes, caps);
  const navIds = new Set(nav.map(r => r.id));
  const blanks = rows.filter(row =>
    row.outcome === 'withhold' ? navIds.has(row.id)          /* promised but unmountable */
                               : !(row.kind === 'native' || row.kind === 'seller' ||
                                   row.kind === 'pos' || row.kind === 'page' || row.kind === 'exit'));
  return { rows, nav, blanks };
}

/* ── 1. The two shells under test ─────────────────────────────────────────── */
console.log('\n1. Shell capability, measured from source (not declared)');

const SHELLS = [
  { key: 'v1', file: 'merchant.html',    note: 'the shell live on rc/combined' },
  { key: 'v2', file: 'merchant-v2.html', note: 'the certified native shell'    }
];

const measured = {};
SHELLS.forEach(s => {
  const src = R(s.file);
  const m   = measureCapabilities(src, s.key);
  measured[s.key] = m;
  check(s.key + ': renderNative() located in ' + s.file, m.found);
  check(s.key + ': native renderers measured', m.ids.length > 0,
        m.ids.length + ' -> ' + m.ids.join(','));
});

/* A shell that WIRES the layer has to tell it what it can render, and a running shell
   cannot parse its own source — so it declares a list. A declaration drifts the moment
   someone deletes a renderer and forgets the list. This is the assertion that stops
   that: the DECLARED list must equal the list measured out of renderNative() itself.
   Delete a renderer without updating the declaration and this fails. */
SHELLS.forEach(s => {
  const src = R(s.file);
  const decl = src.match(/var\s+NATIVE_CAPABILITY\s*=\s*\[([^\]]*)\]/);
  if (!decl) {
    check(s.key + ': declares no capability list (layer not wired — nothing to drift)', true, 'not wired');
    return;
  }
  const declared = [...decl[1].matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]).sort();
  check(s.key + ': DECLARED capability matches MEASURED renderNative()',
        declared.join(',') === measured[s.key].ids.join(','),
        declared.length === measured[s.key].ids.length
          ? declared.join(',')
          : 'declared=' + declared.join(',') + '  measured=' + measured[s.key].ids.join(','));
});

check('the two shells differ in capability (else there is nothing to negotiate)',
      measured.v1.ids.join(',') !== measured.v2.ids.join(','),
      'v1=' + measured.v1.ids.length + ' v2=' + measured.v2.ids.length);

const capsOf = key => ({ native: Object.fromEntries(measured[key].ids.map(i => [i, true])) });

/* ── 2. The negotiation surface is exactly the registry delta ─────────────── */
console.log('\n2. Negotiation surface is exactly the delta, and has not grown');

const v1 = evaluate(C.ROUTES, capsOf('v1'));
const v2 = evaluate(C.ROUTES, capsOf('v2'));

CAP.ALWAYS_NATIVE.forEach(id => {
  const a = v1.rows.find(r => r.id === id);
  const b = v2.rows.find(r => r.id === id);
  check('always-native route survives BOTH shells natively: ' + id,
        !!a && !!b && a.outcome === 'native' && b.outcome === 'native',
        a && b ? 'v1=' + a.outcome + ' v2=' + b.outcome : 'route missing');
});

const negotiated = v1.rows.filter(r => r.outcome !== 'native').map(r => r.id).sort();
/* 10 since Products became native in v2. A route only becomes negotiable when one shell
   renders it natively and the other does not; products was kind:'seller' — identical in
   both shells — until the merchant-v2 migration. */
check('exactly 11 routes need negotiation in v1', negotiated.length === 11, negotiated.join(','));

/* ── 3. PROOF 1 — v1 + certified registry: no blank native surfaces ──────── */
console.log('\n3. PROOF — Merchant v1 loading the CERTIFIED registry');

check('v1 opens NO blank panel on any of the ' + C.ROUTES.length + ' routes', v1.blanks.length === 0,
      v1.blanks.length ? v1.blanks.map(b => b.id).join(',') : '0 blanks / ' + C.ROUTES.length + ' routes');

const v1down = v1.rows.filter(r => r.outcome === 'downgrade').map(r => r.id).sort();
check('the 9 upgraded surfaces DOWNGRADE rather than blank',
      v1down.join(',') === 'customers,disputes,kra-tax,marketing,messages,products,receipts,shop,staff',
      v1down.join(','));

const v1hold = v1.rows.filter(r => r.outcome === 'withhold').map(r => r.id).sort();
check('only the 2 genuinely-new surfaces are withheld',
      v1hold.join(',') === 'inventory,sell', v1hold.join(','));
check('withheld routes are absent from every nav projection',
      v1hold.every(id => !v1.nav.some(r => r.id === id)),
      'nav = ' + v1.nav.length + ' of ' + C.ROUTES.length + ' routes');

/* A downgrade that points at a section seller.js does not have is a blank with
   extra steps — seller.js silently resolves an unknown page to Overview. */
const sellerJs  = R('seller.js');
const dashStart = sellerJs.indexOf('const DASH_PAGES = {');
const dashBlock = sellerJs.slice(dashStart, sellerJs.indexOf('\n};', dashStart));
const realSecs  = [...dashBlock.matchAll(/^\s{2}([a-zA-Z_][\w]*)\s*:/gm)].map(m => m[1]);
check('seller.js DASH_PAGES parsed', realSecs.length > 5, realSecs.length + ' sections');

v1.rows.filter(r => r.outcome === 'downgrade').forEach(r => {
  check('downgrade target is a REAL seller.js section: ' + r.id + ' -> "' + r.sec + '"',
        realSecs.includes(r.sec));
});

/* The sidebar is not the only projection. The Settings hub renders a card per id in
   `settings.links`, and the bottom nav renders its own four. A withheld route reached
   from either is the same defect as a withheld route in the sidebar — a control that
   promises a destination the shell cannot mount. projectNav() filters the sidebar; these
   two lists are built from their own arrays, so they are asserted directly. */
const withheldSet = new Set(v1.rows.filter(r => r.outcome === 'withhold').map(r => r.id));
const settingsLinks = (C.get('settings') || {}).links || [];
check('Settings hub links to no withheld route', settingsLinks.every(id => !withheldSet.has(id)),
      settingsLinks.filter(id => withheldSet.has(id)).join(',') ||
      settingsLinks.length + ' links, none withheld');
/* Resolved exactly as the shell resolves it: a slot whose preferred route is withheld uses
   its contract-declared fallback. The assertion is on the RESOLVED slot, because that is
   what the merchant's thumb actually lands on. */
const resolveSlot = b => (b.id !== '__more' && withheldSet.has(b.id) && b.fallback && !withheldSet.has(b.fallback))
  ? b.fallback : b.id;
const bottomIds = C.BOTTOM_NAV.map(resolveSlot).filter(id => id !== '__more');
/* A withheld slot is resolved one of TWO legitimate ways, and the thumb lands on a real
   destination either way:
     - `fallback`   substitute a route THIS shell can render;
     - `crossShell` hand the merchant to the shell that renders the real thing.
   The till slot deliberately uses the second. v1 has no native Sell renderer, and the
   capability layer's own rule is that falling `sell` back to POS "would quietly merge
   exactly what the platform has decided must stay apart". A handoff reaches Sell ITSELF,
   so it satisfies what this assertion is actually about — no control may promise a
   destination the merchant cannot arrive at. A slot with NEITHER is the real defect,
   and that is asserted separately below so removing both is still caught. */
const crossOf = (id) => ((C.get(id) || {}).crossShell) || null;
const deadSlots = bottomIds.filter(id => withheldSet.has(id) && !crossOf(id));
check('bottom nav points at no withheld route (fallback or cross-shell handoff)',
      deadSlots.length === 0,
      deadSlots.join(',') || bottomIds.map(id => id + (crossOf(id) ? ' -> ' + crossOf(id) : '')).join(', '));
/* The converse: a withheld slot resolved by NOTHING is a dead thumb. Without this, deleting
   both the fallback and the crossShell would silently satisfy the check above. */
const unresolved = C.BOTTOM_NAV.filter(b => b.id !== '__more' && withheldSet.has(b.id) &&
  !(b.fallback && !withheldSet.has(b.fallback)) && !crossOf(b.id));
check('every withheld bottom-nav slot resolves — never a dead thumb',
      unresolved.length === 0, unresolved.map(b => b.id).join(',') || 'all slots resolve');
/* A cross-shell target must be a CLEAN route: cleanUrls:true means '<page>.html' 301s, and
   a till must open in ONE navigation. */
C.BOTTOM_NAV.filter(b => crossOf(b.id)).forEach(b => {
  const t = crossOf(b.id);
  check('cross-shell target is a clean, single-navigation route: ' + b.id + ' -> ' + t,
        t.charAt(0) === '/' && t.indexOf('.html') === -1, t);
});
check('...and every resolved slot is a real, mobile-safe route',
      bottomIds.every(id => { const r = C.get(id); return r && r.mobile === true; }),
      bottomIds.filter(id => { const r = C.get(id); return !r || r.mobile !== true; }).join(',') || 'all 3 + More');
/* A fallback must only be DECLARED where it can be needed. A slot that no shell withholds
   carrying a fallback is dead configuration that will rot unnoticed. */
C.BOTTOM_NAV.filter(b => b.fallback).forEach(b => {
  check('bottom-nav fallback is declared only where a shell withholds the slot: ' + b.id,
        withheldSet.has(b.id), withheldSet.has(b.id) ? b.id + ' -> ' + b.fallback : 'unnecessary fallback');
});

/* ── 4. PROOF 2 — v2 + certified registry ─────────────────────────────────── */
console.log('\n4. PROOF — Merchant v2 loading the CERTIFIED registry');

['sell', 'inventory'].forEach(id => {
  const row = v2.rows.find(r => r.id === id);
  check('v2 renders ' + id + ' NATIVELY (the reason the registry exists)',
        !!row && row.outcome === 'native', row ? row.outcome : 'route missing');
});

check('v2 opens NO blank panel on any of the ' + C.ROUTES.length + ' routes', v2.blanks.length === 0,
      v2.blanks.length ? v2.blanks.map(b => b.id).join(',') : '0 blanks / ' + C.ROUTES.length + ' routes');

const v2unsupported = v2.rows.filter(r => r.outcome !== 'native');
check('v2 needs no downgrade for the 9 negotiated routes', v2unsupported.length === 0,
      v2unsupported.length ? v2unsupported.map(r => r.id + '=' + r.outcome).join(',') : 'full native coverage');

/* v2 must still be ABLE to downgrade — it is the shell that will meet a future
   registry naming a surface it has not ported. Prove the path works there too. */
const v2Degraded = evaluate(C.ROUTES, { native: { dashboard: true } });
check('v2 mechanism supports downgrade for an unported future surface',
      /* 8 with products: the LEGACY map is what makes a downgrade possible, and products
         gained an entry there when it became native. Counting the map's size is the point —
         a shell that cannot downgrade a surface it has not ported blanks instead. */
      v2Degraded.rows.filter(r => r.outcome === 'downgrade').length === 9,
      v2Degraded.rows.filter(r => r.outcome === 'downgrade').map(r => r.id).join(','));
const v2SellerKindOk = /m\.kind\s*===\s*'seller'/.test(R('merchant-v2.html'));
check('...and v2 really mounts kind:"seller" (a downgrade it cannot mount is a lie)',
      v2SellerKindOk);

/* ── 5. Negative controls — prove this gate can fail ──────────────────────── */
console.log('\n5. Negative controls (a gate that cannot fail proves nothing)');

/* NC1 — an empty shell must measure zero, not inherit anything. */
const NC1 = measureCapabilities('function renderNative (id) { }', 'nc1');
check('NC1  empty renderNative measures ZERO capabilities',
      NC1.found && NC1.ids.length === 0, NC1.ids.join(',') || 'none');

/* NC2 — withhold must actually fire for a route with no renderer and no legacy. */
const NC2 = CAP.negotiate({ id: 'holograms', kind: 'native', name: 'Holograms' }, { native: {} });
check('NC2  unknown native route withholds (not silently native)',
      NC2.outcome === 'withhold', NC2.outcome);

/* NC3 — the assertion in section 3 must FAIL when a fallback is removed.
   Rebuild the capability layer with `staff` missing from LEGACY, and require
   that v1 now reports staff as a blank risk. If this does NOT happen, the
   blank-panel assertion is vacuous and every PASS above is meaningless. */
const brokenLegacy = Object.assign({}, CAP.LEGACY);
delete brokenLegacy.staff;
const brokenCap = {
  LEGACY: brokenLegacy,
  negotiate (route, caps) {
    if (route.kind !== 'native') return { id: route.id, outcome: 'native', kind: route.kind };
    if (caps.native && caps.native[route.id]) return { id: route.id, outcome: 'native', kind: 'native' };
    if (Object.prototype.hasOwnProperty.call(brokenLegacy, route.id))
      return { id: route.id, outcome: 'downgrade', kind: 'seller', sec: brokenLegacy[route.id] };
    return { id: route.id, outcome: 'withhold', kind: null };
  },
  /* The realistic regression: the projection keeps showing the button because
     nobody told it the capability vanished. That is what turns a withhold into
     a blank, and it is what NC3 must catch. */
  projectNav: routes => routes.slice()
};
const NC3 = evaluate(C.ROUTES, capsOf('v1'), brokenCap);
check('NC3  removing the "staff" fallback IS detected as a blank risk',
      NC3.blanks.some(b => b.id === 'staff'),
      NC3.blanks.map(b => b.id).join(',') || 'NOT DETECTED — section 3 is vacuous');

/* ── summary ──────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(78));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);
