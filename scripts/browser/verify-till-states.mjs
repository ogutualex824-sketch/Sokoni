/* VERIFY — the till always reaches a terminal state, at every size.
   ==========================================================================
   Run against a served copy:
     node <browser-automation>/browser.mjs http://127.0.0.1:8797/till.html \
       --script scripts/browser/verify-till-states.mjs

   THE STANDARD: READY · PAIR DEVICE · ERROR · RETRY — never an indefinite
   loading screen, never a white page. "Opening your till…" must have a
   deadline, because a merchant stranded on a spinner has no way to tell a slow
   network from a dead app.

   Signed out is the only state this rig can reach honestly (no real session),
   so that is what is asserted — plus the watchdog, which is the guarantee that
   covers every state the rig cannot reach.
========================================================================== */
const VIEWPORTS = [
  { name: '390x665', w: 390, h: 665 },
  { name: '390x844', w: 390, h: 844 },
  { name: '412x915', w: 412, h: 915 },
  { name: '430x932', w: 430, h: 932 },
  { name: '820x1180', w: 820, h: 1180 },
  { name: '1280x720', w: 1280, h: 720 },
];

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });
  const browser = page.context().browser();

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await ctx.newPage();
    await p.goto('http://127.0.0.1:8797/till.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(16000);   /* past the 15s auth bound, before the 25s watchdog */

    const s = await p.evaluate(() => {
      const boot = document.getElementById('boot');
      const txt = (document.body.innerText || '');
      return {
        bodyChars: txt.length,
        heading: (boot && boot.querySelector('.hd') && boot.querySelector('.hd').textContent) || '',
        stillSpinning: !!(boot && boot.querySelector('.sp')),
        hasAction: !!(boot && boot.querySelector('a.btn')),
        docScrolls: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    }).catch(() => ({ bodyChars: 0 }));

    const t = vp.name;
    ck('T1 [' + t + '] reached a terminal state, not a spinner',
      !s.stillSpinning && s.heading.length > 0,
      'heading="' + s.heading + '" spinning=' + s.stillSpinning);

    ck('T2 [' + t + '] the state is never a white page',
      s.bodyChars > 40, 'bodyChars=' + s.bodyChars);

    ck('T3 [' + t + '] the state offers an action',
      s.hasAction, 'a signed-out till must offer Sign in; every error offers Retry');

    ck('T4 [' + t + '] no horizontal overflow',
      !s.docScrolls, 'scrollWidth vs innerWidth');

    await p.close(); await ctx.close();
  }

  /* ── the watchdog is the guarantee for states this rig cannot reach ────── */
  const src = await (await fetch('http://127.0.0.1:8797/till.html')).text();
  ck('T5 a watchdog bounds the loading state',
    /setTimeout\([\s\S]{0,400}Taking longer than expected/.test(src),
    'no boot state may last forever');
  ck('T6 every terminal render stands the watchdog down',
    /function show\([\s\S]{0,120}settle\(/.test(src),
    'otherwise a rendered state could still be overwritten by the timeout');
  ck('T7 a successful mount stands it down too',
    /sell:mounted[\s\S]{0,120}settle\(\)/.test(src),
    'a working till must not be interrupted by its own backstop');
  ck('T8 pair-device RENDERS rather than falling through to a mount',
    /decision === 'pair-device'[\s\S]{0,600}return show\('Connect this device'/.test(src),
    'this is the defect that left an unpaired device on the spinner');
  ck('T9 CONTROL the till still mounts the CERTIFIED module, not a copy',
    /SokoniMerchantSell/.test(src) && !/function\s+renderProducts/.test(src),
    'one selling surface; the till is a shell around it');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
