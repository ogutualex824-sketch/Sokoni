/* SOKONI homepage scroll — STAGE 2, run while the page is STUCK.
   Paste this whole block. Do NOT reload first.
   It runs the three requested measurements plus the content-visibility test,
   and prints a mechanism verdict. It changes nothing on the page. */
(async () => {
  const H = document.documentElement, B = document.body;
  const cs = e => getComputedStyle(e);
  const geo = () => ({ y: Math.round(scrollY), h: H.scrollHeight, bodyH: B.scrollHeight,
                       max: H.scrollHeight - innerHeight });

  /* ── BLOCK 1 — geometry + the usual page-level suspects ────────────────── */
  const b1 = {
    y: Math.round(scrollY), innerHeight,
    scrollHeight: H.scrollHeight, bodyScrollHeight: B.scrollHeight,
    htmlOverflowY: cs(H).overflowY, bodyOverflowY: cs(B).overflowY,
    htmlPosition: cs(H).position,   bodyPosition: cs(B).position,
    htmlHeight: cs(H).height,       bodyHeight: cs(B).height,
    /* added: these silently cap a document without any overflow rule */
    htmlMaxHeight: cs(H).maxHeight, bodyMaxHeight: cs(B).maxHeight,
    bodyOverflowX: cs(B).overflowX, htmlContentVisibility: cs(H).contentVisibility,
  };
  console.log('%cBLOCK 1 — geometry', 'font-weight:bold'); console.table(b1);

  /* ── BLOCK 2 — is it actually at the bottom? ───────────────────────────── */
  const b2 = { atBottom: scrollY + innerHeight >= H.scrollHeight - 5,
               remaining: H.scrollHeight - (scrollY + innerHeight) };
  console.log('%cBLOCK 2 — position', 'font-weight:bold'); console.table(b2);

  /* ── BLOCK 3 — decisive: can it move WITHOUT the wheel? ────────────────── */
  const beforeJump = geo();
  scrollTo({ top: H.scrollHeight, behavior: 'instant' });
  await new Promise(r => setTimeout(r, 1200));   /* smooth-scroll is active; let it settle */
  const afterJump = geo();
  console.log('%cBLOCK 3 — programmatic scrollTo', 'font-weight:bold');
  console.table({ before: beforeJump, after: afterJump,
                  reachedBottom: afterJump.y >= afterJump.max - 5,
                  movedBy: afterJump.y - beforeJump.y });

  /* ── BLOCK 4 — content-visibility placeholder deficit ──────────────────── */
  const SEL = '.hub-section, .trending-section:not(:first-of-type), .section-wrap, .hub-row';
  const els = [...document.querySelectorAll(SEL)];
  let deficit = 0;
  const cvRows = els.map(e => {
    const h = Math.round(e.getBoundingClientRect().height);
    const s = cs(e);
    if (s.contentVisibility === 'auto' && h > 480) deficit += (h - 480);
    return { cls: String(e.className).slice(0, 34), cv: s.contentVisibility,
             intrinsic: s.containIntrinsicSize, height: h };
  });
  console.log('%cBLOCK 4 — content-visibility (' + els.length + ' matching)', 'font-weight:bold');
  if (els.length) console.table(cvRows);
  console.log('placeholder deficit if unrendered: ' + deficit + 'px');

  /* ── BLOCK 5 — does a RESIZE unstick it? (the DevTools signature) ──────── */
  const preResize = geo();
  dispatchEvent(new Event('resize'));
  await new Promise(r => setTimeout(r, 900));
  const postResize = geo();
  console.log('%cBLOCK 5 — resize event', 'font-weight:bold');
  console.table({ before: preResize, after: postResize,
                  heightChanged: postResize.h - preResize.h });

  /* ── mechanism verdict ─────────────────────────────────────────────────── */
  let m;
  if (afterJump.reachedBottom || afterJump.y > beforeJump.y + 200)
    m = 'A — the DOCUMENT CAN scroll; wheel input is being interrupted. Investigate input/focus/event handling, not layout.';
  else if (postResize.h - preResize.h > 200)
    m = 'B1 — a RESIZE changes document height by ' + (postResize.h - preResize.h) +
        'px. Deferred layout/lazy content is under-reporting the page length.';
  else if (deficit > 1000)
    m = 'B2 — content-visibility placeholders under-report by ' + deficit +
        'px (style.css:15581, contain-intrinsic-size 0 480px).';
  else if (b1.htmlMaxHeight !== 'none' || b1.bodyMaxHeight !== 'none')
    m = 'B3 — an explicit max-height caps the document: html=' + b1.htmlMaxHeight + ' body=' + b1.bodyMaxHeight;
  else
    m = 'B4 — document will not move even programmatically, no resize effect, no placeholder deficit, no max-height. Report BLOCK 1 + 3 verbatim.';
  console.log('%cMECHANISM: ' + m, 'font-weight:bold;font-size:13px');
  return m;
})();
