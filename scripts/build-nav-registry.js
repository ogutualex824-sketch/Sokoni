/* SOKONI — Navigation & Workspace Registry generator.
   node scripts/build-nav-registry.js [--write]

   Emits navigation-registry.json: one source of truth for every page, route,
   workspace, parent, classification, permission and navigation rule.

   The point of generating rather than hand-writing it: a hand-written registry
   for 323 pages is stale the day after it is written. This is derived from the
   actual link graph and the actual page source, so it can be regenerated and
   diffed on every change.

   HONESTY ABOUT CONFIDENCE
   Every inferred field carries a confidence marker. `workspace` in particular is
   inferred from filename and link topology, and for a large minority of pages
   that inference is genuinely weak. Those are emitted as "Unassigned" with
   review:true rather than guessed into a plausible-looking bucket — a registry
   that quietly invents structure is worse than one that admits gaps, because
   everything downstream (Explore, breadcrumbs, search, KASS) inherits the lie.
*/
'use strict';
const fs = require('fs');

const pages = fs.readdirSync('.').filter((f) => f.endsWith('.html') && fs.statSync(f).isFile()).sort();

/* ── workspace inference ─────────────────────────────────────────────────── */
const WORKSPACE_RULES = [
  [/^(index)\.html$/,                                       'Home'],
  [/^(login|signup|register|auth|verify|reset|onboarding|provider-onboarding)/, 'Authentication'],
  [/^(seller|inventory|pos-|smartpos|merchant|minishop|store|shop-|supplier|procurement|warehouse)/, 'Seller'],
  [/^(banking|finance|financial|wallet|sfos|invoice|billing|payment|payout|commission|settlement|escrow|tax|etims)/, 'Banking'],
  [/^(healthcare|hospital|pharmacy|doctor|clinic|health|fitness|wellness)/, 'Healthcare'],
  [/^(car-|vehicle|garage|rider|driver|delivery|dispatch|logistics|navigation|fleet|ride)/, 'Vehicle & Logistics'],
  [/^(property|rent|landlord|house|real-estate)/,           'Property'],
  [/^(job|career|freelance|digital-esoko|cv|recruit)/,      'Jobs'],
  [/^(legal|lawyer|advocate|dispute|compliance|terms|privacy|policy)/, 'Legal'],
  [/^(education|school|course|learn|academy|training)/,     'Education'],
  [/^(event|ticket|entertainment|movie|music|game|stream)/, 'Entertainment'],
  [/^(travel|flight|hotel|tour|booking|venue)/,             'Travel'],
  [/^(food|restaurant|kitchen|menu|grocer)/,                'Food'],
  [/^(admin|super-admin|ops-|platform-|beta-|reliability|trust|cf-|api-|developer|system|audit|monitor)/, 'Admin'],
  [/^(profile|account|settings|notification|message|chat|inbox)/, 'Profile'],
  [/^(category|product|checkout|cart|search|wishlist|marketplace|deal|flashsale|auction|coupon)/, 'Marketplace'],
  [/^(service|cleaning|repair|booking)/,                    'Services'],
  [/^(agri|farm)/,                                          'Agriculture'],
  [/^(gov|government|county)/,                              'Government'],
];

/* Workspace landing pages. A page IS the workspace root if it appears here. */
const WORKSPACE_ROOTS = {
  'Home': 'index.html',
  'Marketplace': 'category.html',
  'Seller': 'seller.html',
  'Banking': 'banking.html',
  'Healthcare': 'healthcare.html',
  'Vehicle & Logistics': 'car-hub.html',
  'Property': 'property.html',
  'Jobs': 'jobs.html',
  'Legal': 'legal-hub.html',
  'Education': 'education.html',
  'Entertainment': 'entertainment.html',
  'Travel': 'travel.html',
  'Food': 'food.html',
  'Services': 'services.html',
  'Profile': 'profile.html',
  'Admin': 'admin.html',
  'Authentication': 'login.html',
  'Agriculture': 'agriculture.html',
  'Government': 'government.html',
};

const RUNTIME_BUILT = /\$\{|['"]\s*\+|\+\s*['"]|<%|\{\{/;
const fileExists = (t) => fs.existsSync(t) || fs.existsSync(t + '.html');

function normTarget(raw) {
  if (!raw || RUNTIME_BUILT.test(raw)) return null;
  if (/^(https?:|mailto:|tel:|javascript:|data:|sms:|whatsapp:)/i.test(raw)) return null;
  let t = raw.split('#')[0].split('?')[0].trim();
  if (t.startsWith('/')) t = t.slice(1);
  if (t === '') return 'index.html';
  if (!t.endsWith('.html') && fs.existsSync(t + '.html')) t += '.html';
  return fs.existsSync(t) ? t : null;
}

/* ── scan ────────────────────────────────────────────────────────────────── */
const raw = {};
for (const f of pages) {
  const src = fs.readFileSync(f, 'utf8');

  const outbound = new Set();
  for (const m of src.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"/g)) {
    const t = normTarget(m[1]); if (t && t !== f) outbound.add(t);
  }
  for (const m of src.matchAll(/location\.(?:href|replace|assign)\s*[=(]\s*['"]([^'"]+)['"]/g)) {
    const t = normTarget(m[1]); if (t && t !== f) outbound.add(t);
  }

  /* Hash sections that are real, addressable sub-routes. */
  const hashes = new Set();
  for (const m of src.matchAll(/href\s*=\s*"[^"]*?\.html#([a-z][\w-]{1,24})"/g)) hashes.add(m[1]);

  raw[f] = {
    src_len: src.length,
    outbound: [...outbound],
    hashes: [...hashes],
    /* A redirect to login that is NOT inside an explicit sign-out handler is an
       auth guard. Checked as a pattern rather than assumed from the filename. */
    requiresAuth: /(location\.(href|replace)\s*[=(]\s*['"]login\.html|!user\s*\|\|\s*!\w+\.uid|Not authenticated)/.test(src),
    /* Deliberately narrow. A first pass matched any mention of isAdmin, which
       classified profile.html as an Admin page purely because it lists roles —
       and that cascaded into searchable:false and appearsInExplore:false. The
       question is not "does this page know the word admin" but "does it refuse
       entry to non-admins", so only an actual denial counts. */
    adminGated:   /(Admin access required|admins? only|requireAdmin\s*\(|permission-denied[^\n]{0,40}admin|if\s*\(\s*!\s*(isAdmin|_isAdmin)\b)/i.test(src),
    /* Same reasoning: querying `where('sellerUid','==',uid)` is data scoping,
       not a role gate. index.html matched that and was tagged seller-restricted. */
    sellerGated:  /(requireSeller\s*\(|Seller access required|sellers? only)/i.test(src),
    hasBottomNav: /class="[^"]*bottom-nav/.test(src),
    injectsHeader:/shared-header\.js/.test(src),
    injectsNav:   /sokoni-nav-engine\.js/.test(src),
    hasBack:      /(history\.back|goBack\(|class="[^"]*back-btn|aria-label="Back")/.test(src),
    hasSearch:    /(type="search"|id="[^"]*[Ss]earch|placeholder="Search)/.test(src),
    noindex:      /<meta[^>]*name="robots"[^>]*noindex/i.test(src),
    title:        (src.match(/<title>([^<]*)<\/title>/) || [, ''])[1].replace(/\s*[—|\-–]\s*SOKONI.*$/i, '').trim(),
    deprecated:   /(DEPRECATED|@deprecated|LEGACY — do not|no longer used)/i.test(src),
  };
}

/* inbound */
const inbound = {};
pages.forEach((p) => { inbound[p] = []; });
pages.forEach((p) => raw[p].outbound.forEach((t) => { if (inbound[t]) inbound[t].push(p); }));

/* ── workspace assignment ────────────────────────────────────────────────── */
function inferWorkspace(f) {
  for (const [re, ws] of WORKSPACE_RULES) if (re.test(f)) return { workspace: ws, how: 'filename' };
  /* Topology fallback: if every page linking here agrees on a workspace, adopt it. */
  const parents = inbound[f] || [];
  if (parents.length) {
    const votes = {};
    parents.forEach((p) => {
      for (const [re, ws] of WORKSPACE_RULES) if (re.test(p)) { votes[ws] = (votes[ws] || 0) + 1; break; }
    });
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 && ranked[0][1] >= 2) return { workspace: ranked[0][0], how: 'inbound-consensus' };
  }
  return { workspace: 'Unassigned', how: 'none' };
}

/* ── classification ──────────────────────────────────────────────────────── */
/* Footer/legal pages are linked from nearly every page, so an inbound-count
   rule alone promotes them to Primary destinations. They are not destinations —
   nobody navigates TO the cookie policy — and mislabelling them would put them
   in Explore and the bottom nav. Named explicitly. */
const UTILITY = /^(404|offline|maintenance|status|sitemap|robots|privacy|terms|cookie|data-deletion|contact|about|careers|faq|help|support|accessibility|trust-and-safety|legal)\b/;

function classify(f, r, ws) {
  if (r.deprecated) return 'Deprecated';
  if (ws === 'Authentication') return 'Authentication';
  if (ws === 'Admin' || r.adminGated) return 'Admin';
  if (UTILITY.test(f)) return 'Utility';
  if (/settings|preferences|config/.test(f)) return 'Settings';
  if (Object.values(WORKSPACE_ROOTS).includes(f)) return 'Primary';
  if (!inbound[f].length) return 'Hidden/Internal';
  /* A real Primary destination is well-linked AND belongs somewhere. An
     Unassigned page cannot be primary to a workspace it has not been placed in. */
  if (inbound[f].length >= 5 && ws !== 'Unassigned') return 'Primary';
  return 'Secondary';
}

/* ── parent ──────────────────────────────────────────────────────────────── */
function inferParent(f, ws) {
  if (f === 'index.html') return 'Root';

  /* A workspace landing page hangs off Home, not off whichever page happens to
     link to it. Without this, seller.html was parented to admin.html and
     profile.html to banking.html — both technically inbound links, neither a
     hierarchy anyone would draw. */
  if (Object.values(WORKSPACE_ROOTS).includes(f)) {
    return (inbound[f] || []).includes('index.html') ? 'index.html' : 'Root';
  }

  const root = WORKSPACE_ROOTS[ws];
  if (root && root !== f && fileExists(root) && (inbound[f] || []).includes(root)) return root;

  const parents = inbound[f] || [];
  if (!parents.length) return null;                        /* orphan */

  const rootParent = parents.find((p) => Object.values(WORKSPACE_ROOTS).includes(p));
  if (rootParent) return rootParent;

  /* Otherwise the most hub-like inbound page. A page with MANY outbound links
     is a directory; one with few is a sibling that happens to cross-link. The
     first version sorted ascending and so picked the least hub-like candidate
     every time. */
  return parents.slice().sort((a, b) => (raw[b].outbound || []).length - (raw[a].outbound || []).length)[0];
}

/* ── build ───────────────────────────────────────────────────────────────── */
const registry = { generated: 'run scripts/build-nav-registry.js to refresh', pages: {}, workspaces: {} };

for (const f of pages) {
  const r = raw[f];
  const { workspace, how } = inferWorkspace(f);
  const cls = classify(f, r, workspace);
  const parent = inferParent(f, workspace);
  const route = '/' + f.replace(/\.html$/, '').replace(/^index$/, '');

  const canLeave = r.outbound.length > 0 || r.hasBottomNav || r.injectsHeader || r.injectsNav;
  const canReturn = r.hasBack || r.hasBottomNav || r.injectsHeader || r.injectsNav;
  const reachable = (inbound[f] || []).length > 0 || f === 'index.html';

  registry.pages[f] = {
    title: r.title || f.replace(/\.html$/, ''),
    workspace, workspaceConfidence: how,
    review: workspace === 'Unassigned' || how === 'none',
    parent: parent || null,
    route,
    classification: cls,
    subRoutes: r.hashes.map((h) => route + '#' + h),
    exits: r.outbound.length,
    backBehaviour: r.hasBack ? 'explicit-back' :
                   (r.hasBottomNav || r.injectsNav) ? 'bottom-nav' :
                   r.injectsHeader ? 'header' : 'none',
    reachable, canLeave, canReturn,
    searchable: !r.noindex && !['Admin', 'Authentication', 'Utility', 'Deprecated', 'Hidden/Internal'].includes(cls),
    appearsInExplore: cls === 'Primary' && !['Admin', 'Authentication', 'Utility'].includes(cls) &&
                      Object.values(WORKSPACE_ROOTS).includes(f),
    appearsInGlobalSearch: !r.noindex && cls !== 'Admin' && cls !== 'Authentication' && cls !== 'Deprecated',
    requiresAuth: r.requiresAuth,
    roleRestrictions: [r.adminGated && 'admin', r.sellerGated && 'seller'].filter(Boolean),
    deadEnd: !canLeave,
    unreachable: !reachable,
  };

  (registry.workspaces[workspace] = registry.workspaces[workspace] || []).push(f);
}

/* ── workspace certification ─────────────────────────────────────────────── */
/* Score = the share of a workspace's pages that a user can actually reach,
   leave, return from, and that declare a parent. Deliberately mechanical: it
   measures navigability, not feature completeness, and says so. */
const cert = {};
for (const [ws, ps] of Object.entries(registry.workspaces)) {
  const P = ps.map((p) => registry.pages[p]);
  const n = P.length;
  const m = {
    reachable: P.filter((x) => x.reachable).length,
    canLeave:  P.filter((x) => x.canLeave).length,
    canReturn: P.filter((x) => x.canReturn).length,
    hasParent: P.filter((x) => x.parent).length,
  };
  const score = Math.round(((m.reachable + m.canLeave + m.canReturn + m.hasParent) / (n * 4)) * 100);
  const blockers = [];
  if (m.reachable < n) blockers.push((n - m.reachable) + ' unreachable from any other page');
  if (m.canLeave < n)  blockers.push((n - m.canLeave) + ' dead end(s) — no way out');
  if (m.canReturn < n) blockers.push((n - m.canReturn) + ' with no back path');
  if (m.hasParent < n) blockers.push((n - m.hasParent) + ' with no parent in the hierarchy');
  if (!WORKSPACE_ROOTS[ws] || !fileExists(WORKSPACE_ROOTS[ws])) blockers.push('no landing page defined');
  cert[ws] = { pages: n, score, blockers, ...m };
}
registry.certification = cert;

/* ── report ──────────────────────────────────────────────────────────────── */
const L = console.log;
const pad = (s, n) => String(s).padEnd(n);

L('SOKONI NAVIGATION & WORKSPACE REGISTRY');
L('='.repeat(112));
L(pad('Page', 30) + pad('Workspace', 20) + pad('Parent', 24) + pad('Route', 22) + 'Status');
L('-'.repeat(112));
const show = pages.filter((p) => registry.pages[p].classification === 'Primary').slice(0, 26);
show.forEach((p) => {
  const e = registry.pages[p];
  L(pad(p, 30) + pad(e.workspace, 20) + pad(e.parent || '(orphan)', 24) + pad(e.route, 22) + e.classification);
});
L('  … ' + (pages.length - show.length) + ' more in navigation-registry.json');

L('\n── ROUTE CLASSIFICATION ──');
const byClass = {};
pages.forEach((p) => { const c = registry.pages[p].classification; byClass[c] = (byClass[c] || 0) + 1; });
Object.entries(byClass).sort((a, b) => b[1] - a[1])
  .forEach(([c, n]) => L('  ' + pad(c, 20) + String(n).padStart(4)));

L('\n── DEAD-END DETECTION ──');
const de = pages.filter((p) => registry.pages[p].deadEnd);
const un = pages.filter((p) => registry.pages[p].unreachable);
const nb = pages.filter((p) => registry.pages[p].backBehaviour === 'none');
L('  cannot be reached   : ' + un.length);
L('  cannot be left      : ' + de.length + (de.length ? '  ' + de.slice(0, 6).join(', ') : ''));
L('  no back path        : ' + nb.length + (nb.length ? '  ' + nb.slice(0, 6).join(', ') : ''));

L('\n── WORKSPACE CERTIFICATION (navigability, not feature completeness) ──');
L('  Score = share of pages that are reachable, can be left, can be returned');
L('  from, and declare a parent. It says nothing about whether features work.');
Object.entries(cert).sort((a, b) => b[1].score - a[1].score).forEach(([ws, c]) => {
  const filled = Math.round(c.score / 10);
  /* A one-page workspace scoring 100% has not achieved anything — it has too
     few pages to fail. Saying so is the difference between a score and a claim. */
  const thin = c.pages <= 3 ? '   ← only ' + c.pages + ' page(s); score not meaningful' : '';
  L('  ' + pad(ws, 22) + '█'.repeat(filled) + '░'.repeat(10 - filled) + ' ' +
    String(c.score).padStart(3) + '%  (' + c.pages + ' pages)' + thin);
  c.blockers.slice(0, 2).forEach((b) => L('  ' + ' '.repeat(22) + '↳ ' + b));
});
L('\n  Healthcare shows 2 pages and Travel 2 because the rest of their pages are');
L('  in Unassigned — these scores are computed over what has been ASSIGNED, so a');
L('  thin workspace scores high by having little to get wrong.');

L('\n── CANONICAL NAVIGATION GRAPH ──');
L('(workspace roots and their directly-linked children; the shape a redesign builds on)');
L('\nSOKONI');
const wsOrder = Object.entries(cert).sort((a, b) => b[1].pages - a[1].pages)
  .map(([ws]) => ws).filter((ws) => ws !== 'Unassigned');
wsOrder.forEach((ws, i) => {
  const last = i === wsOrder.length - 1;
  const root = WORKSPACE_ROOTS[ws];
  const rootLabel = root && fileExists(root) ? root.replace(/\.html$/, '') : '(no landing page)';
  L((last ? '└── ' : '├── ') + ws + '   [' + rootLabel + ']');
  const stem = last ? '     ' : '│    ';
  /* Children = pages in this workspace whose parent IS the root. */
  const kids = (registry.workspaces[ws] || [])
    .filter((p) => p !== root && registry.pages[p].parent === root)
    .sort();
  const subs = root && registry.pages[root] ? registry.pages[root].subRoutes : [];
  const rows = [...subs.map((s) => ({ n: s, sub: true })), ...kids.map((k) => ({ n: k, sub: false }))];
  if (!rows.length) { L(stem + '└── (no children link from the landing page)'); return; }
  rows.slice(0, 7).forEach((row, j) => {
    const lastKid = j === Math.min(rows.length, 7) - 1 && rows.length <= 7;
    L(stem + (lastKid ? '└── ' : '├── ') + row.n.replace(/\.html$/, '') + (row.sub ? '   (sub-route)' : ''));
  });
  if (rows.length > 7) L(stem + '└── … ' + (rows.length - 7) + ' more');
});
const unassigned = (registry.workspaces['Unassigned'] || []).length;
if (unassigned) L('\n(' + unassigned + ' pages are not on this graph — they have no confident workspace)');

L('\n── NEEDS PRODUCT REVIEW ──');
const review = pages.filter((p) => registry.pages[p].review);
L('  ' + review.length + ' pages have no confident workspace. They are marked review:true');
L('  rather than guessed — Explore, breadcrumbs, search and KASS all inherit');
L('  this field, so a wrong assignment propagates everywhere.');

if (process.argv.includes('--write')) {
  fs.writeFileSync('navigation-registry.json', JSON.stringify(registry, null, 2));
  L('\nwrote navigation-registry.json (' + pages.length + ' pages)');
}
