/* SOKONI tap diagnostic — what is actually receiving the tap?
 *
 * Paste into the console on the page where products will not respond.
 * Requires no deployment and changes nothing.
 *
 *   sokoniDiagnoseTap()                 // uses .product-tile
 *   sokoniDiagnoseTap('.my-selector')   // any element that should be tappable
 *
 * WHY THIS BEFORE READING THE HANDLER
 * A dead tap has two very different causes: the event never reaches the element,
 * or it reaches it and the handler does nothing. Reading SPos.cart.addItem tells
 * you nothing about the first, and the first is far more common after a UI
 * change. Identify what owns the pixel before debugging the code that should
 * have owned it.
 *
 * The ancestor walk matters: elementFromPoint returns the deepest node, which is
 * often a <span> or <img> inside an overlay. The interesting id is on the
 * parent, so reporting only the hit element sends you looking for a span that
 * does not exist in any stylesheet.
 */
window.sokoniDiagnoseTap = function sokoniDiagnoseTap(selector) {
  const sel = selector || '.product-tile';
  const card = document.querySelector(sel);

  console.log('%c SOKONI TAP DIAGNOSTIC ', 'background:#71ff00;color:#000;font-weight:bold');

  if (!card) {
    console.error('  No element matches "' + sel + '".');
    console.error('  Nothing is rendered, so this is not an overlay problem — check why the list is empty.');
    return { verdict: 'NO_ELEMENT', selector: sel };
  }

  const r = card.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) {
    console.error('  Element has zero size (' + r.width + 'x' + r.height + ').');
    console.error('  It cannot be tapped because it occupies no pixels — a layout problem, not an overlay.');
    return { verdict: 'ZERO_SIZE', rect: r };
  }

  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);

  if (!hit) {
    console.error('  Nothing at the centre point — the element may be scrolled out of view.');
    return { verdict: 'OFF_SCREEN', rect: r };
  }

  /* Walk up to the nearest identifiable ancestor. An overlay is usually the
     element with the id; the node under the finger is usually its child. */
  let node = hit, nearestId = null, depth = 0;
  while (node && depth < 12) {
    if (node.id) { nearestId = node.id; break; }
    node = node.parentElement; depth++;
  }

  const cs = getComputedStyle(hit);
  const reaches = hit === card || card.contains(hit) || hit.contains(card);

  const out = {
    selector: sel,
    hit,
    hitTag: hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : ''),
    nearestId: nearestId || '(none)',
    display: cs.display,
    pointerEvents: cs.pointerEvents,
    zIndex: cs.zIndex,
    position: cs.position,
    reachesTarget: reaches,
  };

  console.table(out);

  /* Name the blocker where it is one we already know about, so the result is
     actionable without a second round trip. */
  const KNOWN = {
    'sokoni-update-pending': 'the deferred-update banner (pos-lifecycle.js) — should be pointer-events:none',
    'posQrModal':            'the QR payment modal (pos.html) — position:fixed;inset:0, covers the whole viewport',
    'branch-selector-modal': 'the branch selector (pos.html) — position:fixed;inset:0, covers the whole viewport',
  };

  console.log('');
  if (reaches) {
    console.log('%c  The tap REACHES the element. This is not an overlay problem. ',
                'background:#71ff00;color:#000');
    console.log('  Next: confirm the events are dispatched at all —');
    console.log('    monitorEvents(document.querySelector("' + sel + '"), ["pointerdown","pointerup","click"])');
    console.log('  then tap once.');
    console.log('    no pointerdown        -> something above it is still capturing');
    console.log('    pointerdown, no click -> preventDefault() or pointer cancellation');
    console.log('    all three arrive      -> the handler is the problem, read it now');
    out.verdict = 'REACHES_TARGET';
  } else {
    console.log('%c  BLOCKED — something else owns this pixel. ', 'background:#ff3c3c;color:#fff');
    console.log('  intercepting: ' + (nearestId || out.hitTag));
    if (nearestId && KNOWN[nearestId]) console.log('  identified  : ' + KNOWN[nearestId]);
    if (cs.display === 'none') {
      console.log('  NOTE: display is "none", so this element should not be receiving anything.');
      console.log('        elementFromPoint returning it suggests a stale layout — re-run after a scroll.');
    }
    console.log('  Fix that element. Do NOT change the product card or its handler.');
    out.verdict = 'BLOCKED';
    out.blockedBy = nearestId || out.hitTag;
  }

  console.log('\n  copy(JSON.stringify(sokoniDiagnoseTap.last, null, 2))');
  window.sokoniDiagnoseTap.last = Object.assign({}, out, { hit: out.hitTag });
  return out;
};

console.log('%c sokoniDiagnoseTap() ready — run: sokoniDiagnoseTap() ',
            'background:#71ff00;color:#000;font-weight:bold');
