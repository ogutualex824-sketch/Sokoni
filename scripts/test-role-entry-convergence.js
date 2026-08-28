'use strict';
/* role-entry-convergence — scenario matrix against the REAL live SokoniRoleAuthority
   (sokoni-role-authority.js) with the convergence gap-fills, in Chromium over file://.
   Stubs window.firebaseAuth.currentUser.getIdTokenResult -> {claims} so approval is decided by
   signed claims exactly as in production. */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const SP = path.join(ROOT, 'scripts', '.rctmp');
fs.mkdirSync(SP, { recursive: true });
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));

let pass = 0, fail = 0;
const P = (n) => { pass++; console.log('  [PASS] ' + n); };
const F = (n, d) => { fail++; console.log('  [FAIL] ' + n + (d ? '  -> ' + d : '')); };

function stub(scn) {
  return `(function(){
    var CLAIMS = ${JSON.stringify(scn.claims || null)};
    var USER = CLAIMS ? { uid:'u1', getIdTokenResult:function(){ return Promise.resolve({ claims: CLAIMS }); } } : null;
    window.firebaseAuth = { currentUser: USER };
    ${scn.activeRole ? `try{ localStorage.setItem('sokoniUser', JSON.stringify({ roles:['buyer'], activeRole:'${scn.activeRole}' })); }catch(e){}` : ''}
  })();`;
}
async function load(browser, scn) {
  const url = 'file://' + path.join(SP, 'h.html').replace(/\\/g, '/');
  if (!fs.existsSync(path.join(SP, 'h.html'))) fs.writeFileSync(path.join(SP, 'h.html'), '<!doctype html><html><body></body></html>');
  const page = await browser.newPage();
  const nav = [];
  page.on('request', (r) => { if (r.isNavigationRequest()) nav.push(r.url()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.addScriptTag({ content: stub(scn) });
  await page.addScriptTag({ path: path.join(ROOT, 'sokoni-role-authority.js') });
  await page.evaluate(() => window.SokoniRoleAuthority.refresh(true));
  return { page, nav };
}
const approved = (page, role) => page.evaluate((r) => window.SokoniRoleAuthority.isApproved(r), role);

(async () => {
  const browser = await chromium.launch();

  // Approved roles -> isApproved true (matrix: Approved X -> X dashboard)
  { const { page } = await load(browser, { claims: { seller: true } });   (await approved(page, 'seller'))   ? P('Approved Seller -> seller approved (merchant dashboard opens)') : F('seller approved'); await page.close(); }
  { const { page } = await load(browser, { claims: { provider: true } }); (await approved(page, 'provider')) ? P('Approved Provider -> provider approved') : F('provider approved'); await page.close(); }
  { const { page } = await load(browser, { claims: { driver: true, rider: true } });
    ((await approved(page, 'rider')) && (await approved(page, 'driver'))) ? P('Approved Driver/Rider -> rider approved (driver alias too)') : F('driver approved'); await page.close(); }
  { const { page } = await load(browser, { claims: { landlord: true } }); (await approved(page, 'landlord')) ? P('Approved Landlord -> landlord approved') : F('landlord approved'); await page.close(); }

  // Buyer (no role claims) -> denied for every workspace role
  { const { page } = await load(browser, { claims: {} });
    const any = (await approved(page, 'seller')) || (await approved(page, 'provider')) || (await approved(page, 'rider')) || (await approved(page, 'landlord'));
    (!any) ? P('Buyer -> NOT approved for merchant/provider/driver/landlord') : F('buyer wrongly approved'); await page.close(); }

  // Wrong custom claim: admin alone does NOT become merchant/provider/driver/landlord
  { const { page } = await load(browser, { claims: { admin: true } });
    const any = (await approved(page, 'seller')) || (await approved(page, 'provider')) || (await approved(page, 'rider')) || (await approved(page, 'landlord'));
    (!any) ? P('Admin alone -> does NOT auto-become merchant/provider/driver/landlord') : F('admin leaked a role'); await page.close(); }
  // Super-admin alone -> same principle
  { const { page } = await load(browser, { claims: { superAdmin: true } });
    const any = (await approved(page, 'seller')) || (await approved(page, 'landlord'));
    (!any) ? P('Super-admin alone -> does NOT auto-become a workspace role') : F('superadmin leaked a role'); await page.close(); }

  // Forged activeRole (localStorage) with no matching claim -> reset to buyer (forgery rejected)
  { const { page } = await load(browser, { claims: {}, activeRole: 'seller' });
    const ar = await page.evaluate(() => window.SokoniRoleAuthority.getActiveRole());
    (ar === 'buyer') ? P('Forged activeRole:seller with no seller claim -> reset to buyer (denied)') : F('forged activeRole not rejected', ar); await page.close(); }
  // Legitimate activeRole with the claim -> kept
  { const { page } = await load(browser, { claims: { seller: true }, activeRole: 'seller' });
    const ar = await page.evaluate(() => window.SokoniRoleAuthority.getActiveRole());
    (ar === 'seller') ? P('activeRole:seller WITH the seller claim -> kept') : F('valid activeRole dropped', ar); await page.close(); }

  // Signed-out -> not verified (auth-guard.js handles the login redirect, not the workspace gate)
  { const { page } = await load(browser, { claims: null });
    const snap = await page.evaluate(() => window.SokoniRoleAuthority.getSnapshot());
    (snap.verified === false && (await approved(page, 'seller')) === false) ? P('Signed-out -> not verified, no role approved (auth-guard -> login)') : F('signed-out state', JSON.stringify(snap)); await page.close(); }

  // WORKSPACE_ROUTES now covers the newly-guarded surfaces
  { const { page } = await load(browser, { claims: {} });
    const wr = await page.evaluate(() => window.SokoniRoleAuthority.WORKSPACE_ROUTES);
    (wr['provider.html'] === 'provider' && wr['provider-dashboard.html'] === 'provider' && wr['rider-dashboard.html'] === 'rider' && wr['landlord.html'] === 'landlord')
      ? P('WORKSPACE_ROUTES guards provider/provider-dashboard/rider-dashboard/landlord') : F('WORKSPACE_ROUTES gaps', JSON.stringify(wr)); await page.close(); }

  // guardWorkspace(unapproved) -> redirects to the ROLE'S APPLICATION (matrix: Buyer -> X -> X application)
  async function redirectTo(role, expect) {
    const { page, nav } = await load(browser, { claims: {} });
    await page.evaluate((r) => window.SokoniRoleAuthority.guardWorkspace(r), role).catch(() => {});
    await page.waitForTimeout(300);
    (nav.some((u) => new RegExp(expect.replace('.', '\\.')).test(u)))
      ? P(`Buyer -> ${role} workspace -> redirected to its application (${expect})`) : F(`${role} did not redirect to ${expect}`, nav.join(','));
    await page.close();
  }
  await redirectTo('landlord', 'onboarding-landlord.html');
  await redirectTo('provider', 'provider-onboarding.html');
  await redirectTo('rider', 'onboarding-driver.html');

  // Approved landlord -> guardWorkspace stays (no redirect)
  { const { page, nav } = await load(browser, { claims: { landlord: true } });
    const res = await page.evaluate(() => window.SokoniRoleAuthority.guardWorkspace('landlord'));
    (res.ok === true && !nav.some((u) => /onboarding|profile/.test(u))) ? P('Approved Landlord -> guardWorkspace stays on landlord.html') : F('approved landlord should stay', JSON.stringify(res) + ' nav=' + nav.join(',')); await page.close(); }

  await browser.close();
  try { fs.rmSync(SP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + (fail === 0 ? `role-entry-convergence: PASS ${pass}/${pass}` : `role-entry-convergence: ${fail} FAIL of ${pass + fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(1); });
