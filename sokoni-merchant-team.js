/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Team — the staff surface (2D-2 step 2)

       merchant.html
          ↓
       this surface
          ↓
       listShopEmployees / listShopInvites / inviteShopEmployee /
       revokeShopInvite / removeShopEmployee
          ↓
       shopEmployees/{shopId}_{uid}
          ↓
       shops/{shopId} corroboration

   Native. No seller.html iframe, and no route through seller.js.

   ── What it will not do ─────────────────────────────────────────────────────
   seller.js's Team screen removed a person with a client-side
   `deleteDoc(shopEmployees/{id})` AND `deleteDoc(users/{id})` — the browser
   deciding who was allowed to, destroying the employment record and the person's
   user document together. This surface has no Firestore access at all; removal
   goes through `removeShopEmployee`, which DEACTIVATES so the record survives as
   evidence of who had access to a till and until when.

   Nor does it keep a local mirror. seller.js wrote every fetch into
   `localStorage.sokoniEmployees` and fell back to it when Firestore failed —
   so a revoked cashier kept appearing as staff on that device. Here a failed
   read is reported as a failure.

   ── The empty state is a real answer ────────────────────────────────────────
   A shop with no staff is a normal, common state, not an error and not a
   loading spinner that never resolves. It says so and offers the one useful
   action.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantTeam = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-team-css';

  var CSS = [
    '#native-staff{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mtm{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}',

    '.mtm-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mtm-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}',
    '.mtm-tabs::-webkit-scrollbar{display:none}',
    '.mtm-tab{flex:0 0 auto;min-height:44px;padding:0 15px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.mtm-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',

    '.mtm-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px 18px}',

    '.mtm-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);min-height:68px}',
    '.mtm-row:last-child{border-bottom:none}',
    '.mtm-av{flex:0 0 auto;width:42px;height:42px;border-radius:13px;display:flex;align-items:center;',
      'justify-content:center;font-weight:900;font-size:14px;letter-spacing:.02em}',
    '.mtm-av.manager{background:rgba(100,180,255,.16);color:#64b4ff;border:1px solid rgba(100,180,255,.3)}',
    '.mtm-av.cashier{background:rgba(113,255,0,.14);color:var(--acc);border:1px solid rgba(113,255,0,.3)}',
    '.mtm-av.inventory{background:rgba(251,191,36,.14);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}',
    '.mtm-av.support{background:rgba(192,132,252,.14);color:#c084fc;border:1px solid rgba(192,132,252,.3)}',
    '.mtm-av.pending{background:rgba(255,255,255,.06);color:var(--txt3);border:1px dashed var(--line)}',
    /* min-width:0 lets the flex child actually shrink, so a long name ellipses
       instead of widening the row and scrolling the page sideways. */
    '.mtm-info{flex:1;min-width:0}',
    '.mtm-nm{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mtm-sub{font-size:11.5px;color:var(--txt3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mtm-chip{flex:0 0 auto;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;',
      'padding:5px 9px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--txt2);border:1px solid var(--line)}',
    '.mtm-chip.pending{color:#fbbf24;border-color:rgba(251,191,36,.32);background:rgba(251,191,36,.10)}',
    '.mtm-chip.expired{color:#ff9a9a;border-color:rgba(255,90,90,.32);background:rgba(255,90,90,.10)}',
    '.mtm-kebab{flex:0 0 auto;width:44px;height:44px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-size:17px;cursor:pointer;font-family:inherit}',

    '.mtm-state{padding:44px 26px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mtm-state .ic{font-size:36px;margin-bottom:12px}',
    '.mtm-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mtm-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;',
      'padding:0 20px;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mtm-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mtm-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.mtm-btn.danger{background:rgba(255,90,90,.12);border-color:rgba(255,90,90,.34);color:#ff9a9a}',
    '.mtm-btn[disabled]{opacity:.5;cursor:default}',
    '.mtm-btn.wide{width:100%}',

    '.mtm-cta{flex:0 0 auto;padding:11px 14px;border-top:1px solid var(--line);',
      'background:linear-gradient(180deg,#0c0c0c,#080808)}',

    '.mtm-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;animation:mtmFade .16s ease both}',
    '@keyframes mtmFade{from{opacity:0}to{opacity:1}}',
    '.mtm-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:90%;display:flex;',
      'flex-direction:column;animation:mtmUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mtmUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.mtm-sheet,.mtm-scrim{animation:none}}',
    '.mtm-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;border-bottom:1px solid var(--line)}',
    '.mtm-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mtm-sh-x{width:44px;height:44px;flex:0 0 auto;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer;font-family:inherit}',
    '.mtm-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.mtm-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:9px}',

    '.mtm-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:0 0 7px}',
    '.mtm-inp{width:100%;height:52px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:0 14px;color:var(--txt);font-size:16px;font-family:inherit;outline:none}',
    '.mtm-inp:focus{border-color:rgba(113,255,0,.42)}',
    '.mtm-roles{display:grid;gap:7px;margin:14px 0}',
    '.mtm-role{min-height:56px;padding:10px 13px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);cursor:pointer;font-family:inherit;text-align:left}',
    '.mtm-role .rl{font-size:13px;font-weight:800;color:var(--txt)}',
    '.mtm-role .rh{font-size:11px;color:var(--txt3);margin-top:2px}',
    '.mtm-role.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.10)}',
    '.mtm-role.on .rl{color:var(--acc)}',

    '.mtm-link{display:flex;gap:8px;margin-top:6px}',
    '.mtm-link input{flex:1;min-width:0;height:48px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:12px;padding:0 12px;color:var(--txt);font-size:13px;font-family:inherit;outline:none}',

    '.mtm-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2)}',
    '.mtm-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mtmSpin .7s linear infinite}',
    '@keyframes mtmSpin{to{transform:rotate(360deg)}}',
    '.mtm-err{padding:13px 14px;border-radius:13px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:13px;font-weight:700;line-height:1.5;margin-top:12px}',
    '.mtm-warn{padding:12px 14px;border-radius:13px;background:rgba(255,176,32,.10);border:1px solid rgba(255,176,32,.32);',
      'color:#ffc45e;font-size:12.5px;font-weight:700;line-height:1.5;margin-bottom:12px}',
    '.mtm-ok{text-align:center;padding:16px 6px 6px}',
    '.mtm-ok .ic{font-size:38px;margin-bottom:10px}',
    '.mtm-ok .hd{font-size:17px;font-weight:900;color:var(--acc)}',
    '.mtm-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px}',
    '@media (min-width:821px){.mtm-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%)}}',
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

  /**
   * ctx:
   *   scope         resolved merchant scope (SokoniMerchantData.resolveScope)
   *   shopName      display only
   *   callList / callInvites / callInvite / callRevoke / callRemove
   *   onToast       (message, kind) => void   (optional)
   */
  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var ST = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantStaff) || null;
    if (!ST) {
      host.innerHTML = '<div class="mtm"><div class="mtm-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Team is unavailable</div>The staff module did not load. Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',      /* loading | no_shop | error | ready */
      error: null,
      tab: 'team',           /* team | invites */
      employees: [],
      invites: [],
      staleInvites: 0,
      invitesError: null,
      sheet: null,           /* null | 'invite' | 'member' */
      member: null,
      email: '',
      role: null,
      busy: false,
      opError: null,
      createdToken: null,
      copied: false,
    };

    function load() {
      if (!ctx.scope || !ctx.scope.ok) { S.phase = 'no_shop'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; paint();
      return ST.listStaff({ scope: ctx.scope, callList: ctx.callList }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        S.employees = r.employees || [];
        S.phase = 'ready';
        paint();
        return loadInvites();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Your team could not be loaded.'; paint();
      });
    }

    /* Invites load SEPARATELY and a failure here does not blank the team: the
       staff list is the more important answer, and losing it because a secondary
       read failed would be a worse screen than an honest partial one. */
    function loadInvites() {
      if (typeof ctx.callInvites !== 'function') return Promise.resolve();
      return ST.listInvites({ scope: ctx.scope, callInvites: ctx.callInvites }).then(function (r) {
        if (!r.ok) { S.invitesError = r.error; S.invites = []; }
        else { S.invites = r.invites || []; S.staleInvites = r.staleCount || 0; S.invitesError = null; }
        if (S.phase === 'ready') paint();
      }).catch(function () { /* reported through invitesError on the next read */ });
    }

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant team] ' + msg);
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mtm">' + topHTML() + bodyHTML() + ctaHTML() + '</div>' + sheetHTML();
    }

    function topHTML() {
      var pending = S.invites.length;
      return '<div class="mtm-top"><div class="mtm-tabs">' +
        '<button class="mtm-tab' + (S.tab === 'team' ? ' on' : '') + '" data-act="tab" data-t="team">' +
          'Team' + (S.employees.length ? ' · ' + S.employees.length : '') + '</button>' +
        '<button class="mtm-tab' + (S.tab === 'invites' ? ' on' : '') + '" data-act="tab" data-t="invites">' +
          'Invites' + (pending ? ' · ' + pending : '') + '</button>' +
      '</div></div>';
    }

    function ctaHTML() {
      if (S.phase !== 'ready') return '';
      return '<div class="mtm-cta"><button class="mtm-btn solid wide" data-act="open-invite">＋ Invite someone</button></div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mtm-body">' +
          '<div class="sk-line" style="width:68%"></div><div class="sk-line" style="width:50%"></div>' +
          '<div class="sk-line" style="width:60%"></div></div>';
      }
      if (S.phase === 'no_shop') {
        return '<div class="mtm-body"><div class="mtm-state"><div class="ic">🏪</div>' +
          '<div class="hd">No shop is active yet</div>' +
          'A team belongs to a shop. Once your merchant account has an approved shop, you can invite ' +
          'people to work in it.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mtm-body"><div class="mtm-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Your team could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mtm-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }
      return S.tab === 'invites' ? invitesHTML() : teamHTML();
    }

    function teamHTML() {
      if (!S.employees.length) {
        return '<div class="mtm-body"><div class="mtm-state"><div class="ic">👥</div>' +
          '<div class="hd">It is just you so far</div>' +
          'Invite a cashier, a manager or an inventory clerk and they will appear here as soon as they ' +
          'accept. You stay in control — you can remove anyone at any time.' +
          '</div></div>';
      }
      return '<div class="mtm-body">' + S.employees.map(function (e, i) {
        var role = e.role || '';
        return '<div class="mtm-row">' +
          '<div class="mtm-av ' + esc(role) + '">' + esc(ST.initials(e.name, e.email)) + '</div>' +
          '<div class="mtm-info">' +
            '<div class="mtm-nm">' + esc(e.name || e.email || 'Team member') + '</div>' +
            '<div class="mtm-sub">' + esc(e.email || '') + '</div>' +
          '</div>' +
          '<span class="mtm-chip">' + esc(ST.roleLabel(role)) + '</span>' +
          '<button class="mtm-kebab" data-act="member" data-i="' + i + '" aria-label="Manage ' +
            esc(e.name || e.email || 'team member') + '">⋯</button>' +
        '</div>';
      }).join('') + '</div>';
    }

    function invitesHTML() {
      var head = '';
      if (S.invitesError) {
        head += '<div class="mtm-err" style="margin:4px 0 12px">' + esc(S.invitesError) +
          ' <button class="mtm-btn ghost" style="min-height:36px;margin-left:6px" data-act="reload-invites">Retry</button></div>';
      }
      /* Invites created before shops were named on invites can no longer be
         accepted. Saying so beats an owner waiting for someone who cannot join. */
      if (S.staleInvites) {
        head += '<div class="mtm-warn">' + S.staleInvites + ' older invite' + (S.staleInvites === 1 ? '' : 's') +
          ' cannot be accepted any more, because they were created before invites recorded which shop they ' +
          'were for. Send a fresh invite instead — the old links simply will not work.</div>';
      }
      if (!S.invites.length) {
        return '<div class="mtm-body">' + head + '<div class="mtm-state"><div class="ic">✉️</div>' +
          '<div class="hd">No invites outstanding</div>' +
          'When you invite someone, their pending invite appears here until they accept it.' +
          '</div></div>';
      }
      return '<div class="mtm-body">' + head + S.invites.map(function (v, i) {
        return '<div class="mtm-row">' +
          '<div class="mtm-av pending">✉</div>' +
          '<div class="mtm-info">' +
            '<div class="mtm-nm">' + esc(v.email || 'Invited person') + '</div>' +
            '<div class="mtm-sub">' + esc(ST.roleLabel(v.role)) +
              (v.expired ? ' · expired' : ' · waiting to be accepted') + '</div>' +
          '</div>' +
          '<span class="mtm-chip ' + (v.expired ? 'expired' : 'pending') + '">' +
            (v.expired ? 'Expired' : 'Pending') + '</span>' +
          '<button class="mtm-kebab" data-act="copy-invite" data-i="' + i + '" aria-label="Copy invite link">⧉</button>' +
          '<button class="mtm-kebab" data-act="revoke" data-i="' + i + '" aria-label="Withdraw invite">✕</button>' +
        '</div>';
      }).join('') + '</div>';
    }

    /* ── Sheets ───────────────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet) return '';
      var inner = S.sheet === 'invite' ? inviteSheet() : memberSheet();
      return '<div class="mtm-scrim" data-act="close"></div>' +
        '<div class="mtm-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    }

    function inviteSheet() {
      if (S.createdToken) {
        var link = ST.inviteLink(S.createdToken, ctx.origin);
        return '<div class="mtm-sh-h"><div class="t">Invite ready</div>' +
            '<button class="mtm-sh-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="mtm-sh-b">' +
            '<div class="mtm-ok"><div class="ic">✉️</div><div class="hd">Share this link</div></div>' +
            '<div class="mtm-note" style="text-align:center;margin-bottom:12px">' +
              esc(S.email) + ' joins as <b>' + esc(ST.roleLabel(S.role)) + '</b> once they open it and sign in ' +
              'with that email address.</div>' +
            '<div class="mtm-link">' +
              '<input id="mtm-link" readonly value="' + esc(link || '') + '" aria-label="Invite link">' +
              '<button class="mtm-btn ghost" data-act="copy" style="min-height:48px">' +
                (S.copied ? '✓ Copied' : 'Copy') + '</button>' +
            '</div>' +
            '<div class="mtm-note">They appear in your team only after they accept — nothing is granted ' +
            'by creating the link.</div>' +
          '</div>' +
          '<div class="mtm-sh-f">' +
            '<button class="mtm-btn ghost wide" data-act="invite-another">Invite someone else</button>' +
            '<button class="mtm-btn solid wide" data-act="close">Done</button>' +
          '</div>';
      }

      return '<div class="mtm-sh-h"><div class="t">Invite someone</div>' +
          '<button class="mtm-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mtm-sh-b">' +
          '<div class="mtm-lbl">Their email address</div>' +
          '<input class="mtm-inp" id="mtm-email" type="email" inputmode="email" autocomplete="off" ' +
            'placeholder="name@example.com" value="' + esc(S.email) + '" aria-label="Email address"' +
            (S.busy ? ' disabled' : '') + '>' +
          '<div class="mtm-lbl" style="margin-top:16px">What will they do?</div>' +
          '<div class="mtm-roles">' + ST.ROLES.map(function (r) {
            return '<button class="mtm-role' + (S.role === r.id ? ' on' : '') + '" data-act="role" data-r="' + r.id + '"' +
              (S.busy ? ' disabled' : '') + '><div class="rl">' + esc(r.label) + '</div>' +
              '<div class="rh">' + esc(r.hint) + '</div></button>';
          }).join('') + '</div>' +
          (S.opError ? '<div class="mtm-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mtm-prog"><span class="mtm-spin"></span>Creating the invite…</div>' : '') +
        '</div>' +
        '<div class="mtm-sh-f">' +
          '<button class="mtm-btn solid wide" data-act="send"' + (S.busy || !S.role || !S.email ? ' disabled' : '') + '>' +
            (S.busy ? 'Creating…' : (!S.role ? 'Choose what they will do' : 'Create invite link')) + '</button>' +
          '<button class="mtm-btn ghost wide" data-act="close"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    function memberSheet() {
      var m = S.member || {};
      return '<div class="mtm-sh-h"><div class="t">' + esc(m.name || m.email || 'Team member') + '</div>' +
          '<button class="mtm-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mtm-sh-b">' +
          '<div class="mtm-row" style="border-bottom:none;padding-top:0">' +
            '<div class="mtm-av ' + esc(m.role || '') + '">' + esc(ST.initials(m.name, m.email)) + '</div>' +
            '<div class="mtm-info"><div class="mtm-nm">' + esc(m.name || m.email || 'Team member') + '</div>' +
              '<div class="mtm-sub">' + esc(m.email || '') + '</div></div>' +
            '<span class="mtm-chip">' + esc(ST.roleLabel(m.role)) + '</span>' +
          '</div>' +
          (S.opError ? '<div class="mtm-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mtm-prog" style="margin-top:12px"><span class="mtm-spin"></span>' +
                    'Removing them on the server…</div>' : '') +
          '<div class="mtm-note">Removing someone takes away their access to this shop straight away. ' +
          'Their record is kept, not deleted — you need to be able to see who had access to a till and ' +
          'until when.</div>' +
        '</div>' +
        '<div class="mtm-sh-f">' +
          '<button class="mtm-btn danger wide" data-act="remove"' + (S.busy ? ' disabled' : '') + '>' +
            (S.busy ? 'Removing…' : 'Remove from this shop') + '</button>' +
          '<button class="mtm-btn ghost wide" data-act="close"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function send() {
      if (S.busy) return;
      S.busy = true; S.opError = null; paint();
      ST.invite({
        scope: ctx.scope, email: S.email, role: S.role,
        shopName: ctx.shopName, callInvite: ctx.callInvite,
      }).then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        S.createdToken = r.token || null;
        if (!S.createdToken) { S.opError = 'The invite was created but no link came back. Check the Invites tab.'; paint(); return; }
        paint();
        toast('Invite created', 'success');
        loadInvites();
      }).catch(function (e) {
        S.busy = false;
        S.opError = (e && e.message) || 'The invite could not be created.';
        paint();
      });
    }

    function removeMember() {
      if (S.busy || !S.member) return;
      S.busy = true; S.opError = null; paint();
      ST.removeMember({ scope: ctx.scope, uid: S.member.uid, callRemove: ctx.callRemove }).then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        S.sheet = null; S.member = null;
        toast('Removed from this shop', 'success');
        /* Re-read from the server rather than splicing the local array — the
           authority is what the list must reflect. */
        load();
      }).catch(function (e) {
        S.busy = false;
        S.opError = (e && e.message) || 'That person could not be removed.';
        paint();
      });
    }

    function revoke(i) {
      var v = S.invites[i];
      if (!v || S.busy) return;
      S.busy = true; paint();
      ST.revokeInvite({ token: v.token, callRevoke: ctx.callRevoke }).then(function (r) {
        S.busy = false;
        if (!r.ok) { toast(r.error, 'error'); paint(); return; }
        toast('Invite withdrawn', 'success');
        loadInvites();
      }).catch(function () { S.busy = false; toast('The invite could not be withdrawn.', 'error'); paint(); });
    }

    function copy(text, label) {
      var nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(function () {
          S.copied = true; paint();
          toast(label || 'Copied', 'success');
        }).catch(function () { toast('The link could not be copied.', 'error'); });
        return;
      }
      toast('Copying is not available on this device.', 'error');
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      var i = parseInt(el.getAttribute('data-i'), 10);

      if (act === 'tab')            { S.tab = el.getAttribute('data-t') || 'team'; paint(); return; }
      if (act === 'reload')         { load(); return; }
      if (act === 'reload-invites') { S.invitesError = null; paint(); loadInvites(); return; }
      if (act === 'open-invite')    { S.sheet = 'invite'; S.email = ''; S.role = null;
                                      S.createdToken = null; S.opError = null; S.copied = false; paint(); return; }
      if (act === 'invite-another') { S.createdToken = null; S.email = ''; S.role = null; S.copied = false; paint(); return; }
      if (act === 'close')          { if (S.busy) return; S.sheet = null; S.member = null; S.opError = null; paint(); return; }
      if (act === 'role')           { S.role = el.getAttribute('data-r'); S.opError = null; paint(); return; }
      if (act === 'send')           { send(); return; }
      if (act === 'member')         { S.member = S.employees[i] || null; if (S.member) { S.sheet = 'member'; S.opError = null; paint(); } return; }
      if (act === 'remove')         { removeMember(); return; }
      if (act === 'revoke')         { revoke(i); return; }
      if (act === 'copy')           { copy(ST.inviteLink(S.createdToken, ctx.origin), 'Invite link copied'); return; }
      if (act === 'copy-invite')    { var v = S.invites[i]; if (v) copy(ST.inviteLink(v.token, ctx.origin), 'Invite link copied'); return; }
    }

    function onInput(ev) {
      var el = ev.target;
      if (!el) return;
      if (el.id === 'mtm-email') {
        S.email = el.value || '';
        /* Repaint only the footer so the field keeps focus and the caret. */
        var f = host.querySelector('.mtm-sh-f');
        if (f) {
          var btn = f.querySelector('[data-act="send"]');
          if (btn) {
            btn.disabled = !!(S.busy || !S.role || !S.email);
            btn.textContent = S.busy ? 'Creating…' : (!S.role ? 'Choose what they will do' : 'Create invite link');
          }
        }
      }
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
