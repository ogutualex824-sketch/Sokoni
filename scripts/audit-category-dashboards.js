#!/usr/bin/env node
/* audit-category-dashboards.js — every business category a user can REGISTER, run through the REAL authorities.
 *
 *   node scripts/audit-category-dashboards.js            # markdown report to stdout
 *   node scripts/audit-category-dashboards.js --json     # machine-readable
 *   node scripts/audit-category-dashboards.js --gate     # exit 1 while any registrable category is unclassified,
 *                                                          unrouted, or reaches a legacy intake (C4–C9 end gate)
 *
 * WHY
 * The owner's C4–C9 end gate: every category offered at the registration entry points must land, on approval, in a
 * working dashboard fitted to that category — none left out. This does not read the code by eye: it feeds each
 * registrable category through
 *   C1  functions/business-category.js   categoryFromApplication()  — what the business IS
 *   C2  functions/business-workspace.js  ROUTE_OF / modulesForProfile() — where it lands and what it is equipped with
 * exactly as the approval projection does (the application carries category, categoryLabel, hub, type:'business'
 * from hub-register.js).
 *
 * ENTRY POINTS SCANNED
 *   hub-register.js  CATS           — the "Register My Business" modal (index.html "List Any Business", services …)
 *   offer.html       provider tiles — "What Are You Offering?" (index.html "Start Selling")
 *
 * Read-only. No Firebase, no network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BCAT = require(path.join(ROOT, 'functions/business-category.js'));
const BW = require(path.join(ROOT, 'functions/business-workspace.js'));
const HCAT = require(path.join(ROOT, 'functions/healthcare-category.js'));

/* The REAL role resolver, extracted verbatim from application-lifecycle.js (that module needs firebase-admin; this
   function does not). Approval = resolveRole(app) → categoryFromApplication(app, role), and for role `health` the
   category IS healthcare-category's decision — exactly as projectProvider stamps providers.business. */
const resolveRole = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/application-lifecycle.js'), 'utf8');
  const head = 'function resolveRole(app) {';
  const s = src.indexOf(head);
  if (s < 0) { console.error('CANNOT RUN: resolveRole not found in application-lifecycle.js'); process.exit(2); }
  let d = 0, e = -1;
  for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } } }
  /* resolveRole lazily requires sibling modules ('./business-category' …): resolve them from functions/ */
  const req = (p) => require(p.startsWith('.') ? path.join(ROOT, 'functions', p) : p);
  return new Function('require', src.slice(s, e) + '\nreturn resolveRole;')(req);
})();
function approvalCategory(app) {
  const role = resolveRole(app).role;
  if (role === 'health') { const c = HCAT.categoryFromApplication(app); return { role, category: BCAT.isCategory(c) ? c : null, reason: 'healthcare-category' }; }
  const r = BCAT.categoryFromApplication(app, role);
  return { role, category: r.category, reason: r.reason };
}

const JSON_OUT = process.argv.includes('--json');
const GATE = process.argv.includes('--gate');
const die = (m) => { console.error('CANNOT RUN: ' + m); process.exit(2); };

/* ── entry point 1: hub-register.js CATS ─────────────────────────────── */
const hr = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
const catsBlock = (hr.match(/var CATS = \[([\s\S]*?)\n\s*\];/) || [])[1];
if (!catsBlock) die('hub-register.js CATS block not found');
const CATS = [];
const re = /\{\s*id:'([^']+)',\s*label:'((?:[^'\\]|\\.)*)',\s*hub:'([^']+)'/g;
let m; while ((m = re.exec(catsBlock))) CATS.push({ id: m[1], label: m[2].replace(/\\'/g, "'"), hub: m[3] });
if (CATS.length < 50) die('parsed only ' + CATS.length + ' hub-register categories — the parser no longer matches the file');

/* ── entry point 2: offer.html provider tiles ────────────────────────── */
const offer = fs.readFileSync(path.join(ROOT, 'offer.html'), 'utf8');
const OFFER = [...offer.matchAll(/href="(provider\.html\?cat=([a-z0-9-]+))"/g)].map((x) => ({ href: x[1], cat: x[2] }));
const OFFER_OTHER = [...new Set([...offer.matchAll(/href="([a-z0-9-]+\.html)(?:\?[^"]*)?"/g)].map((x) => x[1]))]
  .filter((h) => !/^(index|profile|my-orders|services|category)\.html$/.test(h));

/* ── run each registrable category through C1 and C2 ─────────────────── */
const rows = CATS.map((c) => {
  const app = { category: c.id, categoryLabel: c.label, hub: c.hub, type: 'business' };
  const r = approvalCategory(app);
  const c1 = r && r.category ? r.category : null;
  const route = c1 ? (Object.prototype.hasOwnProperty.call(BW.ROUTE_OF, c1) ? BW.ROUTE_OF[c1] : undefined) : null;
  const mods = c1 && route === 'provider-dashboard.html' ? BW.modulesForProfile(c1, {}) : null;
  const byState = {};
  if (mods) for (const [k, v] of Object.entries(mods)) (byState[v.state] = byState[v.state] || []).push(k);
  let verdict;
  /* ADMIN REVIEW ONLY (C1 ADMIN_REVIEW_ONLY, owner 2026-09-28): unclassified on purpose — AdminOS classifies it by
     hand at approval. An EXEMPTION with a documented authority, not a gap. */
  if (!c1 && (BCAT.ADMIN_REVIEW_ONLY || []).includes(c.id)) verdict = 'ADMIN_REVIEW';
  else if (!c1) verdict = 'UNCLASSIFIED';
  else if (route === undefined) verdict = 'NO_ROUTE_ENTRY';
  else if (route === null) verdict = 'UNROUTED';
  /* merchant-v2 runs on a SHOP, and approval provisions a shop only for the `seller` role — a category routed there
     under any other decided role would land on a dashboard with nothing behind it. */
  else if (route === 'merchant-v2.html' && r.role !== 'seller') verdict = 'ROUTED_NO_SHOP';
  else verdict = 'ROUTED';
  return { id: c.id, label: c.label, hub: c.hub, role: r.role, c1, c1Label: c1 ? BCAT.label(c1) : 'Unclassified', reason: r && r.reason, route, verdict,
    profile: c1 ? (BW.PROFILE_OF[c1] || null) : null,
    available: byState[BW.STATE.AVAILABLE] || [], notImplemented: byState[BW.STATE.NOT_IMPLEMENTED] || [] };
});

const by = (k) => rows.reduce((a, r) => ((a[r[k]] = a[r[k]] || []).push(r), a), {});
const verdicts = by('verdict');
const c1s = by('c1');
const summary = {
  registrable: rows.length,
  routed: (verdicts.ROUTED || []).length,
  unrouted: (verdicts.UNROUTED || []).length,
  unclassified: (verdicts.UNCLASSIFIED || []).length,
  adminReview: (verdicts.ADMIN_REVIEW || []).length,
  routedNoShop: (verdicts.ROUTED_NO_SHOP || []).length,
  noRouteEntry: (verdicts.NO_ROUTE_ENTRY || []).length,
  offerTilesToLegacyIntake: OFFER.length,
  c1CategoriesReached: Object.keys(c1s).filter((k) => k !== 'null').length,
  c1CategoriesTotal: BCAT.KEYS.length,
  c1NeverReached: BCAT.KEYS.filter((k) => !c1s[k]),
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, rows, offer: { providerTiles: OFFER, otherDestinations: OFFER_OTHER } }, null, 2));
} else {
  const out = [];
  out.push('# Registrable category → dashboard matrix (executed against C1 + C2)\n');
  out.push(`Source: hub-register.js CATS (${rows.length}) + offer.html tiles (${OFFER.length} to provider.html). Generated by scripts/audit-category-dashboards.js.\n`);
  out.push('## Summary\n');
  out.push(`- ROUTED to a working dashboard: **${summary.routed}** / ${rows.length}`);
  out.push(`- UNROUTED (approved, but no working dashboard): **${summary.unrouted}**`);
  out.push(`- UNCLASSIFIED (C1 cannot place it → hidden from discovery, no dashboard): **${summary.unclassified}**`);
  out.push(`- ROUTED TO MERCHANT-V2 WITHOUT A SHOP (decided role is not seller → no shop is provisioned): **${summary.routedNoShop}**`);
  out.push(`- ADMIN REVIEW ONLY (exempt: AdminOS classifies by hand — C1 ADMIN_REVIEW_ONLY): **${summary.adminReview}**`);
  out.push(`- NO ROUTE ENTRY (C1 category missing from ROUTE_OF): **${summary.noRouteEntry}**`);
  out.push(`- offer.html tiles that send registrants to the legacy provider.html intake: **${summary.offerTilesToLegacyIntake}**`);
  out.push(`- C1 categories reached from the register modal: ${summary.c1CategoriesReached} / ${summary.c1CategoriesTotal}; never reached: ${summary.c1NeverReached.join(', ') || 'none'}\n`);
  out.push('## By C1 category\n');
  out.push('| C1 category | Route | Profile | Registrable ids | Modules NOT_IMPLEMENTED |');
  out.push('|---|---|---|---|---|');
  for (const k of [...BCAT.KEYS, null]) {
    const list = c1s[k]; if (!list) continue;
    const r0 = list[0];
    out.push(`| ${k ? '`' + k + '` ' + BCAT.label(k) : '**UNCLASSIFIED**'} | ${r0.route === null ? '**UNROUTED**' : r0.route === undefined ? '—' : r0.route || '—'} | ${r0.profile || '—'} | ${list.map((r) => r.id).join(', ')} | ${r0.notImplemented.join(', ') || '—'} |`);
  }
  out.push('\n## Every registrable category\n');
  out.push("| id | label | hub | decided role | C1 | verdict | route |");
  out.push("|---|---|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.id} | ${r.label} | ${r.hub} | ${r.role} | ${r.c1 || "—"} (${r.reason}) | ${r.verdict} | ${r.route || "—"} |`);
  out.push('\n## offer.html ("What Are You Offering?")\n');
  out.push(`Provider tiles → legacy intake: ${OFFER.map((o) => o.cat).join(', ')}`);
  out.push(`\nOther destinations: ${OFFER_OTHER.join(', ')}`);
  console.log(out.join('\n'));
}

const gateFail = summary.unrouted + summary.unclassified + summary.noRouteEntry + summary.routedNoShop + summary.offerTilesToLegacyIntake;
if (GATE) process.exit(gateFail ? 1 : 0);
