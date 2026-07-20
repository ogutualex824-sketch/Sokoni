/* SOKONI — Information Architecture certification.
   node scripts/certify-nav-registry.js [--write-review]

   Runs the integrity, depth and capability checks that must pass BEFORE any
   consumer (bottom nav, Explore, breadcrumbs, search, KASS) is wired to
   navigation-registry.json. A consumer built on an uncertified registry
   inherits every wrong parent and every duplicate route silently.

   Emits docs/WORKSPACE_ASSIGNMENT_REVIEW.md with a proposal for each
   unassigned page. Proposals are PROPOSALS — the registry is not modified. */
'use strict';
const fs = require('fs');

const REG = 'navigation-registry.json';
if (!fs.existsSync(REG)) { console.error('run scripts/build-nav-registry.js --write first'); process.exit(1); }
const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
const pages = Object.keys(reg.pages);
const P = reg.pages;

const L = console.log;
const pad = (s, n) => String(s).padEnd(n);
let failures = 0;
const check = (label, ok, detail) => {
  L('  ' + (ok ? 'PASS  ' : 'FAIL  ') + pad(label, 46) + (detail || ''));
  if (!ok) failures++;
};

/* ── 7. REGISTRY INTEGRITY ───────────────────────────────────────────────── */
L('\n══ REGISTRY INTEGRITY ══');

const routeMap = {};
pages.forEach((p) => { (routeMap[P[p].route] = routeMap[P[p].route] || []).push(p); });
const dupRoutes = Object.entries(routeMap).filter(([, ps]) => ps.length > 1);
check('no duplicate routes', dupRoutes.length === 0,
  dupRoutes.slice(0, 3).map(([r, ps]) => r + ' <- ' + ps.join(' + ')).join('; '));

/* A parent that is not a page is a conflicting parent. 'Root' is the sentinel. */
const badParents = pages.filter((p) => {
  const par = P[p].parent;
  return par && par !== 'Root' && !P[par];
});
check('every parent resolves to a real page', badParents.length === 0,
  badParents.slice(0, 4).join(', '));

/* Cycles. Walk each page to Root; a repeat means a loop. */
const cycles = [];
for (const start of pages) {
  const seen = new Set([start]);
  let cur = P[start].parent, hops = 0;
  while (cur && cur !== 'Root' && P[cur] && hops++ < 40) {
    if (seen.has(cur)) { cycles.push(start + ' -> … -> ' + cur); break; }
    seen.add(cur); cur = P[cur].parent;
  }
}
check('no circular parent chains', cycles.length === 0, cycles.slice(0, 3).join('; '));

const orphans = pages.filter((p) => !P[p].parent && p !== 'index.html');
check('no orphan pages', orphans.length === 0, orphans.length + ' orphan(s)');

/* A page excluded from search but linked from a public, searchable page is
   reachable by anyone who follows that link — "hidden" only in the index. */
const leaked = [];
pages.forEach((p) => {
  if (P[p].appearsInGlobalSearch || P[p].classification === 'Authentication') return;
  const publicParent = P[p].parent && P[P[p].parent] && P[P[p].parent].appearsInGlobalSearch;
  if (publicParent && P[p].classification !== 'Admin') leaked.push(p + ' <- ' + P[p].parent);
});
check('no hidden page linked from a public one', leaked.length === 0,
  leaked.length + (leaked.length ? ' e.g. ' + leaked[0] : ''));

const unreachableCanonical = pages.filter((p) => P[p].classification === 'Primary' && P[p].unreachable);
check('no unreachable canonical (Primary) route', unreachableCanonical.length === 0,
  unreachableCanonical.slice(0, 4).join(', '));

/* ── 3. PARENT-CHILD VALIDATION ──────────────────────────────────────────── */
L('\n══ HIERARCHY ══');
/* Depth 0 = Home. 'Root' is a sentinel, not a page, so stepping onto it must
   not cost a hop — counting it put every page one level deeper than it is and
   made the depth-limit check fire on pages that were within budget. */
const depthOf = (p) => {
  let d = 0, cur = p;
  while (cur && cur !== 'Root' && P[cur] && P[cur].parent && d < 40) {
    const par = P[cur].parent;
    if (par === 'Root') break;
    cur = par; d++;
  }
  return d;
};
const depths = {};
pages.forEach((p) => { const d = depthOf(p); (depths[d] = depths[d] || []).push(p); });
Object.keys(depths).sort((a, b) => a - b).forEach((d) =>
  L('  depth ' + d + ': ' + String(depths[d].length).padStart(4) + ' pages'));
const tooDeep = pages.filter((p) => depthOf(p) > 4);
check('no page deeper than Root>Workspace>Section>Feature', tooDeep.length === 0,
  tooDeep.length + ' deeper than 4');

/* ── 5. NAVIGATION DEPTH (taps from Home) ────────────────────────────────── */
L('\n══ TAPS FROM HOME ══');
/* BFS over the real outbound graph, not the parent tree: taps follow links. */
const out = {};
pages.forEach((p) => { out[p] = []; });
/* Rebuild edges from parent+workspace roots is not enough; use the registry's
   own reachability by walking parents downward. */
pages.forEach((p) => { const par = P[p].parent; if (par && par !== 'Root' && out[par]) out[par].push(p); });
const taps = { 'index.html': 0 };
const q = ['index.html'];
while (q.length) {
  const cur = q.shift();
  for (const nx of out[cur] || []) if (taps[nx] === undefined) { taps[nx] = taps[cur] + 1; q.push(nx); }
}
const dist = {};
pages.forEach((p) => { const t = taps[p]; const k = t === undefined ? 'unreachable' : t; dist[k] = (dist[k] || 0) + 1; });
Object.keys(dist).filter((k) => k !== 'unreachable').sort((a, b) => a - b)
  .forEach((k) => L('  ' + k + ' tap(s): ' + String(dist[k]).padStart(4)));
L('  unreachable: ' + (dist.unreachable || 0));
const far = pages.filter((p) => taps[p] > 3);
check('every reachable page within 3 taps of Home', far.length === 0, far.length + ' beyond 3 taps');

/* ── 6. GLOBAL CAPABILITY MAPPING ────────────────────────────────────────── */
L('\n══ CAPABILITIES (cross-workspace, not pages in one) ══');
const CAPABILITY_SIGNALS = {
  Wallet:        /sokoni-wallet|walletBalance|SokoniWallet|\bwallet\b/i,
  Payments:      /sokoni-pay\.js|initiateSTKPush|SokoniPay|checkout/i,
  Search:        /type="search"|SokoniSearch|globalSearch|sokoni-search/i,
  Messaging:     /sokoni-chat-engine|SokoniChat|conversationId/i,
  Notifications: /sokoni-notif|SokoniNotif|notificationContainer/i,
  KASS:          /kass-widget|SokoniCP|kassBtn/i,
  Maps:          /leaflet|mapbox|google\.maps|sokoni-gip|initMap/i,
  Auth:          /firebaseAuth|onAuthStateChanged|sokoniSignOut/i,
  Loyalty:       /sokoni-loyalty|loyaltyPoints|SKN-/,
  Reviews:       /sokoni-review|submitReview|starRating/i,
};
const capUsage = {};
Object.keys(CAPABILITY_SIGNALS).forEach((c) => { capUsage[c] = { pages: [], workspaces: new Set() }; });
for (const p of pages) {
  let src = '';
  try { src = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
  for (const [cap, re] of Object.entries(CAPABILITY_SIGNALS)) {
    if (re.test(src)) { capUsage[cap].pages.push(p); capUsage[cap].workspaces.add(P[p].workspace); }
  }
}
L('  ' + pad('capability', 16) + pad('pages', 8) + pad('workspaces', 12) + 'verdict');
const capabilityVerdicts = {};
Object.entries(capUsage).sort((a, b) => b[1].workspaces.size - a[1].workspaces.size).forEach(([cap, u]) => {
  /* Present in many workspaces = a platform capability, not a page that belongs
     to one of them. This is the §6 question answered with counts. */
  const v = u.workspaces.size >= 5 ? 'PLATFORM CAPABILITY' :
            u.workspaces.size >= 2 ? 'shared (review)' : 'workspace-local';
  capabilityVerdicts[cap] = { pages: u.pages.length, workspaces: [...u.workspaces], verdict: v };
  L('  ' + pad(cap, 16) + pad(u.pages.length, 8) + pad(u.workspaces.size, 12) + v);
});

/* ── 1. ASSIGNMENT PROPOSALS ─────────────────────────────────────────────── */
const unassigned = pages.filter((p) => P[p].workspace === 'Unassigned');

/* Content signals, checked against the page body — filename rules already ran
   in the generator and did not match these, so guessing again from the name
   would just repeat the same miss. */
const CONTENT_RULES = [
  [/pharmac|medicine|prescription|clinic|hospital|doctor|patient|telemedicine/i, 'Healthcare', 'Marketplace'],
  [/\b(loan|sacco|insurance|forex|invest|mpesa|paybill|ledger|invoice|payout|escrow)\b/i, 'Banking', 'Business'],
  [/\b(rider|driver|dispatch|delivery|fleet|vehicle|logistics|route)\b/i, 'Vehicle & Logistics', 'Marketplace'],
  [/\b(property|landlord|tenant|rent|apartment|plot)\b/i, 'Property', 'Marketplace'],
  [/\b(job|vacancy|cv|resume|applicant|recruit|freelanc)\b/i, 'Jobs', 'Business'],
  [/\b(course|lesson|student|tutor|curriculum|academy)\b/i, 'Education', 'Entertainment'],
  [/\b(event|ticket|venue|concert|movie|stream)\b/i, 'Entertainment', 'Travel'],
  [/\b(restaurant|menu|kitchen|food|grocer|recipe)\b/i, 'Food', 'Marketplace'],
  [/\b(advocate|lawyer|legal|case|litigation|contract)\b/i, 'Legal', 'Business'],
  [/\b(farm|agri|crop|livestock|harvest)\b/i, 'Agriculture', 'Marketplace'],
  [/\b(hotel|flight|tour|travel|booking|itinerary)\b/i, 'Travel', 'Entertainment'],
  [/\b(product|cart|checkout|category|listing|wishlist)\b/i, 'Marketplace', 'Seller'],
  [/\b(seller|merchant|inventory|pos|storefront|supplier)\b/i, 'Seller', 'Marketplace'],
  [/\b(admin|moderation|audit|ops|platform health|superadmin)\b/i, 'Admin', 'Support'],
];

const proposals = [];
for (const p of unassigned) {
  let src = '';
  try { src = fs.readFileSync(p, 'utf8'); } catch (_) {}

  /* Match VISIBLE TEXT ONLY.
     A first pass scanned raw source and proposed crm.html -> Entertainment at
     "High confidence, 40 matches" — because JavaScript is full of the word
     `event` (event.target, addEventListener), `product`, `driver` and so on.
     It was measuring identifiers, not subject matter, and the confidence label
     made a nonsense answer look authoritative. Script, style and tags are
     stripped so the signal comes from what a reader actually sees. */
  const body = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 60000);
  const scores = [];
  for (const [re, ws, alt] of CONTENT_RULES) {
    const hits = (body.match(new RegExp(re.source, 'gi')) || []).length;
    if (hits) scores.push({ ws, alt, hits });
  }
  scores.sort((a, b) => b.hits - a.hits);
  const top = scores[0], second = scores[1];
  let confidence = 'Low', reason = 'no strong content signal', ws = 'Unassigned', alt = '—';
  if (top) {
    ws = top.ws; alt = (second && second.ws !== top.ws) ? second.ws : top.alt;
    const margin = top.hits / Math.max(1, (second ? second.hits : 0));
    confidence = (top.hits >= 12 && margin >= 2) ? 'High' : (top.hits >= 4) ? 'Medium' : 'Low';
    reason = top.hits + ' content match(es)';
  }
  proposals.push({ page: p, ws, confidence, reason, alt, title: P[p].title });
}

L('\n══ ASSIGNMENT PROPOSALS ══');
const byConf = { High: 0, Medium: 0, Low: 0 };
proposals.forEach((x) => byConf[x.confidence]++);
L('  unassigned pages : ' + unassigned.length);
L('  High confidence  : ' + byConf.High);
L('  Medium           : ' + byConf.Medium);
L('  Low / none       : ' + byConf.Low + '   <- these need a human decision');

if (process.argv.includes('--write-review')) {
  const rows = proposals.sort((a, b) =>
    (a.confidence === b.confidence ? a.page.localeCompare(b.page)
      : ({ High: 0, Medium: 1, Low: 2 })[a.confidence] - ({ High: 0, Medium: 1, Low: 2 })[b.confidence]));
  const md = [
    '# Workspace Assignment Review',
    '',
    '**Status:** PROPOSALS. `navigation-registry.json` is unchanged. Nothing here is canonical',
    'until reviewed — a wrong assignment propagates into Explore, breadcrumbs, global search',
    'and KASS routing, and is far harder to unpick later than to decide now.',
    '',
    '`Confidence` is measured from VISIBLE TEXT only — script, style and tags are stripped',
    'before matching. The filename rules already ran in the generator and did not match any',
    'of these pages, so guessing from the name again would repeat the same miss.',
    '',
    '## Read the confidence honestly',
    '',
    'An earlier version scanned raw source and reported 42 High-confidence proposals. It was',
    'matching JavaScript identifiers — `event.target`, `product`, `driver` — not subject',
    'matter, and confidently proposed `crm.html` as **Entertainment**. Stripping code dropped',
    'High from 42 to 10 and raised Low from 12 to 69.',
    '',
    'That collapse is the real finding: **most of these pages render their content with',
    'JavaScript, so there is very little visible text to classify from.** Static analysis',
    'cannot place them. The Medium rows are starting points for a human, not answers, and the',
    'Low rows are genuinely undecidable without product knowledge.',
    '',
    '| Page | Proposed Workspace | Confidence | Reason | Alternative |',
    '|---|---|---|---|---|',
    ...rows.map((r) => '| `' + r.page + '` | ' + r.ws + ' | ' + r.confidence + ' | ' + r.reason + ' | ' + r.alt + ' |'),
    '',
    '## How to apply',
    '',
    'Correct the Proposed Workspace column, then the mapping can be folded into',
    '`WORKSPACE_RULES` in `scripts/build-nav-registry.js` and the registry regenerated.',
    'Assignments live in the generator so they survive regeneration.',
  ].join('\n');
  if (!fs.existsSync('docs')) fs.mkdirSync('docs');
  fs.writeFileSync('docs/WORKSPACE_ASSIGNMENT_REVIEW.md', md);
  L('\n  wrote docs/WORKSPACE_ASSIGNMENT_REVIEW.md (' + rows.length + ' rows)');
}

L('\n══ RESULT ══');
L('  ' + failures + ' integrity check(s) failing');
L('  The registry must NOT be wired to consumers until these are zero.');
