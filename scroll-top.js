/* ============================================================
   SOKONI — Scroll-to-Top Button  v2
   Left side (bottom:calc(76px + safe-area)) to clear bottom nav.
   Uses onclick for max mobile compatibility.
============================================================ */
(function(){
  const style = document.createElement("style");
  style.textContent = `
    #sokoniScrollTop {
      position: fixed;
      bottom: calc(76px + env(safe-area-inset-bottom, 0px));
      left: 14px;
      right: auto;
      z-index: 9989;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: linear-gradient(135deg, #71ff00, #4fc800);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(113,255,0,0.42), 0 1px 4px rgba(0,0,0,0.4);
      opacity: 0;
      pointer-events: none;
      transform: scale(0.65) translateY(8px);
      transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34,1.56,0.64,1);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      /* Ensure it sits above overlays */
      isolation: isolate;
    }
    #sokoniScrollTop.visible {
      opacity: 1;
      pointer-events: all;
      transform: scale(1) translateY(0);
    }
    #sokoniScrollTop:active {
      transform: scale(0.9);
      box-shadow: 0 2px 10px rgba(113,255,0,0.3);
    }
    #sokoniScrollTop svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: #000;
      stroke-width: 2.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    @keyframes sstPop {
      0%   { box-shadow: 0 0 0 0   rgba(113,255,0,0.55); }
      60%  { box-shadow: 0 0 0 16px rgba(113,255,0,0); }
      100% { box-shadow: 0 0 0 0   rgba(113,255,0,0); }
    }
    #sokoniScrollTop.first-show { animation: sstPop 0.65s ease-out; }

    /* ── Horizontal scroll fade edges ── */
    .h-scroll-wrap {
      position: relative;
    }
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

  const btn = document.createElement("button");
  btn.id = "sokoniScrollTop";
  btn.setAttribute("aria-label", "Back to top");
  btn.setAttribute("title", "Back to top");
  btn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"></polyline></svg>`;

  /* Use both onclick and addEventListener for maximum mobile reliability */
  btn.onclick = function(){ window.scrollTo({ top:0, behavior:"smooth" }); };
  btn.addEventListener("touchend", function(e){
    e.preventDefault();
    window.scrollTo({ top:0, behavior:"smooth" });
  }, { passive:false });

  document.body.appendChild(btn);

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
