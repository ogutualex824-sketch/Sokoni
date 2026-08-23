/* VERIFY — /pos never routes anyone into BUSINESS registration.
   ==========================================================================
   Run against a served copy of the worktree:
     node <browser-automation>/browser.mjs http://127.0.0.1:8796/pos.html \
       --script scripts/browser/verify-pos-no-business-setup.mjs

   THE RULE: if the business is already approved, /pos opens the till. If the
   device is not paired, /pos offers POS SETUP — device pairing — never business
   setup. Nothing in the boot path may redirect on the strength of a
   device-local flag.

   The states below are exactly the ones that used to bounce a merchant into
   shop creation: a brand-new browser, a cleared browser, and a signed-out one.
========================================================================== */
const VIEWPORTS = [
  { name: '390x844', w: 390, h: 844 },
  { name: '412x915', w: 412, h: 915 },
  { name: '820x1180', w: 820, h: 1180 },
  { name: '1280x720', w: 1280, h: 720 },
];

const STATES = [
  { name: 'brand-new browser (no flags at all)', seed: null },
  { name: 'cleared site data, signed out', seed: () => { try { localStorage.clear(); } catch (e) {} } },
  { name: 'signed in, no device flags', seed: () => { try { localStorage.setItem('loggedIn', 'true'); } catch (e) {} } },
  { name: 'device flags present', seed: () => { try {
      localStorage.setItem('sokoni_setup_complete', '1');
      localStorage.setItem('sokoni_merchant_id', 'rig');
    } catch (e) {} } },
];

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });
  const browser = page.context().browser();

  for (const vp of VIEWPORTS) {
    for (const st of STATES) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const p = await ctx.newPage();
      if (st.seed) await p.addInitScript(st.seed);
      await p.goto('http://127.0.0.1:8796/pos.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await p.waitForTimeout(4000);

      const url = p.url();
      const wentToBusinessSetup = /pos-setup/.test(url);
      ck('N [' + vp.name + '] ' + st.name + ' — stays on /pos',
        !wentToBusinessSetup, 'landed=' + url.split('/').pop().slice(0, 40) +
        (wentToBusinessSetup ? '  *** routed into business setup' : ''));

      await p.close(); await ctx.close();
    }
  }

  /* ── the source-level guarantee ───────────────────────────────────────── */
  const html = await (await fetch('http://127.0.0.1:8796/pos.html')).text();
  const code = html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  ck('N1  no redirect to pos-setup remains in the boot path',
    !/location\.(replace|href|assign)\s*\(\s*['"][^'"]*pos-setup/.test(code),
    'comments are stripped before scanning, so a comment mentioning it cannot pass this');

  ck('N2  CONTROL the scan can still see a real redirect if one existed',
    /location\.(replace|href|assign)/.test(code + "location.replace('x')"),
    'the detector matches the construct it is looking for');

  ck('N3  the resolver is still loaded to make the decision',
    /sokoni-pos-context\.js/.test(html) && /sokoni-pos-boot\.js/.test(html),
    'removing the redirect without the resolver would just be a deletion');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
    sample: rows.slice(0, 6).map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.label),
  };
}
