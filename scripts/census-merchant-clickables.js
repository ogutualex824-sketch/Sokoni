#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT CLICKABLE CENSUS — every control, and where it goes
   ------------------------------------------------------------------------------
   The consolidation rule this enforces, in one line:

       EVERY BUTTON THAT WORKED BEFORE CONSOLIDATION STILL WORKS AFTER IT,
       AND OPENS ITS DESTINATION INSIDE THE SAME MERCHANT SHELL.

   Existing gates cover the ROUTES (test-merchant-routes), the CHIP BARS
   (test-merchant-actions), the DESTINATIONS in a browser (test-merchant-route-gate)
   and the SHELL BOUNDARY (test-merchant-shell-boundary). None of them enumerate the
   ordinary controls — the sidebar entries, quick-action cards, header actions and
   per-module buttons the merchant actually presses. A control can be deleted, or
   silently unbound, without moving any of those gates.

   This census enumerates every clickable DECLARATION across the shell and every
   surface it mounts, classifies where each one goes, and fails on three defects:

     DEAD ROUTE     a control navigates to a route id the registry does not resolve
                    -> the button looks fine and refuses on click
     UNBOUND ACT    a control declares data-act="x" and no handler in its own file
                    ever compares against 'x'  -> a button that does nothing
     SHELL ESCAPE   a shell-native surface navigates the document to another page
                    -> the whole merchant application is torn down and re-booted

   Static by design: it reads declarations, so it sees controls that never render
   for an unauthenticated harness (which is most of them). It is a LEDGER, not a
   substitute for the browser gate. Rendered-DOM coverage is test-merchant-route-gate.

   Section NEGATIVE CONTROLS shows each detector a defect it MUST catch. A detector
   that silently matched nothing would report a perfect score, which is how a gate
   becomes decorative.

     node scripts/census-merchant-clickables.js            # ledger + verdict
     node scripts/census-merchant-clickables.js --md       # markdown for docs/
     node scripts/census-merchant-clickables.js --summary  # counts only
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = process.argv.includes('--md');
const SUMMARY = process.argv.includes('--summary');

/* The registry is a browser global module; load it the way merchant.html would. */
global.window = {};
require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const C = global.window.SokoniMerchantRoutes;

const regErrs = C.validate();
if (regErrs.length) {
  console.error('registry does not validate — refusing to census a broken contract:');
  regErrs.forEach((e) => console.error('  · ' + e));
  process.exit(1);
}

const ROUTE_IDS = new Set(C.ROUTES.map((r) => r.id));
const resolves = (id) => !!C.resolve(id);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── Surfaces ─────────────────────────────────────────────────────────────────
   SHELL      merchant.html — owns the page. A document navigation here destroys
              the application, so shell escapes are judged strictly.
   NATIVE     sokoni-merchant-*.js actually loaded by the shell — rendered directly
              INTO the shell DOM. Same strictness: they share the shell's document.
   EMBEDDED   every kind:page / kind:seller / kind:pos destination in the registry.
              These live in an iframe, so a document navigation inside them replaces
              only their own pane. Reported, not failed. */
const SHELL = 'merchant.html';
const shellSrc = fs.readFileSync(path.join(ROOT, SHELL), 'utf8');

/* Only modules the shell actually loads. sokoni-merchant-success.js belongs to the
   standalone merchant-success.html; including it would attribute another page's
   login redirect to the shell. */
const NATIVE = fs.readdirSync(ROOT)
  .filter((f) => /^sokoni-merchant-.*\.js$/.test(f) && f !== 'sokoni-merchant-routes.js')
  .filter((f) => shellSrc.indexOf(f) >= 0);

const EMBEDDED = [...new Set(C.ROUTES
  .filter((r) => r.kind === 'page' || r.kind === 'seller' || r.kind === 'pos')
  .map((r) => (r.src ? r.src.split(/[?#]/)[0].replace(/^\//, '')
                     : (r.kind === 'pos' ? 'pos.html' : 'seller.html'))))]
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ── Extraction ───────────────────────────────────────────────────────────────
   Most merchant UI is emitted from JS string concatenation, so a DOM parser sees
   almost nothing. We match the declaration text itself, which survives being split
   across  '<button class="x' + cond + '" data-act="tab"' . */
function clickables(src) {
  const out = [];
  const re = /<(button|a)\b([^>]{0,400}?)(?:>|$)/gi;
  let m;
  while ((m = re.exec(src))) out.push({ tag: m[1].toLowerCase(), attrs: m[2], at: m.index });
  return out;
}

/* Attribute values in emitted markup may be delimited by real quotes or by
   backslash-escaped quotes inside a JS string literal. Accept both. */
function attr(attrs, name) {
  const m = new RegExp(name + '\\s*=\\s*\\\\?(["\'])([\\s\\S]*?)\\\\?\\1', 'i').exec(attrs);
  return m ? m[2] : null;
}

/* Route ids reached through the shell router, in every form the codebase uses:
   __mgo('x'), SokoniShell.go('x'), go('x') — with or without escaped quotes. */
const ROUTE_CALL = /(?:__mgo|SokoniShell\s*\.\s*go|\bgo)\s*\(\s*\\?["']([a-z0-9-]+)\\?["']/i;

function classify(ctl, attrsRead) {
  const attrs = ctl.attrs;
  const onclick = attr(attrs, 'onclick') || '';
  const href = attr(attrs, 'href');
  const target = attr(attrs, 'target');
  const actName = actionAttr(attrs, attrsRead || new Set(['data-act']));
  const act = actName ? attr(attrs, actName) : null;

  const rc = ROUTE_CALL.exec(onclick) || ROUTE_CALL.exec(attrs);
  if (rc) return { kind: 'route', to: rc[1] };

  if (href && /^(https?:)?\/\//i.test(href)) return { kind: 'external', to: href };
  if (target === '_blank')                   return { kind: 'external', to: href || '?' };
  if (href && /^(tel:|mailto:)/i.test(href)) return { kind: 'external', to: href };
  if (href && /^#/.test(href)) {
    const id = href.slice(1);
    return (ROUTE_IDS.has(id) || C.resolve(id)) ? { kind: 'route', to: id }
                                                : { kind: 'anchor', to: href };
  }
  if (href && /\.html?(\?|#|$)/i.test(href))  return { kind: 'document', to: href };
  if (act !== null && act !== undefined)      return { kind: 'act', to: act, attrName: actName };
  if (onclick)                                return { kind: 'handler', to: onclick.slice(0, 60) };
  return { kind: 'inert', to: null };
}

/* ── Binding attributes are DISCOVERED, never assumed ─────────────────────────
   The modules do not share one convention: sokoni-merchant-disputes-ui.js delegates on
   `data-act`, sokoni-merchant-tax-ui.js on `data-a` and `data-tab`. A detector carrying a
   hardcoded list of attribute names silently scores a whole module's controls as inert —
   which is how a real dead button hides behind a green gate.

   So for each file we derive the attributes it actually READS — via getAttribute('data-x'),
   .dataset.x, or a [data-x] selector — and treat exactly those as its binding vocabulary. */
function bindingAttrs(src) {
  const set = new Set();
  const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  let m;
  const getAttr = /getAttribute\s*\(\s*["'](data-[a-z0-9-]+)["']/gi;
  while ((m = getAttr.exec(src))) set.add(m[1].toLowerCase());
  const ds = /\.dataset\s*\.\s*([A-Za-z0-9_]+)/g;
  while ((m = ds.exec(src))) set.add('data-' + kebab(m[1]).toLowerCase());
  const sel = /\[\s*(data-[a-z0-9-]+)\s*[\]=]/gi;
  while ((m = sel.exec(src))) set.add(m[1].toLowerCase());
  return set;
}

/* Of the attributes a control declares, the ACTION is the one the file reads. `data-i`
   (a row index) and `data-t` (a tab payload) are read too, so prefer the conventional
   action names when several are present and fall back to the first read attribute. */
const ACTION_PREFERENCE = ['data-act', 'data-a', 'data-action', 'data-tab', 'data-t', 'data-view', 'data-nav'];
function actionAttr(attrs, attrsRead) {
  const declared = [];
  const re = /(data-[a-z0-9-]+)\s*=/gi;
  let m;
  while ((m = re.exec(attrs))) declared.push(m[1].toLowerCase());
  const usable = declared.filter((d) => attrsRead.has(d));
  if (!usable.length) return null;
  for (const p of ACTION_PREFERENCE) if (usable.indexOf(p) >= 0) return p;
  return usable[0];
}

/* A PASSTHROUGH read consumes the attribute as data rather than comparing it to a
   literal: `_state.aiType = this.dataset.type`, `var target = this.dataset.tab`. The
   assignment is the evidence — `===` and friends are excluded so a comparison is never
   mistaken for one. Such an attribute owes no literal anywhere in the file. */
function isPassthrough(src, attrName) {
  const camel = attrName.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const asgnDataset = new RegExp('[^=!<>]=\\s*[\\w$.\\[\\]]*\\.dataset\\.' + esc(camel) + '\\b');
  const asgnGetAttr = new RegExp('[^=!<>]=\\s*[\\w$.\\[\\]]*\\.getAttribute\\(\\s*["\']' +
                                 esc(attrName) + '["\']\\s*\\)');
  return asgnDataset.test(src) || asgnGetAttr.test(src);
}

/* An act is BOUND when its name appears in the same file somewhere that is not a
   declaration of that attribute — i.e. in a comparison, a switch case or a handler map. */
function actBound(src, act, attrName) {
  const decl = new RegExp((attrName || 'data-act') + '\\s*=\\s*\\\\?["\'][\\s\\S]*?\\\\?["\']', 'gi');
  const stripped = src.replace(decl, '');
  return new RegExp('(["\'`])' + esc(act) + '\\1').test(stripped);
}

/* A data-act whose value is COMPUTED — data-act="' + act + '" — names no literal to
   look up, so bindability cannot be decided statically. Counted and reported so it is
   never silently dropped, but not asserted against: flagging it would be a false
   positive, and the browser gate is what covers a computed control. */
const isDynamicAct = (v) => /[+`]|\$\{|\\?["']\s*\+/.test(v);

/* Mask HTML and JS comments with spaces, preserving every newline so reported line
   numbers stay true. Without this, PROSE describing a historical defect scores as the
   defect — merchant.html's auth-guard comment narrates a location.replace() that the
   shell does not perform. */
function maskComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/* ── Census ───────────────────────────────────────────────────────────────────*/
const surfaces = [];
const dead = [], unbound = [], escapes = [], dynamicActs = [], passthrough = [];

function census(file, zone) {
  const src = read(file);
  const ctls = clickables(src);
  const attrsRead = bindingAttrs(src);
  const counts = { route: 0, act: 0, handler: 0, document: 0, external: 0, anchor: 0, inert: 0 };
  const routesTo = new Set();
  const seenAct = new Set();
  const actValues = {};

  ctls.forEach((c) => {
    const d = classify(c, attrsRead);
    counts[d.kind]++;
    if (d.kind === 'route') {
      routesTo.add(d.to);
      if (!resolves(d.to)) dead.push({ file: file, to: d.to });
    }
    if (d.kind === 'act' && !seenAct.has(d.attrName + '=' + d.to)) {
      seenAct.add(d.attrName + '=' + d.to);
      if (isDynamicAct(d.to)) dynamicActs.push({ file: file, act: d.attrName + '="' + d.to + '"' });
      else (actValues[d.attrName] || (actValues[d.attrName] = [])).push(d.to);
    }
    if (d.kind === 'document' && zone !== 'EMBEDDED') escapes.push({ file: file, to: d.to });
  });

  /* ── Is a value DISPATCHED ON, or PASSED THROUGH? ────────────────────────────
     Two legitimate shapes read the same attribute:

       dispatch    switch (act) { case 'reload': … }          value compared to a literal
       passthrough _state.aiType = this.dataset.type;         value consumed as data

     Asserting "the literal must appear elsewhere" is only meaningful for the first.
     Applied to the second it flags every control in the file — minishop-admin.html's
     tab/range/type bars are all passthrough, and a naive check called all nine dead.

     Inferring the shape from the values themselves does not work: `analytics`, `share`
     and `customize` all occur incidentally as strings in minishop-admin.html, so "some
     values match" wrongly concludes the file dispatches and then reports the two that
     happen not to occur. The evidence has to be the READ, not the values.

     isPassthrough() looks for the attribute being ASSIGNED — `_state.aiType =
     this.dataset.type` — as opposed to compared. An assigned value is consumed as data
     and no literal is owed anywhere. Only when the read is not an assignment does the
     literal check apply, and then a missing literal is a genuinely unhandled control. */
  Object.keys(actValues).forEach((an) => {
    const vals = actValues[an];
    if (isPassthrough(src, an)) { passthrough.push({ file: file, attr: an, n: vals.length }); return; }
    vals.filter((v) => !actBound(src, v, an))
        .forEach((v) => unbound.push({ file: file, act: an + '="' + v + '"' }));
  });

  surfaces.push({ file: file, zone: zone, total: ctls.length, counts: counts,
                  routesTo: [...routesTo].sort(), acts: seenAct.size });
}

census(SHELL, 'SHELL');
NATIVE.forEach((f) => census(f, 'NATIVE'));
EMBEDDED.forEach((f) => census(f, 'EMBEDDED'));

/* Shell-level document navigation outside of any control (a bare location write).
   The registry's single `exit` route is the one legitimate document navigation in
   the merchant application; anything else tears the shell down. */
const bareNav = [];
maskComments(shellSrc).split('\n').forEach((line, i) => {
  if (!/location\s*\.\s*(href|assign|replace)\s*[=(]/.test(line)) return;
  if (/kind\s*===?\s*['"]exit['"]/.test(line)) return;                /* the sanctioned exit */
  bareNav.push({ line: i + 1, text: line.trim().slice(0, 100) });
});

/* ── Coverage: can the merchant actually REACH every route? ───────────────────
   A route is reachable three ways, and all three must be counted or the metric is
   noise. The shell renders its sidebar and bottom nav AS A PROJECTION of the registry
   (merchant.html:625-634 — CONTRACT.primary() + moreGroups(), CONTRACT.BOTTOM_NAV), so
   a route holding a nav position needs no hand-written control at all.

     NAV      holds a sidebar position or a bottom-nav slot
     CONTROL  a hand-written clickable declares it (quick-action card, header action)
     CALL     opened programmatically — router('minishop') behind the header card

   What this then catches is the real regression: a route that loses its nav position
   AND has no control AND is never called is a destination no merchant can open. */
const viaNav = new Set();
const addNav = (id) => { const x = C.resolve(id); if (x) viaNav.add(x); };
C.primary().forEach((r) => addNav(r.id));
if (typeof C.moreGroups === 'function') {
  C.moreGroups().forEach((g) => (g.routes || g.items || []).forEach((r) => addNav(r.id || r)));
}
C.more().forEach((r) => addNav(r.id));
C.BOTTOM_NAV.forEach((b) => addNav(b.route || b.id || b.to));

const viaControl = new Set();
surfaces.forEach((s) => s.routesTo.forEach((r) => { const x = C.resolve(r); if (x) viaControl.add(x); }));

/* Programmatic opens: __mgo('x'), SokoniShell.go('x'), and the router held in a local
   (`var router = window.__mgo || …; router('minishop')`). Comments masked so a route
   named only in prose does not count as reachable. */
const viaCall = new Set();
const CALL_ANY = /(?:__mgo|SokoniShell\s*\.\s*go|\brouter|\bgo)\s*\(\s*\\?["']([a-z0-9-]+)\\?["']/gi;
[SHELL].concat(NATIVE).forEach((f) => {
  const src = maskComments(read(f));
  let m; CALL_ANY.lastIndex = 0;
  while ((m = CALL_ANY.exec(src))) { const x = C.resolve(m[1]); if (x) viaCall.add(x); }
});

const reachable = new Set([...viaNav, ...viaControl, ...viaCall]);
const unreachable = C.ROUTES.map((r) => r.id).filter((id) => !reachable.has(id));

/* ── Negative controls ────────────────────────────────────────────────────────*/
const NEG = [
  ['dead-route detector catches an unknown route id',
   () => { const d = classify(clickables('<button onclick="__mgo(\'not-a-route\')">x</button>')[0]);
           return d.kind === 'route' && !resolves(d.to); }],
  ['dead-route detector does NOT flag a real route id',
   () => { const d = classify(clickables('<button onclick="__mgo(\'orders\')">x</button>')[0]);
           return d.kind === 'route' && resolves(d.to); }],
  ['unbound-act detector catches a handler-less act',
   () => !actBound('<button data-act="ghostact">x</button>', 'ghostact')],
  ['unbound-act detector does NOT flag a handled act',
   () => actBound('<button data-act="realact">x</button>; if (a === "realact") run();', 'realact')],
  ['shell-escape detector catches an internal page navigation',
   () => classify(clickables('<a href="pos.html">POS</a>')[0]).kind === 'document'],
  ['external links are not mistaken for shell escapes',
   () => classify(clickables('<a href="https://x.co/y.html">e</a>')[0]).kind === 'external'],
  ['binding attributes are discovered from the file, not assumed',
   () => { const b = bindingAttrs("el.getAttribute('data-a'); x.dataset.tabId; q('[data-act]')");
           return b.has('data-a') && b.has('data-tab-id') && b.has('data-act'); }],
  ['a control bound by data-a is classified as an act, not inert',
   () => { const b = bindingAttrs("el.getAttribute('data-a')");
           return classify(clickables('<button data-a="save">S</button>')[0], b).kind === 'act'; }],
  ['an attribute the file never reads does NOT count as a binding',
   () => classify(clickables('<button data-zz="save">S</button>')[0], new Set()).kind === 'inert'],
  ['the conventional action attribute wins over a payload attribute',
   () => { const b = new Set(['data-act', 'data-i']);
           return classify(clickables('<button data-i="3" data-act="open">o</button>')[0], b).attrName === 'data-act'; }],
  ['passthrough read is recognised from the assignment',
   () => isPassthrough('_state.aiType = this.dataset.type;', 'data-type')],
  ['a comparison is NOT mistaken for a passthrough assignment',
   () => !isPassthrough('if (el.dataset.act === "save") go();', 'data-act')],
  ['passthrough recognises a kebab attribute read as camelCase',
   () => isPassthrough('var v = el.dataset.tabId;', 'data-tab-id')],
  ['comment masking hides prose but keeps line numbers true',
   () => { const m = maskComments('a\n<!-- location.replace(1) -->\nb');
           return m.split('\n').length === 3 && !/location/.test(m); }],
  ['comment masking does NOT hide a real navigation',
   () => /location\.assign/.test(maskComments('x\nlocation.assign("/y");\n'))],
  ['computed data-act is recognised, not scored as unbound',
   () => isDynamicAct("' + act + '") && !isDynamicAct('reload')],
  ['route call is recognised through escaped quotes in emitted markup',
   () => { const d = classify(clickables('<a onclick="__mgo(\\\'orders\\\')">o</a>')[0]);
           return d.kind === 'route' && d.to === 'orders'; }],
];
const negFails = NEG.filter((n) => { try { return !n[1](); } catch (_) { return true; } });

/* ── Report ───────────────────────────────────────────────────────────────────*/
const tot = surfaces.reduce((a, s) => a + s.total, 0);
const zTot = (z) => surfaces.filter((s) => s.zone === z).reduce((a, s) => a + s.total, 0);
const badCount = dead.length + unbound.length + escapes.length + bareNav.length +
                 unreachable.length + negFails.length;

if (SUMMARY) {
  console.log('surfaces        ' + surfaces.length);
  console.log('clickables      ' + tot);
  console.log('  shell         ' + zTot('SHELL'));
  console.log('  native        ' + zTot('NATIVE'));
  console.log('  embedded      ' + zTot('EMBEDDED'));
  console.log('routes total    ' + C.ROUTES.length);
  console.log('routes reached  ' + reachable.size);
  console.log('dead routes     ' + dead.length);
  console.log('unbound acts    ' + unbound.length);
  console.log('shell escapes   ' + (escapes.length + bareNav.length));
  process.exit(badCount ? 1 : 0);
}

surfaces.sort((a, b) => b.total - a.total);

if (MD) {
  console.log('# Merchant Clickable Census');
  console.log('');
  console.log('> Generated by `node scripts/census-merchant-clickables.js --md`. Read-only.');
  console.log('> Static ledger of control DECLARATIONS. Rendered-DOM coverage is');
  console.log('> `test-merchant-route-gate.js --all`. Related: [[MERCHANT_2D2_QUEUE]] ·');
  console.log('> [[MERCHANT_ROUTE_MATRIX]] · [[MERCHANT_CAPABILITY_MAP]]');
  console.log('');
  console.log('**' + tot + ' controls** across **' + surfaces.length + ' surfaces** — ' +
    zTot('SHELL') + ' shell · ' + zTot('NATIVE') + ' native · ' + zTot('EMBEDDED') + ' embedded.');
  console.log('');
  console.log('| surface | zone | controls | route | act | handler | doc-nav | external |');
  console.log('|---|---|--:|--:|--:|--:|--:|--:|');
  surfaces.forEach((s) => {
    console.log('| `' + s.file + '` | ' + s.zone + ' | ' + s.total + ' | ' + s.counts.route + ' | ' +
      s.counts.act + ' | ' + s.counts.handler + ' | ' + s.counts.document + ' | ' + s.counts.external + ' |');
  });
  console.log('');
  console.log('## Verdict');
  console.log('');
  console.log('- dead routes: **' + dead.length + '**');
  console.log('- unbound acts: **' + unbound.length + '**');
  console.log('- shell escapes: **' + (escapes.length + bareNav.length) + '**');
  console.log('');
  console.log('## Route reachability');
  console.log('');
  console.log('**' + reachable.size + ' of ' + C.ROUTES.length +
              ' routes are reachable.** A merchant opens a route three ways, and all three');
  console.log('count — the shell renders its sidebar and bottom nav as a projection of the registry');
  console.log('(`merchant.html:625-634`), so a route holding a nav position needs no hand-written');
  console.log('control of its own:');
  console.log('');
  console.log('| channel | routes | meaning |');
  console.log('|---|--:|---|');
  console.log('| nav | ' + viaNav.size + ' | holds a sidebar position or a bottom-nav slot |');
  console.log('| control | ' + viaControl.size + ' | a hand-written clickable declares it |');
  console.log('| call | ' + viaCall.size + ' | opened programmatically, e.g. `router(\'minishop\')` |');
  console.log('');
  console.log('`minishop` is deliberately `tier:\'hidden\'` — it holds no sidebar row and is opened');
  console.log('from the header MiniShop card (`merchant.html:2967`), as its own route note records.');
  if (unreachable.length) {
    console.log('');
    console.log('**Unreachable — no nav position, no control, no call. A merchant cannot open these:**');
    console.log('');
    unreachable.forEach((id) => console.log('- `' + id + '`'));
  }
  process.exit(badCount ? 1 : 0);
}

console.log('\n\x1b[1mMERCHANT CLICKABLE CENSUS\x1b[0m');
console.log('  surfaces   ' + surfaces.length + '   clickables ' + tot +
            '  (shell ' + zTot('SHELL') + ' · native ' + zTot('NATIVE') +
            ' · embedded ' + zTot('EMBEDDED') + ')');
console.log('  routes     ' + reachable.size + '/' + C.ROUTES.length + ' reachable' +
            '  (nav ' + viaNav.size + ' · control ' + viaControl.size + ' · call ' + viaCall.size + ')');

console.log('\n\x1b[1mBY SURFACE\x1b[0m');
surfaces.forEach((s) => {
  console.log('  ' + String(s.total).padStart(4) + '  ' + s.zone.padEnd(9) + s.file +
    '   [route ' + s.counts.route + ' · act ' + s.counts.act + ' · handler ' + s.counts.handler +
    ' · doc ' + s.counts.document + ' · ext ' + s.counts.external + ']');
});

console.log('\n\x1b[1mDEFECTS\x1b[0m');
const line = (label, arr, fmt) => {
  console.log('  ' + (arr.length ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mPASS\x1b[0m') +
              '  ' + label + '  (' + arr.length + ')');
  arr.slice(0, 15).forEach((x) => console.log('          · ' + fmt(x)));
  if (arr.length > 15) console.log('          · … and ' + (arr.length - 15) + ' more');
};
line('dead routes   — control navigates to an unresolvable id', dead,
     (d) => d.file + ' -> "' + d.to + '"');
line('unbound acts  — data-act with no handler in its own file', unbound,
     (u) => u.file + ' -> ' + u.act);
console.log('  \x1b[36mINFO\x1b[0m  computed data-act — bindability not statically decidable  (' +
            dynamicActs.length + ')');
dynamicActs.forEach((d) => console.log('          · ' + d.file + ' -> ' + d.act));
line('shell escapes — shell/native surface navigates the document', escapes,
     (e) => e.file + ' -> ' + e.to);
line('bare shell navigation outside the sanctioned exit', bareNav,
     (b) => SHELL + ':' + b.line + '  ' + b.text);
line('unreachable   — route no merchant can open (no nav, no control, no call)',
     unreachable.map((id) => ({ id: id })), (u) => u.id);

console.log('\n\x1b[1mNEGATIVE CONTROLS\x1b[0m  (a detector that catches nothing must fail here)');
NEG.forEach((n) => {
  let good; try { good = !!n[1](); } catch (_) { good = false; }
  console.log('  ' + (good ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + '  ' + n[0]);
});


console.log('\n' + (badCount
  ? '\x1b[31mVERDICT: ' + badCount + ' defect(s)\x1b[0m'
  : '\x1b[32mVERDICT: clean — no dead route, no unbound control, no shell escape\x1b[0m') + '\n');
process.exit(badCount ? 1 : 0);
