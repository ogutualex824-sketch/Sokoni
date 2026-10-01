/* test-financial-partner-intake.js — the Banking Hub partner intake files ONE truthful request, and nothing more
 *
 *   node scripts/test-financial-partner-intake.js
 *
 *   P   sokoni-financial-partner-application.js over an in-memory store: what it writes, what it refuses
 *   W   business-apply.html ?offer=financial wiring (static)
 *   R   sokoni-role-authority.js routes the role (dashboard hub, page guard, intake route)
 *   E   ENUM PARITY with the server validator (functions/financial-partner-listing.js on the functions branch):
 *       a client list that drifted would let applicants pick values the server then refuses
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FPA = require(path.join(ROOT, 'sokoni-financial-partner-application.js'));
const MA = require(path.join(ROOT, 'sokoni-merchant-application.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };

function store(seed) {
  const data = Object.assign({}, seed || {}); const writes = [];
  return { data, writes,
    async get(c, id) { return data[c + '/' + id] ? JSON.parse(JSON.stringify(data[c + '/' + id])) : null; },
    async set(c, id, v) { writes.push(c + '/' + id); data[c + '/' + id] = Object.assign({}, data[c + '/' + id] || {}, v); } };
}
const GOOD = { institutionName: ' Mfano <b>Bank</b> Ltd ', institutionType: 'bank', services: ['LOANS', 'loans', 'NOPE', 'TAX'],
  description: 'Loans for SMEs.', county: 'nairobi', website: 'https://mfano.example.co.ke', businessEmail: 'Hi@Mfano.example.co.ke',
  businessPhone: '0712 345 678', licenceClaimed: 'CBK/1/2024' };

(async () => {
  console.log('\nFINANCIAL PARTNER INTAKE\n');
  console.log('  [P the submission primitive]');
  let s = store();
  let r = await FPA.submit({ uid: 'u1', fs: s, input: GOOD, agreementAccepted: true, nowISO: 'T' });
  const d = s.data['applications/u1--financial_partner'] || {};
  ck('P1  files applications/{uid}--financial_partner, pending_review', r.ok && s.writes.length === 1 && d.status === 'pending_review', r);
  ck('P2  declares requestedRole financial_partner and the institution type as category',
     d.requestedRole === 'financial_partner' && d.institutionType === 'BANK' && d.category === 'BANK' && d.categoryLabel === 'Bank', d);
  ck('P3  fields are cleaned: name plain text, services filtered, county / email / phone canonical',
     d.institutionName === 'Mfano Bank Ltd' && JSON.stringify(d.services) === '["LOANS","TAX"]' && d.county === 'Nairobi'
       && d.businessEmail === 'hi@mfano.example.co.ke' && d.businessPhone === '+254712345678', d);
  ck('P4  uid matches the account (the rule claimsOwner() needs it)', d.uid === 'u1');
  const FORBID = ['role', 'roles', 'approved', 'verified', 'licenceVerified', 'listingStatus', 'decidedBy', 'statusCanonical', 'projectionStatus', 'featured'];
  s = store();
  await FPA.submit({ uid: 'u2', fs: s, input: Object.assign({}, GOOD, { role: 'admin', verified: true, licenceVerified: true, listingStatus: 'approved', decidedBy: 'x' }), agreementAccepted: true });
  const d2 = s.data['applications/u2--financial_partner'] || {};
  ck('P5  smuggled role / verified / licenceVerified / listingStatus / decidedBy never reach the document', FORBID.every((k) => !(k in d2)), FORBID.filter((k) => k in d2));
  s = store();
  r = await FPA.submit({ uid: 'u3', fs: s, input: GOOD, agreementAccepted: false });
  ck('P6  no agreement → refused, nothing written', !r.ok && r.reason === 'agreement_not_accepted' && s.writes.length === 0, r.reason);
  s = store();
  r = await FPA.submit({ uid: 'u4', fs: s, input: Object.assign({}, GOOD, { institutionType: 'CASINO', services: ['X'], website: 'javascript:alert(1)', institutionName: 'A' }), agreementAccepted: true });
  ck('P7  invalid type / services / website / name → refused with a message per field, nothing written',
     !r.ok && r.reason === 'invalid_fields' && ['institutionType', 'services', 'website', 'institutionName'].every((k) => r.errors && r.errors[k]) && s.writes.length === 0, r.errors);
  ck('P7b http:// website refused', !!FPA.validate(Object.assign({}, GOOD, { website: 'http://mfano.example.co.ke' })).errors.website);
  ck('P7c 9 services → capped at 8', FPA.validate(Object.assign({}, GOOD, { services: FPA.SERVICES.map((x) => x[0]) })).profile.services.length === 8);
  s = store({ 'applications/u5--financial_partner': { status: 'pending_review', uid: 'u5' } });
  r = await FPA.submit({ uid: 'u5', fs: s, input: GOOD, agreementAccepted: true });
  const d5 = s.data['applications/u5--financial_partner'];
  ck('P8  an application in review may be corrected (merchant semantics: update), and stays pending', r.ok && r.action === 'update' && d5.status === 'pending_review' && !('resubmitCount' in d5), r);
  s = store({ 'applications/u6--financial_partner': { status: 'approved', uid: 'u6' } });
  r = await FPA.submit({ uid: 'u6', fs: s, input: GOOD, agreementAccepted: true });
  ck('P9  an approved partner cannot re-apply, and is pointed to the dashboard', !r.ok && r.reason === 'already_approved' && /dashboard/.test(r.message), r.message);
  s = store({ 'applications/u7--financial_partner': { status: 'rejected', uid: 'u7', resubmitCount: 1 } });
  r = await FPA.submit({ uid: 'u7', fs: s, input: GOOD, agreementAccepted: true, nowISO: 'T2' });
  ck('P10 a rejected applicant may resubmit; the count increments', r.ok && s.data['applications/u7--financial_partner'].resubmitCount === 2, r);
  ck('P11 CONTROL the forbidden list really is the merchant module\'s', MA.FORBIDDEN.includes('verified') && MA.FORBIDDEN.includes('role'));

  console.log('\n  [W business-apply.html ?offer=financial]');
  const BA = fs.readFileSync(path.join(ROOT, 'business-apply.html'), 'utf8');
  ck('W1  loads the primitive after its merchant dependency', BA.indexOf('src="sokoni-merchant-application.js"') > -1
     && BA.indexOf('src="sokoni-merchant-application.js"') < BA.indexOf('src="sokoni-financial-partner-application.js"'));
  ck('W2  financial mode is keyed on offer=financial only', /const FIN = _qs\.get\('offer'\) === 'financial';/.test(BA));
  ck('W3  status comes from the server-written listing (financialProviders), not the form', /getDoc\(doc\(db, 'financialProviders', uid\)\)/.test(BA));
  ck('W4  an approved listing opens the partner dashboard', BA.indexOf("const FIN_WORKSPACE = 'financial-partner-dashboard.html';") > -1);
  ck('W5  "approved but not listed" is stated, never shown as listed', /return 'blocked';/.test(BA) && /Approved, not listed/.test(BA));
  ck('W6  success is announced only after the write resolved', /if \(r && r\.ok\) say\('ok'/.test(BA));
  ck('W7  the licence field says it is self-declared and not verified', /self-declared, not verified by SOKONI/.test(BA));
  ck('W8  page still self-updates (sw-register)', /sw-register\.js/.test(BA));
  ck('W9  no wa.me hand-off introduced', !/wa\.me/.test(BA));

  console.log('\n  [R role routing]');
  /* Browser module: the same minimal globals test-role-authority.js installs; no token, so nothing is approved. */
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.sessionStorage = global.localStorage;
  global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = (o || {}).detail; } };
  global.document = { addEventListener() {}, dispatchEvent() { return true; } };
  global.window = { document: global.document, localStorage: global.localStorage, location: { replace() {} } };
  global.window.window = global.window;
  require(path.join(ROOT, 'sokoni-role-authority.js'));
  const RA = global.window.SokoniRoleAuthority;
  const RASRC = fs.readFileSync(path.join(ROOT, 'sokoni-role-authority.js'), 'utf8');
  ck('R1  financial_partner is a canonical client role', RA.CANONICAL_ROLES.indexOf('financial_partner') > -1);
  ck('R2  its workspace is financial-partner-dashboard.html', RA.WORKSPACE_HUBS && RA.WORKSPACE_HUBS.financial_partner === 'financial-partner-dashboard.html', RA.WORKSPACE_HUBS && RA.WORKSPACE_HUBS.financial_partner);
  ck('R3  the dashboard page is guarded for the role', RA.WORKSPACE_ROUTES['financial-partner-dashboard.html'] === 'financial_partner');
  ck('R4  an unapproved user is sent to the financial intake', RASRC.indexOf("financial_partner: 'business-apply.html?offer=financial'") > -1);
  ck('R5  hubFor answers nothing for a role the account does not hold', RA.hubFor('financial_partner') === null);
  const AOS = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('R6  AdminOS Applications labels the role', /financial_partner:"Financial partner"/.test(AOS));

  console.log('\n  [H hub-register.js financial categories hand off, never file]');
  {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
    const mk = () => {
      const win = { location: { href: '', pathname: '/banking.html', search: '' }, firebaseDB: null };
      const sandbox = { window: win, document: { addEventListener() {}, getElementById: () => null, body: { style: {}, appendChild() {} },
        createElement: () => ({ style: {}, addEventListener() {}, classList: { add() {} } }), head: { appendChild() {} } },
        localStorage: { getItem: () => null, setItem() {} }, console, setTimeout, encodeURIComponent };
      sandbox.globalThis = sandbox; win.window = win;
      vm.createContext(sandbox); vm.runInContext(src, sandbox);
      return { win, HR: win.HubRegister || sandbox.HubRegister };
    };
    const want = { bank: 'BANK', sacco: 'SACCO', microfinance: 'MICROFINANCE', chama: 'CHAMA', insurance: 'INSURER', accountant: 'ACCOUNTANT', forex: 'FOREX' };
    let okAll = true, seen = [];
    for (const [cat, type] of Object.entries(want)) {
      const { win, HR } = mk();
      try { HR.open({ hub: 'financial', category: cat }); } catch (e) { seen.push(cat + ':' + e.message); okAll = false; continue; }
      const u = win.location.href;
      if (u.indexOf('business-apply.html?offer=financial&category=' + type + '&label=') !== 0) { okAll = false; seen.push(cat + '→' + u); }
    }
    ck('H1  all seven financial categories open the Banking Hub intake with the right type', okAll, seen);
    const SRC = src;
    ck('H2  submit has a backstop: a financial category never reaches addDoc', /if \(_finHandoff\(cat\)\) return;/.test(SRC)
       && SRC.indexOf('if (_finHandoff(cat)) return;') < SRC.lastIndexOf('_saveToFirestore(data)'));
    const { win: w2, HR: h2 } = mk();
    let threw = null; try { h2.open({ hub: 'cleaning', category: 'cleaning' }); } catch (e) { threw = e.message; }
    ck('H3  CONTROL a non-financial category does NOT hand off', w2.location.href === '', w2.location.href || threw);
  }

  console.log('\n  [E enum parity with the server validator]');
  let server = null;
  for (const ref of ['origin/feat/financial-partner-on-f66f2c1', 'feat/financial-partner-on-f66f2c1']) {
    try { server = cp.execFileSync('git', ['show', ref + ':functions/financial-partner-listing.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); break; } catch (_) {}
  }
  if (fs.existsSync(path.join(ROOT, 'functions', 'financial-partner-listing.js'))) server = fs.readFileSync(path.join(ROOT, 'functions', 'financial-partner-listing.js'), 'utf8');
  if (!server) un('E1-E3 parity', 'server validator not reachable from this tree');
  else {
    const m = {}; const tmp = path.join(require('os').tmpdir(), 'fpl-parity-' + process.pid + '.js');
    fs.writeFileSync(tmp, server); Object.assign(m, require(tmp)); fs.unlinkSync(tmp);
    const codes = (pairs) => pairs.map((p) => p[0]);
    ck('E1  institution types match the server exactly', JSON.stringify(codes(FPA.INSTITUTION_TYPES)) === JSON.stringify(m.INSTITUTION_TYPES));
    ck('E2  services match the server exactly', JSON.stringify(codes(FPA.SERVICES)) === JSON.stringify(m.SERVICES));
    ck('E3  counties match the server exactly', JSON.stringify(FPA.COUNTIES) === JSON.stringify(m.COUNTIES));
    const sv = m.buildListing(Object.assign({}, FPA.validate(GOOD).profile), 'u1', 'a1');
    ck('E4  what the client accepts, the server lists', sv.ok === true, sv.reason);
  }

  console.log(`\n${pass} passed, ${fail} failed, ${unproven} unproven`);
  console.log('  NOT proven here: the form in a real browser (needs a browser run).');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
