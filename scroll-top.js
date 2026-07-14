/* ============================================================
   SOKONI — Scroll-to-Top Button  v3
   Reuses #sokoniScrollTop if already in DOM (static HTML fallback);
   creates it dynamically only when missing.
   Left side (bottom:80px) to clear bottom nav and chatbot (right:20px).
============================================================ */
(function(){
  /* Inject additional interactive states not covered by the inline style */
  const style = document.createElement("style");
  style.textContent = `
    #sokoniScrollTop:active {
      transform: scale(0.9) !important;
      box-shadow: 0 2px 10px rgba(113,255,0,0.3) !important;
    }
    @keyframes sstPop {
      0%   { box-shadow: 0 0 0 0   rgba(113,255,0,0.55); }
      60%  { box-shadow: 0 0 0 16px rgba(113,255,0,0); }
      100% { box-shadow: 0 0 0 0   rgba(113,255,0,0); }
    }
    #sokoniScrollTop.first-show { animation: sstPop 0.65s ease-out; }

    /* The .visible class was ADDED by the scroll handler but STYLED NOWHERE, so
       the button never came back from its hidden inline state
       (opacity:0; pointer-events:none; transform:scale(0.65)).
       Measured: after scrolling 1500px it was still opacity=0, pointer-events=none.
       Back-to-top was dead on every page. This is the missing rule.

       It also restores the full 46x46 size, which clears the 44px minimum tap
       target — the "30x30" the audit saw was just the hidden 0.65 scale. */
    #sokoniScrollTop.visible {
      opacity: 1 !important;
      pointer-events: auto !important;
      transform: scale(1) translateY(0) !important;
    }

    /* ── Horizontal scroll fade edges ── */
    .h-scroll-wrap { position: relative; }
    .h-scroll-wrap::after {
      content: '';
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 32px;
      background: linear-gradient(to right, transparent, rgba(0,0,0,0.55));
      pointer-events: none;
      border-radius: 0 12px 12px 0;
    }
  `;
  document.head.appendChild(style);

  /* Reuse static element if already in DOM; create dynamically as fallback */
  let btn = document.getElementById("sokoniScrollTop");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "sokoniScrollTop";
    btn.setAttribute("aria-label", "Back to top");
    btn.setAttribute("title", "Back to top");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#000" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
    btn.style.cssText = "position:fixed;bottom:var(--sk-scroll-bottom,82px);left:14px;right:auto;z-index:9989;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#71ff00,#4fc800);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(113,255,0,0.42),0 1px 4px rgba(0,0,0,0.4);opacity:0;pointer-events:none;transform:scale(0.65) translateY(8px);transition:opacity 0.25s ease,transform 0.25s cubic-bezier(0.34,1.56,0.64,1);-webkit-tap-highlight-color:transparent;touch-action:manipulation;";
    document.body.appendChild(btn);
  }

  /* Wire scroll-to-top action (preserves any onclick already set in HTML).

     touchend ALONE left the button dead on desktop: the dynamically-created button carries no
     onclick, and a mouse click never produces a touchend — so on every desktop browser the
     back-to-top button appeared, highlighted on hover, and did nothing when clicked. Bind click
     as well. On touch, touchend's preventDefault() suppresses the synthetic click, so this does
     not double-fire; and scrolling to top twice would be a harmless no-op regardless. */
  const _toTop = function(){ window.scrollTo({ top:0, behavior:"smooth" }); };
  btn.addEventListener("touchend", function(e){
    e.preventDefault();
    _toTop();
  }, { passive:false });
  /* Only bind click if the HTML did not already wire one, so a static button keeps its own. */
  if (!btn.getAttribute("onclick")) btn.addEventListener("click", _toTop);

  let _shown = false;
  const SHOW_AT = 280;

  function _onScroll() {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y > SHOW_AT) {
      if (!btn.classList.contains("visible")) {
        btn.classList.add("visible");
        if (!_shown) { btn.classList.add("first-show"); _shown = true; }
        setTimeout(() => btn.classList.remove("first-show"), 700);
      }
    } else {
      btn.classList.remove("visible");
    }
  }

  window.addEventListener("scroll", _onScroll, { passive: true });
  /* Also listen on document for iOS Safari which sometimes fires on document */
  document.addEventListener("scroll", _onScroll, { passive: true });

})();
