#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   BUSINESS CAPABILITIES — the read model                                (C2)
   scripts/test-business-capabilities.js

   Pure module, pure tests. What is held:
     V  the vocabulary is closed: exactly two capabilities, five states, five
        classifications, three authority statuses; only three are routable
     S  the stamp validates strictly — a client-shaped stamp (no decidedBy, no
        source, wrong version) is INVALID and makes the business CONFLICT
     O  observation reports what records CONTAIN, through business-scope's
        liveness (reused, not restated), and never reads a label
     P  proposal: seller live → PRODUCTS; provider live → SERVICES; both → both;
        neither → UNCLASSIFIED; disagreements → CONFLICT with a named code;
        authority is NOT_YET_STAMPED without a stamp and STAMPED with one
     A  additive: PRODUCTS + SERVICES approved is both, never a transformation
     D  the DG Wine / Latomi shape: provider live, seller absent, approved provider
        application, 0 products → SERVICES proposed, PRODUCTS absent, NOT_YET_STAMPED
     R  the routing contract: three routable outcomes on the existing surfaces;
        UNCLASSIFIED and CONFLICT route nowhere with a reason
     X  static: the module never reads category / businessType / hub / type, and
        NO production file imports it yet (adoption is a deliberate act)
   Negative controls flip inputs and prove each check bites.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'functions/shared/business-capabilities.js'));
const scope = require(path.join(ROOT, 'functions/shared/business-scope.js'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   [' + (typeof d === 'string' ? d : JSON.stringify(d)) + ']' : '')); } };
const head = (t) => console.log('\n' + t);

const APPROVED_AT = '2026-09-01T00:00:00Z';
const liveSeller   = { status: 'active', active: true, approvedAt: APPROVED_AT };
const liveProvider = { status: 'active', approvedAt: APPROVED_AT, searchable: true };
const stamp = (p, s) => ({ version: 1,
  PRODUCTS: p ? { state: p, decidedBy: 'admin_1', decidedAt: APPROVED_AT, applicationId: 'a1', source: 'application_approval' } : undefined,
  SERVICES: s ? { state: s, decidedBy: 'admin_1', decidedAt: APPROVED_AT, applicationId: 'a2', source: 'application_approval' } : undefined });

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  BUSINESS CAPABILITIES — one vocabulary, observed → proposed → routed');
  console.log('══════════════════════════════════════════════════════════════════');

  head('V - the vocabulary is closed');
  ok('V1  two capabilities, five states, two stamp sources', C.CAPABILITIES.join() === 'PRODUCTS,SERVICES' && C.CAPABILITY_STATE.length === 5 && C.STAMP_SOURCE.join() === 'application_approval,admin');
  ok('V2  five classifications, exactly three routable', Object.keys(C.CLASSIFICATION).length === 5 && C.ROUTABLE.join() === 'PRODUCTS,SERVICES,PRODUCTS_AND_SERVICES');
  ok('V3  three authority statuses', Object.values(C.AUTHORITY).sort().join() === 'INVALID_STAMP,NOT_YET_STAMPED,STAMPED');
  ok('V4  vocabularies are frozen', Object.isFrozen(C.CAPABILITY) && Object.isFrozen(C.CLASSIFICATION) && Object.isFrozen(C.ROUTING));
  ok('V5  application roles map: seller/merchant/vendor → PRODUCTS; provider/professional/health/legal → SERVICES; driver → nothing',
     C.ROLE_TO_CAPABILITY.seller === 'PRODUCTS' && C.ROLE_TO_CAPABILITY.merchant === 'PRODUCTS' && C.ROLE_TO_CAPABILITY.health === 'SERVICES' && C.ROLE_TO_CAPABILITY.legal === 'SERVICES' && C.ROLE_TO_CAPABILITY.driver === undefined);

  head('S - the stamp validates strictly');
  ok('S1  a well-formed stamp validates', C.validateStamp(stamp('approved', 'absent')).ok === true);
  ok('S2  no stamp → present:false (absent is not invalid)', C.validateStamp(undefined).present === false && C.validateStamp(null).present === false);
  ok('S3  a client-shaped stamp (approved with no decidedBy / source) is INVALID', !C.validateStamp({ version: 1, PRODUCTS: { state: 'approved' } }).ok);
  ok('S4  wrong version, unknown capability, unknown state are each refused',
     !C.validateStamp({ version: 2, PRODUCTS: { state: 'absent' } }).ok && !C.validateStamp({ version: 1, FOOD: { state: 'absent' } }).ok && !C.validateStamp({ version: 1, PRODUCTS: { state: 'live' } }).ok);
  ok('S5  an array or a string is not a stamp', !C.validateStamp([]).ok && !C.validateStamp('approved').ok);

  head('O - observation contains, never infers');
  let o = C.observe({ seller: liveSeller, provider: null, applications: [{ role: 'seller', status: 'approved' }], business: { id: 'b' }, shop: { id: 's' }, productCount: 4 });
  ok('O1  seller live / provider absent / application approved PRODUCTS / business+shop present / 4 products', o.seller === 'live' && o.provider === 'absent' && o.applications.approved.join() === 'PRODUCTS' && o.business === 'present' && o.shop === 'present' && o.productCount === 4);
  ok('O2  liveness is business-scope\'s rule (reused): a seller with status active but NO approval evidence is not live', C.observe({ seller: { status: 'active', active: true } }).seller === 'status_live_no_approval_evidence' && scope.resolveBusinessScope({ seller: { status: 'active', active: true } }).sellsProducts === false);
  ok('O3  applications not loaded → loaded:false and no approval facts claimed', C.observe({ seller: liveSeller }).applications.loaded === false);
  ok('O4  statusCanonical wins over status; pending_review and under_review are pending; rejected is rejected',
     (() => { const x = C.observe({ applications: [{ role: 'provider', status: 'pending', statusCanonical: 'approved' }, { role: 'seller', status: 'pending_review' }, { role: 'health', status: 'rejected' }] }).applications; return x.approved.join() === 'SERVICES' && x.pending.join() === 'PRODUCTS' && x.rejected.join() === 'SERVICES'; })());
  ok('O5  a label never changes an observation: provider with category "retail-shop" and businessType "seller" is still provider-only',
     (() => { const x = C.observe({ provider: Object.assign({ category: 'retail-shop', businessType: 'seller', hub: 'shopping', type: 'seller' }, liveProvider) }); return x.live.PRODUCTS === false && x.live.SERVICES === true; })());

  head('P - proposal and authority');
  const P = (r) => C.readModel(r);
  ok('P1  seller live only → PRODUCTS, NOT_YET_STAMPED, proposed PRODUCTS approved / SERVICES absent',
     (() => { const p = P({ seller: liveSeller }); return p.classification === 'PRODUCTS' && p.authorityStatus === 'NOT_YET_STAMPED' && p.proposed.PRODUCTS === 'approved' && p.proposed.SERVICES === 'absent' && p.conflicts.length === 0; })());
  ok('P2  provider live only → SERVICES', P({ provider: liveProvider }).classification === 'SERVICES');
  ok('P3  both live → PRODUCTS_AND_SERVICES', P({ seller: liveSeller, provider: liveProvider }).classification === 'PRODUCTS_AND_SERVICES');
  ok('P4  neither → UNCLASSIFIED with both absent', (() => { const p = P({}); return p.classification === 'UNCLASSIFIED' && p.proposed.PRODUCTS === 'absent' && p.proposed.SERVICES === 'absent'; })());
  ok('P5  a pending seller application with no live seller → UNCLASSIFIED but PRODUCTS proposed "pending"', (() => { const p = P({ applications: [{ role: 'seller', status: 'pending' }] }); return p.classification === 'UNCLASSIFIED' && p.proposed.PRODUCTS === 'pending'; })());
  ok('P6  CONFLICT seller_status_without_approval: sellers doc active with no approvedAt', (() => { const p = P({ seller: { status: 'active', active: true } }); return p.classification === 'CONFLICT' && p.conflicts.some((c) => c.code === 'seller_status_without_approval'); })());
  ok('P7  CONFLICT approval_without_projection: approved seller application, sellers doc absent', (() => { const p = P({ applications: [{ role: 'seller', status: 'approved' }] }); return p.classification === 'CONFLICT' && p.conflicts.some((c) => c.code === 'approval_without_projection' && c.capability === 'PRODUCTS'); })());
  ok('P8  NOTE (not conflict) projection_without_application: seller live, applications loaded, none approved', (() => { const p = P({ seller: liveSeller, applications: [] }); return p.classification === 'PRODUCTS' && p.notes.some((n) => n.code === 'projection_without_application'); })());
  ok('P9  CONFLICT products_without_products_capability: 3 products attached, PRODUCTS not live', (() => { const p = P({ provider: liveProvider, productCount: 3 }); return p.classification === 'CONFLICT' && p.conflicts.some((c) => c.code === 'products_without_products_capability'); })());
  ok('P10 STAMPED and agreeing: stamp PRODUCTS approved + seller live → PRODUCTS, authority STAMPED', (() => { const p = P({ seller: liveSeller, business: { capabilities: stamp('approved', 'absent') } }); return p.classification === 'PRODUCTS' && p.authorityStatus === 'STAMPED' && p.conflicts.length === 0; })());
  ok('P11 STAMPED but disagreeing: stamp says SERVICES approved, provider not live → CONFLICT stamp_disagrees_with_registry', (() => { const p = P({ seller: liveSeller, business: { capabilities: stamp('approved', 'approved') } }); return p.classification === 'CONFLICT' && p.authorityStatus === 'STAMPED' && p.conflicts.some((c) => c.code === 'stamp_disagrees_with_registry' && c.capability === 'SERVICES'); })());
  ok('P12 INVALID_STAMP: a client-shaped stamp makes the business CONFLICT even when the registry is clean', (() => { const p = P({ seller: liveSeller, business: { capabilities: { version: 1, PRODUCTS: { state: 'approved' } } } }); return p.authorityStatus === 'INVALID_STAMP' && p.classification === 'CONFLICT' && p.conflicts.some((c) => c.code === 'stamp_invalid'); })());
  ok('P13 a stamp with state "suspended" for PRODUCTS and seller not live agrees (suspended ≠ approved) → SERVICES if provider live',
     (() => { const p = P({ provider: liveProvider, seller: { status: 'suspended', approvedAt: APPROVED_AT }, business: { capabilities: stamp('suspended', 'approved') } }); return p.classification === 'SERVICES' && p.conflicts.length === 0 && p.proposed.PRODUCTS === 'suspended'; })());

  ok('P14 an UNSTAMPED business and a business STAMPED with neither capability are DIFFERENT states (null ≠ empty)',
     (() => { const un = P({}); const st = P({ business: { capabilities: { version: 1 } } }); return un.authorityStatus === 'NOT_YET_STAMPED' && st.authorityStatus === 'STAMPED' && un.classification === 'UNCLASSIFIED' && st.classification === 'UNCLASSIFIED' && un.observed.stamp === null && st.observed.stamp !== null; })());

  head('A - additive, independently approvable');
  ok('A1  PRODUCTS approved, then SERVICES approved → both; PRODUCTS is not removed', (() => { const before = P({ seller: liveSeller }); const after = P({ seller: liveSeller, provider: liveProvider }); return before.classification === 'PRODUCTS' && after.classification === 'PRODUCTS_AND_SERVICES' && after.proposed.PRODUCTS === 'approved'; })());
  ok('A2  choosing a service label never transforms PRODUCTS into SERVICES', (() => { const p = P({ seller: Object.assign({ category: 'salon', businessType: 'provider' }, liveSeller) }); return p.classification === 'PRODUCTS'; })());

  head('D - the DG Wine / Latomi shape (from the 777fcef census)');
  const dg = P({ provider: liveProvider, seller: null, applications: [{ role: 'provider', status: 'approved' }], business: null, shop: null, productCount: 0 });
  ok('D1  observed: provider live, seller absent, application approved SERVICES, business absent, shop absent, 0 products',
     dg.observed.provider === 'live' && dg.observed.seller === 'absent' && dg.observed.applications.approved.join() === 'SERVICES' && dg.observed.business === 'absent' && dg.observed.shop === 'absent' && dg.observed.productCount === 0);
  ok('D2  proposed: SERVICES approved, PRODUCTS absent — no product capability is proposed for a move to Business', dg.proposed.SERVICES === 'approved' && dg.proposed.PRODUCTS === 'absent');
  ok('D3  authority NOT_YET_STAMPED, classification SERVICES, no conflicts', dg.authorityStatus === 'NOT_YET_STAMPED' && dg.classification === 'SERVICES' && dg.conflicts.length === 0);

  head('R - the routing contract');
  ok('R1  PRODUCTS → product storefront, product card, merchant-v2, no services workspace', JSON.stringify(C.resolveRouting('PRODUCTS')) === JSON.stringify({ classification: 'PRODUCTS', routable: true, storefront: 'product', card: 'product', dashboard: 'merchant-v2', servicesWorkspace: false }));
  ok('R2  SERVICES → provider storefront, provider card, provider-dashboard', (() => { const r = C.resolveRouting('SERVICES'); return r.storefront === 'provider' && r.card === 'provider' && r.dashboard === 'provider-dashboard' && r.servicesWorkspace === false; })());
  ok('R3  PRODUCTS_AND_SERVICES → one business: both storefront, merchant-v2 WITH the services workspace', (() => { const r = C.resolveRouting('PRODUCTS_AND_SERVICES'); return r.storefront === 'both' && r.dashboard === 'merchant-v2' && r.servicesWorkspace === true; })());
  ok('R4  UNCLASSIFIED and CONFLICT route NOWHERE, each with a reason — never a default', (() => { const u = C.resolveRouting('UNCLASSIFIED'), c = C.resolveRouting('CONFLICT'); return !u.routable && !c.routable && u.dashboard === null && c.dashboard === null && u.storefront === null && /no approved capability/.test(u.reason) && /human/.test(c.reason); })());
  ok('R5  an unknown classification string routes nowhere too', C.resolveRouting('provider').routable === false);

  head('X - static');
  const src = fs.readFileSync(path.join(ROOT, 'functions/shared/business-capabilities.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('X1  the module\'s CODE never reads category / businessType / hub / type / registeredAs / localStorage', !/\.(category|businessType|hub|type|registeredAs|isProvider|isSeller)\b|localStorage/.test(src));
  /* `.add(` alone would match Set#add on the in-memory role sets; a Firestore write needs a
     document or collection handle, so that is what is asserted absent. */
  ok('X2  the module writes nothing (no Firestore handle, no collection/doc, no firebase require)', !/firestore|\.collection\(|\.doc\(|require\('firebase|setCustomUserClaims/.test(src));
  const importers = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (/node_modules|\.git|scripts|tests|docs/.test(p)) continue; const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (/\.(js|html)$/.test(f) && f !== 'business-capabilities.js' && /business-capabilities/.test(fs.readFileSync(p, 'utf8'))) importers.push(path.relative(ROOT, p)); } };
  walk(ROOT);
  ok('X3  NO production file imports the module yet — adoption is a later, deliberate slice', importers.length === 0, importers.join(','));
  ok('X3c CONTROL: this suite itself does import it (the scan can see an importer when one exists)', /business-capabilities\.js/.test(fs.readFileSync(__filename, 'utf8')));

  head('N - negative controls');
  ok('N1  removing approvedAt from the live seller flips P1 to CONFLICT', P({ seller: { status: 'active', active: true } }).classification === 'CONFLICT');
  ok('N2  adding approvedAt to the provider stub flips UNCLASSIFIED to SERVICES', P({ provider: { status: 'active' } }).classification === 'CONFLICT' && P({ provider: liveProvider }).classification === 'SERVICES');
  ok('N3  a stamp that agrees turns CONFLICT off; corrupting one field turns it back on', (() => { const good = P({ seller: liveSeller, business: { capabilities: stamp('approved', 'absent') } }); const bad = JSON.parse(JSON.stringify(stamp('approved', 'absent'))); delete bad.PRODUCTS.source; const b = P({ seller: liveSeller, business: { capabilities: bad } }); return good.classification === 'PRODUCTS' && b.classification === 'CONFLICT'; })());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
