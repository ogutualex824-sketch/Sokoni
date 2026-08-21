/* AFTER-PROOF — the role authority reaches a MIRROR-ONLY page.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/cart.html" \n              --script ./scripts/after-authority-bootstrap.mjs

   MEASURED LIVE on production /cart before this fix:
     SokoniRoleAuthority  undefined
     SokoniPermissions    undefined
     dropdownMarked       "Buyer"   (from the localStorage mirror)

   317 pages load shared-header.js and it injects a role switcher on 180 of them,
   but only FIVE loaded the authority modules. On the other 175 the mirror became
   the authority again.

   WHY THIS HARNESS EXISTS AT ALL
   after-role-menu-convergence.mjs runs on 404.html and injects the modules with
   addScriptTag. It proved the switcher logic GIVEN the authority is present, and
   was structurally incapable of noticing that real pages do not load it. 18/0 was
   true and irrelevant to /cart. This file injects NOTHING and asks a real page.
   ==========================================================================*/
export default async function run(page) {
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e)));
  await page.addInitScript(() => {
    localStorage.setItem('loggedIn','true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid:'fx', roles:['buyer','rider','seller','driver'], activeRole:'buyer' }));
  });
  await page.goto('http://127.0.0.1:8901/cart.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.addScriptTag({ content:
    'document.documentElement.setAttribute("data-a", JSON.stringify({'
    + ' hasRA: typeof window.SokoniRoleAuthority,'
    + ' hasPerms: typeof window.SokoniPermissions,'
    + ' raTag: !!document.querySelector("script[src*=\'sokoni-role-authority.js\']"),'
    + ' permTag: !!document.querySelector("script[src*=\'sokoni-permissions.js\']") }));' });
  const r = JSON.parse(await page.getAttribute('html','data-a'));
  return { pageErrors: errs, ...r };
}
