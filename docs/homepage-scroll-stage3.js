/* SOKONI homepage scroll — STAGE 3: identify the ACTUAL wheel target.
   Paste while the page is stuck, then just keep scrolling where it fails.
   It reports automatically. Changes nothing on the page.

   Why not use a recorded mouse position: reading one requires moving the mouse
   to the console, which changes it. This captures clientX/clientY ON THE WHEEL
   EVENT itself — the exact point the wheel was delivered to — and dumps the
   ancestor chain from there the moment it sees dead wheel input. */
(() => {
  if (window.__sokoniStage3) { console.log('already installed — keep scrolling, or call __sokoniWheelTarget()'); return; }
  const S = { last: null, dead: 0, live: 0, reported: false };
  window.__sokoniStage3 = S;

  const CAPTURES = r => (r.overflowY === 'auto' || r.overflowY === 'scroll') && r.scrollHeight > r.clientHeight;

  function chainAt(x, y) {
    const out = [];
    let p = document.elementFromPoint(x, y);
    while (p && out.length < 14) {
      const s = getComputedStyle(p);
      out.push({
        tag: p.tagName, id: p.id || '',
        class: (typeof p.className === 'string' ? p.className : '').slice(0, 44),
        overflowX: s.overflowX, overflowY: s.overflowY,
        overscrollY: s.overscrollBehaviorY,
        scrollTop: p.scrollTop, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight,
        position: s.position, zIndex: s.zIndex,
        CAPTURES: (s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight,
      });
      p = p.parentElement;
    }
    return out;
  }

  function report(why) {
    if (!S.last) { console.warn('no wheel event recorded yet — scroll once at the failing point'); return null; }
    const chain = chainAt(S.last.x, S.last.y);
    const capturing = chain.filter(CAPTURES);
    console.log('%c=== STAGE 3 — WHEEL TARGET (' + why + ') ===', 'font-weight:bold');
    console.log('wheel delivered at: x=' + S.last.x + ' y=' + S.last.y +
                '   dead=' + S.dead + '  live=' + S.live);
    console.log('target element:', document.elementFromPoint(S.last.x, S.last.y));
    console.table(chain);
    if (capturing.length) {
      console.log('%cCAPTURING ANCESTOR FOUND: ' + capturing[0].tag +
        (capturing[0].id ? '#' + capturing[0].id : '') +
        (capturing[0].class ? '.' + capturing[0].class : '') +
        '  (overflowY:' + capturing[0].overflowY + ', ' + capturing[0].scrollHeight +
        ' > ' + capturing[0].clientHeight + ')', 'font-weight:bold;font-size:13px');
    } else {
      console.log('%cNO ancestor can legitimately capture the wheel. ' +
        'Stop chasing scroll containers — move to wheel/input interception or focus state.',
        'font-weight:bold;font-size:13px');
    }
    return chain;
  }

  addEventListener('wheel', e => {
    S.last = { x: e.clientX, y: e.clientY };
    const before = window.scrollY;
    requestAnimationFrame(() => {
      const moved = Math.abs(window.scrollY - before) > 1;
      if (moved) { S.live++; S.dead = 0; }
      else if (e.deltaY > 0) {
        S.dead++;
        /* auto-report on the first sustained stall, at the real wheel point */
        if (S.dead === 5 && !S.reported) { S.reported = true; report('5 consecutive dead wheels'); }
      }
    });
  }, { passive: true, capture: true });

  window.__sokoniWheelTarget = () => report('manual');
  console.log('%cSTAGE 3 installed.', 'font-weight:bold');
  console.log('Just keep scrolling where it fails — it reports automatically after 5 dead wheels.');
  console.log('Or call __sokoniWheelTarget() at any time.');
})();
