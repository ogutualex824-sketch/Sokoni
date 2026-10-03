/* sokoni-merchant-food.js — FOOD HUB GATE 2: Menu · Drinks · Kitchen inside merchant-v2 (owner brief 2026-10-03).
 *
 * ONE module, three views (ctx.view = 'menu' | 'drinks' | 'kitchen'), mounted by the merchant-v2 shell like every other
 * ported surface: mount(host, ctx) → { refresh, destroy }.
 *
 * IT DECIDES NOTHING. Every fact comes from a server authority:
 *   - whether the view is open  → providerDispatch {op:'businessWorkspace'} (approval → category → capability →
 *                                 merchantModules). Pending / non-food / unreadable → the server's own state, no menu.
 *   - the menu itself           → foodMenu {op:'load'} (canonical products/{id}; drinks = the same products in drinks
 *                                 sections — the Drinks view is a FILTER of the one list, never a copy).
 *   - every change              → foodMenu ops (saveSections / saveItem / setStatus / setAvailability / archive /
 *                                 reorder). Nothing is written from here; a success message appears only after the
 *                                 server answers ok.
 *   - photos                    → the shell's existing product photo pipeline (SokoniMerchantData.attachProductImages),
 *                                 the ONE media entry point products already use.
 *   - opening stock             → merchantAdjustStock (the one stock authority), never a field written here.
 *   - your role                 → foodMenu load returns it; edit controls render only for roles the server accepts
 *                                 (owner / manager edit; cashier marks availability). The server re-checks every call.
 *
 * KITCHEN is NOT live: the server reports it NOT_IMPLEMENTED (FOOD_ORDERS_PENDING) until food orders exist (Gate 3).
 * The view shows the board it will become and the exact dependency — no orders, no counts, no demo tickets.
 *
 * Every string from the server is escaped before it reaches innerHTML.
 */
(function (root) {
  'use strict';
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var kes = function (n) { return typeof n === 'number' && isFinite(n) ? 'KES ' + n.toLocaleString('en-KE', { maximumFractionDigits: 2 }) : '—'; };
  var EDITORS = ['owner', 'manager'];
  var AVAIL_EDITORS = ['owner', 'manager', 'cashier'];
  var AV_LABEL = { available: 'Available', unavailable: 'Unavailable', temporarily_unavailable: 'Back soon' };
  var REASON = {
    NOT_APPROVED: 'Your food business is not approved yet. Your menu opens as soon as SOKONI approves it.',
    PENDING_APPROVAL: 'Your food business application is with SOKONI for review.',
    MODULE_NOT_APPLICABLE: 'Menus are for approved food businesses. Your business is registered as another kind of business.',
    MODULE_NOT_IMPLEMENTED: 'This part of your workspace is not available yet.',
    ROLE_NOT_PERMITTED: 'Your role cannot make this change. Ask the shop owner or a manager.',
    PRODUCT_LIMIT_REACHED: 'Your plan does not allow another item. Upgrade your plan to add more.',
    SECTION_IN_USE: 'Move or archive the items in that section before removing it.',
    BAD_PRICE: 'Enter a price in KES greater than zero (at most 2 decimals).',
    NO_SECTION: 'Choose a section for this item.',
    ITEM_NOT_OWNED: 'That item belongs to another business.',
    WORKSPACE_UNREADABLE: 'Your business record could not be read just now. Nothing was changed.',
  };
  function why(e) {
    var r = e && e.details && e.details.reason;
    return REASON[r] || (e && e.message) || 'Something went wrong. Nothing was changed.';
  }
  var CSS_ID = 'sk-food-css';
  function css() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style'); s.id = CSS_ID;
    s.textContent = [
      '.fm{padding:14px 14px 90px;max-width:980px;margin:0 auto}',
      '.fm-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:12px}',
      '.fm-head h2{font-size:18px;font-weight:900;margin:0;flex:1 1 auto;color:var(--txt)}',
      '.fm-btn{min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--acc-line);background:var(--acc-dim);color:var(--acc);font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit}',
      '.fm-btn.ghost{border-color:var(--line);background:var(--surface-2);color:var(--txt)}',
      '.fm-btn.danger{border-color:rgba(255,82,82,.4);background:rgba(255,82,82,.08);color:var(--danger)}',
      '.fm-btn[disabled]{opacity:.45;cursor:default}',
      '.fm-search{flex:1 1 220px;min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--txt);font-size:14px;font-family:inherit}',
      '.fm-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px;-webkit-overflow-scrolling:touch}',
      '.fm-chip{flex:0 0 auto;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--txt2);font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit}',
      '.fm-chip.on{border-color:var(--acc-line);background:var(--acc-dim);color:var(--acc)}',
      '.fm-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
      '.fm-card{display:flex;gap:12px;padding:12px;border-radius:14px;background:var(--surface);border:1px solid var(--line);min-width:0}',
      '.fm-img{flex:0 0 64px;height:64px;border-radius:10px;background:var(--surface-2);object-fit:cover;display:flex;align-items:center;justify-content:center;font-size:24px;overflow:hidden}',
      '.fm-img img{width:100%;height:100%;object-fit:cover}',
      '.fm-body{flex:1 1 auto;min-width:0}',
      '.fm-name{font-weight:800;color:var(--txt);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fm-meta{font-size:12px;color:var(--txt2);margin:3px 0 8px}',
      '.fm-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}',
      '.fm-badge{font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--txt2)}',
      '.fm-badge.ok{border-color:var(--acc-line);color:var(--acc)}',
      '.fm-badge.off{border-color:rgba(255,82,82,.35);color:var(--danger)}',
      '.fm-row{display:flex;flex-wrap:wrap;gap:6px}',
      '.fm-row .fm-btn{min-height:40px;padding:0 12px;font-size:12.5px}',
      '.fm-sel{min-height:40px;border-radius:10px;border:1px solid var(--line);background:var(--surface-2);color:var(--txt);font-family:inherit;font-size:12.5px;padding:0 8px}',
      '.fm-sheet{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}',
      '@media(min-width:700px){.fm-sheet{align-items:center}}',
      '.fm-panel{width:100%;max-width:560px;max-height:92vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:18px 18px 0 0;padding:18px 16px calc(18px + var(--safe-bot,0px))}',
      '@media(min-width:700px){.fm-panel{border-radius:18px}}',
      '.fm-panel h3{margin:0 0 12px;font-size:16px;font-weight:900;color:var(--txt)}',
      '.fm-f{display:block;margin-bottom:12px}',
      '.fm-f span{display:block;font-size:12px;font-weight:700;color:var(--txt2);margin-bottom:5px}',
      '.fm-f input,.fm-f textarea,.fm-f select{width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--txt);font-size:14px;font-family:inherit}',
      '.fm-f textarea{min-height:80px;resize:vertical}',
      '.fm-err{color:var(--danger);font-size:12.5px;margin:4px 0 10px;min-height:1em}',
      '.fm-foot{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:6px}',
      '.fm-var{display:grid;grid-template-columns:1fr 120px 44px;gap:8px;margin-bottom:8px}',
      '.fm-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '@media(max-width:820px){.fm-board{grid-template-columns:1fr}}',
      '.fm-col{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px;min-height:120px}',
      '.fm-col b{display:flex;justify-content:space-between;font-size:12.5px;color:var(--txt);margin-bottom:8px}',
      '.fm-col small{color:var(--txt3);font-size:12px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function mount(host, ctx) {
    css();
    var view = ctx.view === 'drinks' ? 'drinks' : (ctx.view === 'kitchen' ? 'kitchen' : 'menu');
    var S = { destroyed: false, loading: true, error: null, gate: null, role: null, sections: [], items: [], q: '', sec: 'all', busy: {} };
    var shopId = ctx.scope && ctx.scope.ok ? ctx.scope.shopId : null;
    var root = document.createElement('div'); root.className = 'fm'; host.appendChild(root);

    function state(icon, title, body, retry) {
      root.innerHTML = '<div class="state"><span class="ico">' + icon + '</span><b>' + esc(title) + '</b><small>' + esc(body) + '</small>' +
        (retry ? '<button type="button" class="act ghost" data-fm="retry">↻ Try again</button>' : '') + '</div>';
    }
    function toast(m) { try { ctx.onToast && ctx.onToast(m); } catch (_) {} }
    function call(op, payload) { return ctx.foodMenu(Object.assign({ op: op, shopId: shopId }, payload || {})).then(function (r) { return r && r.data; }); }

    /* ── 1. THE GATE — the server's workspace answer, nothing else ── */
    function load() {
      S.loading = true; S.error = null;
      state('⏳', 'Loading…', view === 'kitchen' ? 'Opening your kitchen.' : 'Opening your menu.');
      if (!shopId) { state('🏪', 'No shop on this account', 'Your food business workspace opens once your approved shop is set up.'); return Promise.resolve(); }
      return Promise.resolve().then(function () { return ctx.workspace(); }).then(function (w) {
        if (S.destroyed) return;
        S.gate = w || null;
        var key = view;
        var mm = (w && w.merchantModules) || {};
        var m = mm[key];
        if (!w || w.state !== 'AVAILABLE' || w.route !== 'merchant-v2.html') {
          state('🍽️', 'Your food business', (w && w.message) || REASON[(w && (w.reason || w.state))] || 'Your workspace is not available yet.');
          return;
        }
        if (view === 'kitchen') {
          if (!m) { state('👨‍🍳', 'Kitchen is for food businesses', REASON.MODULE_NOT_APPLICABLE); return; }
          return kitchen(m);
        }
        if (!m) { state('🍽️', 'Menus are for food businesses', REASON.MODULE_NOT_APPLICABLE); return; }
        if (m.state !== 'AVAILABLE') { state('🍽️', 'Not available yet', REASON['MODULE_' + m.state] || REASON.MODULE_NOT_IMPLEMENTED); return; }
        return call('load').then(function (d) {
          if (S.destroyed) return;
          S.role = d.role; S.sections = d.sections || []; S.items = d.items || []; S.loading = false;
          paint();
        });
      }).catch(function (e) {
        if (S.destroyed) return;
        S.error = e; state('⚠️', 'Could not open your ' + (view === 'kitchen' ? 'kitchen' : 'menu'), why(e), true);
      });
    }

    /* ── 2. KITCHEN — the board it will be, with the exact dependency; no orders invented ── */
    function kitchen(m) {
      var live = m && m.state === 'AVAILABLE';
      var cols = [['NEW', 'Paid orders waiting to be accepted'], ['PREPARING', 'Accepted, being cooked'], ['READY', 'Ready for pickup or a rider'], ['HANDED OFF', 'Collected or out for delivery']];
      root.innerHTML = '<div class="fm-head"><h2>👨‍🍳 Kitchen</h2></div>' +
        (live ? '' : '<div class="note" style="margin:0 0 14px"><b>Kitchen opens with Food ordering.</b> This board fills from real paid food orders and moves them through the order authority. ' +
          'Customers cannot place food orders on SOKONI yet, so there are no orders to show — and none are invented.</div>') +
        '<div class="fm-board">' + cols.map(function (c) {
          return '<div class="fm-col"><b><span>' + esc(c[0]) + '</span><span>—</span></b><small>' + esc(c[1]) + '</small></div>';
        }).join('') + '</div>';
    }

    /* ── 3. MENU / DRINKS ── */
    function canEdit() { return EDITORS.indexOf(S.role) > -1; }
    function canAvail() { return AVAIL_EDITORS.indexOf(S.role) > -1; }
    function kindSections() { return S.sections.filter(function (s) { return view === 'drinks' ? s.kind === 'drinks' : true; }); }
    function visibleItems() {
      var secIds = kindSections().map(function (s) { return s.id; });
      var q = S.q.trim().toLowerCase();
      return S.items.filter(function (it) {
        if (it.status === 'archived') return false;
        if (view === 'drinks' && it.kind !== 'drinks') return false;
        if (secIds.indexOf(it.sectionId) < 0) return false;
        if (S.sec !== 'all' && it.sectionId !== S.sec) return false;
        return !q || String(it.name).toLowerCase().indexOf(q) > -1 || String(it.description || '').toLowerCase().indexOf(q) > -1;
      }).sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
    }
    function secName(id) { var s = S.sections.filter(function (x) { return x.id === id; })[0]; return s ? s.name : '—'; }

    function paint() {
      if (S.destroyed) return;
      var title = view === 'drinks' ? '🥤 Drinks' : '🍽️ Menu';
      var secs = kindSections();
      var items = visibleItems();
      var h = '<div class="fm-head"><h2>' + title + '</h2>' +
        (canEdit() ? '<button type="button" class="fm-btn ghost" data-fm="sections">Sections</button>' +
          '<button type="button" class="fm-btn" data-fm="add"' + (secs.length ? '' : ' disabled') + '>+ Add ' + (view === 'drinks' ? 'drink' : 'item') + '</button>' : '') + '</div>';
      h += '<div class="fm-head"><input class="fm-search" type="search" placeholder="Search ' + (view === 'drinks' ? 'drinks' : 'your menu') + '" aria-label="Search" value="' + esc(S.q) + '" data-fm="q"></div>';
      if (!secs.length) {
        root.innerHTML = h + '<div class="state"><span class="ico">📋</span><b>No ' + (view === 'drinks' ? 'drinks sections' : 'menu sections') + ' yet</b><small>' +
          (canEdit() ? 'Create sections such as Breakfast, Mains' + (view === 'drinks' ? ' or Soft drinks, Juices, Coffee' : ' or Drinks') + ', then add items to them.' : 'The owner or a manager sets up the menu.') +
          '</small>' + (canEdit() ? '<button type="button" class="act" data-fm="sections">Set up sections</button>' : '') + '</div>';
        return;
      }
      h += '<div class="fm-chips" role="tablist"><button type="button" class="fm-chip' + (S.sec === 'all' ? ' on' : '') + '" data-fm="sec" data-sec="all">All</button>' +
        secs.map(function (s) { return '<button type="button" class="fm-chip' + (S.sec === s.id ? ' on' : '') + '" data-fm="sec" data-sec="' + esc(s.id) + '">' + esc(s.name) + '</button>'; }).join('') + '</div>';
      if (!items.length) {
        h += '<div class="state"><span class="ico">🍴</span><b>' + (S.q ? 'Nothing matches your search' : 'No items here yet') + '</b><small>' +
          (canEdit() && !S.q ? 'Add your first ' + (view === 'drinks' ? 'drink' : 'dish') + '. It stays a draft until you publish it.' : '') + '</small></div>';
      } else {
        h += '<div class="fm-list">' + items.map(card).join('') + '</div>';
      }
      root.innerHTML = h;
    }
    function card(it) {
      var busy = !!S.busy[it.id];
      var pub = it.status === 'published';
      var av = it.availability || 'available';
      var img = it.image ? '<img src="' + esc(it.image) + '" alt="" loading="lazy">' : (it.kind === 'drinks' ? '🥤' : '🍽️');
      var stock = it.metered ? ('Stock ' + esc(it.stock)) : 'Not stock-tracked';
      var price = kes(it.price) + (it.variants && it.variants.length ? ' · ' + it.variants.length + ' sizes' : '');
      var h = '<div class="fm-card" data-id="' + esc(it.id) + '"><div class="fm-img">' + img + '</div><div class="fm-body">' +
        '<div class="fm-name">' + esc(it.name) + '</div>' +
        '<div class="fm-meta">' + esc(price) + ' · ' + esc(secName(it.sectionId)) + '</div>' +
        '<div class="fm-badges"><span class="fm-badge ' + (pub ? 'ok' : '') + '">' + (pub ? 'Published' : 'Draft') + '</span>' +
        '<span class="fm-badge ' + (av === 'available' ? 'ok' : 'off') + '">' + esc(AV_LABEL[av] || av) + '</span>' +
        '<span class="fm-badge">' + stock + '</span></div><div class="fm-row">';
      if (canEdit()) {
        h += '<button type="button" class="fm-btn ghost" data-fm="edit" data-id="' + esc(it.id) + '"' + (busy ? ' disabled' : '') + '>Edit</button>' +
          '<button type="button" class="fm-btn' + (pub ? ' ghost' : '') + '" data-fm="pub" data-id="' + esc(it.id) + '"' + (busy ? ' disabled' : '') + '>' + (pub ? 'Unpublish' : 'Publish') + '</button>' +
          '<button type="button" class="fm-btn ghost" data-fm="up" data-id="' + esc(it.id) + '" aria-label="Move up"' + (busy ? ' disabled' : '') + '>↑</button>';
      }
      if (canAvail()) {
        h += '<select class="fm-sel" data-fm="avail" data-id="' + esc(it.id) + '" aria-label="Availability"' + (busy ? ' disabled' : '') + '>' +
          [['available', 'Available'], ['unavailable', 'Unavailable'], ['temporarily_unavailable:1', 'Back in 1 hour'], ['temporarily_unavailable:4', 'Back in 4 hours'], ['temporarily_unavailable:24', 'Back tomorrow']]
            .map(function (o) { var v = o[0].split(':')[0]; return '<option value="' + o[0] + '"' + (v === av && (v !== 'temporarily_unavailable' || o[0].split(':')[1] === '1') ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
          '</select>';
      }
      if (canEdit()) h += '<button type="button" class="fm-btn danger" data-fm="archive" data-id="' + esc(it.id) + '"' + (busy ? ' disabled' : '') + '>Archive</button>';
      return h + '</div></div></div>';
    }

    /* Every change: busy → server → reload from the server. Never optimistic, never a success before the answer. */
    function act(id, op, payload, okMsg) {
      if (S.busy[id]) return;
      S.busy[id] = true; paint();
      return call(op, Object.assign({ itemId: id }, payload)).then(function () {
        toast(okMsg); return call('load');
      }).then(function (d) {
        S.busy[id] = false; if (S.destroyed) return;
        S.items = d.items || []; S.sections = d.sections || S.sections; paint();
      }).catch(function (e) { S.busy[id] = false; toast(why(e)); paint(); });
    }

    /* ── editor sheets ── */
    function sheet(html, onSubmit) {
      var el = document.createElement('div'); el.className = 'fm-sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
      el.innerHTML = '<form class="fm-panel" novalidate>' + html + '<div class="fm-err" role="alert"></div><div class="fm-foot">' +
        '<button type="button" class="fm-btn ghost" data-close>Cancel</button><button type="submit" class="fm-btn">Save</button></div></form>';
      document.body.appendChild(el);
      var form = el.querySelector('form'), err = el.querySelector('.fm-err'), save = el.querySelector('[type=submit]');
      var close = function () { el.remove(); };
      el.addEventListener('click', function (e) { if (e.target === el || (e.target.hasAttribute && e.target.hasAttribute('data-close'))) close(); });
      form.addEventListener('submit', function (e) {
        e.preventDefault(); err.textContent = ''; save.disabled = true; save.textContent = 'Saving…';
        Promise.resolve().then(function () { return onSubmit(form, el); }).then(function () { close(); }, function (x) {
          err.textContent = why(x); save.disabled = false; save.textContent = 'Save';
        });
      });
      var first = form.querySelector('input,select,textarea'); if (first && first.focus) first.focus();
      return el;
    }
    function sectionsSheet() {
      var rows = S.sections.map(function (s) { return { id: s.id, name: s.name, kind: s.kind }; });
      if (!rows.length) rows = view === 'drinks' ? [{ name: 'Soft drinks', kind: 'drinks' }, { name: 'Juices', kind: 'drinks' }] : [{ name: 'Mains', kind: 'food' }, { name: 'Drinks', kind: 'drinks' }];
      var drinksOn = !!((S.gate && S.gate.merchantModules) || {}).drinks;
      var render = function (box) {
        box.innerHTML = rows.map(function (r, i) {
          return '<div class="fm-var" data-i="' + i + '"><input aria-label="Section name" value="' + esc(r.name) + '" data-k="name" maxlength="40">' +
            '<select class="fm-sel" aria-label="Section type" data-k="kind"><option value="food"' + (r.kind === 'food' ? ' selected' : '') + '>Food</option>' +
            (drinksOn ? '<option value="drinks"' + (r.kind === 'drinks' ? ' selected' : '') + '>Drinks</option>' : '') + '</select>' +
            '<button type="button" class="fm-btn ghost" data-rm="' + i + '" aria-label="Remove section">✕</button></div>';
        }).join('');
      };
      var el = sheet('<h3>Menu sections</h3><div data-box></div><button type="button" class="fm-btn ghost" data-addsec>+ Add section</button>', function () {
        return call('saveSections', { sections: rows.filter(function (r) { return String(r.name).trim(); }) }).then(function (d) {
          S.sections = d.sections || []; toast('Sections saved'); paint();
        });
      });
      var box = el.querySelector('[data-box]'); render(box);
      el.addEventListener('input', function (e) { var row = e.target.closest('[data-i]'); if (row) rows[+row.dataset.i][e.target.dataset.k] = e.target.value; });
      el.addEventListener('change', function (e) { var row = e.target.closest('[data-i]'); if (row) rows[+row.dataset.i][e.target.dataset.k] = e.target.value; });
      el.addEventListener('click', function (e) {
        if (e.target.hasAttribute('data-addsec')) { rows.push({ name: '', kind: view === 'drinks' ? 'drinks' : 'food' }); render(box); }
        var rm = e.target.getAttribute && e.target.getAttribute('data-rm'); if (rm != null) { rows.splice(+rm, 1); render(box); }
      });
    }
    function itemSheet(it) {
      var secs = kindSections();
      var isDrink = function (sid) { var s = secs.filter(function (x) { return x.id === sid; })[0]; return s && s.kind === 'drinks'; };
      var variants = (it && it.variants ? it.variants : []).map(function (v) { return { name: v.name, price: v.price }; });
      var html = '<h3>' + (it ? 'Edit ' : 'Add ') + (view === 'drinks' ? 'drink' : 'menu item') + '</h3>' +
        '<label class="fm-f"><span>Name</span><input name="name" maxlength="120" required value="' + esc(it ? it.name : '') + '"></label>' +
        '<label class="fm-f"><span>Description</span><textarea name="description" maxlength="1000">' + esc(it ? it.description : '') + '</textarea></label>' +
        '<label class="fm-f"><span>Price (KES)</span><input name="price" inputmode="decimal" required value="' + esc(it ? it.price : '') + '"></label>' +
        '<label class="fm-f"><span>Section</span><select name="sectionId">' + secs.map(function (s) {
          return '<option value="' + esc(s.id) + '"' + ((it ? it.sectionId === s.id : S.sec === s.id) ? ' selected' : '') + '>' + esc(s.name) + (s.kind === 'drinks' ? ' (drinks)' : '') + '</option>'; }).join('') + '</select></label>' +
        '<div class="fm-f"><span>Sizes / options (optional — each with its own price)</span><div data-vars></div><button type="button" class="fm-btn ghost" data-addvar>+ Add size</button></div>' +
        '<label class="fm-f"><span>Preparation time, minutes (optional)</span><input name="prepMinutes" inputmode="numeric" value="' + esc(it && it.prepMinutes != null ? it.prepMinutes : '') + '"></label>' +
        (it ? '<label class="fm-f"><span>Add photos</span><input name="photos" type="file" accept="image/*" multiple></label>'
            : '<label class="fm-f"><span>Opening stock (optional — only for items you count, like bottled drinks)</span><input name="opening" inputmode="numeric" placeholder="Leave empty for dishes"></label>' +
              '<p class="fm-meta">You can add photos after saving. New items stay drafts until you publish them.</p>');
      var token = it ? null : ('fm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
      var el = sheet(html, function (form) {
        var f = form.elements;
        var payload = { name: f.name.value, description: f.description.value, price: f.price.value, sectionId: f.sectionId.value,
          prepMinutes: f.prepMinutes.value, variants: variants.filter(function (v) { return String(v.name).trim(); }) };
        if (it) payload.itemId = it.id; else payload.draftToken = token;
        var opening = !it && f.opening && f.opening.value.trim() !== '' ? Number(f.opening.value) : null;
        if (opening !== null && (!Number.isInteger(opening) || opening < 0 || opening > 100000)) return Promise.reject(new Error('Opening stock is a whole number.'));
        var photos = it && f.photos && f.photos.files && f.photos.files.length ? Array.prototype.slice.call(f.photos.files) : null;
        return call('saveItem', payload).then(function (d) {
          var id = d.itemId, steps = [];
          /* opening stock: the stock authority, idempotent on the item id — never a field written here */
          if (opening) steps.push(ctx.adjustStock({ productId: id, shopId: shopId, adjustmentId: 'open_' + id, delta: opening, reason: 'restock', note: 'Opening stock (menu item)' })
            .catch(function () { toast('Item saved, but its opening stock was not recorded. Set it in Inventory.'); }));
          if (photos) steps.push(ctx.attachImages(id, photos).catch(function (e) { toast('Item saved, but the photos did not upload: ' + why(e)); }));
          return Promise.all(steps).then(function () { toast(it ? 'Item saved' : 'Item added as a draft'); return call('load'); });
        }).then(function (d) { S.items = d.items || []; paint(); });
      });
      var vbox = el.querySelector('[data-vars]');
      var vr = function () {
        vbox.innerHTML = variants.map(function (v, i) {
          return '<div class="fm-var" data-v="' + i + '"><input aria-label="Size name" placeholder="e.g. 500ml" value="' + esc(v.name) + '" data-k="name" maxlength="40">' +
            '<input aria-label="Size price" inputmode="decimal" placeholder="KES" value="' + esc(v.price) + '" data-k="price">' +
            '<button type="button" class="fm-btn ghost" data-vrm="' + i + '" aria-label="Remove size">✕</button></div>';
        }).join('');
      };
      vr();
      el.addEventListener('input', function (e) { var row = e.target.closest('[data-v]'); if (row) variants[+row.dataset.v][e.target.dataset.k] = e.target.value; });
      el.addEventListener('click', function (e) {
        if (e.target.hasAttribute && e.target.hasAttribute('data-addvar')) { variants.push({ name: '', price: '' }); vr(); }
        var rm = e.target.getAttribute && e.target.getAttribute('data-vrm'); if (rm != null) { variants.splice(+rm, 1); vr(); }
      });
      return isDrink;
    }

    /* ── events ── */
    function onClick(e) {
      var t = e.target.closest ? e.target.closest('[data-fm]') : null; if (!t || !root.contains(t)) return;
      var k = t.getAttribute('data-fm'), id = t.getAttribute('data-id');
      var it = S.items.filter(function (x) { return x.id === id; })[0];
      if (k === 'retry') return load();
      if (k === 'sections') return sectionsSheet();
      if (k === 'add') return itemSheet(null);
      if (k === 'edit' && it) return itemSheet(it);
      if (k === 'sec') { S.sec = t.getAttribute('data-sec'); return paint(); }
      if (k === 'pub' && it) return act(id, 'setStatus', { status: it.status === 'published' ? 'draft' : 'published' }, it.status === 'published' ? 'Unpublished' : 'Published');
      if (k === 'archive' && it) { if (root.ownerDocument.defaultView.confirm('Archive "' + it.name + '"? It leaves your menu; its order history is kept.')) act(id, 'archive', {}, 'Archived'); return; }
      if (k === 'up' && it) {
        var list = visibleItems().filter(function (x) { return x.sectionId === it.sectionId; });
        var i = list.indexOf(it); if (i <= 0) return;
        var ids = list.map(function (x) { return x.id; }); ids.splice(i, 1); ids.splice(i - 1, 0, id);
        return act(id, 'reorder', { itemIds: ids }, 'Order updated');
      }
    }
    function onChange(e) {
      var t = e.target; if (!t || t.getAttribute('data-fm') !== 'avail') return;
      var parts = String(t.value).split(':');
      act(t.getAttribute('data-id'), 'setAvailability', { availability: parts[0], hours: parts[1] ? Number(parts[1]) : undefined }, AV_LABEL[parts[0]] || 'Updated');
    }
    function onInput(e) { if (e.target.getAttribute && e.target.getAttribute('data-fm') === 'q') { S.q = e.target.value; var pos = e.target.selectionStart; paint(); var q = root.querySelector('[data-fm="q"]'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) {} } } }
    root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('input', onInput);
    load();
    return {
      refresh: function () { return load(); },
      destroy: function () { S.destroyed = true; root.removeEventListener('click', onClick); root.removeEventListener('change', onChange); root.removeEventListener('input', onInput); root.remove(); },
      _state: S,
    };
  }

  root.SokoniMerchantFood = { mount: mount, _esc: esc };
})(typeof window !== 'undefined' ? window : globalThis);
