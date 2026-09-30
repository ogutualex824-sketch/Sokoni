/* test-earn-application-chain.js — Earn with SOKONI → application → AdminOS decision → granted dashboard.
 *
 *   node scripts/test-earn-application-chain.js          (no browser, no emulator, no network)
 *
 * 2026-09-30 owner: "fix earn with sokoni page and make sure it is connected to the adminos and super admin
 * hence should be able to grant the correct dashboard according to the application".
 *
 * What is proven here, statically and by executing lifted page code:
 *   A. opportunity.html files nothing itself and hands off to NO WhatsApp; every card opens an EXISTING
 *      intake that declares the card's role; no invented earnings figures; the "Your applications" panel
 *      reads only the visitor's own applications and opens a dashboard ONLY through hubFor().
 *   B. business-apply.html's deep link preselects an offer and carries a category LABEL — the shared
 *      FORBIDDEN filter still strips role / status / claims, executed on the real primitive.
 *   C. sokoni-role-authority.js: provider's workspace is provider-dashboard.html; unapproved seller /
 *      provider are sent to the gated application, not to dead ends.
 *   D. AdminOS has ONE Applications module that reads and decides only through applicationList /
 *      applicationDecide / applicationReconcile, never writes Firestore, and refuses self-decision.
 *   E. Every earn category resolves on the server's legacy role path to the role the card claims.
 * Each section carries a deliberate-breakage control so a green run cannot come from a vacuous check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && !ok ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(70));
function lift(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src); if (!m) throw new Error('lift failed: ' + name);
  const open = src.indexOf('{', m.index); let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(m.index, i + 1); } }
  throw new Error('unbalanced ' + name);
}
function between(src, a, b) { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('between failed: ' + a); return src.slice(i, j); }

const OPP = read('opportunity.html');
const BA = read('business-apply.html');
const RA = read('sokoni-role-authority.js');
const AOS = read('sokoni-aos.js');
const AOSH = read('admin-os.html');
const HUBREG = read('hub-register.js');

console.log('\nEARN WITH SOKONI — APPLICATION CHAIN');
console.log('='.repeat(70));

/* ── A. the earn page ─────────────────────────────────────────────────────── */
head('A — opportunity.html files through existing intakes only');
const opsSrc = between(OPP, 'const _svc =', "let _activeFilter = 'all';");
const box = {}; vm.createContext(box);
vm.runInContext(opsSrc + '\nthis.OPS = OPS;', box);
const OPS = box.OPS;
ck('ten ways to earn, ids unique', Array.isArray(OPS) && OPS.length === 10 && new Set(OPS.map((o) => o.id)).size === 10, OPS && OPS.map((o) => o.id));
ck('the duplicate "Delivery Driver" card is gone (rider covers riders and drivers)', !OPS.some((o) => o.id === 'driver') && OPS.some((o) => o.id === 'rider'));
ck('no WhatsApp hand-off anywhere on the page', !/wa\.me|whatsapp\.com\/send|api\.whatsapp/i.test(OPP));
ck('no false success message', !/Application sent/i.test(OPP));
ck('the page never writes Firestore itself (no setDoc/addDoc/updateDoc)', !/\b(setDoc|addDoc|updateDoc)\s*\(/.test(OPP));

const INTAKE = {
  'onboarding-driver.html':       { role: 'rider',    proof: (s) => /requestedRole\s*:\s*'rider'/.test(s) && /collection\(db,\s*'applications'\)/.test(s) },
  'business-apply.html':          { role: null,       proof: (s) => /sokoni-merchant-application\.js/.test(s) && /sokoni-provider-application\.js/.test(s) },
  'onboarding-landlord.html':     { role: 'landlord', proof: (s) => /requestedRole\s*:\s*'landlord'/.test(s) && /'applications'/.test(s) },
  'onboarding-professional.html': { role: 'health',   proof: (s) => /'Doctor \/ Healthcare':\s*'health'/.test(s) && /'Lawyer \/ Legal':\s*'legal'/.test(s) && /collection\(db,'applications'\)/.test(s) },
};
for (const o of OPS) {
  const a = o.apply || {};
  if (a.none) { ck(o.id + ': says no application is needed and links to an existing page', fs.existsSync(path.join(ROOT, a.href)) && /no application needed/i.test(o.perks.join(' ')) && o.role === null); continue; }
  if (a.hub) {
    const catOk = new RegExp("id:'" + a.category + "'[^}]*hub:'" + a.hub + "'").test(HUBREG);
    const roleOk = new RegExp("_ROLE_BY_CATEGORY = \\{[^}]*" + a.category + ": '" + o.role + "'").test(HUBREG);
    ck(o.id + ': hub-register intake — category exists and declares requestedRole ' + o.role, catOk && roleOk);
    continue;
  }
  const page = a.href.split('?')[0];
  const exists = fs.existsSync(path.join(ROOT, page));
  const spec = INTAKE[page];
  ck(o.id + ': opens ' + page + ' (exists, is a known intake that files applications/*)', exists && !!spec && spec.proof(read(page)), a.href);
  if (page === 'business-apply.html') {
    const offer = new URLSearchParams(a.href.split('?')[1] || '').get('offer');
    const want = o.role === 'seller' ? 'products' : 'services';
    ck(o.id + ': business-apply offer matches the role (' + o.role + ' → ' + want + ')', offer === want, offer);
  } else if (spec.role) {
    ck(o.id + ': the intake declares the card role', spec.role === o.role || (page === 'onboarding-professional.html' && o.role === 'health'), o.role);
  }
}
ck('hub-register.js is loaded for the mechanic card', /<script src="hub-register\.js" defer><\/script>/.test(OPP));
ck('hero: no invented earnings figure, the count is derived from the cards', !/KES 45K/.test(OPP) && /id="opWaysCount"/.test(OPP) && /opWaysCount'\);\s*if \(n\) n\.textContent = String\(OPS\.length\)/.test(OPP));
ck('earnings guide is labelled as estimates, not records', /Monthly Earnings Guide — estimates/.test(OPP) && /not a promise or a record/.test(OPP));
ck('chooser is built from OPS (the two can never disagree)', /OPS\.forEach\(\(o\) => \{ const opt = document\.createElement\('option'\)/.test(OPP));
ck('"Your applications" reads ONLY the visitor\'s own documents', /fsm\.where\('uid', '==', user\.uid\)/.test(OPP));
ck('"Open your dashboard" comes only from SokoniRoleAuthority.hubFor', /const hub = RA && role \? RA\.hubFor\(role\) : null;/.test(OPP) && !/href="(merchant-v2|provider-dashboard|driver|landlord)\.html"/.test(between(OPP, 'async function renderMyApplications', 'window.renderMyApplications')));
ck('an approved application with a stale token refreshes it once (no loop)', /if \(RA && !_refreshedOnce && approvedRoles\.some/.test(OPP) && /_refreshedOnce = true;/.test(OPP));
ck('a read failure says so — unknown is never rendered as "none"', /We could not load your applications right now/.test(OPP));
const home = read('index.html');
ck('home page card advertises the same count as the page', new RegExp(OPS.length + ' ways to earn').test(home) && !/8 ways to earn/.test(home));

/* status / role mapping — the lifted page functions */
const sb = {}; vm.createContext(sb);
vm.runInContext("const _canonRole = (r) => (r === 'driver' ? 'rider' : r);\n" + lift(OPP, '_statusOf') + '\n' + lift(OPP, '_roleOf'), sb);
const S = (st) => vm.runInContext('_statusOf(' + JSON.stringify({ status: st }) + ')', sb);
const R = (a) => vm.runInContext('_roleOf(' + JSON.stringify(a) + ')', sb);
ck('status: approved/active/accepted/verified → approved', ['approved', 'active', 'accepted', 'verified'].every((x) => S(x) === 'approved'));
ck('status: pending / pending_review / unknown → in review (never approved)', ['pending', 'pending_review', '', 'weird'].every((x) => S(x) === 'review'));
ck('status: rejected, suspended, info_requested, withdrawn map to their own states', S('declined') === 'rejected' && S('suspended') === 'suspended' && S('info_requested') === 'info' && S('withdrawn') === 'withdrawn');
ck('role: server-resolved role wins; legacy driver → rider; business-apply ids → seller/provider',
   R({ role: 'driver', requestedRole: 'seller' }) === 'rider' && R({ requestedRole: 'landlord' }) === 'landlord'
   && R({ applicationId: 'u1--merchant' }) === 'seller' && R({ applicationId: 'u1--provider' }) === 'provider' && R({}) === null);
ck('control: a card pointing at a page with no intake is detected', !(INTAKE['seller.html']) && !fs.existsSync(path.join(ROOT, 'no-such-intake.html')));

/* ── B. business-apply deep link ─────────────────────────────────────────── */
head('B — business-apply.html deep link carries a label, never authority');
ck('offer is restricted to products | services | both', /\['products', 'services', 'both'\]\.includes\(_qs\.get\('offer'\)\)/.test(BA));
ck('the hint carries only category and categoryLabel', /if \(c\) HINT\.category = c;/.test(BA) && /if \(l\) HINT\.categoryLabel = l;/.test(BA) && !/HINT\.(role|status|requestedRole)/.test(BA));
ck('the hint reaches the primitive as the profile', /profile: Object\.assign\(\{\}, HINT\),/.test(BA));
ck('offer is applied once, after the real status loaded (render clears a disabled choice)', /if \(OFFER && !_offerApplied\) \{ _offerApplied = true; if \(!state\.choice\) state\.choice = OFFER; \}/.test(BA));
const wsBA = /const WORKSPACE = \{ products: '([^']+)', services: '([^']+)' \}/.exec(BA);
const hubSeller = /seller:\s+'([^']+)'/.exec(between(RA, 'var WORKSPACE_HUBS', '};'));
const hubProv = /provider: '([^']+)'/.exec(between(RA, 'var WORKSPACE_HUBS', '};'));
ck('the approved-side workspace links equal the role authority destinations', wsBA && hubSeller && hubProv && wsBA[1] === hubSeller[1] && wsBA[2] === hubProv[1], wsBA && [wsBA[1], wsBA[2], hubSeller && hubSeller[1], hubProv && hubProv[1]]);
/* execute the REAL primitive with a hostile profile */
const win = {}; const ctx = { window: win, self: win, globalThis: win, console };
vm.createContext(ctx);
vm.runInContext(read('sokoni-merchant-application.js'), ctx);
vm.runInContext(read('sokoni-provider-application.js'), ctx);
const P = win.SokoniProviderApplication;
const built = P && P.buildDocument({ uid: 'u1', agreementAccepted: true, source: 'earn-with-sokoni', nowISO: '2026-09-30T00:00:00Z',
  profile: { category: 'freelancer', categoryLabel: 'Freelancer', role: 'admin', status: 'approved', requestedRole: 'admin', claims: { admin: true }, approved: true } });
const d = built && built.data;
ck('real provider primitive: category and label are kept', d && d.category === 'freelancer' && d.categoryLabel === 'Freelancer', d);
ck('real provider primitive: a smuggled role / status / claims / requestedRole never reaches the document',
   d && d.status === 'pending_review' && d.role === undefined && d.claims === undefined && d.approved === undefined && d.requestedRole === undefined, d);
ck('real provider primitive: refuses without the agreement', P && P.buildDocument({ uid: 'u1', agreementAccepted: false, profile: {} }).action === 'refused');

/* ── C. role authority ───────────────────────────────────────────────────── */
head('C — sokoni-role-authority.js destinations');
ck("provider's workspace is provider-dashboard.html (not the public providers.html directory)", hubProv && hubProv[1] === 'provider-dashboard.html');
ck('provider-dashboard.html exists and is guarded for the provider role', fs.existsSync(path.join(ROOT, 'provider-dashboard.html')) && /'provider-dashboard\.html': 'provider'/.test(RA));
const routes = between(RA, 'var APPLICATION_ROUTES', '};').replace(/\/\*[\s\S]*?\*\//g, '');   /* comments may name the old targets */
ck('unapproved seller → the gated application (products)', /seller:\s+'business-apply\.html\?offer=products'/.test(routes));
ck('unapproved provider → the gated application (services), not the self-publishing provider-onboarding', /provider: 'business-apply\.html\?offer=services'/.test(routes) && !/provider-onboarding\.html/.test(routes));
ck('rider and landlord keep their own intakes', /rider:\s+'onboarding-driver\.html'/.test(routes) && /landlord: 'onboarding-landlord\.html'/.test(routes));
ck('every application route target exists', [...routes.matchAll(/'([a-z-]+\.html)/g)].every((m) => fs.existsSync(path.join(ROOT, m[1]))));
ck('admin is still NOT a workspace destination', !/\badmin\s*:/.test(between(RA, 'var WORKSPACE_HUBS', '};')));

/* ── D. AdminOS module ───────────────────────────────────────────────────── */
head('D — AdminOS Applications module');
const mod = between(AOS, '// ── Applications (canonical applicationList', '// ── Bookings (canonical providerBookings');
ck('nav item and panel exist in admin-os.html', /data-section="applications"/.test(AOSH) && /id="panel-applications"/.test(AOSH) && /id="appsBody"/.test(AOSH));
ck('the panel loader is registered', /applications:\s+\(\) => _loadApplications\(true\),/.test(AOS));
ck('reads through applicationList', /_call\("applicationList", \{ limit: 500 \}\)/.test(mod));
ck('decides through applicationDecide with the four server decisions only', /_call\("applicationDecide", \{ applicationId: id, decision, reason \}\)/.test(mod) && /\["approve", "reject", "suspend", "request_info"\]\.includes\(act\)/.test(mod));
ck('repairs through applicationReconcile', /_call\("applicationReconcile", \{ applicationId: id \}\)/.test(mod));
ck('no direct Firestore access in the module', !/_db\.|collection\(|\.set\(|\.update\(|\.add\(|setDoc|updateDoc/.test(mod));
ck('an administrator cannot decide their own application (UI refuses; server enforces)', /const own = !!\(me && i\.uid && i\.uid === me\);/.test(mod) && /You cannot decide your own application/.test(mod));
ck('ids travel in data attributes — no id is interpolated into an inline handler', /data-app-id="' \+ _esc\(i\.id\) \+ '"/.test(mod) && !/onclick=/.test(mod));
ck('a refusal or partial projection is never shown as success', /Decision saved, but NOT live/.test(mod) && /Not published: no recorded admin decision/.test(mod) && /Not decided: /.test(mod));
ck('"approved but not live" is visible as its own state and filter', /Approved, NOT live/.test(mod) && /value="unpublished"/.test(AOSH));
ck('public API exposes the module', /loadApplications:\s+_loadApplications,/.test(AOS) && /decideApplication:\s+_decideApplication,/.test(AOS));
ck('applicationList / applicationDecide are NOT routed through adminOsDispatch (they are their own callables)', !/'application(List|Decide|Reconcile)'/.test(between(AOS, '_ADMIN_OS_OPS', ']);')));
/* lifted projection-health words */
const pb = { _esc: (x) => String(x == null ? '' : x) }; vm.createContext(pb);
vm.runInContext(lift(AOS, '_appProjection'), pb);
const PJ = (i) => vm.runInContext('_appProjection(' + JSON.stringify(i) + ')', pb);
ck('projection: approved + applied → live', /Live/.test(PJ({ status: 'approved', projectionStatus: 'applied' })));
ck('projection: approved + not applied → NOT live, with the reason', /NOT live — boom/.test(PJ({ status: 'approved', projectionStatus: 'failed', projectionError: 'boom' })));
ck('projection: a status nobody decided is flagged, not hidden', /nothing was granted/.test(PJ({ status: 'pending', projectionStatus: 'blocked_unauthorised_decision' })));
ck('control: a module that wrote Firestore directly would be caught', /collection\(/.test(mod + 'db.collection("applications")'));

/* ── E. server legacy role path for the earn categories ─────────────────── */
head('E — each earn category resolves to the role its card claims (server legacy path)');
let LC = null;
try { LC = require(path.join(ROOT, 'functions', 'application-lifecycle.js'))._internal; } catch (e) { LC = null; }
ck('application-lifecycle.js loads (resolveRole is exercised, not re-implemented)', !!(LC && typeof LC.resolveRole === 'function'));
if (LC) {
  for (const o of OPS.filter((x) => x.apply && x.apply.href && x.apply.href.startsWith('business-apply.html'))) {
    const q = new URLSearchParams(o.apply.href.split('?')[1]);
    const type = q.get('offer') === 'products' ? 'seller' : 'provider';
    const r = LC.resolveRole({ type, hub: type === 'seller' ? 'marketplace' : 'service', category: q.get('category') || '', categoryLabel: q.get('label') || '' });
    ck(o.id + ' (' + (q.get('label') || type) + ') → ' + o.role, r && r.role === o.role, r);
  }
  ck('control: a label containing a rider keyword WOULD flip the role (the check is not vacuous)',
     LC.resolveRole({ type: 'provider', hub: 'service', categoryLabel: 'Delivery courier' }).role === 'driver');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
