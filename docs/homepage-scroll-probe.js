(() => {
  if (window.__sokoniScrollProbe) { console.log('probe already installed — scroll, then run __sokoniReport()'); return; }
  var S = { samples: [], marks: [], maxY: 0, startedAt: Date.now(), lastEl: null };
  window.__sokoniScrollProbe = S;

  function ancestry(x, y) {
    var el = document.elementFromPoint(x, y), out = [];
    while (el) {
      var s = getComputedStyle(el);
      out.push({
        tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 60),
        overflowY: s.overflowY, overscrollY: s.overscrollBehaviorY, position: s.position,
        zIndex: s.zIndex, height: s.height, maxHeight: s.maxHeight,
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        TRAPS: el.scrollHeight > el.clientHeight && (s.overflowY === 'hidden' || s.overflowY === 'clip')
      });
      el = el.parentElement;
    }
    return out;
  }

  function sample(tag) {
    var doc = document.documentElement;
    S.samples.push({ t: Date.now() - S.startedAt, y: Math.round(window.scrollY),
      max: Math.round(doc.scrollHeight - window.innerHeight), tag: tag || null });
    if (window.scrollY > S.maxY) S.maxY = window.scrollY;
  }

  addEventListener('scroll', function () { sample(); }, { passive: true });
  addEventListener('wheel', function (e) {
    S.lastEl = { x: e.clientX, y: e.clientY };
    sample('wheel' + (e.deltaY > 0 ? '_down' : '_up'));
  }, { passive: true });
  sample('install');

  window.__sokoniMark = function (label) { sample('MARK:' + label); console.log('marked: ' + label); };

  window.__sokoniReport = function () {
    var mid = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
    var chain = ancestry(mid.x, mid.y);
    var traps = chain.filter(function (r) { return r.TRAPS; });
    var top = chain[0] || {};
    var covering = (top.position === 'fixed' || top.position === 'absolute') &&
                   (parseInt(top.zIndex, 10) || 0) >= 1000;

    /* CRITICAL: "furthest reached" alone CANNOT distinguish "the user stopped
       scrolling" from "the page refused to scroll". An earlier build reported a
       page that scrolls perfectly as "stops 4682px short" purely because the
       test only scrolled partway. The real signal is DOWNWARD WHEEL INPUT THAT
       PRODUCED NO MOVEMENT. */
    var stalled = 0, lastDownY = null;
    for (var k = 0; k < S.samples.length; k++) {
      var smp = S.samples[k];
      if (smp.tag !== "wheel_down") continue;
      if (lastDownY !== null && smp.y <= lastDownY + 2) stalled++;
      lastDownY = smp.y;
    }
    var ys = S.samples.map(function (s) { return s.y; });
    var maxSeen = Math.max.apply(null, ys.concat([0]));
    var maxPossible = Math.round(document.documentElement.scrollHeight - innerHeight);
    var downs = S.samples.filter(function (s) { return s.tag === 'wheel_down'; }).length;
    var ups = S.samples.filter(function (s) { return s.tag === 'wheel_up'; }).length;

    /* did an upward wheel ever actually move the page up? */
    var wentUp = false;
    for (var i = 1; i < S.samples.length; i++)
      if (S.samples[i].y < S.samples[i - 1].y - 5) { wentUp = true; break; }

    console.log('%c=== SOKONI SCROLL REPORT ===', 'font-weight:bold');
    console.log('scrollY now        : ' + Math.round(scrollY));
    console.log('furthest reached   : ' + maxSeen + '  of possible ' + maxPossible +
                (maxSeen >= maxPossible - 5 ? '   (reached the bottom)' : '   (STOPPED ' + (maxPossible - maxSeen) + 'px SHORT)'));
    console.log('wheel down / up    : ' + downs + ' / ' + ups + '    page ever moved UP: ' + wentUp);
    console.log('dead downward wheels: ' + stalled + '   (>=3 means the page REFUSED to move)');
    console.log('topmost at centre  : ' + top.tag + (top.id ? '#' + top.id : '') +
                ' pos=' + top.position + ' z=' + top.zIndex);
    console.log('TRAPPING ancestors : ' + (traps.length ? traps.length : 'NONE'));
    if (traps.length) console.table(traps);
    console.log('full ancestor chain at centre:');
    console.table(chain);

    var verdict;
    if (covering) verdict = 'E — something is covering/capturing the page: ' + top.tag + (top.id ? '#' + top.id : '');
    else if (traps.length) {
      /* HTML/BODY trapping is DOCUMENT-level, not a component. Calling it
         "component scroll ownership" would send the fix at the wrong layer —
         caught by a positive control that disabled document scrolling and got
         back "component: HTML". */
      var docLevel = traps.filter(function (r) { return r.tag === "HTML" || r.tag === "BODY"; });
      var comp = traps.filter(function (r) { return r.tag !== "HTML" && r.tag !== "BODY"; });
      if (comp.length) verdict = "A — component scroll ownership: " + comp[0].tag +
        (comp[0].id ? "#" + comp[0].id : "") + (comp[0].cls ? "." + comp[0].cls : "");
      else verdict = "B — DOCUMENT-level scroll ownership: " + docLevel[0].tag +
        " has overflowY:" + docLevel[0].overflowY + " with scrollHeight " + docLevel[0].scrollH +
        " > clientHeight " + docLevel[0].clientH;
    }
    else if (ups > 0 && !wentUp) verdict = 'D — scrolls down but will NOT scroll back up';
    else if (stalled >= 3 && maxSeen < maxPossible - 5) verdict = 'C — downward wheel STALLED (' + stalled + ' dead events), stuck ' + (maxPossible - maxSeen) + 'px short, no trapping ancestor (page/layout or lazy content)';
    else if (maxSeen < maxPossible - 5) verdict = 'INCONCLUSIVE — did not reach the bottom, but downward wheel never stalled. Keep scrolling down at the failing point, then re-run.';
    else verdict = 'no failure captured in this session — scroll again over the failing region, then re-run __sokoniReport()';
    console.log('%cVERDICT: ' + verdict, 'font-weight:bold;font-size:13px');
    console.log('(scroll-behavior:smooth is active on this page — let motion STOP before reading)');
    return verdict;
  };

  console.log('%cSOKONI scroll probe installed.', 'font-weight:bold');
  console.log('1) put the cursor over Hubs/Tickys and scroll down');
  console.log('2) __sokoniMark("over-hubs")');
  console.log('3) put the cursor over empty background and scroll down');
  console.log('4) __sokoniMark("over-background")');
  console.log('5) try scrolling back UP');
  console.log('6) __sokoniReport()');
})();
