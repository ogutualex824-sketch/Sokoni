/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Disputes — the native surface (2D-2 step 4)

       merchant.html → this surface → getSellerDisputes / getDisputeDetail /
       sellerRespondToDispute / addDisputeEvidence

   ── The one thing this screen must never imply ──────────────────────────────
   That responding RESOLVES anything. `sellerRespondToDispute` sets the status to
   `seller_responded`, which means SOKONI has not decided yet. A merchant who
   reads a green tick and stops watching will miss the outcome, so the state is
   written as it is:

       Awaiting your response  →  Submitted, awaiting SOKONI review  →  Resolved by SOKONI

   The third step is never reached by anything this screen can do.

   ── And what it cannot start ────────────────────────────────────────────────
   A merchant cannot OPEN a dispute (`createDispute` refuses a non-buyer) or
   CANCEL one (`cancelDispute` is the buyer withdrawing). Rather than omitting
   those controls and leaving a merchant hunting for them, the screen explains
   where disputes come from.

   ── Scope ───────────────────────────────────────────────────────────────────
   Account-level, and labelled so. A dispute carries no `shopId`; `sellerId` is
   copied from the order. Filtering by the active shop here would invent a
   boundary the server never applied.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantDisputesUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-disputes-css';

  var CSS = [
    '#native-disputes{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mdp{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}',

    '.mdp-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mdp-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}',
    '.mdp-tabs::-webkit-scrollbar{display:none}',
    '.mdp-tab{flex:0 0 auto;min-height:44px;padding:0 15px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.mdp-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',

    '.mdp-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 18px}',

    '.mdp-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;',
      'margin-bottom:11px;width:100%;text-align:left;color:var(--txt);font-family:inherit;cursor:pointer;display:block}',
    '.mdp-card.action{border-color:rgba(255,176,32,.34)}',
    '.mdp-hd{display:flex;align-items:flex-start;gap:11px}',
    '.mdp-hd .info{flex:1;min-width:0}',
    '.mdp-nm{font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mdp-sub{font-size:11.5px;color:var(--txt3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mdp-amt{flex:0 0 auto;font-size:14px;font-weight:900;color:var(--txt2);font-variant-numeric:tabular-nums}',
    '.mdp-status{display:inline-flex;align-items:center;gap:6px;margin-top:11px;font-size:11px;font-weight:800;',
      'text-transform:uppercase;letter-spacing:.04em;padding:6px 10px;border-radius:9px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2)}',
    '.mdp-status.action{color:#ffc45e;border-color:rgba(255,176,32,.34);background:rgba(255,176,32,.10)}',
    '.mdp-status.wait{color:#64b4ff;border-color:rgba(100,180,255,.3);background:rgba(100,180,255,.10)}',
    '.mdp-status.done{color:var(--txt3)}',
    '.mdp-desc{font-size:12.5px;color:var(--txt2);line-height:1.5;margin-top:10px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',

    '.mdp-state{padding:40px 24px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mdp-state .ic{font-size:36px;margin-bottom:12px}',
    '.mdp-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mdp-banner{padding:11px 13px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);',
      'font-size:11.5px;color:var(--txt2);line-height:1.55;margin-bottom:12px}',
    '.mdp-banner b{color:var(--txt)}',

    '.mdp-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:48px;',
      'padding:0 18px;border-radius:13px;font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mdp-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mdp-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.mdp-btn[disabled]{opacity:.5;cursor:default}',
    '.mdp-btn.wide{width:100%}',

    '.mdp-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;animation:mdpFade .16s ease both}',
    '@keyframes mdpFade{from{opacity:0}to{opacity:1}}',
    '.mdp-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:92%;display:flex;',
      'flex-direction:column;animation:mdpUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mdpUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.mdp-sheet,.mdp-scrim{animation:none}}',
    '.mdp-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;border-bottom:1px solid var(--line)}',
    '.mdp-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mdp-sh-x{width:44px;height:44px;flex:0 0 auto;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer;font-family:inherit}',
    '.mdp-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.mdp-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:9px}',

    '.mdp-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:14px 0 7px}',
    '.mdp-lbl:first-child{margin-top:0}',
    '.mdp-inp{width:100%;min-height:52px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:14px;color:var(--txt);font-size:16px;font-family:inherit;outline:none;resize:vertical}',
    '.mdp-inp:focus{border-color:rgba(113,255,0,.42)}',
    '.mdp-opts{display:grid;gap:7px}',
    '.mdp-opt{min-height:52px;padding:9px 13px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);cursor:pointer;font-family:inherit;text-align:left}',
    '.mdp-opt .l{font-size:13px;font-weight:800;color:var(--txt)}',
    '.mdp-opt .h{font-size:11px;color:var(--txt3);margin-top:2px}',
    '.mdp-opt.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.10)}',
    '.mdp-opt.on .l{color:var(--acc)}',

    /* The progression a merchant is actually in — the third step is SOKONI's. */
    '.mdp-steps{display:flex;gap:0;margin:14px 0 4px}',
    '.mdp-step{flex:1;min-width:0;text-align:center;position:relative;padding-top:20px}',
    '.mdp-step::before{content:"";position:absolute;top:6px;left:50%;width:11px;height:11px;',
      'margin-left:-5.5px;border-radius:50%;background:rgba(255,255,255,.12);border:1px solid var(--line)}',
    '.mdp-step::after{content:"";position:absolute;top:11px;left:50%;right:-50%;height:1px;background:var(--line)}',
    '.mdp-step:last-child::after{display:none}',
    '.mdp-step.done::before{background:var(--acc);border-color:var(--acc)}',
    '.mdp-step.now::before{background:#ffc45e;border-color:#ffc45e}',
    '.mdp-step .k{font-size:10px;font-weight:800;color:var(--txt3);line-height:1.3;padding:0 3px;overflow-wrap:anywhere}',
    '.mdp-step.done .k,.mdp-step.now .k{color:var(--txt2)}',

    '.mdp-ev{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)}',
    '.mdp-ev:last-child{border-bottom:none}',
    '.mdp-ev .ic{flex:0 0 auto;width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,.06);',
      'display:flex;align-items:center;justify-content:center;font-size:14px}',
    '.mdp-ev .info{flex:1;min-width:0}',
    '.mdp-ev .t{font-size:12.5px;font-weight:800}',
    '.mdp-ev .d{font-size:11.5px;color:var(--txt3);margin-top:2px;overflow-wrap:anywhere}',

    '.mdp-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2);margin-top:12px}',
    '.mdp-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mdpSpin .7s linear infinite}',
    '@keyframes mdpSpin{to{transform:rotate(360deg)}}',
    '.mdp-err{padding:13px 14px;border-radius:13px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:13px;font-weight:700;line-height:1.5;margin-top:12px}',
    '.mdp-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px}',
    '.mdp-ok{text-align:center;padding:16px 6px 6px}',
    '.mdp-ok .ic{font-size:38px;margin-bottom:10px}',
    '.mdp-ok .hd{font-size:16px;font-weight:900;color:#64b4ff}',
    '@media (min-width:821px){.mdp-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%)}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var DP = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantDisputes) || null;
    if (!DP) {
      host.innerHTML = '<div class="mdp"><div class="mdp-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Disputes are unavailable</div>The disputes module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',      /* loading | not_signed_in | error | ready */
      error: null,
      tab: 'open',           /* open | all */
      disputes: [],
      sheet: null,           /* null | 'detail' | 'respond' | 'evidence' */
      current: null,
      form: {},
      busy: false,
      opError: null,
      done: null,            /* 'responded' | 'evidence' */
    };

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant disputes] ' + msg);
    }

    function load() {
      /* Disputes are ACCOUNT-scoped, so a resolved shop is not required — but a
         signed-in account is, and the surface says which is missing. */
      if (!ctx.scope || (!ctx.scope.ok && ctx.scope.reason === 'not_signed_in')) {
        S.phase = 'not_signed_in'; paint(); return Promise.resolve();
      }
      S.phase = 'loading'; paint();
      return DP.listDisputes({ callList: ctx.callList }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        S.disputes = r.disputes || [];
        S.phase = 'ready'; paint();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Your disputes could not be loaded.'; paint();
      });
    }

    function visible() {
      return S.tab === 'open' ? S.disputes.filter(function (d) { return DP.isOpen(d.status); }) : S.disputes;
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mdp">' + topHTML() + bodyHTML() + '</div>' + sheetHTML();
    }

    function topHTML() {
      var open = S.disputes.filter(function (d) { return DP.isOpen(d.status); }).length;
      return '<div class="mdp-top"><div class="mdp-tabs">' +
        '<button class="mdp-tab' + (S.tab === 'open' ? ' on' : '') + '" data-act="tab" data-t="open">' +
          'Needs attention' + (open ? ' · ' + open : '') + '</button>' +
        '<button class="mdp-tab' + (S.tab === 'all' ? ' on' : '') + '" data-act="tab" data-t="all">' +
          'All' + (S.disputes.length ? ' · ' + S.disputes.length : '') + '</button>' +
      '</div></div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mdp-body"><div class="sk-line" style="width:70%"></div>' +
          '<div class="sk-line" style="width:52%"></div><div class="sk-line" style="width:62%"></div></div>';
      }
      if (S.phase === 'not_signed_in') {
        return '<div class="mdp-body"><div class="mdp-state"><div class="ic">🔒</div>' +
          '<div class="hd">Sign in to see disputes</div>' +
          'Disputes are tied to your SOKONI account.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mdp-body"><div class="mdp-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Your disputes could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mdp-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }

      var sc = DP.scopeNote();
      var head = '<div class="mdp-banner"><b>' + esc(sc.label) + '.</b> ' + esc(sc.note) + '</div>';

      var rows = visible();
      if (!rows.length) {
        return '<div class="mdp-body">' + head + '<div class="mdp-state"><div class="ic">' +
          (S.tab === 'open' ? '✅' : '⚖️') + '</div>' +
          '<div class="hd">' + (S.tab === 'open' ? 'Nothing needs your attention' : 'No disputes') + '</div>' +
          (S.tab === 'open'
            ? 'Any dispute waiting on you will appear here. Disputes already with SOKONI are under All.'
            : 'A dispute is opened by a buyer from their order when something has gone wrong. ' +
              'When one is opened against a sale of yours, it appears here and you can respond.') +
          '</div>' + originHTML() + '</div>';
      }

      return '<div class="mdp-body">' + head + rows.map(function (d, i) {
        var st = DP.statusInfo(d.status);
        return '<button class="mdp-card' + (st.tone === 'action' ? ' action' : '') + '" data-act="open" data-i="' + i + '">' +
          '<div class="mdp-hd"><div class="info">' +
            '<div class="mdp-nm">' + esc(DP.reasonLabel(d.reason)) + '</div>' +
            '<div class="mdp-sub">Order ' + esc(d.orderId || '—') + '</div>' +
          '</div><div class="mdp-amt">' + esc(DP.formatKES(d.amount)) + '</div></div>' +
          (d.description ? '<div class="mdp-desc">' + esc(d.description) + '</div>' : '') +
          '<div class="mdp-status ' + st.tone + '">' + esc(st.label) + '</div>' +
        '</button>';
      }).join('') + originHTML() + '</div>';
    }

    /* Where disputes come from — shown instead of a control the server refuses. */
    function originHTML() {
      return '<div class="mdp-banner" style="margin:14px 0 0"><b>You cannot open a dispute here.</b> ' +
        'A dispute is raised by the buyer from their order, and SOKONI decides the outcome. ' +
        'Your part is to respond and add evidence — which is what this screen is for.</div>';
    }

    /* ── Sheets ───────────────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet || !S.current) return '';
      var inner = S.sheet === 'respond' ? respondSheet()
        : S.sheet === 'evidence' ? evidenceSheet()
        : detailSheet();
      return '<div class="mdp-scrim" data-act="close"></div>' +
        '<div class="mdp-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    }

    /* The honest progression. Step three belongs to SOKONI and is never marked
       done by anything this surface can do. */
    function stepsHTML(d) {
      var responded = !!d.sellerResponse || d.status === 'seller_responded';
      var resolved = !DP.isOpen(d.status);
      return '<div class="mdp-steps">' +
        '<div class="mdp-step done"><div class="k">Buyer raised it</div></div>' +
        '<div class="mdp-step ' + (responded ? 'done' : 'now') + '"><div class="k">' +
          (responded ? 'You responded' : 'Your response') + '</div></div>' +
        '<div class="mdp-step ' + (resolved ? 'done' : '') + '"><div class="k">' +
          (resolved ? 'SOKONI decided' : 'SOKONI reviews') + '</div></div>' +
      '</div>';
    }

    function detailSheet() {
      var d = S.current;
      var st = DP.statusInfo(d.status);
      var perms = DP.permissions(d);
      return '<div class="mdp-sh-h"><div class="t">' + esc(DP.reasonLabel(d.reason)) + '</div>' +
          '<button class="mdp-sh-x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="mdp-sh-b">' +
          '<div class="mdp-hd"><div class="info">' +
            '<div class="mdp-sub">Order ' + esc(d.orderId || '—') + '</div></div>' +
            '<div class="mdp-amt">' + esc(DP.formatKES(d.amount)) + '</div></div>' +
          stepsHTML(d) +
          '<div class="mdp-status ' + st.tone + '" style="margin-top:12px">' + esc(st.label) + '</div>' +

          '<div class="mdp-lbl">What the buyer says</div>' +
          '<div style="font-size:13px;line-height:1.55;color:var(--txt2);overflow-wrap:anywhere">' +
            esc(d.description || '—') + '</div>' +

          (d.sellerResponse
            ? '<div class="mdp-lbl">Your response</div>' +
              '<div style="font-size:13px;line-height:1.55;color:var(--txt2);overflow-wrap:anywhere">' +
                esc(d.sellerResponse) + '</div>'
            : '') +

          (d.evidence.length
            ? '<div class="mdp-lbl">Evidence (' + d.evidence.length + ')</div>' +
              d.evidence.map(function (e) {
                return '<div class="mdp-ev"><div class="ic">' + (e.addedByRole === 'seller' ? '🏪' : '🧑') + '</div>' +
                  '<div class="info"><div class="t">' + esc(DP.evidenceLabel(e.type)) + '</div>' +
                  '<div class="d">' + esc(e.description || '') + '</div></div></div>';
              }).join('')
            : '') +

          (!DP.isOpen(d.status)
            ? '<div class="mdp-note">This dispute is closed, so no further response or evidence can be added.</div>'
            : '<div class="mdp-note">Adding your side does <b>not</b> close the dispute — SOKONI reviews ' +
              'both accounts and decides. You will see the outcome here.</div>') +
        '</div>' +
        '<div class="mdp-sh-f">' +
          (perms.canRespond
            ? '<button class="mdp-btn solid wide" data-act="open-respond">Write your response</button>' : '') +
          (perms.canAddEvidence
            ? '<button class="mdp-btn ghost wide" data-act="open-evidence">＋ Add evidence</button>' : '') +
          '<button class="mdp-btn ghost wide" data-act="close">Close</button>' +
        '</div>';
    }

    function respondSheet() {
      if (S.done === 'responded') {
        return '<div class="mdp-sh-h"><div class="t">Response sent</div>' +
            '<button class="mdp-sh-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="mdp-sh-b"><div class="mdp-ok"><div class="ic">📨</div>' +
            '<div class="hd">Awaiting SOKONI review</div></div>' +
            '<div class="mdp-note" style="text-align:center">Your response is with SOKONI. ' +
            'The dispute stays open until SOKONI decides — nothing is settled yet.</div></div>' +
          '<div class="mdp-sh-f"><button class="mdp-btn solid wide" data-act="close">Done</button></div>';
      }
      return '<div class="mdp-sh-h"><div class="t">Your response</div>' +
          '<button class="mdp-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mdp-sh-b">' +
          '<div class="mdp-note" style="margin:0 0 12px">Explain what happened from your side. SOKONI reads ' +
          'this alongside the buyer\'s account before deciding.</div>' +
          '<textarea class="mdp-inp" id="mdp-response" rows="6" maxlength="2000" ' +
            'placeholder="The order was collected on the 14th and signed for…"' + (S.busy ? ' disabled' : '') + '>' +
            esc(S.form.response || '') + '</textarea>' +
          (S.opError ? '<div class="mdp-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mdp-prog"><span class="mdp-spin"></span>Sending your response…</div>' : '') +
        '</div>' +
        '<div class="mdp-sh-f">' +
          '<button class="mdp-btn solid wide" data-act="send-response"' + (S.busy ? ' disabled' : '') + '>' +
            (S.busy ? 'Sending…' : 'Send response') + '</button>' +
          '<button class="mdp-btn ghost wide" data-act="back"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    function evidenceSheet() {
      if (S.done === 'evidence') {
        return '<div class="mdp-sh-h"><div class="t">Evidence added</div>' +
            '<button class="mdp-sh-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="mdp-sh-b"><div class="mdp-ok"><div class="ic">📎</div>' +
            '<div class="hd">Awaiting SOKONI review</div></div>' +
            '<div class="mdp-note" style="text-align:center">Your evidence is on the dispute. ' +
            'SOKONI reviews everything both sides have added before deciding.</div></div>' +
          '<div class="mdp-sh-f"><button class="mdp-btn solid wide" data-act="close">Done</button></div>';
      }
      var f = S.form;
      return '<div class="mdp-sh-h"><div class="t">Add evidence</div>' +
          '<button class="mdp-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mdp-sh-b">' +
          '<div class="mdp-lbl">What kind of evidence?</div>' +
          '<div class="mdp-opts">' + DP.EVIDENCE_TYPES.map(function (t) {
            return '<button class="mdp-opt' + (f.evidenceType === t.id ? ' on' : '') + '" data-act="etype" data-v="' + t.id + '"' +
              (S.busy ? ' disabled' : '') + '><div class="l">' + esc(t.label) + '</div>' +
              '<div class="h">' + esc(t.hint) + '</div></button>';
          }).join('') + '</div>' +
          '<div class="mdp-lbl">Describe it</div>' +
          '<textarea class="mdp-inp" id="mdp-evidence" rows="4" maxlength="1000" ' +
            'placeholder="Signed delivery note from the rider, 14 April"' + (S.busy ? ' disabled' : '') + '>' +
            esc(f.description || '') + '</textarea>' +
          '<div class="mdp-lbl">Link to a photo or file (optional)</div>' +
          '<input class="mdp-inp" id="mdp-file" inputmode="url" placeholder="https://…" value="' + esc(f.fileUrl || '') + '"' +
            (S.busy ? ' disabled' : '') + '>' +
          (S.opError ? '<div class="mdp-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mdp-prog"><span class="mdp-spin"></span>Adding the evidence…</div>' : '') +
        '</div>' +
        '<div class="mdp-sh-f">' +
          '<button class="mdp-btn solid wide" data-act="send-evidence"' + (S.busy || !f.evidenceType ? ' disabled' : '') + '>' +
            (S.busy ? 'Adding…' : (!f.evidenceType ? 'Choose a kind' : 'Add evidence')) + '</button>' +
          '<button class="mdp-btn ghost wide" data-act="back"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function op(promise, onOk) {
      S.busy = true; S.opError = null; paint();
      return promise.then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        onOk(r);
      }).catch(function (e) {
        S.busy = false;
        S.opError = (e && e.message) || 'That did not work.';
        paint();
      });
    }

    function sendResponse() {
      if (S.busy || !S.current) return;
      try { DP.buildResponse({ disputeId: S.current.id, response: S.form.response }); }
      catch (e) { S.opError = e.message; paint(); return; }
      op(DP.respond({ disputeId: S.current.id, response: S.form.response, callRespond: ctx.callRespond }),
        function () {
          S.done = 'responded'; paint();
          toast('Response sent — awaiting SOKONI review', 'success');
          load();
        });
    }

    function sendEvidence() {
      if (S.busy || !S.current) return;
      var f = S.form;
      try { DP.buildEvidence({ disputeId: S.current.id, evidenceType: f.evidenceType,
        description: f.description, fileUrl: f.fileUrl }); }
      catch (e) { S.opError = e.message; paint(); return; }
      op(DP.addEvidence({ disputeId: S.current.id, evidenceType: f.evidenceType,
        description: f.description, fileUrl: f.fileUrl, callEvidence: ctx.callEvidence }),
        function () {
          S.done = 'evidence'; paint();
          toast('Evidence added — awaiting SOKONI review', 'success');
          load();
        });
    }

    function openDetail(i) {
      var rows = visible();
      var d = rows[i]; if (!d) return;
      S.current = d; S.sheet = 'detail'; S.opError = null; S.done = null; paint();
      /* Refresh from the authority: the list may predate the buyer's latest
         evidence, and a stale timeline is a merchant arguing with old facts. */
      if (typeof ctx.callDetail === 'function' && d.id) {
        DP.getDetail({ disputeId: d.id, callDetail: ctx.callDetail }).then(function (r) {
          if (r.ok && S.sheet === 'detail' && S.current && S.current.id === d.id) {
            S.current = r.dispute; paint();
          }
        }).catch(function () {});
      }
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      var i = parseInt(el.getAttribute('data-i'), 10);

      if (act === 'tab')            { S.tab = el.getAttribute('data-t') || 'open'; paint(); return; }
      if (act === 'reload')         { load(); return; }
      if (act === 'open')           { openDetail(i); return; }
      if (act === 'close')          { if (S.busy) return; S.sheet = null; S.current = null;
                                      S.form = {}; S.opError = null; S.done = null; paint(); return; }
      if (act === 'back')           { if (S.busy) return; S.sheet = 'detail'; S.form = {}; S.opError = null; paint(); return; }
      if (act === 'open-respond')   { S.sheet = 'respond'; S.form = {}; S.opError = null; S.done = null; paint(); return; }
      if (act === 'open-evidence')  { S.sheet = 'evidence'; S.form = {}; S.opError = null; S.done = null; paint(); return; }
      if (act === 'etype')          { S.form.evidenceType = el.getAttribute('data-v'); S.opError = null; paint(); return; }
      if (act === 'send-response')  { sendResponse(); return; }
      if (act === 'send-evidence')  { sendEvidence(); return; }
    }

    var FIELDS = { 'mdp-response': 'response', 'mdp-evidence': 'description', 'mdp-file': 'fileUrl' };
    function onInput(ev) {
      var el = ev.target; if (!el || !FIELDS[el.id]) return;
      S.form[FIELDS[el.id]] = el.value;
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
