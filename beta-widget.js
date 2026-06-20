/* ================================================================
   SOKONI BETA WIDGET  v1.0
   Self-injecting floating bug report + feedback panel.
   Auto-activates for registered beta testers.
   Provides SokoniWidget.prompt(question, context) for in-flow prompts.
================================================================ */
(function () {
  'use strict';

  if (!localStorage.getItem('_sokoniBetaMode')) return;

  /* Load sokoni-beta.js if not already present */
  function _ensureBeta(cb) {
    if (window.SokoniBeta) { cb(); return; }
    var s = document.createElement('script');
    s.src = '/sokoni-beta.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function _inject() {
    /* ── CSS ── */
    var css = document.createElement('style');
    css.textContent = [
      '#sbFab{position:fixed;left:14px;bottom:86px;z-index:99999;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#71ff00,#5ccc00);border:2px solid rgba(0,0,0,0.2);cursor:pointer;font-size:19px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(113,255,0,0.45);transition:transform .2s;}',
      '#sbFab:hover{transform:scale(1.12);}',
      '#sbFab .sbFab-badge{position:absolute;top:-3px;right:-3px;min-width:17px;height:17px;background:#ff3c3c;border-radius:999px;font-size:9px;font-weight:900;color:#fff;display:none;align-items:center;justify-content:center;padding:0 3px;line-height:17px;}',
      '#sbOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:999998;display:none;align-items:flex-end;justify-content:center;backdrop-filter:blur(5px);}',
      '#sbOverlay.open{display:flex;}',
      '#sbModal{background:#111;border-radius:20px 20px 0 0;width:100%;max-width:500px;max-height:88vh;overflow-y:auto;padding:20px 18px;border:1px solid rgba(255,255,255,0.1);border-bottom:none;position:relative;}',
      '.sbTabs{display:flex;gap:7px;margin-bottom:18px;}',
      '.sbTab{flex:1;padding:9px 4px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:rgba(255,255,255,0.4);font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .2s;}',
      '.sbTab.active{background:rgba(113,255,0,0.1);border-color:rgba(113,255,0,0.3);color:#71ff00;}',
      '.sbPane{display:none;}.sbPane.active{display:block;}',
      '.sbLbl{font-size:10px;font-weight:800;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}',
      '.sbInp,.sbTxt,.sbSel{width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:14px;font-family:inherit;outline:none;margin-bottom:13px;box-sizing:border-box;}',
      '.sbTxt{min-height:78px;resize:vertical;}',
      '.sbSel option{background:#111;}',
      '.sbChips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:13px;}',
      '.sbChip{padding:7px 12px;border-radius:20px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.45);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;}',
      '.sbChip.on{background:rgba(113,255,0,0.1);border-color:rgba(113,255,0,0.3);color:#71ff00;}',
      '.sbStars{display:flex;gap:7px;margin-bottom:13px;}',
      '.sbStar{font-size:26px;cursor:pointer;opacity:.25;transition:opacity .15s;}',
      '.sbStar.on{opacity:1;}',
      '.sbBtn{width:100%;padding:13px;background:linear-gradient(135deg,#71ff00,#5ccc00);border:none;border-radius:12px;color:#080808;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit;margin-top:4px;}',
      '.sbClose{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
      '.sbOk{text-align:center;padding:20px 0;display:none;}',
      '.sbOk .sbOkIcon{font-size:44px;margin-bottom:10px;}',
      '.sbOk .sbOkTitle{font-size:14px;font-weight:800;color:#fff;}',
      '.sbOk .sbOkSub{font-size:12px;color:rgba(255,255,255,0.35);margin-top:5px;}',
      '#sbPrompt{position:fixed;bottom:88px;right:14px;z-index:99997;background:#111;border:1px solid rgba(113,255,0,0.3);border-radius:14px;padding:14px;max-width:260px;display:none;box-shadow:0 8px 28px rgba(0,0,0,0.55);}',
      '#sbPrompt .sbpQ{font-size:13px;font-weight:800;color:#fff;margin-bottom:10px;padding-right:20px;}',
      '#sbPrompt .sbpStars{display:flex;gap:6px;}',
      '#sbPrompt .sbpStar{font-size:22px;cursor:pointer;opacity:.25;transition:opacity .15s;}',
      '#sbPrompt .sbpStar.on,.sbpStar:hover{opacity:1;}',
      '#sbPrompt .sbpX{position:absolute;top:10px;right:10px;background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;font-size:14px;padding:0;line-height:1;}',
      '@media(min-width:769px){#sbFab{bottom:20px;}#sbPrompt{bottom:20px;}}',
    ].join('');
    document.head.appendChild(css);

    /* ── HTML ── */
    var tester = (function(){ try{return JSON.parse(localStorage.getItem('_sokoniBetaTester')||'{}');}catch{return{};} })();
    var div = document.createElement('div');
    div.id = 'sbRoot';
    div.innerHTML = '<button id="sbFab" title="Report bug or give feedback">🐛<span class="sbFab-badge" id="sbFabBadge"></span></button>' +
      '<div id="sbOverlay">' +
        '<div id="sbModal">' +
          '<button class="sbClose" id="sbCloseBtn">✕</button>' +
          '<div style="font-size:14px;font-weight:900;color:#fff;margin-bottom:15px;">Beta Feedback' +
            (tester.name ? '<span style="font-size:11px;color:rgba(255,255,255,0.3);font-weight:400;margin-left:8px;">'+tester.name+'</span>' : '') +
          '</div>' +
          '<div class="sbTabs">' +
            '<button class="sbTab active" id="sbT0">🐛 Bug</button>' +
            '<button class="sbTab" id="sbT1">⭐ Feedback</button>' +
            '<button class="sbTab" id="sbT2">💡 Idea</button>' +
          '</div>' +

          /* BUG PANE */
          '<div class="sbPane active" id="sbP0">' +
            '<div class="sbLbl">Bug type</div>' +
            '<div class="sbChips" id="sbBugType">' +
              '<button class="sbChip on" data-v="ui">UI</button>' +
              '<button class="sbChip" data-v="crash">Crash</button>' +
              '<button class="sbChip" data-v="data">Wrong Data</button>' +
              '<button class="sbChip" data-v="payment">Payment</button>' +
              '<button class="sbChip" data-v="feature">Missing Feature</button>' +
              '<button class="sbChip" data-v="other">Other</button>' +
            '</div>' +
            '<div class="sbLbl">Severity</div>' +
            '<select class="sbSel" id="sbSev">' +
              '<option value="low">Low — minor annoyance</option>' +
              '<option value="medium" selected>Medium — affects usability</option>' +
              '<option value="high">High — can\'t complete task</option>' +
              '<option value="critical">Critical — crash / data loss</option>' +
            '</select>' +
            '<div class="sbLbl">What were you trying to do?</div>' +
            '<input class="sbInp" id="sbDoing" placeholder="e.g. Trying to place an order...">' +
            '<div class="sbLbl">What happened?</div>' +
            '<textarea class="sbTxt" id="sbHappened" placeholder="Describe the bug in detail..."></textarea>' +
            '<button class="sbBtn" id="sbBugBtn">Submit Bug Report</button>' +
            '<div class="sbOk" id="sbBugOk"><div class="sbOkIcon">✅</div><div class="sbOkTitle">Bug reported!</div><div class="sbOkSub">ID saved. Thanks for helping fix SOKONI.</div></div>' +
          '</div>' +

          /* FEEDBACK PANE */
          '<div class="sbPane" id="sbP1">' +
            '<div class="sbLbl">Overall experience</div>' +
            '<div class="sbStars" id="sbStars"><span class="sbStar" data-v="1">⭐</span><span class="sbStar" data-v="2">⭐</span><span class="sbStar" data-v="3">⭐</span><span class="sbStar" data-v="4">⭐</span><span class="sbStar" data-v="5">⭐</span></div>' +
            '<div class="sbLbl">What worked well?</div>' +
            '<textarea class="sbTxt" id="sbGood" placeholder="What did you like?"></textarea>' +
            '<div class="sbLbl">What needs improvement?</div>' +
            '<textarea class="sbTxt" id="sbBad" placeholder="What frustrated you?"></textarea>' +
            '<div class="sbLbl">Would you recommend SOKONI?</div>' +
            '<div class="sbChips" id="sbRec"><button class="sbChip" data-v="yes">👍 Yes</button><button class="sbChip" data-v="maybe">🤔 Maybe</button><button class="sbChip" data-v="no">👎 No</button></div>' +
            '<button class="sbBtn" id="sbFbBtn">Submit Feedback</button>' +
            '<div class="sbOk" id="sbFbOk"><div class="sbOkIcon">🙏</div><div class="sbOkTitle">Thank you!</div><div class="sbOkSub">Your feedback shapes SOKONI.</div></div>' +
          '</div>' +

          /* IDEA PANE */
          '<div class="sbPane" id="sbP2">' +
            '<div class="sbLbl">Category</div>' +
            '<div class="sbChips" id="sbIdeaCat"><button class="sbChip on" data-v="feature">New Feature</button><button class="sbChip" data-v="ux">Better UX</button><button class="sbChip" data-v="speed">Speed</button><button class="sbChip" data-v="trust">Trust & Safety</button><button class="sbChip" data-v="other">Other</button></div>' +
            '<div class="sbLbl">Your idea</div>' +
            '<textarea class="sbTxt" id="sbIdea" placeholder="Describe your idea or suggestion..."></textarea>' +
            '<button class="sbBtn" id="sbIdeaBtn">Submit Idea</button>' +
            '<div class="sbOk" id="sbIdeaOk"><div class="sbOkIcon">💡</div><div class="sbOkTitle">Idea received!</div><div class="sbOkSub">We review every suggestion.</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* QUICK PROMPT */
      '<div id="sbPrompt">' +
        '<button class="sbpX" id="sbpX">✕</button>' +
        '<div class="sbpQ" id="sbpQ">How was that?</div>' +
        '<div class="sbpStars" id="sbpStars"><span class="sbpStar" data-v="1">⭐</span><span class="sbpStar" data-v="2">⭐</span><span class="sbpStar" data-v="3">⭐</span><span class="sbpStar" data-v="4">⭐</span><span class="sbpStar" data-v="5">⭐</span></div>' +
      '</div>';

    document.body.appendChild(div);

    /* ── Wire chips (single-select toggle) ── */
    document.querySelectorAll('#sbRoot .sbChips').forEach(function(g) {
      g.querySelectorAll('.sbChip').forEach(function(c) {
        c.addEventListener('click', function() {
          g.querySelectorAll('.sbChip').forEach(function(x){ x.classList.remove('on'); });
          c.classList.add('on');
        });
      });
    });

    /* ── Wire rating stars ── */
    var _rating = 0;
    document.querySelectorAll('#sbStars .sbStar').forEach(function(s) {
      s.addEventListener('click', function() {
        _rating = parseInt(s.dataset.v);
        document.querySelectorAll('#sbStars .sbStar').forEach(function(x,i){ x.classList.toggle('on', i < _rating); });
      });
    });

    /* ── Tabs ── */
    [0,1,2].forEach(function(i) {
      document.getElementById('sbT'+i).addEventListener('click', function() {
        document.querySelectorAll('.sbTab').forEach(function(t){ t.classList.remove('active'); });
        document.querySelectorAll('.sbPane').forEach(function(p){ p.classList.remove('active'); });
        document.getElementById('sbT'+i).classList.add('active');
        document.getElementById('sbP'+i).classList.add('active');
      });
    });

    /* ── FAB & close ── */
    document.getElementById('sbFab').addEventListener('click', function(){ SokoniWidget.open(); });
    document.getElementById('sbCloseBtn').addEventListener('click', function(){ SokoniWidget.close(); });
    document.getElementById('sbOverlay').addEventListener('click', function(e){ if(e.target===this) SokoniWidget.close(); });

    /* ── Bug submit ── */
    document.getElementById('sbBugBtn').addEventListener('click', function() {
      var happened = (document.getElementById('sbHappened').value||'').trim();
      if (!happened) { (window._skToast||alert)('Please describe what happened.'); return; }
      SokoniBeta.reportBug({
        type    : (document.querySelector('#sbBugType .on')||{}).dataset?.v || 'other',
        severity: document.getElementById('sbSev').value,
        doing   : (document.getElementById('sbDoing').value||'').trim(),
        happened: happened,
      });
      document.getElementById('sbBugBtn').style.display='none';
      document.getElementById('sbBugOk').style.display='block';
      var b=document.getElementById('sbFabBadge'); b.textContent='!'; b.style.display='block';
      setTimeout(function(){ SokoniWidget.close(); },2200);
    });

    /* ── Feedback submit ── */
    document.getElementById('sbFbBtn').addEventListener('click', function() {
      SokoniBeta.submitFeedback({
        type     : 'full',
        rating   : _rating,
        good     : (document.getElementById('sbGood').value||'').trim(),
        bad      : (document.getElementById('sbBad').value||'').trim(),
        recommend: (document.querySelector('#sbRec .on')||{}).dataset?.v || '',
      });
      document.getElementById('sbFbBtn').style.display='none';
      document.getElementById('sbFbOk').style.display='block';
      setTimeout(function(){ SokoniWidget.close(); },2200);
    });

    /* ── Idea submit ── */
    document.getElementById('sbIdeaBtn').addEventListener('click', function() {
      var idea = (document.getElementById('sbIdea').value||'').trim();
      if (!idea) { (window._skToast||alert)('Please describe your idea.'); return; }
      SokoniBeta.submitFeedback({
        type    : 'idea',
        category: (document.querySelector('#sbIdeaCat .on')||{}).dataset?.v || 'feature',
        idea    : idea,
      });
      document.getElementById('sbIdeaBtn').style.display='none';
      document.getElementById('sbIdeaOk').style.display='block';
      setTimeout(function(){ SokoniWidget.close(); },2200);
    });

    /* ── Quick prompt stars ── */
    var _promptCtx = {};
    document.querySelectorAll('#sbpStars .sbpStar').forEach(function(s) {
      s.addEventListener('click', function() {
        var v = parseInt(s.dataset.v);
        SokoniBeta.submitFeedback(Object.assign({ type:'quick', rating:v }, _promptCtx));
        document.querySelectorAll('#sbpStars .sbpStar').forEach(function(x,i){ x.classList.toggle('on', i<v); });
        setTimeout(function(){ SokoniWidget.dismissPrompt(); },700);
      });
    });
    document.getElementById('sbpX').addEventListener('click', function(){ SokoniWidget.dismissPrompt(); });
  }

  /* ── Public API ── */
  window.SokoniWidget = {
    open : function() {
      document.getElementById('sbOverlay').classList.add('open');
      SokoniBeta.track('widget_opened');
    },
    close: function() { document.getElementById('sbOverlay').classList.remove('open'); },

    prompt: function(question, context, delayMs) {
      setTimeout(function() {
        var p = document.getElementById('sbPrompt'); if (!p) return;
        document.getElementById('sbpQ').textContent = question || 'How was that?';
        document.querySelectorAll('#sbpStars .sbpStar').forEach(function(s){ s.classList.remove('on'); });
        var ctx = context || {}; ctx._question = question;
        document.getElementById('sbPrompt')._ctx = ctx;
        var _promptCtx = ctx;  // closure update
        p.style.display = 'block';
        clearTimeout(p._t);
        p._t = setTimeout(function(){ SokoniWidget.dismissPrompt(); }, 18000);
      }, delayMs || 0);
    },

    dismissPrompt: function() {
      var p = document.getElementById('sbPrompt');
      if (p) { p.style.display='none'; clearTimeout(p._t); }
    },
  };

  /* ── Inject when DOM ready ── */
  _ensureBeta(function() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _inject);
    } else {
      _inject();
    }
  });

})();

