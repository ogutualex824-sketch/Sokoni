/* SOKONI — platform navigation audit.   node scripts/nav-audit.js [--json out.json]

   Produces the map that a navigation redesign has to start from: what pages
   exist, how they link to each other, which are unreachable, which links go
   nowhere, and where the same concept is called different things.

   STATIC BY DESIGN, AND HONEST ABOUT IT.
   This reads markup. It cannot see routes built at runtime, and this codebase
   builds a lot of them — sokoni-nav-engine.js injects a bottom nav, and
   shared-header.js injects the top nav. Those are reported separately as
   "injected" rather than counted as page markup, because conflating the two
   produced a badly wrong picture on the first pass: pages that inject a nav
   looked navless.

   Every count here is a starting point for runtime checks, not a verdict. */
'use strict';
const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', '.claude', 'docs', 'scripts', 'functions', 'Temp']);
const pages = fs.readdirSync('.')
  .filter((f) => f.endsWith('.html') && fs.statSync(f).isFile())
  .sort();

/* Workspace inference from filename. Deliberately explicit rather than clever:
   a wrong guess here silently mis-parents a page in the IA. */
const WORKSPACE_RULES = [
  [/^(index|home)\b/,                                   'Home'],
  [/^(login|signup|register|auth|verify|reset)/,        'Auth'],
  [/^(seller|inventory|pos-|smartpos|merchant|shop-|store-|minishop)/, 'Seller'],
  [/^(banking|finance|financial|wallet|sfos|invoice|billing|payment)/, 'Banking'],
  [/^(healthcare|hospital|pharmacy|doctor|clinic|health)/, 'Healthcare'],
  [/^(car-hub|vehicle|garage|rider|driver|delivery|dispatch|logistics|navigation)/, 'Vehicle & Logistics'],
  [/^(property|rent|landlord|house)/,                   'Property'],
  [/^(job|career|freelance|digital-esoko)/,             'Jobs'],
  [/^(legal|lawyer|advocate)/,                          'Legal'],
  [/^(education|school|course|learn|academy)/,          'Education'],
  [/^(event|ticket|entertainment|movie|music)/,         'Entertainment'],
  [/^(travel|flight|hotel|tour)/,                       'Travel'],
  [/^(food|restaurant|kitchen|menu)/,                   'Food'],
  [/^(admin|super-admin|ops-|platform-|beta-|reliability|trust)/, 'Admin'],
  [/^(profile|account|settings|notification|message|chat)/, 'Profile & Comms'],
  [/^(category|product|checkout|cart|search|wishlist|marketplace)/, 'Marketplace'],
  [/^(services|service-|booking|venue)/,                'Services'],
];
const workspaceOf = (f) => {
  for (const [re, ws] of WORKSPACE_RULES) if (re.test(f)) return ws;
  return 'Unassigned';
};

/* A href built at runtime is not a dead link, it is a link this scanner cannot
   resolve. The first pass reported 77 dead links; most were template
   placeholders (${BASE}, '+r.href+') inside JS that emits markup. Reporting
   those as defects would have buried the ~12 real ones. */
const RUNTIME_BUILT = /\$\{|['"]\s*\+|\+\s*['"]|<%|\{\{/;

const exists = (target) => {
  if (!target) return false;
  if (RUNTIME_BUILT.test(target)) return null;      /* unresolvable, not dead */
  let t = target.split('#')[0].split('?')[0].trim();
  if (!t || /^(https?:|mailto:|tel:|javascript:|data:|sms:|whatsapp:)/i.test(t)) return null; /* external */
  if (t.startsWith('/')) t = t.slice(1);
  if (t === '' ) return true;                       /* "/" -> index */
  if (fs.existsSync(t)) return true;
  if (fs.existsSync(t + '.html')) return true;      /* firebase cleanUrls */
  return false;
};

const norm = (target) => {
  let t = target.split('#')[0].split('?')[0].trim();
  if (t.startsWith('/')) t = t.slice(1);
  if (t === '') return 'index.html';
  if (!t.endsWith('.html') && fs.existsSync(t + '.html')) return t + '.html';
  return t;
};

const report = {
  pages: {}, edges: [], deadLinks: [], orphans: [], navless: [],
  labels: {}, workspaces: {}, injected: {},
};

for (const f of pages) {
  const src = fs.readFileSync(f, 'utf8');
  const ws = workspaceOf(f);

  /* Nav components present in the page's own markup. */
  const hasBottomNav  = /class="[^"]*bottom-nav/.test(src);
  const hasTopNav     = /class="[^"]*(navbar|sk-top-nav|top-nav)/.test(src);
  const hasBack       = /(history\.back|goBack\(|←|&larr;|class="[^"]*back-btn)/.test(src);
  /* Injected at runtime — NOT the same as present in markup. */
  const injectsHeader = /shared-header\.js/.test(src);
  const injectsNav    = /sokoni-nav-engine\.js/.test(src);

  /* Outbound links. */
  const links = new Set();
  for (const m of src.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"/g)) links.add(m[1]);
  for (const m of src.matchAll(/location\.href\s*=\s*['"]([^'"]+)['"]/g)) links.add(m[1]);
  for (const m of src.matchAll(/location\.replace\(\s*['"]([^'"]+)['"]/g)) links.add(m[1]);

  const out = [];
  for (const l of links) {
    const ok = exists(l);
    if (ok === null) continue;              /* external — not our graph */
    if (ok === false) { report.deadLinks.push({ from: f, to: l }); continue; }
    const t = norm(l);
    if (t !== f) { out.push(t); report.edges.push([f, t]); }
  }

  /* Bottom-nav labels, for terminology consistency. */
  const navLabels = [];
  const navBlock = src.match(/<nav[^>]*class="[^"]*bottom-nav[^"]*"[\s\S]*?<\/nav>/);
  if (navBlock) {
    for (const m of navBlock[0].matchAll(/<span[^>]*>([^<]{2,20})<\/span>/g)) {
      const t = m[1].trim();
      if (t && !/^[\p{Emoji}\s]+$/u.test(t)) navLabels.push(t);
    }
  }
  navLabels.forEach((l) => { (report.labels[l] = report.labels[l] || []).push(f); });

  report.pages[f] = {
    workspace: ws, hasBottomNav, hasTopNav, hasBack,
    injectsHeader, injectsNav,
    outbound: out.length, navLabels,
  };
  (report.workspaces[ws] = report.workspaces[ws] || []).push(f);
  if (!hasBottomNav && !injectsNav && !injectsHeader) report.navless.push(f);
}

/* Reachability from the real entry points. */
const adj = {};
report.edges.forEach(([a, b]) => { (adj[a] = adj[a] || []).push(b); });
const ROOTS = ['index.html', 'login.html', 'signup.html'].filter((r) => report.pages[r]);
const seen = new Set(ROOTS);
const q = [...ROOTS];
while (q.length) {
  const cur = q.shift();
  for (const nx of (adj[cur] || [])) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
}
report.orphans = pages.filter((p) => !seen.has(p));

/* Inbound counts, to distinguish a true orphan from a deep-linked page. */
const inbound = {};
report.edges.forEach(([, b]) => { inbound[b] = (inbound[b] || 0) + 1; });

/* ── output ─────────────────────────────────────────────────────────────── */
const L = (s) => console.log(s);
L('SOKONI NAVIGATION AUDIT');
L('='.repeat(72));
L('pages scanned            : ' + pages.length);
L('internal links resolved  : ' + report.edges.length);
L('dead links               : ' + report.deadLinks.length);
L('unreachable from Home    : ' + report.orphans.length);
L('no nav of any kind       : ' + report.navless.length);

L('\n── WORKSPACES (inferred from filename) ──');
Object.entries(report.workspaces).sort((a, b) => b[1].length - a[1].length)
  .forEach(([ws, ps]) => L('  ' + ws.padEnd(22) + String(ps.length).padStart(4) + ' pages'));

L('\n── NAVIGATION COMPONENT INVENTORY ──');
const count = (pred) => pages.filter((p) => pred(report.pages[p])).length;
L('  bottom-nav in markup   : ' + count((p) => p.hasBottomNav));
L('  top nav in markup      : ' + count((p) => p.hasTopNav));
L('  injects shared-header  : ' + count((p) => p.injectsHeader));
L('  injects nav-engine     : ' + count((p) => p.injectsNav));
L('  has a back affordance  : ' + count((p) => p.hasBack));
L('  NEITHER markup nor injection: ' + report.navless.length);

L('\n── DEAD LINKS (target does not exist) ──');
if (!report.deadLinks.length) L('  none');
const byTarget = {};
report.deadLinks.forEach((d) => { (byTarget[d.to] = byTarget[d.to] || []).push(d.from); });
Object.entries(byTarget).sort((a, b) => b[1].length - a[1].length).slice(0, 25)
  .forEach(([t, froms]) => L('  ' + String(froms.length).padStart(3) + 'x  ' + t.slice(0, 46).padEnd(48) +
    'e.g. ' + froms.slice(0, 2).join(', ')));

L('\n── UNREACHABLE FROM HOME (top 30 by inbound=0) ──');
report.orphans.filter((o) => !inbound[o]).slice(0, 30)
  .forEach((o) => L('  ' + o.padEnd(40) + report.pages[o].workspace));
const deepLinked = report.orphans.filter((o) => inbound[o]).length;
L('  (' + deepLinked + ' more are linked from other orphans — reachable only if you already know the URL)');

L('\n── PAGES WITH NO NAVIGATION AT ALL (top 30) ──');
report.navless.slice(0, 30).forEach((n) => L('  ' + n.padEnd(40) + report.pages[n].workspace));

L('\n── BOTTOM-NAV TERMINOLOGY (same slot, different words) ──');
Object.entries(report.labels).sort((a, b) => b[1].length - a[1].length)
  .forEach(([label, ps]) => L('  ' + label.padEnd(20) + String(ps.length).padStart(4) + ' pages'));

const jsonAt = process.argv.indexOf('--json');
if (jsonAt > -1 && process.argv[jsonAt + 1]) {
  fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(report, null, 2));
  L('\nwrote ' + process.argv[jsonAt + 1]);
}
