/* ============================================================================
   SOKONI — Digital Agreement (guided signing experience)
   sokoni-legal-sign.js

   The premium front end for the Legal Compliance Engine. Same backend
   (legalDispatch), same audit guarantees — a signable journey, not a checkbox wall.

     SokoniLegalSign.mount(el, { role, businessId, onComplete })

   Flow (professional roles):  Review → Accept → Sign → Declare → Activate
   Flow (buyer):               Review → Accept → Sign → Continue

   Design intent
   -------------
   • Feels like opening a business account with a bank. Progress rail, premium
     cards, one clear action per step, generous tap targets, mobile-first.
   • Never a wall of text: each agreement is a card with a summary, key points and
     an honest reading time. The full document opens on demand.
   • Signature: draw (finger/mouse/stylus), type a legal name rendered as a
     signature, or upload a company stamp.

   What this component does NOT do
   -------------------------------
   • It does not decide compliance — the server does (assertLegalCompliance).
   • It does not timestamp anything — the server does. A client clock is not
     evidence, so we never send one.
   • Read-tracking (dwell, scroll-to-end) is reported as EVIDENCE only. It gates
     nothing: a dwell timer is trivially faked, and blocking on it would be
     security theatre. The signature and declaration are what authorise, and both
     are validated server-side.

   Accessibility: role=dialog + ESC on the modal, visible focus rings, 44px+ tap
   targets, and a TYPED fallback for the signature — a draw-only signature would
   exclude keyboard and screen-reader users.
============================================================================ */
(function () {
  'use strict';

  if (window.SokoniLegalSign) return;

  var LEGAL_DOC = {
    'terms-of-service': 'terms.html',
    'privacy-policy': 'privacy.html',
    'cookie-policy': 'cookie-policy.html',
    'community-standards': 'community-guidelines.html',
    'acceptable-use': 'trust-and-safety.html',
    'data-processing-agreement': 'privacy.html',
    'returns-refund-policy': 'returns-policy.html',
    'merchant-agreement': 'seller-terms.html',
    'marketplace-seller-terms': 'seller-terms.html',
    'service-provider-agreement': 'provider-terms.html',
    'booking-cancellation-policy': 'provider-terms.html',
    'payment-settlement-terms': 'payment-security.html',
  };
  function docFor(id) { return LEGAL_DOC[id] || 'legal-hub.html'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function caller() {
    var fns = window.__sokoniFns ||
      (typeof firebase !== 'undefined' && firebase.functions && firebase.functions());
    if (!fns) throw new Error('SokoniLegalSign: Firebase Functions SDK not found on page.');
    return function (op, data) {
      return fns.httpsCallable('legalDispatch', { timeout: 30000 })(
        Object.assign({ op: op }, data || {})
      ).then(function (r) { return r.data; });
    };
  }

  var PROFESSIONAL = ['merchant', 'provider', 'driver', 'rider', 'property',
                      'hotel', 'restaurant', 'healthcare', 'employer'];

  var DECLARATION = [
    'The information I have provided is true and accurate.',
    'I have the authority to operate and bind this business.',
    'I will comply with the laws of Kenya.',
    'I will honour customer rights, including refunds and returns where they apply.',
    'I understand that false information may result in suspension or termination.',
    'I agree to electronic records and digital signatures under applicable law.',
  ];

  var CSS = `
.sls{--sls-card:#111214;--sls-line:rgba(255,255,255,.08);--sls-txt:rgba(255,255,255,.72);
  --sls-hd:#fff;--sls-mut:rgba(255,255,255,.45);--sls-acc:#71ff00;--sls-ok:#22c55e;
  color:var(--sls-txt);font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  max-width:640px;margin:0 auto;padding:8px 0 32px;-webkit-font-smoothing:antialiased;text-align:left}
.sls *{box-sizing:border-box}

.sls-rail{display:flex;align-items:flex-start;gap:2px;margin:0 0 26px}
.sls-step{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;position:relative;min-width:0}
.sls-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  border:1.5px solid var(--sls-line);background:var(--sls-card);color:var(--sls-mut);
  font-size:12px;font-weight:700;transition:all .3s cubic-bezier(.4,0,.2,1);flex:0 0 26px;z-index:1}
.sls-step.on .sls-dot{border-color:var(--sls-acc);color:#050505;background:var(--sls-acc);box-shadow:0 0 0 4px rgba(113,255,0,.12)}
.sls-step.done .sls-dot{border-color:var(--sls-ok);background:var(--sls-ok);color:#050505}
.sls-step span{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--sls-mut);font-weight:700;text-align:center}
.sls-step.on span{color:var(--sls-hd)}
.sls-bar{position:absolute;top:13px;left:calc(50% + 16px);right:calc(-50% + 16px);height:1.5px;background:var(--sls-line)}
.sls-step.done .sls-bar{background:var(--sls-ok)}
.sls-step:last-child .sls-bar{display:none}

.sls-hero{text-align:center;margin:0 0 24px}
.sls-hero h2{margin:0 0 8px;font-size:22px;font-weight:800;color:var(--sls-hd);letter-spacing:-.01em}
.sls-hero p{margin:0;font-size:14px;color:var(--sls-mut);line-height:1.6}

.sls-list{display:flex;flex-direction:column;gap:10px;margin:0 0 22px}
.sls-card{background:var(--sls-card);border:1px solid var(--sls-line);border-radius:14px;padding:14px 16px;
  display:flex;align-items:center;gap:12px;transition:border-color .2s,transform .15s}
.sls-card:hover{border-color:rgba(113,255,0,.24);transform:translateY(-1px)}
.sls-card.read{border-color:rgba(34,197,94,.3)}
.sls-card.read .sls-ic{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.28)}
.sls-card.read .sls-ic svg{stroke:var(--sls-ok)}
.sls-ic{width:34px;height:34px;border-radius:10px;flex:0 0 34px;display:flex;align-items:center;justify-content:center;
  background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.18)}
.sls-ic svg{width:16px;height:16px;stroke:var(--sls-acc);fill:none;stroke-width:1.6}
.sls-meta{flex:1;min-width:0}
.sls-meta b{display:block;font-size:14px;font-weight:700;color:var(--sls-hd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sls-meta small{display:block;font-size:11.5px;color:var(--sls-mut);margin-top:1px}
.sls-view{flex:0 0 auto;min-height:44px;display:inline-flex;align-items:center;padding:0 12px;border-radius:10px;
  border:1px solid var(--sls-line);background:transparent;color:var(--sls-txt);font:600 12.5px/1 inherit;cursor:pointer;transition:all .2s}
.sls-view:hover{border-color:rgba(113,255,0,.4);color:var(--sls-acc)}

.sls-confirm{display:flex;gap:12px;align-items:flex-start;background:var(--sls-card);border:1px solid var(--sls-line);
  border-radius:14px;padding:16px;margin:0 0 20px}
.sls-confirm input{width:22px;height:22px;flex:0 0 22px;margin-top:1px;accent-color:var(--sls-acc);cursor:pointer}
.sls-confirm label{font-size:14px;color:var(--sls-txt);cursor:pointer;line-height:1.55}

.sls-decl{background:var(--sls-card);border:1px solid var(--sls-line);border-radius:16px;padding:18px 20px;margin:0 0 18px}
.sls-decl h4{margin:0 0 12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--sls-mut);font-weight:700}
.sls-decl ul{margin:0;padding-left:20px}
.sls-decl li{margin:8px 0;font-size:14px;line-height:1.55;color:var(--sls-txt)}

.sls-tabs{display:flex;gap:8px;margin:0 0 12px}
.sls-tab{flex:1;min-height:44px;border-radius:11px;border:1px solid var(--sls-line);background:var(--sls-card);
  color:var(--sls-mut);font:700 13px/1 inherit;cursor:pointer;transition:all .2s}
.sls-tab.on{border-color:var(--sls-acc);color:var(--sls-acc);background:rgba(113,255,0,.07)}
.sls-pad{position:relative;background:#fff;border:1px solid var(--sls-line);border-radius:14px;height:180px;overflow:hidden;touch-action:none}
.sls-pad canvas{display:block;width:100%;height:100%;cursor:crosshair}
.sls-pad-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:13px;pointer-events:none}
.sls-pad-line{position:absolute;left:20px;right:20px;bottom:44px;height:1px;background:#dcdfe3;pointer-events:none}
.sls-stamp{display:flex;align-items:center;justify-content:center;min-height:150px;border-radius:14px;cursor:pointer;
  border:1.5px dashed var(--sls-line);background:var(--sls-card);text-align:center;padding:16px}
.sls-stamp:hover{border-color:rgba(113,255,0,.4)}
.sls-stamp span{color:var(--sls-mut);font-size:13.5px;display:block}
.sls-stamp small{display:block;margin-top:6px;font-size:11.5px;opacity:.7}
.sls-stamp img{max-height:130px;max-width:100%;object-fit:contain}
.sls-typed{width:100%;min-height:56px;padding:14px 16px;border-radius:14px;background:var(--sls-card);
  border:1px solid var(--sls-line);color:var(--sls-hd);font-size:16px;font-family:inherit;outline:none}
.sls-typed:focus{border-color:rgba(113,255,0,.45)}
.sls-preview{margin-top:12px;background:#fff;border-radius:14px;padding:18px 20px;text-align:center}
.sls-preview .sig{font-family:'Segoe Script','Brush Script MT','Snell Roundhand',cursive;font-size:30px;color:#111;line-height:1.25;word-break:break-word}
.sls-preview .rule{height:1px;background:#dcdfe3;margin:10px 0 8px}
.sls-preview .cap{font-size:11px;color:#6b7280;letter-spacing:.04em}
.sls-clear{margin-top:8px;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--sls-line);
  background:transparent;color:var(--sls-mut);font:600 12.5px/1 inherit;cursor:pointer}
.sls-clear:hover{color:var(--sls-hd)}

.sls-cta{width:100%;min-height:52px;border-radius:14px;border:none;cursor:pointer;background:var(--sls-acc);color:#050505;
  font:800 15px/1 inherit;margin-top:20px;transition:filter .2s,transform .12s}
.sls-cta:hover:not(:disabled){filter:brightness(1.08)}
.sls-cta:active:not(:disabled){transform:translateY(1px)}
.sls-cta:disabled{opacity:.4;cursor:not-allowed}
.sls-back{width:100%;min-height:44px;margin-top:10px;background:transparent;border:none;color:var(--sls-mut);
  font:600 13px/1 inherit;cursor:pointer}
.sls-back:hover{color:var(--sls-hd)}
.sls-err{margin-top:12px;padding:12px 14px;border-radius:12px;font-size:13px;background:rgba(255,60,60,.08);
  border:1px solid rgba(255,60,60,.24);color:#ff8a8a}

.sls-receipt{background:var(--sls-card);border:1px solid rgba(34,197,94,.28);border-radius:16px;padding:20px;margin:0 0 18px}
.sls-receipt h3{margin:0 0 14px;font-size:15px;color:var(--sls-ok);font-weight:800}
.sls-row{display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid var(--sls-line);font-size:12.5px}
.sls-row:last-child{border-bottom:none}
.sls-row span{color:var(--sls-mut);flex:0 0 auto}
.sls-row b{color:var(--sls-txt);font-weight:600;text-align:right;word-break:break-all;min-width:0}
.sls-badge{display:flex;align-items:center;gap:10px;background:rgba(113,255,0,.06);border:1px solid rgba(113,255,0,.22);
  border-radius:14px;padding:14px 16px;margin:0 0 18px}
.sls-badge b{color:var(--sls-acc);font-size:13.5px}
.sls-badge small{display:block;color:var(--sls-mut);font-size:11.5px;margin-top:2px}

.sls-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;
  background:rgba(0,0,0,.72);backdrop-filter:blur(4px)}
.sls-sheet{background:var(--sls-card);border:1px solid var(--sls-line);border-radius:20px 20px 0 0;width:100%;
  max-width:640px;max-height:86vh;overflow:auto;padding:22px 20px 28px;animation:slsUp .28s cubic-bezier(.4,0,.2,1)}
@keyframes slsUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
.sls-sheet h3{margin:0 0 4px;font-size:18px;color:var(--sls-hd);font-weight:800}
.sls-sheet .ver{font-size:11.5px;color:var(--sls-mut);margin-bottom:14px}
.sls-sheet h4{margin:16px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--sls-mut)}
.sls-sheet p{margin:0;font-size:14px;line-height:1.65}
.sls-sheet ul{margin:0;padding-left:18px}
.sls-sheet li{margin:6px 0;font-size:14px;line-height:1.55}
.sls-sheet .acts{display:flex;gap:10px;margin-top:22px}
.sls-sheet .acts a,.sls-sheet .acts button{flex:1;min-height:48px;border-radius:12px;display:inline-flex;align-items:center;
  justify-content:center;font:700 13.5px/1 inherit;cursor:pointer;text-decoration:none}
.sls-sheet .acts a{background:transparent;border:1px solid var(--sls-line);color:var(--sls-txt)}
.sls-sheet .acts button{background:var(--sls-acc);border:none;color:#050505}
@media(min-width:640px){.sls-modal{align-items:center}.sls-sheet{border-radius:20px}}

.sls a:focus-visible,.sls button:focus-visible,.sls input:focus-visible,.sls-sheet a:focus-visible,.sls-sheet button:focus-visible{
  outline:2px solid var(--sls-acc);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.sls *,.sls-sheet{transition:none!important;animation:none!important}}
`;

  function injectCSS() {
    if (document.getElementById('sls-css')) return;
    var s = document.createElement('style');
    s.id = 'sls-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var ICON = '<svg viewBox="0 0 16 16" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M4 1.5h5l3 3v10H4v-13Z"/><path d="M9 1.5v3h3"/><path d="M6 8.5h4M6 11h3"/></svg>';

  /* ── Signature pad ──────────────────────────────────────────────────────── */
  function SignaturePad(canvas) {
    var ctx = canvas.getContext('2d');
    var drawing = false, dirty = false, last = null;

    function size() {
      var r = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    }
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function down(e) { e.preventDefault(); drawing = true; last = pt(e); }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pt(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; dirty = true;
      if (canvas._onDirty) canvas._onDirty();
    }
    function up() { drawing = false; }

    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', up);

    size();
    return {
      isEmpty: function () { return !dirty; },
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; if (canvas._onDirty) canvas._onDirty(); },
      dataURL: function () { return canvas.toDataURL('image/png'); },
      resize: function () { var d = dirty; size(); dirty = d; },
    };
  }

  /* ── Component ──────────────────────────────────────────────────────────── */
  function mount(el, opts) {
    opts = opts || {};
    injectCSS();
    var call = caller();
    var role = opts.role || '';
    var needsDeclaration = PROFESSIONAL.indexOf(role) !== -1;
    var root = typeof el === 'string' ? document.querySelector(el) : el;
    if (!root) throw new Error('SokoniLegalSign: mount target not found.');

    var state = {
      step: 0, agreements: [], confirmed: false,
      mode: 'draw', pad: null, typed: '', stamp: null,
      declared: false, busy: false, err: '',
      read: {},                 // client-reported engagement evidence, per agreement
    };

    root.classList.add('sls');
    root.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,.45);padding:40px 0">Loading agreements…</p>';

    call('legalGetAgreements', { role: role }).then(function (res) {
      state.agreements = (res && res.agreements) ||
        ((res && res.core) || []).concat((res && res.roleSpecific) || []);
      if (!state.agreements.length) { if (opts.onComplete) opts.onComplete({ count: 0, skipped: true }); return; }
      render();
    }).catch(function (e) {
      root.innerHTML = '<div class="sls-err">Could not load agreements: ' + esc(e.message || 'unknown error') + '</div>';
    });

    function rail() {
      var steps = needsDeclaration
        ? ['Review', 'Accept', 'Sign', 'Declare', 'Activate']
        : ['Review', 'Accept', 'Sign', 'Continue'];
      return '<div class="sls-rail">' + steps.map(function (s, i) {
        var cls = i < state.step ? 'done' : (i === state.step ? 'on' : '');
        return '<div class="sls-step ' + cls + '"><div class="sls-dot">' +
          (i < state.step ? '&#10003;' : String(i + 1)) + '</div>' +
          '<span>' + s + '</span><div class="sls-bar"></div></div>';
      }).join('') + '</div>';
    }

    function cards() {
      return '<div class="sls-list">' + state.agreements.map(function (a, i) {
        var r = state.read[a.id];
        var mins = a.readingMinutes || 3;
        return '<div class="sls-card' + (r && r.opened ? ' read' : '') + '">' +
          '<div class="sls-ic">' + ICON + '</div>' +
          '<div class="sls-meta"><b>' + esc(a.name) + '</b>' +
            '<small>Version ' + esc(a.version) + ' &middot; ' + mins + ' min read</small></div>' +
          '<button class="sls-view" data-i="' + i + '">' + (r && r.opened ? 'Reviewed' : 'Review') + '</button>' +
        '</div>';
      }).join('') + '</div>';
    }

    function wireCards() {
      root.querySelectorAll('.sls-view').forEach(function (b) {
        b.addEventListener('click', function () { openModal(state.agreements[+b.dataset.i]); });
      });
    }

    function render() {
      if (state.step === 0) return renderReview();
      if (state.step === 1) return renderAccept();
      if (state.step === 2) return renderSign();
      if (state.step === 3 && needsDeclaration) return renderDeclare();
    }

    /* STEP 1 — Review */
    function renderReview() {
      root.innerHTML = rail() +
        '<div class="sls-hero"><h2>Welcome to SOKONI</h2>' +
        '<p>We’ve prepared a few important agreements that protect you, your customers ' +
        'and the SOKONI community.</p></div>' +
        cards() +
        '<button class="sls-cta" id="slsNext">Continue</button>';
      wireCards();
      root.querySelector('#slsNext').addEventListener('click', function () { state.step = 1; render(); });
    }

    /* STEP 2 — Accept (never pre-ticked: a pre-ticked box is not consent) */
    function renderAccept() {
      root.innerHTML = rail() +
        '<div class="sls-hero"><h2>Confirm your understanding</h2>' +
        '<p>You are agreeing to ' + state.agreements.length + ' document' +
        (state.agreements.length === 1 ? '' : 's') + ' as a ' + esc(role || 'user') + '.</p></div>' +
        cards() +
        '<div class="sls-confirm">' +
          '<input type="checkbox" id="slsOk"' + (state.confirmed ? ' checked' : '') + '>' +
          '<label for="slsOk">I have read and understand these agreements.</label>' +
        '</div>' +
        '<button class="sls-cta" id="slsNext"' + (state.confirmed ? '' : ' disabled') + '>Continue to signature</button>' +
        '<button class="sls-back" id="slsBack">Back</button>';
      wireCards();
      var ok = root.querySelector('#slsOk'), next = root.querySelector('#slsNext');
      ok.addEventListener('change', function () { state.confirmed = ok.checked; next.disabled = !ok.checked; });
      next.addEventListener('click', function () { if (state.confirmed) { state.step = 2; render(); } });
      root.querySelector('#slsBack').addEventListener('click', function () { state.step = 0; render(); });
    }

    /* STEP 3 — Sign */
    function renderSign() {
      var padHtml = '';
      if (state.mode === 'draw') {
        padHtml = '<div class="sls-pad"><canvas id="slsPad"></canvas><div class="sls-pad-line"></div>' +
          '<div class="sls-pad-hint" id="slsHint">Sign here</div></div>' +
          '<button class="sls-clear" id="slsClear">Clear</button>' +
          '<input class="sls-typed" id="slsName" placeholder="Full legal name (for the record)" ' +
          'autocomplete="name" value="' + esc(state.typed) + '" style="margin-top:12px">';
      } else if (state.mode === 'type') {
        padHtml = '<input class="sls-typed" id="slsName" placeholder="Type your full legal name" ' +
          'autocomplete="name" value="' + esc(state.typed) + '">' +
          '<div class="sls-preview" id="slsPrev" style="' + (state.typed ? '' : 'display:none') + '">' +
            '<div class="sig" id="slsSig">' + esc(state.typed) + '</div>' +
            '<div class="rule"></div><div class="cap">Signed digitally</div>' +
          '</div>';
      } else {
        padHtml = '<label class="sls-stamp" for="slsStampFile">' +
            (state.stamp ? '<img src="' + esc(state.stamp) + '" alt="Business stamp preview">'
                         : '<span>Upload your official company stamp or logo<small>PNG or JPG &middot; max 2 MB</small></span>') +
          '</label>' +
          '<input type="file" id="slsStampFile" accept="image/png,image/jpeg" hidden>' +
          '<input class="sls-typed" id="slsName" placeholder="Full legal name of the authorised signatory" ' +
          'autocomplete="name" value="' + esc(state.typed) + '" style="margin-top:12px">';
      }

      root.innerHTML = rail() +
        '<div class="sls-hero"><h2>Sign your agreement</h2>' +
        '<p>Draw your signature, type your full legal name' +
        (needsDeclaration ? ', or use your company stamp' : '') + '.</p></div>' +
        '<div class="sls-tabs">' +
          '<button class="sls-tab' + (state.mode === 'draw' ? ' on' : '') + '" data-m="draw">Draw</button>' +
          '<button class="sls-tab' + (state.mode === 'type' ? ' on' : '') + '" data-m="type">Type</button>' +
          (needsDeclaration ? '<button class="sls-tab' + (state.mode === 'stamp' ? ' on' : '') + '" data-m="stamp">Stamp</button>' : '') +
        '</div>' +
        padHtml +
        (state.err ? '<div class="sls-err">' + esc(state.err) + '</div>' : '') +
        '<button class="sls-cta" id="slsSign" disabled>' +
          (needsDeclaration ? 'Continue to declaration' : 'Sign &amp; activate account') + '</button>' +
        '<button class="sls-back" id="slsBack">Back</button>';

      var name = root.querySelector('#slsName');
      var signBtn = root.querySelector('#slsSign');

      function validate() {
        var hasName = name && name.value.trim().length >= 2;
        var ok = state.mode === 'type' ? hasName
               : state.mode === 'stamp' ? (!!state.stamp && hasName)
               : (state.pad && !state.pad.isEmpty() && hasName);
        signBtn.disabled = !ok;
      }

      if (state.mode === 'draw') {
        var canvas = root.querySelector('#slsPad');
        state.pad = SignaturePad(canvas);
        canvas._onDirty = function () {
          var hint = root.querySelector('#slsHint');
          if (hint) hint.style.display = state.pad.isEmpty() ? '' : 'none';
          validate();
        };
        root.querySelector('#slsClear').addEventListener('click', function () { state.pad.clear(); });
        window.addEventListener('resize', function () { if (state.pad) state.pad.resize(); });
      } else {
        state.pad = null;
      }

      if (state.mode === 'stamp') {
        var file = root.querySelector('#slsStampFile');
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { state.err = 'Stamp image must be 2 MB or smaller.'; render(); return; }
          var fr = new FileReader();
          fr.onload = function () { state.stamp = fr.result; state.err = ''; render(); };
          fr.readAsDataURL(f);
        });
      }

      name.addEventListener('input', function () {
        state.typed = name.value;
        var p = root.querySelector('#slsPrev'), s = root.querySelector('#slsSig');
        if (p && s) { s.textContent = name.value; p.style.display = name.value.trim() ? '' : 'none'; }
        validate();
      });

      root.querySelectorAll('.sls-tab').forEach(function (t) {
        t.addEventListener('click', function () { state.mode = t.dataset.m; state.err = ''; render(); });
      });
      root.querySelector('#slsBack').addEventListener('click', function () { state.step = 1; state.err = ''; render(); });
      signBtn.addEventListener('click', function () {
        state.typed = name.value.trim();
        if (needsDeclaration) { state.step = 3; state.err = ''; render(); }
        else submit();
      });
      validate();
    }

    /* STEP 4 — Professional Declaration (a separate attestation, not a 2nd checkbox) */
    function renderDeclare() {
      root.innerHTML = rail() +
        '<div class="sls-hero"><h2>Professional declaration</h2>' +
        '<p>One final confirmation before your business goes live.</p></div>' +
        '<div class="sls-decl"><h4>I declare that:</h4><ul>' +
          DECLARATION.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
        '</ul></div>' +
        '<div class="sls-confirm">' +
          '<input type="checkbox" id="slsDecl"' + (state.declared ? ' checked' : '') + '>' +
          '<label for="slsDecl">I make this declaration truthfully, as ' +
            esc(state.typed || 'the authorised representative') + '.</label>' +
        '</div>' +
        (state.err ? '<div class="sls-err">' + esc(state.err) + '</div>' : '') +
        '<button class="sls-cta" id="slsGo"' + (state.declared ? '' : ' disabled') + '>Activate my business</button>' +
        '<button class="sls-back" id="slsBack">Back</button>';

      var box = root.querySelector('#slsDecl'), go = root.querySelector('#slsGo');
      box.addEventListener('change', function () { state.declared = box.checked; go.disabled = !box.checked; });
      go.addEventListener('click', submit);
      root.querySelector('#slsBack').addEventListener('click', function () { state.step = 2; state.err = ''; render(); });
    }

    function submit() {
      if (state.busy) return;                        // a double-tap must not sign twice
      state.busy = true;
      var btn = root.querySelector('#slsGo') || root.querySelector('#slsSign');
      if (btn) { btn.disabled = true; btn.textContent = needsDeclaration ? 'Activating…' : 'Signing…'; }

      var type = state.mode === 'stamp' ? 'stamp'
               : (state.mode === 'draw' && state.pad && !state.pad.isEmpty()) ? 'drawn'
               : 'typed';
      var data = type === 'stamp' ? (state.stamp || '')
               : type === 'drawn' ? state.pad.dataURL()
               : '';

      call('legalAccept', {
        role: role,
        acceptances: state.agreements.map(function (a) { return { agreementId: a.id, version: a.version }; }),
        signature: { type: type, name: state.typed, data: data, confirmed: state.confirmed },
        declaration: needsDeclaration ? { accepted: state.declared, version: '1.0' } : { accepted: false },
        readEvidence: state.read,
        /* Device hints for display only. The server takes IP, country, User-Agent and
           the authoritative TIMESTAMP from the request itself — we deliberately do not
           send a client clock, because a client clock is not evidence. */
        meta: {
          device: navigator.platform || '',
          browser: (navigator.userAgent || '').slice(0, 180),
          language: navigator.language || '',
          businessId: opts.businessId || '',
        },
      }).then(finish).catch(function (e) {
        state.busy = false;
        state.err = (e && e.message) || 'Could not record your signature. Please try again.';
        render();
      });
    }

    /* STEP 5 — Certificate + trust badge */
    function finish(res) {
      state.step = needsDeclaration ? 4 : 3;
      var now = new Date();
      root.innerHTML = rail() +
        '<div class="sls-hero"><h2>' + (needsDeclaration ? 'Your business is active' : 'Agreement signed') + '</h2>' +
        '<p>A copy is always available in <a href="legal-centre.html" style="color:var(--sls-acc)">Account &rarr; Legal Centre</a>.</p></div>' +
        (needsDeclaration
          ? '<div class="sls-badge"><div class="sls-ic">' + ICON + '</div>' +
            '<div><b>Verified by SOKONI</b><small>' +
            esc((role || 'business').charAt(0).toUpperCase() + (role || 'business').slice(1)) +
            ' certificate issued</small></div></div>'
          : '') +
        '<div class="sls-receipt">' +
          '<h3>&#10003; Digital Acceptance Certificate</h3>' +
          '<div class="sls-row"><span>Signed by</span><b>' + esc(res.signedName || '') + '</b></div>' +
          '<div class="sls-row"><span>Role</span><b>' + esc(role || 'user') + '</b></div>' +
          '<div class="sls-row"><span>Agreements</span><b>' + (res.count || 0) + ' signed</b></div>' +
          '<div class="sls-row"><span>Signature</span><b>' + esc(res.signatureType || '') + '</b></div>' +
          (res.declarationAccepted ? '<div class="sls-row"><span>Declaration</span><b>Accepted</b></div>' : '') +
          '<div class="sls-row"><span>Certificate ID</span><b>' + esc(res.certificateId || res.acceptanceId || '') + '</b></div>' +
          /* Display-only. The RECORDED time is the server's — this local clock is
             never sent to, or stored by, the server. */
          '<div class="sls-row"><span>Shown at</span><b>' + esc(now.toLocaleString()) + ' (local)</b></div>' +
        '</div>' +
        '<button class="sls-cta" id="slsGo2">Continue</button>' +
        '<button class="sls-back" id="slsDl">Download certificate (PDF)</button>';

      root.querySelector('#slsGo2').addEventListener('click', function () {
        if (opts.onComplete) opts.onComplete(res);
      });
      root.querySelector('#slsDl').addEventListener('click', function () {
        window.open('legal-centre.html?certificate=' +
          encodeURIComponent(res.certificateId || res.acceptanceId || ''), '_blank', 'noopener');
      });
    }

    /* Agreement modal — summary, key points, full document, and read evidence */
    function openModal(a) {
      var m = document.createElement('div');
      m.className = 'sls-modal sls';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.setAttribute('aria-label', a.name);
      var points = (a.keyPoints && a.keyPoints.length) ? a.keyPoints : [
        'You keep ownership of your content and your data.',
        'SOKONI may suspend accounts that breach these terms.',
        'Disputes are handled under Kenyan law.',
      ];
      m.innerHTML = '<div class="sls-sheet">' +
        '<h3>' + esc(a.name) + '</h3>' +
        '<div class="ver">Version ' + esc(a.version) + ' &middot; ' + (a.readingMinutes || 3) + ' min read</div>' +
        '<h4>Summary</h4><p>' + esc(a.summary ||
          ('This agreement sets out the terms that apply to you as a ' + (role || 'user') +
           ' on SOKONI — your rights, your obligations, and how we handle your data.')) + '</p>' +
        '<h4>Key points</h4><ul>' + points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' +
        '<div class="acts">' +
          '<a href="' + esc(a.url || docFor(a.id)) + '" target="_blank" rel="noopener noreferrer">Read full agreement</a>' +
          '<button type="button">Close</button>' +
        '</div></div>';
      document.body.appendChild(m);

      /* Read evidence: opened, dwell time, reached the end. Recorded as EVIDENCE and
         sent to the server labelled client-reported. It gates nothing — see header. */
      var openedAt = Date.now();
      var sheet = m.querySelector('.sls-sheet');
      var rec = state.read[a.id] || { opened: false, dwellMs: 0, scrolledToEnd: false };
      rec.opened = true;
      state.read[a.id] = rec;

      function checkEnd() {
        if (sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 24) {
          state.read[a.id].scrolledToEnd = true;
        }
      }
      sheet.addEventListener('scroll', checkEnd);
      checkEnd();                                     // a short doc is already "at the end"

      function close() {
        state.read[a.id].dwellMs = (state.read[a.id].dwellMs || 0) + (Date.now() - openedAt);
        document.removeEventListener('keydown', onKey);
        m.remove();
        render();                                     // reflect the "Reviewed" state on the card
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      m.querySelector('.acts button').addEventListener('click', close);
      m.addEventListener('click', function (e) { if (e.target === m) close(); });
      document.addEventListener('keydown', onKey);
      m.querySelector('.acts button').focus();
    }
  }

  window.SokoniLegalSign = { mount: mount };
})();
