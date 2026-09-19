/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT — PRODUCTS 2a + 2b + 2c  (list, edit, and photographs)
   ══════════════════════════════════════════════════════════════════════════════
   List, search, filter, sort and view; create, edit and delete; and attach
   photographs to a product that already exists.

   ── IT OWNS THE FORM, AND NOTHING ELSE ──────────────────────────────────────
   Every mutation goes through SokoniMerchantData's certified writer. Ownership
   checks, validation, the publication gate, the three projections and
   idempotency all live there, proven independently of this file, so a defect in
   the write path cannot arrive hidden inside a UI conversion.

   Photos are the same story: this surface CHOOSES files and reports what
   happened. attachProductImages owns the sequence — ownership, then Storage,
   then the canonical record, then the projections — so the product record is
   only ever told about addresses Storage actually returned.

   Still absent, deliberately: no stock ADJUSTMENT of an existing product (Inventory owns
   that — the editor shows the figure and sends the merchant there), no
   productCounters write, no boost or promote-to-story (2d), and no localStorage
   cache treated as authority — the list is re-READ from Firestore after every
   successful mutation.

   ── AND IT OWNS NO AUTHORITY ────────────────────────────────────────────────
       products      SokoniMerchantData.listProducts({scope, db})
                     the canonical reader, scoped by shopId — the SAME one the
                     native Inventory surface uses
       the ceiling   ctx.entitlement().uploadLimit
                     display only, from getMerchantEntitlements, which resolves
                     through subscription-catalog.entitlementFor()

       the gate      ctx.canPublish -> canPublishProduct
                     CONSULTED before any write, by the writer, never modelled
                     here. This surface performs no limit arithmetic and shows
                     the server's own refusal text rather than inventing one.

   ── PRODUCTS IS NOT INVENTORY ───────────────────────────────────────────────
   Inventory owns stock. Changing an existing product's shelf count happens ONLY through
   merchantAdjustStock, which is transactional, floors at zero, bumps inventoryVersion and files
   a stockMovements row. On EDIT this surface shows stock as a read and offers no way to change
   it; on CREATE it accepts an opening quantity, which is handed to that same server authority
   as the product's first movement rather than written as metadata. The two must not merge.

   This block previously said the surface "offers no way to change it" while `fld('stock', …)`
   rendered an editable numeric input on both create and edit, whose value reached a plain
   setDoc(merge) with no transaction and no inventoryVersion. The prose was wrong; the field was
   real. It is corrected here only because the behaviour now matches — a comment is not evidence.

   Contract: mount(host, ctx) -> { refresh, destroy }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantProducts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-products-css';
  /* Scoped by CLASS, never by host id: merchant.html names panels #native-<id>
     and merchant-v2 names them #panel-<id>. Targeting either would render this
     surface unstyled in the other shell — a defect that passes every functional
     check, and one this programme has already made once. */
  var HOST_CLASS = 'sk-mprod';
  var CSS = [
    '.sk-mprod{padding:14px 12px 96px}',
    '.pr-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}',
    '.pr-h{font-size:19px;font-weight:800;letter-spacing:-.01em}',
    '.pr-count{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55))}',
    '.pr-sub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:14px}',
    '.pr-tools{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    '.pr-search{flex:1 1 180px;min-width:0;min-height:44px;border-radius:12px;padding:0 14px;font:inherit;font-size:16px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}',
    '.pr-sel{min-height:44px;border-radius:12px;padding:0 10px;font:inherit;font-size:13px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}',
    '.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:10px}',
    '.pr-card{background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));',
    /* overflow was HIDDEN, which clipped the card's own overflow menu: measured at 390px
       the menu's top sat 37px ABOVE the card edge and was simply cut off, so Edit and
       Adjust stock were unreachable. The image keeps its rounded corners on its own
       instead of borrowing the card's clip. */
    'border-radius:14px;overflow:visible;min-width:0;display:flex;flex-direction:column}',
    '.pr-img,.pr-ph{border-radius:13px 13px 0 0}',
    /* A popup must out-rank the cards that come AFTER it in the grid, or the next card
       paints over it. Only the card whose menu is open is raised. */
    '.pr-card.menu-open{z-index:20}',
    '.pr-img{width:100%;aspect-ratio:1/1;object-fit:cover;background:rgba(255,255,255,.04);display:block}',
    '.pr-ph{width:100%;aspect-ratio:1/1;background:rgba(255,255,255,.04);display:flex;align-items:center;',
    'justify-content:center;font-size:24px;color:var(--txt2,rgba(255,255,255,.3))}',
    '.pr-b{padding:10px 11px 4px;min-width:0}',
    '.pr-card>.pr-acts{padding:0 11px 12px;margin-top:5px}',
    '.pr-n{font-size:13px;font-weight:700;line-height:1.35;overflow:hidden;display:-webkit-box;',
    '-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
    '.pr-p{font-size:14px;font-weight:800;margin-top:5px}',
    '.pr-m{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:4px}',
    '.pr-tag{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:8px;margin-top:6px;',
    'border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.pr-tag.out{color:#ff6b6b;border-color:rgba(255,107,107,.4)}',
    '.pr-tag.draft{color:#ffb020;border-color:rgba(255,176,32,.4)}',
    '.pr-state{padding:30px 18px;text-align:center;color:var(--txt2,rgba(255,255,255,.6));font-size:13.5px;line-height:1.7}',
    '.pr-ov{padding:14px 2px 10px}',
    '.pr-ovn{font-size:30px;font-weight:900;line-height:1;letter-spacing:-.02em}',
    '.pr-ovn span{font-size:13px;font-weight:700;color:var(--txt3,#8b8b8b);margin-left:8px;letter-spacing:0}',
    '.pr-ovs{margin-top:7px;font-size:12.5px;font-weight:600;color:var(--txt3,#8b8b8b)}',
    '.pr-alert{display:flex;align-items:center;gap:8px;width:100%;margin:4px 0 12px;padding:12px 14px;',
      'border-radius:14px;border:1px solid rgba(255,176,32,.34);background:rgba(255,176,32,.10);',
      'color:inherit;font-size:13px;font-weight:800;font-family:inherit;cursor:pointer;text-align:left}',
    '.pr-alert span{margin-left:auto;font-size:11.5px;font-weight:700;color:var(--txt3,#8b8b8b);white-space:nowrap}',
    '.pr-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px;-webkit-overflow-scrolling:touch}',
    '.pr-chips::-webkit-scrollbar{display:none}',
    '.pr-chip{flex:0 0 auto;min-width:78px;padding:9px 13px;border-radius:13px;cursor:pointer;font-family:inherit;',
      'border:1px solid var(--line,rgba(255,255,255,.12));background:var(--card,#0e0e0e);color:inherit;text-align:left}',
    '.pr-chip b{display:block;font-size:17px;font-weight:900;line-height:1.15}',
    '.pr-chip small{display:block;font-size:10.5px;font-weight:700;color:var(--txt3,#8b8b8b);',
      'text-transform:uppercase;letter-spacing:.04em;margin-top:2px}',
    '.pr-chip.on{border-color:var(--acc,#71ff00);background:rgba(113,255,0,.09)}',
    '.pr-chip.warn.on{border-color:#ffb020;background:rgba(255,176,32,.12)}',
    '.pr-chip.bad.on{border-color:#ff6b6b;background:rgba(255,107,107,.12)}',
    '.pr-quick{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    /* BATCH BAR. Sticky, because a merchant ticking their way down a long shelf must not
       have to scroll back up to press print. It appears only once something is selected. */
    '.pr-batch{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
      'margin:0 0 12px;padding:10px 12px;border-radius:13px;',
      'background:rgba(113,255,0,.10);border:1px solid rgba(113,255,0,.30);',
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '.pr-batch-n{font-size:13px;font-weight:900;color:var(--acc,#71ff00);margin-right:auto}',
    '.pr-batch-b{min-height:38px;padding:9px 14px;border-radius:11px;border:0;cursor:pointer;',
      'font-family:inherit;font-size:12.5px;font-weight:800;background:var(--acc,#71ff00);color:#050505}',
    '.pr-batch-b.ghost{background:transparent;color:inherit;',
      'border:1px solid var(--line,rgba(255,255,255,.18))}',
    '.pr-batch-b[disabled]{opacity:.55;cursor:default}',
    /* THE TICK. Its own control, sized for a thumb, and raised above the image so a card
       whose photo fills the corner is still selectable. */
    '.pr-pick{position:absolute;top:7px;left:7px;z-index:10;width:26px;height:26px;border-radius:8px;',
      'cursor:pointer;font-family:inherit;font-size:14px;font-weight:900;line-height:1;',
      'display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.55);color:transparent;',
      'border:1.5px solid rgba(255,255,255,.45);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
    '.pr-pick[aria-checked="true"]{background:var(--acc,#71ff00);border-color:var(--acc,#71ff00);color:#050505}',
    '.pr-card.is-picked{border-color:var(--acc,#71ff00)}',
    '.pr-q{flex:1 1 auto;min-height:44px;padding:11px 15px;border-radius:13px;border:0;cursor:pointer;',
      'font-family:inherit;font-size:13.5px;font-weight:800;background:var(--acc,#71ff00);color:#050505}',
    '.pr-q.ghost{background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.pr-cat{font-size:11px;font-weight:700;color:var(--txt3,#8b8b8b);text-transform:uppercase;',
      'letter-spacing:.04em;margin-top:3px}',
    '.pr-pack{display:block;font-size:10.5px;font-weight:600;color:var(--txt3,#8b8b8b);margin-top:2px}',
    '.pr-tag.ok{background:rgba(113,255,0,.13);color:var(--acc,#71ff00)}',
    '.pr-tag.low{background:rgba(255,176,32,.14);color:#ffb020}',
    '.pr-tag.unk{background:rgba(255,255,255,.07);color:var(--txt3,#8b8b8b)}',
    '.pr-empty-i{font-size:40px;margin-bottom:10px}',
    /* THE PHOTO BUTTON. The native file widget rendered "Choose Files | No file chosen"
       next to a thumbnail the merchant had already picked — the control contradicted the
       screen, because a repaint rebuilds the input and a FileList cannot be restored to
       it. The state lives in _picked, so the label reads from THAT. The input stays in the
       DOM, clipped rather than display:none, so it is still reachable by keyboard. */
    '.pr-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;',
      'clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    '.pr-pickrow{display:flex;gap:8px}',
    '.pr-pickrow>.pr-pickbtn{flex:1 1 0;min-width:0}',
    '.pr-pickbtn.shoot{border-style:solid;background:rgba(113,255,0,.07);border-color:rgba(113,255,0,.3)}',
    '.pr-pickbtn{display:flex;align-items:center;justify-content:center;gap:9px;min-height:50px;',
      'border-radius:13px;border:1px dashed var(--line,rgba(255,255,255,.22));cursor:pointer;',
      'background:rgba(255,255,255,.03);color:inherit;font-weight:800;font-size:13.5px}',
    '.pr-file:focus-visible + .pr-pickbtn{outline:2px solid var(--acc,#71ff00);outline-offset:2px}',
    '@media (hover:hover){.pr-pickbtn:hover{background:rgba(255,255,255,.06);',
      'border-color:var(--acc,#71ff00)}}',
    /* Mobile: a card/list hybrid, not desktop cards shrunk. The image becomes a thumbnail
       beside the text so a one-handed merchant reads a real row. */
    '@media (max-width:520px){',
      '.pr-grid{grid-template-columns:1fr;gap:10px}',
            /* flex-direction MUST be restated: the base rule sets column, and `display:flex`
         alone does not override it — so the thumbnail sat ABOVE the text with a dead
         104px-tall gap beside it, which is not the row this comment promises. */
      '.pr-card{display:grid;grid-template-columns:104px minmax(0,1fr);gap:10px 12px;padding:10px;align-items:start}',
      '.pr-card>.pr-img,.pr-card>.pr-ph{grid-column:1;grid-row:1}',
      '.pr-card>.pr-b{grid-column:2;grid-row:1;padding:0}',
      /* .pr-b is a column flex, so its items STRETCH: the stock pill became a full-width
         bar that read as a progress meter rather than a tag. */
      '.pr-b>.pr-tag{align-self:flex-start}',
      '.pr-card>.pr-acts{grid-column:1 / -1;grid-row:2;padding:0;margin-top:0}',
      /* The info column is ~200px on a 390px screen, which is not enough for three
         side-by-side buttons: "+ Photo" wrapped onto two lines and the row grew taller
         than the thumbnail beside it. The labels stay on one line and the overflow menu
         takes a fixed square instead of an equal third. */
      '.pr-acts{gap:5px;margin-top:8px;flex-wrap:nowrap}',
      '.pr-act{min-width:0;padding:0 8px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pr-acts>.pr-act:last-child{flex:0 0 34px;padding:0}',
      '.pr-img,.pr-ph{width:104px;height:104px;aspect-ratio:auto;flex:0 0 104px;border-radius:12px}',
      '.pr-b{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}',
      '.pr-ovn{font-size:26px}',
    '}',
    /* Below ~380px the 104px thumbnail leaves too little for the price and actions. */
    '@media (max-width:380px){',
      '.pr-img,.pr-ph{width:88px;height:88px;flex:0 0 88px}',
      '.pr-act{font-size:11px;padding:0 6px}',
    '}',
    '.pr-sec{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;',
      'color:var(--txt3,#8b8b8b);margin:18px 0 8px;padding-top:14px;',
      'border-top:1px solid var(--line,rgba(255,255,255,.10))}',
    '.pr-mrow{display:flex;gap:8px}',
    '.pr-mrow .pr-i{flex:1;min-width:0}',
    '.pr-u{flex:0 0 92px !important;min-width:92px}',
    '.pr-dim{display:flex;gap:8px;align-items:center;margin-bottom:8px}',
    '.pr-dim span{flex:0 0 62px;font-size:12px;font-weight:700;color:var(--txt3,#8b8b8b)}',
    '.pr-dim .pr-i{flex:1;min-width:0}',
    '.pr-cust{display:flex;gap:8px;margin-bottom:8px}',
    '.pr-cust .pr-i{flex:1;min-width:0}',
    '.pr-addspec{width:100%;min-height:44px;margin-top:4px;border-radius:12px;cursor:pointer;',
      'font-family:inherit;font-size:13px;font-weight:800;background:transparent;color:inherit;',
      'border:1px dashed var(--line,rgba(255,255,255,.22))}',
    '.pr-unit{font-weight:700;color:var(--txt3,#8b8b8b);text-transform:none;letter-spacing:0}',
    '.pr-vopts{display:flex;gap:8px;margin-bottom:10px}',
    '.pr-vopts .pr-i{flex:1;min-width:0}',
    '.pr-addopt{flex:0 0 44px;border-radius:12px;cursor:pointer;font-family:inherit;font-size:16px;',
      'font-weight:800;background:transparent;color:inherit;',
      'border:1px dashed var(--line,rgba(255,255,255,.22))}',
    '.pr-vrow{display:flex;gap:8px;margin-bottom:6px}',
    '.pr-vrow .pr-i{flex:1;min-width:0}',
    '.pr-vqty{flex:0 0 84px !important;min-width:84px}',
    '.pr-vrow2{display:flex;gap:8px;margin-bottom:12px;padding-bottom:12px;',
      'border-bottom:1px solid var(--line,rgba(255,255,255,.07))}',
    '.pr-vrow2 .pr-i{flex:1;min-width:0;font-size:12.5px}',
    '.pr-vtot{margin-top:10px;padding:11px 13px;border-radius:12px;font-size:12.5px;font-weight:700;',
      'background:rgba(113,255,0,.07);border:1px solid rgba(113,255,0,.22)}',
    '.pr-vtot b{font-weight:900}',
    '.pr-card{cursor:pointer;position:relative}',
    /* Opens DOWNWARD from the action row it belongs to. Anchored at the card's bottom
       edge rather than 52px above it, so it never covers the product whose menu it is. */
    '.pr-menu{position:absolute;right:10px;top:calc(100% - 6px);bottom:auto;z-index:6;min-width:186px;padding:6px;',
      'border-radius:14px;background:var(--card,#141414);border:1px solid var(--line,rgba(255,255,255,.16));',
      'box-shadow:0 18px 44px rgba(0,0,0,.5)}',
    '.pr-menu button{display:block;width:100%;text-align:left;padding:11px 12px;border:0;border-radius:10px;',
      'background:transparent;color:inherit;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer}',
    '.pr-menu button.danger{color:#ff6b6b}',
    '.pr-detail{padding-bottom:18px}',
    '.pr-dimg{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:16px;display:block;margin-bottom:14px}',
    '.pr-dph{width:100%;aspect-ratio:1/1;border-radius:16px;display:flex;align-items:center;',
      'justify-content:center;font-size:52px;background:rgba(255,255,255,.04);margin-bottom:14px}',
    '.pr-dname{font-size:21px;font-weight:900;line-height:1.2;letter-spacing:-.01em}',
    '.pr-dprice{font-size:24px;font-weight:900;color:var(--acc,#71ff00);margin-top:5px}',
    '.pr-dpill{margin-top:9px}',
    '.pr-dgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:9px;margin-top:16px}',
    '.pr-dcell{padding:11px 12px;border-radius:12px;background:rgba(255,255,255,.04)}',
    '.pr-dcell small{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;',
      'letter-spacing:.05em;color:var(--txt3,#8b8b8b)}',
    '.pr-dcell b{display:block;font-size:14px;font-weight:800;margin-top:3px}',
    '.pr-ddesc{margin-top:14px;font-size:13.5px;line-height:1.6;color:var(--txt2,#c9c9c9)}',
    '.pr-dspec,.pr-dvar{display:flex;align-items:center;gap:10px;padding:9px 0;',
      'border-bottom:1px solid var(--line,rgba(255,255,255,.07));font-size:13px}',
    '.pr-dspec span,.pr-dvar span{flex:1;color:var(--txt3,#8b8b8b);font-weight:600}',
    '.pr-dspec b,.pr-dvar b{font-weight:800}',
    '.pr-dvar i{font-style:normal;font-weight:800;color:var(--acc,#71ff00);margin-left:10px}',
    '.pr-dacts{display:grid;gap:8px;margin-top:18px}',
    '.pr-dacts .pr-btn.danger{color:#ff6b6b;border-color:rgba(255,107,107,.34)}',
    '.pr-picks{display:grid;gap:10px;margin-bottom:10px}',
    '.pr-pick{display:flex;gap:11px;align-items:flex-start;padding:10px;border-radius:14px;',
      'background:rgba(255,255,255,.04);position:relative}',
    '.pr-pimg{width:82px;height:82px;flex:0 0 82px;border-radius:11px;object-fit:cover;',
      'background:rgba(255,255,255,.06);display:block}',
    '.pr-ptools{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start}',
    '.pr-ptool{padding:8px 11px;border-radius:10px;cursor:pointer;font-family:inherit;font-size:12px;',
      'font-weight:800;background:transparent;color:inherit;',
      'border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.pr-ptool[disabled]{opacity:.45;cursor:default}',
    '.pr-pbusy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'border-radius:14px;background:rgba(0,0,0,.55);font-size:12.5px;font-weight:800}',





    '.pr-sk{aspect-ratio:1/1;border-radius:14px;background:var(--card,#0e0e0e);',
    'border:1px solid var(--line,rgba(255,255,255,.10));animation:prsk 1.1s ease-in-out infinite}',
    '@keyframes prsk{0%,100%{opacity:.55}50%{opacity:.85}}',
    '@media (prefers-reduced-motion:reduce){.pr-sk{animation:none}}',
    /* ── 2b: the editor ─────────────────────────────────────────────────── */
    '.pr-add{min-height:44px;border-radius:12px;padding:0 16px;cursor:pointer;font:inherit;font-weight:800;',
    'font-size:13px;background:var(--acc,#71ff00);color:#050505;border:0;white-space:nowrap}',
    '.pr-acts{display:flex;gap:6px;margin-top:9px}',
    '.pr-act{flex:1;min-height:36px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700;font-size:12px;',
    'background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.pr-act.danger{color:#ff6b6b;border-color:rgba(255,107,107,.35)}',
    '.pr-sheet{position:fixed;inset:0;z-index:var(--sk-z-sheet, 100010);display:flex;align-items:flex-end;justify-content:center}',
    '.pr-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62)}',
    '.pr-panel{position:relative;width:100%;max-width:520px;max-height:92vh;overflow:auto;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.14));',
    'border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px))}',
    '@media (min-width:600px){.pr-sheet{align-items:center}.pr-panel{border-radius:18px}}',
    '.pr-ph2{font-size:17px;font-weight:800;margin-bottom:2px}',
    '.pr-psub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:16px}',
    '.pr-f{margin-bottom:13px}',
    '.pr-l{display:block;font-size:12px;font-weight:700;margin-bottom:6px;color:var(--txt2,rgba(255,255,255,.7))}',
    /* border-box, because these are width:100% AND padded: with the default
       content-box the padding is added OUTSIDE the 100% and every field spills
       past the sheet — measured at 390px, where the file input ran off the
       right edge. */
    '.pr-i{box-sizing:border-box;width:100%;min-height:46px;border-radius:11px;padding:11px 13px;font:inherit;font-size:16px;',
    'background:rgba(255,255,255,.04);border:1px solid var(--line,rgba(255,255,255,.13));color:inherit}',
    '.pr-i:focus{outline:2px solid var(--acc,#71ff00);outline-offset:1px}',
    'textarea.pr-i{min-height:84px;resize:vertical}',
    '.pr-row{display:flex;gap:10px}.pr-row>.pr-f{flex:1;min-width:0}',
    '.pr-err{font-size:12.5px;color:#ff6b6b;margin-top:6px}',
    '.pr-note{font-size:12px;color:var(--txt2,rgba(255,255,255,.5));margin-top:5px;line-height:1.5}',
    /* ── SCAN CONTROL ─────────────────────────────────────────────────────────
       An input with a button welded to its right edge. The two share one row so the
       barcode field reads as one control, and the button keeps the 44px minimum
       target every other control here uses — a merchant taps this holding a product
       in the other hand. flex + min-width:0 so the input can actually shrink on a
       390px screen instead of pushing the button off the edge. */
    '.pr-scanrow{display:flex;gap:8px;align-items:stretch}',
    '.pr-scanrow>.pr-i{flex:1 1 auto;min-width:0}',
    '.pr-scan{flex:0 0 auto;min-height:46px;padding:0 14px;border-radius:11px;cursor:pointer;',
      'font-family:inherit;font-size:13px;font-weight:800;white-space:nowrap;',
      'border:1px solid var(--acc,#71ff00);background:rgba(113,255,0,.10);color:var(--acc,#71ff00)}',
    '.pr-scan:disabled{opacity:.5;cursor:default}',
    /* ── THE MIGRATED UPLOAD FORM ─────────────────────────────────────────────
       Sections, not one long column. The form now asks for up to forty things and a
       flat list of forty inputs is a form people abandon; grouping them under a
       heading with an emoji lets a merchant scan for the part they care about and
       skip the rest. Only the sections that apply are rendered at all. */
    '.pr-sec{border:1px solid var(--line,rgba(255,255,255,.10));border-radius:14px;',
    'padding:13px 13px 4px;margin:0 0 14px;background:rgba(255,255,255,.02)}',
    '.pr-sec-h{display:flex;align-items:center;gap:8px;margin-bottom:3px}',
    '.pr-sec-e{font-size:16px;line-height:1}',
    '.pr-sec-t{font-size:13.5px;font-weight:800;letter-spacing:.01em}',
    '.pr-sec-s{font-size:12px;color:var(--txt2,rgba(255,255,255,.5));margin-bottom:11px;line-height:1.5}',
    /* Native select, styled to match the inputs. The arrow is drawn rather than
       inherited so it looks the same on Android and iOS. */
    '.pr-sel{appearance:none;-webkit-appearance:none;padding-right:34px;cursor:pointer;',
    "background-image:url(\"data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23888' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\");",
    'background-repeat:no-repeat;background-position:right 12px center}',
    '.pr-sel option{background:#101010;color:#fff}',
    '.pr-sel optgroup{background:#0a0a0a;color:var(--brand,#71ff00);font-weight:800}',
    /* The live bulk-deal read-out. Deliberately loud: a wrong bulk tier is expensive. */
    '.pr-bulk-strip{display:flex;flex-wrap:wrap;align-items:center;gap:5px 12px;font-size:12.5px;',
    'background:rgba(0,170,255,.10);border:1px solid rgba(0,170,255,.28);color:#7fd4ff;',
    'border-radius:11px;padding:9px 11px;margin:2px 0 10px}',
    '.pr-bulk-strip b{color:#00aaff}',
    '.pr-warn--age{background:rgba(255,152,0,.10);border:1px solid rgba(255,152,0,.32);color:#ffb020}',
    '.pr-ok{font-size:12.5px;color:var(--brand,#71ff00);margin-top:8px;line-height:1.5}',
    '.pr-check{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;line-height:1.5;',
    'margin:2px 0 12px;color:var(--txt2,rgba(255,255,255,.75));cursor:pointer}',
    '.pr-check input{margin-top:2px;width:17px;height:17px;flex-shrink:0;accent-color:var(--brand,#71ff00)}',
    '.pr-ai-btn{width:100%;min-height:46px;border-radius:12px;cursor:pointer;font:inherit;',
    'font-size:14px;font-weight:800;border:1px solid rgba(113,255,0,.34);',
    'background:linear-gradient(135deg,rgba(113,255,0,.16),rgba(113,255,0,.06));',
    'color:var(--brand,#71ff00);transition:filter .15s ease,transform .12s ease}',
    '.pr-ai-btn:hover{filter:brightness(1.12)}',
    '.pr-ai-btn:active{transform:scale(.98)}',
    '.pr-ai-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.pr-foot{display:flex;gap:9px;margin-top:6px}',
    '.pr-foot>button{flex:1;min-height:48px;border-radius:12px;cursor:pointer;font:inherit;font-weight:800;font-size:14px}',
    '.pr-save{background:var(--acc,#71ff00);color:#050505;border:0}',
    '.pr-save[disabled]{opacity:.55;cursor:progress}',
    '.pr-cancel{background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.pr-danger{background:#ff6b6b;color:#0a0a0a;border:0}',
    '.pr-warn{font-size:12.5px;line-height:1.6;padding:11px 12px;border-radius:11px;margin-bottom:14px;',
    'background:rgba(255,176,32,.09);border:1px solid rgba(255,176,32,.3);color:#ffb020}',
    /* ── 2c: photos ─────────────────────────────────────────────────────── */
    '.pr-thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
    '.pr-thumb{width:74px;height:74px;object-fit:cover;border-radius:10px;background:rgba(255,255,255,.05);',
    'border:1px solid var(--line,rgba(255,255,255,.12))}',
    'input[type=file].pr-i{padding:11px 12px;line-height:1.4}',
    '.pr-block{font-size:12.5px;line-height:1.6;padding:11px 12px;border-radius:11px;margin-bottom:14px;',
    'background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);color:#ff8a8a}',
    '.pr-btn{min-height:44px;border-radius:12px;padding:0 16px;cursor:pointer;font:inherit;font-weight:700;',
    'font-size:13px;background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
  ].join('');

  function css () {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money (n) {
    var v = Number(n);
    if (!isFinite(v)) return null;          /* never "KES NaN" */
    return 'KES ' + Math.round(v).toLocaleString('en-KE');
  }

  function mount (host, ctx) {
    css();
    ctx = ctx || {};
    if (host && host.classList) host.classList.add(HOST_CLASS);

    var S = {
      rows: null,        /* null = not loaded; [] = loaded and genuinely empty */
      err: null,
      q: '',
      status: 'all',
      menu: null,        /* index of the card whose overflow menu is open; one at a time */
      sort: 'recent',
      limit: undefined,  /* undefined = unknown; -1 = unlimited */
      editor: null,      /* null = closed; otherwise the open create/edit/delete form */
      destroyed: false,
    };

    function skeleton () {
      var cells = '';
      for (var i = 0; i < 6; i++) cells += '<div class="pr-sk"></div>';
      host.innerHTML =
        '<div class="pr-top"><div class="pr-h">Products</div></div>' +
        '<div class="pr-sub">Loading your catalogue…</div>' +
        '<div class="pr-grid">' + cells + '</div>';
    }

    /* ── THE CEILING IS DISPLAYED, NEVER ENFORCED HERE ──────────────────────
       uploadLimit answers "what is my ceiling"; canPublishProduct answers "may
       I publish", and that is a WRITE question this slice never asks. Unknown
       renders as nothing at all — never as 0, and never as a guessed tier. */
    function countLine () {
      if (S.rows === null) return '';
      var n = S.rows.length;
      if (S.limit === -1) return n + ' of unlimited';
      if (typeof S.limit === 'number' && isFinite(S.limit)) return n + ' of ' + S.limit;
      return n + (n === 1 ? ' product' : ' products');
    }


    /* ── STOCK STATE, DECIDED ONCE ────────────────────────────────────────
       Every count, chip, card badge and filter below classifies through THIS, so the
       strip cannot say "5 low" while the list shows 4. lowStockThreshold is the
       merchant's own field on the product (it is in the writer's whitelist); DEFAULT_LOW
       is used only where they have not set one, and is deliberately small — inventing a
       generous threshold would put products into "needs attention" that the merchant
       never asked to be warned about. */
    var DEFAULT_LOW = 5;
    function stockState (p) {
      /* Number(null) is 0 and isFinite(0) is true, so a bare Number() would report a
         product with no stock figure as OUT OF STOCK — a definite claim about a shelf,
         made from an absent field. Same trap as Number(null) rendering "KSh 0".
         null / undefined / '' / boolean are rejected BEFORE the numeric test. */
      var raw = p.stock;
      if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return 'unknown';
      var n = Number(raw);
      if (!isFinite(n)) return 'unknown';        /* NOT "out" — unknown is not zero */
      if (n <= 0) return 'out';
      var t = Number(p.lowStockThreshold);
      if (!isFinite(t) || t < 0) t = DEFAULT_LOW;
      return n <= t ? 'low' : 'in';
    }

    function counts () {
      var c = { all: 0, in: 0, low: 0, out: 0, unknown: 0 };
      (S.rows || []).forEach(function (p) { c.all++; c[stockState(p)]++; });
      return c;
    }

    /* The overview strip. Figures come from the loaded rows and nowhere else; before rows
       exist it renders nothing rather than zeros, because 0 products and "not loaded yet"
       are different statements. */
    function overviewHTML () {
      if (!S.rows) return '';
      var c = counts();
      var chip = function (key, label, n, cls) {
        return '<button class="pr-chip' + (S.status === key ? ' on' : '') + (cls ? ' ' + cls : '') +
          '" data-pr="chip" data-chip="' + key + '" aria-pressed="' + (S.status === key ? 'true' : 'false') + '">' +
          '<b>' + n + '</b><small>' + label + '</small></button>';
      };
      return '<div class="pr-ov">' +
          '<div class="pr-ovn">' + c.all + '<span>' + (c.all === 1 ? 'product' : 'products') + '</span></div>' +
          '<div class="pr-ovs">' + c.in + ' available · ' + c.low + ' low stock · ' + c.out + ' out of stock' +
            (c.unknown ? ' · ' + c.unknown + ' stock unknown' : '') + '</div>' +
        '</div>' +
        (c.low ? '<button class="pr-alert" data-pr="chip" data-chip="low">' +
          '⚠️ ' + c.low + (c.low === 1 ? ' product needs' : ' products need') + ' attention' +
          '<span>View low stock</span></button>' : '') +
        '<div class="pr-chips">' +
          chip('all', 'All', c.all) + chip('in', 'In stock', c.in) +
          chip('low', 'Low stock', c.low, 'warn') + chip('out', 'Out of stock', c.out, 'bad') +
        '</div>';
    }

    function visible () {
      var rows = (S.rows || []).slice();
      var q = S.q.trim().toLowerCase();
      if (q) {
        /* Searchable identifiers, all of them EXISTING product fields — brand and barcode
           come from the specs model, variant SKUs and barcodes from the variants array.
           A merchant holding a scanner types a barcode; a merchant holding the product
           types its name. Both must find it. */
        rows = rows.filter(function (p) {
          var sp = p.specs || {};
          var hay = [p.name, p.title, p.sku, p.category, sp.brand, sp.barcode, sp.model];
          (p.variants || []).forEach(function (v) { hay.push(v.sku, v.barcode); });
          for (var i = 0; i < hay.length; i++) {
            if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) > -1) return true;
          }
          return false;
        });
      }
      if (S.status === 'active')  rows = rows.filter(function (p) { return p.status === 'active'; });
      if (S.status === 'draft')   rows = rows.filter(function (p) { return p.status && p.status !== 'active'; });
      /* Stock filters go through stockState — the SAME classifier the counts use, so a
         chip reading 5 cannot open a list of 4. The old 'out' test was its own
         `Number(p.stock) === 0`, which also swallowed a missing stock as "out". */
      if (S.status === 'in' || S.status === 'low' || S.status === 'out') {
        rows = rows.filter(function (p) { return stockState(p) === S.status; });
      }

      var by = S.sort;
      rows.sort(function (a, b) {
        if (by === 'name')      return String(a.name || '').localeCompare(String(b.name || ''));
        if (by === 'price-asc') return (Number(a.price) || 0) - (Number(b.price) || 0);
        if (by === 'price-desc')return (Number(b.price) || 0) - (Number(a.price) || 0);
        if (by === 'stock')     return (Number(a.stock) || 0) - (Number(b.stock) || 0);
        var at = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
        var bt = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
        return bt - at;                                  /* recent first */
      });
      return rows;
    }


    /* Stock, in the merchant's own unit. "24" alone is not an inventory figure — the
       stockUnit model exists precisely so a shop counting boxes is not read as pieces.
       An unknown stock stays an em-dash: it is not zero. */
    function stockLine (p) {
      var n = Number(p.stock);
      if (!isFinite(n)) return 'Stock —';
      var u = p.stockUnit && p.stockUnit.name ? p.stockUnit.name : null;
      var body = esc(n) + (u ? ' ' + esc(u) : (n === 1 ? ' in stock' : ' in stock'));
      var pack = p.stockUnit && p.stockUnit.perPack
        ? ' <span class="pr-pack">1 ' + esc(u || 'pack') + ' = ' + esc(p.stockUnit.perPack) +
          ' ' + esc(p.stockUnit.packUnit || 'pieces') + '</span>' : '';
      return body + (u ? ' available' : '') + pack;
    }

    /* One visible availability state per card, from the same classifier as the counts. */
    function statusPill (p) {
      var st = stockState(p);
      if (st === 'out')     return '<span class="pr-tag out">● Out of stock</span>';
      if (st === 'low')     return '<span class="pr-tag low">⚠ Low stock</span>';
      if (st === 'unknown') return '<span class="pr-tag unk">Stock unknown</span>';
      return '<span class="pr-tag ok">● In stock</span>';
    }

    function card (p, i) {
      var img = p.image || (Array.isArray(p.images) && p.images[0]) || null;
      var price = money(p.price);
      var draft = p.status && p.status !== 'active';
      var picked = !!(S.selected && S.selected[p.id]);
      return '<div class="pr-card' + (S.menu === i ? ' menu-open' : '') +
        (picked ? ' is-picked' : '') + '" data-pr="open" data-i="' + i + '" role="button" tabindex="0" ' +
        'aria-label="' + esc(p.name || 'Product') + ' — open details">' +
        /* THE TICK IS ITS OWN CONTROL, not the card. data-pr="pick" is checked before the
           card-body branch in onClick, so ticking a product never opens it — the mistake
           that makes a bulk selector infuriating on a phone. */
        '<button class="pr-pick" data-pr="pick" data-i="' + i + '" role="checkbox" ' +
          'aria-checked="' + (picked ? 'true' : 'false') + '" ' +
          'aria-label="Select ' + esc(p.name || 'product') + ' for printing">' +
          (picked ? '✓' : '') + '</button>' +
        (img ? '<img class="pr-img" loading="lazy" alt="" src="' + esc(img) + '">'
             : '<div class="pr-ph" aria-hidden="true">📦</div>') +
        '<div class="pr-b">' +
          '<div class="pr-n">' + esc(p.name || p.title || 'Untitled') + '</div>' +
          '<div class="pr-p">' + esc(price === null ? '—' : price) + '</div>' +
          /* Stock is READ here. Changing it belongs to Inventory. */
          '<div class="pr-m">' + stockLine(p) + '</div>' +
          (p.category ? '<div class="pr-cat">' + esc(p.category) + '</div>' : '') +
          statusPill(p) +
          (draft ? '<span class="pr-tag draft">' + esc(p.status) + '</span>' : '') +
        '</div>' +
          /* The actions are a child of the CARD, not of the text column: in the mobile row
             layout that column is ~200px, too narrow for three buttons — "+ Photo" wrapped,
             then ellipsised to "+ …". As a card-level row they span its full width.
             .pr-menu is position:absolute against .pr-card, so moving it changes nothing
             about where it opens.
             Indices, never interpolated ids: an id spliced into an inline handler
             is the inline-handler XSS this codebase has already been bitten by. */
          '<div class="pr-acts">' +
            '<button class="pr-act" data-pr="edit" data-i="' + i + '">✏️ Edit</button>' +
            '<button class="pr-act" data-pr="photos" data-i="' + i + '">' +
              (p.image ? '📸 Photos' : '📸 + Photo') + '</button>' +
            '<button class="pr-act" data-pr="menu" data-i="' + i + '" aria-label="More actions" ' +
              'aria-haspopup="true">⋮</button>' +
          '</div>' +
          /* The menu is ALWAYS in the DOM and toggled with [hidden], never conditionally
             rendered. Rendering it only when open removed Delete from the document for
             every closed card, so deletion existed only after a second tap — the
             certification caught exactly that. [hidden] also takes it out of the
             accessibility tree and the tab order, so a closed menu is not reachable by
             keyboard either, and toggling no longer needs a full repaint of the row. */
          '<div class="pr-menu" role="menu"' + (S.menu === i ? '' : ' hidden') + '>' +
            '<button role="menuitem" data-pr="edit" data-i="' + i + '">✏️ Edit</button>' +
            '<button role="menuitem" data-pr="go" data-route="inventory">📦 Adjust stock</button>' +
            '<button role="menuitem" data-pr="open" data-i="' + i + '">👁️ View details</button>' +
            '<button role="menuitem" data-pr="tag1" data-i="' + i + '">🖨 Print price tag</button>' +
            '<button role="menuitem" class="danger" data-pr="del" data-i="' + i + '">🗑️ Remove</button>' +
          '</div>' +
      '</div>';
    }

    function paint () {
      if (S.destroyed) return;
      if (S.rows === null && !S.err) return skeleton();

      if (S.err) {
        host.innerHTML =
          '<div class="pr-top"><div class="pr-h">Products</div></div>' +
          '<div class="pr-state">Your products couldn’t be loaded just now.<br>' +
          'This is not an empty catalogue — nothing was fetched.<br>' +
          '<button class="pr-btn" style="margin-top:14px" data-pr="retry">Try again</button></div>';
        return;
      }

      var rows = visible();
      var body;
      if (!rows.length) {
        body = '<div class="pr-state">' +
          (S.rows.length
            ? 'No products match this search or filter.<br>' +
              '<button class="pr-btn" style="margin-top:14px" data-pr="chip" data-chip="all">Clear filters</button>'
            : '<div class="pr-empty-i">🛍️</div>' +
              '<b>Your shop is ready for its first product</b><br>' +
              'Add your first item and start selling.<br>' +
              '<button class="pr-add" style="margin-top:16px" data-pr="add">＋ Add product</button>') +
          '</div>';
      } else {
        body = '<div class="pr-grid">' + rows.map(function (p, i) { return card(p, i); }).join('') + '</div>';
      }
      /* The rows the buttons index into — captured at paint time, so a filter
         change between paint and click cannot resolve to the wrong product. */
      S.painted = rows;

      host.innerHTML =
        '<div class="pr-top"><div class="pr-h">🛍️ Products</div>' +
          '<div class="pr-count">' + esc(countLine()) + '</div></div>' +
        '<div class="pr-sub">Manage your shop catalogue</div>' +
        overviewHTML() +
        /* Quick actions. Inventory is a REAL merchant-v2 route and is reached through the
           shell's own router — never a link out to the legacy shell. */
        '<div class="pr-quick">' +
          '<button class="pr-q" data-pr="add">＋ Add product</button>' +
          /* SCAN FIRST, DECIDE SECOND. Scanning an item the shop already stocks opens
             THAT product rather than starting a duplicate — the commonest way a
             catalogue acquires two records for one item is someone re-adding
             something they could not find by name. */
          '<button class="pr-q ghost" data-pr="scanadd">📷 Scan an item</button>' +
          '<button class="pr-q ghost" data-pr="go" data-route="inventory">📦 Inventory</button>' +
        '</div>' +
        '<div class="pr-tools">' +
          '<input class="pr-search" type="search" inputmode="search" placeholder="Search products" ' +
            'aria-label="Search products" value="' + esc(S.q) + '" data-pr="q">' +
          '<select class="pr-sel" aria-label="Filter by status" data-pr="status">' +
            opt('all', 'All', S.status) + opt('active', 'Active', S.status) +
            opt('draft', 'Draft', S.status) + opt('out', 'Out of stock', S.status) +
          '</select>' +
          '<select class="pr-sel" aria-label="Sort products" data-pr="sort">' +
            opt('recent', 'Newest', S.sort) + opt('name', 'Name', S.sort) +
            opt('price-asc', 'Price ↑', S.sort) + opt('price-desc', 'Price ↓', S.sort) +
            opt('stock', 'Stock', S.sort) +
          '</select>' +
        '</div>' + batchBarHTML() + body +
        (S.editor ? editorHTML() : '');
    }

    /* ── BATCH BAR ───────────────────────────────────────────────────────────
       Present only once something is ticked. A permanent bar offering to print 0 tags is
       a control that spends most of its life disabled, and a merchant learns to ignore it.

       It names the COUNT, so nobody presses print without knowing how much paper is about
       to come out — the difference between a 3-tag correction and a 40-tag shelf run. */
    function batchBarHTML () {
      var n = selectedCount();
      if (!n) return '';
      return '<div class="pr-batch" role="region" aria-label="Selected products">' +
        '<span class="pr-batch-n">' + n + ' selected</span>' +
        '<button class="pr-batch-b" data-pr="tagsel"' + (S.printing ? ' disabled' : '') + '>' +
          (S.printing ? 'Printing…' : '🖨 Print ' + n + ' price tag' + (n === 1 ? '' : 's')) +
        '</button>' +
        '<button class="pr-batch-b ghost" data-pr="pickall">Select all shown</button>' +
        '<button class="pr-batch-b ghost" data-pr="pickno">Clear</button>' +
      '</div>';
    }

    function opt (v, label, cur) {
      return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    }

    /* ── LOAD: the canonical reader, and the ceiling for display ──────────── */
    function load () {
      skeleton();
      /* A SELECTION MUST NOT OUTLIVE ITS ROWS. Reloading the catalogue can remove, rename
         or re-price anything that was ticked, and printing a tag for a record that is no
         longer on screen is how a shelf ends up with a price nobody set. */
      S.selected = {};
      var md = (typeof window !== 'undefined') && window.SokoniMerchantData;
      if (!md || typeof md.listProducts !== 'function') {
        S.err = 'SokoniMerchantData unavailable';
        return Promise.resolve(paint());
      }
      var pRows = md.listProducts({ scope: ctx.scope, db: ctx.db });
      /* Display-only. A failure here must NOT fail the list — the merchant's
         products matter more than the ceiling caption, and an unknown ceiling
         renders as nothing rather than as a number we did not read. */
      var pLimit = (typeof ctx.entitlement === 'function')
        ? Promise.resolve().then(ctx.entitlement).catch(function () { return null; })
        : Promise.resolve(null);

      return Promise.all([pRows, pLimit]).then(function (r) {
        if (S.destroyed) return;
        S.rows = Array.isArray(r[0]) ? r[0] : [];
        var ent = r[1];
        S.limit = (ent && typeof ent.uploadLimit === 'number') ? ent.uploadLimit : undefined;
        S.err = null;
        paint();
      }).catch(function (e) {
        if (S.destroyed) return;
        S.err = (e && e.message) || String(e);
        paint();
      });
    }

    /* ══ 2b — CREATE / EDIT / DELETE ═══════════════════════════════════════
       This surface owns the FORM and nothing else. Every mutation goes through
       SokoniMerchantData, which owns ownership checks, validation, the
       publication gate, the three projections and idempotency, and which is
       certified independently of this file.

       What deliberately does NOT live here:
         · no Firestore SDK import — ctx.db is the only way to touch storage
         · no plan-limit arithmetic — canPublishProduct is asked, never modelled
         · no productCounters write of any kind
         · no Storage, no image field — a product is valid without pictures and
           media attaches in 2c
         · no localStorage. A cache is never the authority for what exists; the
           list is re-read from Firestore after every successful mutation. */

    function draftToken () {
      /* One token per ATTEMPT, not per keystroke and not per product. The writer
         derives a deterministic id from it, so pressing Save twice — or retrying
         after a dropped response — claims the same document instead of creating
         a second product. It is regenerated only when a NEW form is opened. */
      return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 9);
    }

    function openEditor (mode, product) {
      S.editor = {
        mode: mode,                       /* 'create' | 'edit' | 'delete' */
        product: product || null,
        /* What the merchant has typed, held in STATE. Rendering the form from
           the product alone means any re-paint — a blocked gate, a validation
           message, the busy state — silently discards their work. */
        values: Object.assign({}, product || {}),
        token: draftToken(),
        busy: false,
        err: null,
        blocked: null,                    /* the server's refusal, verbatim */
      };
      paint();
      /* Focus the first field so a keyboard user is not dropped at the scrim. */
      var f = host.querySelector('.pr-panel [data-pf]');
      if (f && f.focus) { try { f.focus(); } catch (_) {} }
    }
    function closeEditor () { S.editor = null; _picked = []; paint(); }

    /* ══ SCANNING ══════════════════════════════════════════════════════════════════════
       A shop's catalogue is built standing over a box of stock, and the barcode is the one
       field on the form that a machine gets right every time and a person gets wrong often
       enough to matter — thirteen digits copied by eye is how an item ends up unscannable
       at the counter and nobody finds out until a customer is waiting.

       SokoniBarcode DECODES; this surface RESOLVES. The decoder is handed no catalogue and
       returns a string, and the matching below runs over S.rows — the products already
       loaded for THIS shop's scope. A scan therefore cannot reach another merchant's
       product, because no query is issued at all.

       ABSENT IS SAID, NEVER MIMED. If the module did not load there is no scanner, and the
       button says so instead of opening something that cannot work. */
    function scanner () {
      var B = (typeof window !== 'undefined') && window.SokoniBarcode;
      return (B && typeof B.scanOnce === 'function') ? B : null;
    }

    /* Fill one form field from a scan, without disturbing anything else the merchant has
       typed. captureForm() first: the repaint that shows the scanned value rebuilds the
       sheet, and rebuilding it without capturing would discard every other field. */
    function scanIntoField (key) {
      var B = scanner();
      if (!B) return say('No scanner is available on this device.');
      captureForm();
      B.scanOnce({ title: 'Scan the barcode' }).then(function (code) {
        if (!code || !S.editor) return;                 /* closed, or the sheet went away */
        /* WRITTEN INTO THE LIVE FIELD, NOT THROUGH A REPAINT. The editor renders spec
           inputs from the NESTED values.specs, while submit assembles them from the FLAT
           dotted keys — so setting the flat key and repainting would store the code and
           show an empty box. Setting the input and re-capturing keeps the two in step
           through the form's own machinery, and avoids rebuilding a sheet the merchant is
           part-way through filling in. */
        var el = host.querySelector('[data-pf="' + key + '"]');
        if (!el) return;
        el.value = String(code);
        S.editor.values[key] = String(code);
        captureForm();
        if (el.focus) { try { el.focus(); } catch (_) {} }
      }).catch(function () { say('The scanner could not start.'); });
    }

    /* Scan an item and land on the right screen for it.
         already stocked → open THAT product, so a re-scan corrects a record instead of
                           creating a second one for the same item
         not stocked yet → open Add product with the barcode already filled in
         two matches     → refuse. Two products answering to one code is a catalogue
                           defect, and opening either of them is how the wrong record
                           gets edited. Show the merchant both by searching the code. */
    function scanToAdd () {
      var B = scanner();
      if (!B) return say('No scanner is available on this device.');
      B.scanOnce({ title: 'Scan an item' }).then(function (code) {
        if (!code) return;
        var rows = S.rows || [];
        var t = String(code).trim().toLowerCase();
        var hits = rows.filter(function (p) {
          return [p.sku, p.barcode, (p.specs && p.specs.barcode)].some(function (v) {
            return String(v == null ? '' : v).trim().toLowerCase() === t;
          });
        });

        if (hits.length === 1) {
          openEditor('edit', hits[0]);
          say('Already in your catalogue — opened for editing.');
          return;
        }
        if (hits.length > 1) {
          S.q = String(code); S.menu = null; paint();
          say('More than one product carries that code. Fix the duplicate before scanning it at the till.');
          return;
        }
        /* New item. Open the form with the code already in place — the merchant scanned
           it, so re-typing it would be asking them to do the part the scanner just did. */
        openEditor('create', null);
        if (S.editor) {
          /* BOTH SHAPES, because the form keeps two. `specs` is what the editor RENDERS
             from, so this is what puts the code in the visible box; `spec.barcode` is what
             fieldsFromForm assembles the patch from, so this is what actually saves it.
             Setting only one gives either a code that is stored but invisible, or one that
             is shown and then silently dropped. */
          S.editor.values['spec.barcode'] = String(code);
          S.editor.values.specs = Object.assign({}, S.editor.values.specs, { barcode: String(code) });
          paint();
        }
        var el = host.querySelector('[data-pf="name"]');
        if (el && el.focus) { try { el.focus(); } catch (_) {} }
      }).catch(function () { say('The scanner could not start.'); });
    }

    /* Every TOP-LEVEL field the form shows. The nested ones (spec., stockUnit., ownership.,
       foodLicence., variant.) are assembled separately in fieldsFromForm — this list is for
       flat product fields only, and a field missing from it is a field the form appears to
       save and silently discards. */
    var FORM_KEYS = ['name', 'price', 'costPrice', 'stock', 'sku', 'category', 'description', 'status',
                     'location', 'condition', 'brand', 'kebsCert', 'deliveryCost',
                     'wholesalePrice', 'minWholesaleQty', 'digitalUrl', 'digitalLicense', 'tags',
                     /* The Listing Studio's type picker. It is a hidden input rather than a
                        chip's own state so that a tapped type and a typed field reach the
                        writer by one route — see sokoni-listing-studio.js. */
                     'listingType'];
    var NUMERIC = { price: 1, costPrice: 1, stock: 1,
                    deliveryCost: 1, wholesalePrice: 1, minWholesaleQty: 1 };

    /* Pull every field the form is showing into editor state. */
    function captureForm () {
      if (!S.editor) return;
      FORM_KEYS.forEach(function (k) {
        var el = host.querySelector('[data-pf="' + k + '"]');
        if (el) S.editor.values[k] = el.value;
      });
      /* The nested controls (ownership., foodLicence.) are mirrored by onInput/onChange as
         the merchant types, but a control they never touched has no entry — so a section
         rendered with existing values would lose them on save. Read them straight off the
         DOM, which is the only place that knows what is currently on screen. */
      /* spec., stockUnit., variant. and vopt. belong in this sweep for exactly the reason
         stated above, and were missing from it. fieldsFromForm assembles `out.specs` from
         the flat dotted keys held in state, and `_productFields` REPLACES the stored specs
         object with what it is given. So a merchant who opened a product, corrected the
         brand and saved sent `{brand}` alone — and the barcode, weight, dimensions and
         every variant went with the save. Touch one specification, lose the rest.

         Reading them off the DOM makes what is ON SCREEN the thing that gets saved, which
         is what the merchant believes is happening. It also makes the scanned barcode
         survive a repaint without the scan handler having to know the form's internal
         key shape. */
      var nestedEls = host.querySelectorAll(
        '[data-pf^="ownership."], [data-pf^="foodLicence."], [data-pf^="spec."], ' +
        '[data-pf^="stockUnit."], [data-pf^="variant."], [data-pf^="vopt."], [data-pf^="lf."]');
      Array.prototype.forEach.call(nestedEls, function (el) {
        var k = el.getAttribute('data-pf');
        S.editor.values[k] = (el.type === 'checkbox') ? (el.checked ? '1' : '') : el.value;
      });

      /* THE WARRANTY IS READ FROM ITS TILES, not from data-pf inputs — it is a structured
         promise rather than a field, and reading it off the DOM keeps the saved policy
         identical to the preview the seller was looking at when they pressed save. */
      var W = (typeof window !== 'undefined' && window.SokoniWarrantyUI) || null;
      if (W && host.querySelector('[data-wty-root]')) {
        S.editor.values._warranty = W.readBuilder(host);
      }
    }

    /* EDIT-mode stock: the figure as Inventory holds it, and where to change it. Deliberately
       carries NO data-pf attribute — captureForm() reads by data-pf, so this cannot contribute
       to a patch even if FORM_KEYS still names stock. Two independent reasons it cannot mutate:
       no input, and updateProduct refuses a stock patch outright. */
    /* ── WARRANTY & RETURNS ─────────────────────────────────────────────────
       The seller's promise about this product, built from selectable tiles with a live
       preview of exactly what the buyer will see. Rendered by sokoni-warranty-ui.js so
       the merchant's builder and the buyer's panel share ONE vocabulary — a remedy
       offered here that the server drops would be a promise no buyer can ever claim.

       Absent when the module has not loaded, rather than degraded into raw checkboxes:
       a half-rendered policy builder is how a seller saves a promise they did not mean. */
    /* Repaints ONLY the preview and the conditional groups — never the whole sheet.
       Re-rendering the editor on every tile tap would discard whatever the merchant had
       typed into the fields above, which is exactly the loss that makes people distrust a
       form. */
    function repaintWarranty () {
      var W = (typeof window !== 'undefined' && window.SokoniWarrantyUI) || null;
      if (!W || !host.querySelector) return;
      var root = host.querySelector('[data-wty-root]');
      if (!root) return;
      var read = W.readBuilder(host);
      if (S.editor && S.editor.values) S.editor.values._warranty = read;
      var pv = root.querySelector('[data-wty-preview]');
      if (pv) pv.innerHTML = W.previewHTML(read || {});
      var none = !!(read && read.durationDays === 0);
      Array.prototype.forEach.call(root.querySelectorAll('[data-wty-when="protected"]'),
        function (el) { el.hidden = none; });
      var custom = root.querySelector('.wty-custom');
      var chosen = root.querySelector('[data-wty="duration"][aria-pressed="true"]');
      if (custom) {
        custom.hidden = !(chosen && chosen.getAttribute('data-key') === 'custom');
      }
    }

    function warrantyHTML (p) {
      var W = (typeof window !== 'undefined' && window.SokoniWarrantyUI) || null;
      if (!W) return '';
      var stored = (S.editor && S.editor.values && S.editor.values._warranty) ||
                   (p && p.warranty) || null;
      return '<div class="pr-f pr-warranty" data-warranty-host>' + W.policyBuilderHTML(stored) + '</div>';
    }

    function stockReadHTML (p) {
      var raw = p && p.stock;
      var known = (raw !== undefined && raw !== null && raw !== '' && isFinite(Number(raw)));
      return '<div class="pr-f"><span class="pr-l">Stock</span>' +
        '<div class="pr-i pr-ro" aria-readonly="true">' +
          /* Unknown is said, never rendered as 0 — a zero here is a claim about a shelf. */
          (known ? esc(String(Number(raw))) : '—') +
        '</div>' +
        '<div class="pr-note">Stock is changed in Inventory, so every movement is recorded.' +
        '</div></div>';
    }

    function fieldsFromForm () {
      var v = (S.editor && S.editor.values) || {};
      var out = {};

      /* The whole policy travels as ONE object. Sending its parts separately is how a
         seller who changes the duration loses the remedies — the same defect the nested
         specification fields already had, fixed the same way.

         null means the seller chose nothing, and nothing is written: an absent warranty
         is a real answer and must not be overwritten with an empty one on every save. */
      if (v._warranty) out.warranty = v._warranty;
      FORM_KEYS.forEach(function (k) {
        var raw = v[k];
        if (raw === undefined) return;
        if (NUMERIC[k]) {
          /* Empty is ABSENT, not zero. A blank cost must not become a cost of 0,
             which would report a 100% margin on the product. */
          if (raw === '' || raw === null) return;
          out[k] = Number(raw);
        } else {
          out[k] = raw;
        }
      });
      /* ── SPECIFICATIONS ───────────────────────────────────────────────────
         Spec inputs carry dotted keys (spec.weight.v, spec.dimensions.length.u,
         stockUnit.perPack) because the form is flat and the model is not. They are
         assembled here rather than added to FORM_KEYS: that whitelist is a fixed list of
         top-level product fields, and specs are open-ended by design — a merchant may name
         one we never anticipated.

         An empty input is ABSENT, not zero — the same rule the numeric fields above follow.
         A blank weight must not become a weight of 0. */
      var nested = {};
      Object.keys(v).forEach(function (k) {
        /* ownership. and foodLicence. join spec. and stockUnit. — the form is flat and
           these two models are not. */
        if (k.indexOf('spec.') !== 0 && k.indexOf('stockUnit.') !== 0 &&
            k.indexOf('ownership.') !== 0 && k.indexOf('foodLicence.') !== 0) return;
        var raw = v[k];
        if (raw === '' || raw === null || raw === undefined) return;
        var path = k.split('.');
        var cur = nested;
        for (var i = 0; i < path.length - 1; i++) {
          cur[path[i]] = cur[path[i]] || {};
          cur = cur[path[i]];
        }
        cur[path[path.length - 1]] = raw;
      });

      /* custom.0.name / custom.0.value / custom.0.unit -> an array the model understands.
         A row with no name is dropped: an unnamed value is not a specification. */
      if (nested.spec && nested.spec.custom) {
        var rows = nested.spec.custom;
        nested.spec.custom = Object.keys(rows)
          .sort(function (a, b) { return Number(a) - Number(b); })
          .map(function (i) { return rows[i]; })
          .filter(function (r) { return r && String(r.name || '').trim(); });
        if (!nested.spec.custom.length) delete nested.spec.custom;
      }

      if (nested.spec && Object.keys(nested.spec).length) out.specs = nested.spec;
      if (nested.stockUnit && nested.stockUnit.name) out.stockUnit = nested.stockUnit;
      /* Sent whenever the section was on screen, even when emptied — that is how a merchant
         REMOVES a record they entered by mistake. The writer normalises an all-blank object
         to null rather than storing six empty strings. */
      if (nested.foodLicence) out.foodLicence = nested.foodLicence;
      if (nested.ownership)   out.ownership = nested.ownership;

      /* ── VARIANTS ──────────────────────────────────────────────────────────
         The option NAMES are the merchant's own ("Colour", "Size"), so they cannot be
         part of the input key. They are declared once for the product (vopt.0, vopt.1)
         and each row supplies a VALUE per option (variant.0.v.0, variant.0.v.1). That is
         also how a merchant thinks about it: choose what varies, then fill the grid.

         A row is kept only if it has at least one option value — an unnamed combination
         is not a variant, and the model refuses it anyway. Stock defaults to 0 rather
         than being dropped: a variant that exists with none in stock is a real state,
         unlike a blank weight. */
      var optNames = [];
      Object.keys(v).forEach(function (k) {
        var m = /^vopt\.(\d+)$/.exec(k);
        if (m && String(v[k]).trim()) optNames[Number(m[1])] = String(v[k]).trim();
      });

      var vrows = {};
      Object.keys(v).forEach(function (k) {
        var m = /^variant\.(\d+)\.(.+)$/.exec(k);
        if (!m) return;
        var idx = Number(m[1]);
        vrows[idx] = vrows[idx] || { attrs: {} };
        var rest = m[2];
        var vm = /^v\.(\d+)$/.exec(rest);
        if (vm) {
          var name = optNames[Number(vm[1])];
          var val = String(v[k] == null ? '' : v[k]).trim();
          if (name && val) vrows[idx].attrs[name] = val;
          return;
        }
        if (v[k] === '' || v[k] === null || v[k] === undefined) return;
        vrows[idx][rest] = v[k];
      });

      var variants = Object.keys(vrows)
        .sort(function (a, b) { return Number(a) - Number(b); })
        .map(function (i) { return vrows[i]; })
        .filter(function (r) { return Object.keys(r.attrs).length > 0; });
      if (variants.length) out.variants = variants;

      /* ── LISTING ATTRIBUTES ────────────────────────────────────────────────
         The type-specific fields the Listing Studio drew, gathered out of the flat `lf.`
         namespace into the one `attributes` object the universal listing model describes.
         They are NOT promoted to top-level fields: a room's `guests` and a vehicle's
         `mileage` are properties of that type, and spreading them across the product
         record would give every listing thirty columns it has no use for.

         A list field was typed as one comma-separated line and is split back here, because
         the model says it is a list and the form is the only place it was ever a string.
         Blank entries are dropped rather than stored as empty strings. */
      var LMod = (typeof window !== 'undefined' && window.SokoniListingModel) || null;
      var listKeys = {};
      if (LMod) {
        LMod.fieldsFor({ listingType: v.listingType, category: v.category }).forEach(function (f) {
          if (f.kind === 'list') listKeys[f.key] = 1;
        });
      }
      var lattrs = {};
      Object.keys(v).forEach(function (k) {
        if (k.indexOf('lf.') !== 0) return;
        var raw = v[k];
        if (raw === '' || raw === null || raw === undefined) return;
        var name = k.slice(3);
        if (listKeys[name] && typeof raw === 'string') {
          var parts = raw.split(',').map(function (s) { return s.trim(); })
                         .filter(function (s) { return s !== ''; });
          if (!parts.length) return;
          lattrs[name] = parts;
        } else {
          lattrs[name] = raw;
        }
      });
      if (Object.keys(lattrs).length) out.attributes = lattrs;

      /* An unset type is ABSENT, never the empty string. Storing '' would turn "SOKONI
         inferred this from the category" into "the merchant chose nothing", and the type
         authority reads an explicit value ahead of its own inference. */
      if (out.listingType === '' || out.listingType == null) delete out.listingType;

      return out;
    }
    /* Only what actually CHANGED is sent. Sending the whole form on every edit
       would rewrite fields the merchant never touched, and would silently
       clobber a value another surface (Inventory, POS) had changed meanwhile. */
    function changedOnly (next, prev) {
      var out = {};
      Object.keys(next).forEach(function (k) {
        if (next[k] === undefined) return;
        var before = prev ? prev[k] : undefined;
        if (k === 'sku' || k === 'category' || k === 'description' || k === 'status' || k === 'name') {
          if (String(next[k] || '') !== String(before == null ? '' : before)) out[k] = next[k];
        } else if (Number(next[k]) !== Number(before == null ? NaN : before)) {
          out[k] = next[k];
        }
      });
      return out;
    }

    function md () {
      var m = (typeof window !== 'undefined') && window.SokoniMerchantData;
      if (!m || typeof m.createProduct !== 'function') {
        throw new Error('The product editor is not available just now.');
      }
      return m;
    }

    function say (msg) { if (typeof ctx.onToast === 'function') ctx.onToast(msg); }

    /* A mutation reports what ACTUALLY happened, including partial success. A
       product that reached the catalogue but not the till is not a plain
       success, and saying so is the difference between a merchant who knows to
       retry and one who wonders why the till cannot find their product. */
    /* The product outcome as TEXT, so a photo result can be appended to it. Two toasts in
       a row overwrite one another, and the sync caveat must not be the one that is lost. */
    function createText (res) {
      if (res.replayed) return 'Already saved — no duplicate was created.';
      if (res.complete) return 'Product added, and it is ready at the till.';
      var missing = Object.keys(res.mirrors || {}).filter(function (k) {
        return res.mirrors[k].state !== 'written';
      });
      return 'Product added to your catalogue. Not yet available at ' +
        (missing.indexOf('pos') > -1 ? 'the till' : 'Inventory') +
        ' — open Products again to finish syncing.';
    }

    function reportCreate (res) { say(createText(res)); }

    /* ══ PRICE TAGS ══════════════════════════════════════════════════════
       Shelf labels for products that already exist.

       WHICH ENGINE, AND WHY IT CHANGED. This used to call PosPrintService.printPriceTag().
       That method does not exist and never has: PosPrintService prints RECEIPTS and the
       other POS documents — sale, refund, quote, invoice, kitchen ticket, shift report —
       and has no label surface at all. So the guard below it fired on every single press
       and the button said "the printer service is not loaded on this page", which was also
       untrue: the service was loaded, it simply cannot print labels. The control had never
       once produced a tag.

       The label authority is sokoni-label-engine.js, which owns TSPL, ZPL, ESC/POS and the
       browser-print fallback, and which POS already uses. Routing here is not a second
       printing system — it is the only one that prints labels. PosPrintService is still
       preferred if it ever grows the method, so the day it does, this switches back without
       a code change.

       BATCH IS THE ENGINE'S NATIVE SHAPE. printLabel() takes an ARRAY; printPriceTag() is
       merely its one-item wrapper. So printing a shelf of tags is one job with N items, not
       N jobs — which is what a label printer expects and what stops a 40-tag run becoming
       40 separate connection attempts. */
    function labelService () {
      var svc = window.PosPrintService;
      if (svc && typeof svc.printPriceTag === 'function') {
        return { print: function (items, o) {
          return items.length === 1 ? svc.printPriceTag(items[0], o)
                                    : Promise.all(items.map(function (i) { return svc.printPriceTag(i, o); }));
        }, name: 'pos' };
      }
      var eng = window.SokoniLabelEngine;
      if (eng && typeof eng.printLabel === 'function') {
        return { print: function (items, o) {
          return eng.printLabel(items, Object.assign({ showPrice: true, showBarcode: true }, o));
        }, name: 'label' };
      }
      return null;
    }

    /* The fields the label engine reads, taken from the STORED record. */
    function tagItem (p) {
      return {
        name: p.name || p.title || '',
        price: p.price,
        sku: p.sku || '',
        barcode: (p.specs && p.specs.barcode) || p.barcode || p.sku || '',
        shopName: ctx.shopName || '',
      };
    }

    function printTags (products, opts) {
      var list = (products || []).filter(function (p) { return p && p.id; });
      if (!list.length) return say('Nothing selected to print.');

      var svc = labelService();
      if (!svc) {
        /* Named honestly. "Not loaded" was the old lie; this says which piece is missing. */
        return say('No label printer is available on this page — sokoni-label-engine.js is not loaded.');
      }

      S.printing = true; paint();
      var settle = function (msg) {
        if (S.destroyed) return;
        S.printing = false;
        if (S.editor) S.editor.printing = false;
        paint();
        if (msg) say(msg);
      };

      var n = list.length;
      var noun = n === 1 ? 'Price tag' : n + ' price tags';
      Promise.resolve(svc.print(list.map(tagItem), opts || { copies: 1 }))
        .then(function (r) {
          /* Never announce paper that does not exist: a queued job is reported distinctly
             from a printed one. */
          if (r && r.queued) return settle('No printer connected — ' +
            (n === 1 ? 'the tag is queued.' : 'the ' + n + ' tags are queued.'));
          settle(noun + ' sent to the printer.');
        })
        .catch(function (e) {
          if (e && e.code === 'BARCODE_UNAVAILABLE') {
            return settle(n === 1
              ? 'This product has no SKU or barcode yet, so there is nothing scannable to print.'
              : 'Some of these have no SKU or barcode, so there is nothing scannable to print.');
          }
          settle('Could not print: ' + ((e && e.message) || 'please try again.'));
        });
    }

    function printPriceTag () {
      var E = S.editor;
      if (!E || E.busy || E.printing) return;
      /* The STORED record, never the form. A merchant may have typed a new price
         and not saved it; printing that would put a figure on a shelf that the
         till would refuse to honour. */
      var p = E.product;
      if (!p || !p.id) return say('Add the product first, then reopen it to print its tag.');
      E.printing = true; E.err = null; paint();
      printTags([p]);
    }

    /* ── BATCH ───────────────────────────────────────────────────────────────
       A merchant pricing a shelf does not open forty products one at a time. Selection is
       held here rather than on the records, so nothing about a product changes by being
       ticked, and it is cleared whenever the list is reloaded — a selection that outlived
       its rows would print a tag for something no longer on screen. */
    function selectedProducts () {
      var ids = S.selected || {};
      return (S.rows || []).filter(function (p) { return p && ids[p.id]; });
    }
    function selectedCount () { return Object.keys(S.selected || {}).length; }
    function printSelectedTags () {
      var list = selectedProducts();
      if (!list.length) return say('Select the products you want tags for first.');
      printTags(list);
    }

    /* The product is WRITTEN by the time this runs, so its existence is never in doubt —
       only the photos are. Every branch therefore reports the product outcome first and
       the photo outcome second, in ONE message, because two toasts overwrite each other
       and the sync caveat must not be the one that is lost. A failure here leaves a real
       product with no pictures, which the merchant can fix from its Photos action. */
    function attachAfterCreate (res) {
      var E = S.editor;
      var n = _picked.length;
      var finish = function (extra) {
        _picked = []; _originals = []; S.editor = null;
        say(createText(res) + (extra ? ' ' + extra : ''));
        S.rows = null; load();
      };
      if (!E) return finish('');

      E.busy = true; E.phase = 'photos'; E.err = null;
      E.progress = { done: 0, total: n };
      paint();

      uploadPicked(res.id, function (r) {
        if (S.destroyed) return;
        var count = (r && r.urls && r.urls.length) || n;
        finish(r && r.complete === false
          ? (count === 1 ? 'The photo is on your product but has not reached the till yet.'
                         : 'The photos are on your product but have not reached the till yet.')
          : (count === 1 ? 'Photo added.' : count + ' photos added.'));
      }, function (e) {
        if (S.destroyed) return;
        finish('The photos could not be uploaded (' + ((e && e.message) || 'upload failed') +
               ') — open Photos on the product to try again.');
      });
    }

    function submit () {
      var E = S.editor;
      if (!E || E.busy) return;
      /* Read the form BEFORE any repaint. paint() rebuilds the inputs from state,
         so reading afterwards would read the freshly rendered fields and not the
         ones the merchant filled in. */
      if (E.mode !== 'delete') captureForm();
      E.busy = true; E.err = null; E.blocked = null; paint();

      var done = function (fn) {
        return function (v) {
          if (S.destroyed) return;
          E.busy = false;
          fn(v);
        };
      };

      var run;
      try {
        var M = md();
        if (E.mode === 'delete') {
          run = M.deleteProduct({ scope: ctx.scope, db: ctx.db, id: E.product.id });
        } else if (E.mode === 'edit') {
          var patch = changedOnly(fieldsFromForm(), E.product);   /* stored record, not the form */
          if (!Object.keys(patch).length) { E.busy = false; closeEditor(); return say('Nothing changed.'); }
          run = M.updateProduct({ scope: ctx.scope, db: ctx.db, id: E.product.id, patch: patch });
        } else {
          run = M.createProduct({
            scope: ctx.scope, db: ctx.db, draftToken: E.token,
            product: fieldsFromForm(),
            /* Opening stock does NOT ride in the product document. This is the invoker for
               merchantAdjustStock; the writer files the opening quantity as the product's first
               movement, transactional and versioned, exactly like every later one. */
            adjustStock: (typeof ctx.adjustStock === 'function') ? ctx.adjustStock : null,
            /* CONSULTED, not reimplemented — and consulted by the WRITER, before
               it writes anything, so a refusal mutates nothing at all. */
            canPublish: (typeof ctx.canPublish === 'function') ? ctx.canPublish : null,
            /* createdAt is NOT stamped here. A client clock is not a timestamp
               authority; the adapter applies serverTimestamp() at the write. */
          });
        }
      } catch (e) {
        E.busy = false; E.err = (e && e.message) || String(e); return paint();
      }

      run.then(done(function (res) {
        var mode = E.mode;
        /* Photos chosen in the wizard upload against the id the writer just returned. The
           sheet stays open so the merchant watches progress instead of meeting a pause. */
        if (mode === 'create' && _picked.length && res && res.id) return attachAfterCreate(res);
        S.editor = null;
        if (mode === 'create') reportCreate(res || {});
        else if (mode === 'edit') say('Changes saved.');
        else say('Product deleted.');
        /* Re-READ. The list is never patched from what we believe we wrote. */
        S.rows = null; load();
      })).catch(done(function (e) {
        if (e && e.code === 'publish-refused') {
          /* The server's own words. Never a locally invented limit message. */
          E.blocked = e.message || 'Your plan does not allow another product.';
        } else {
          E.err = (e && e.message) || String(e);
        }
        paint();
      }));
    }

    /* ══ 2c — PHOTOS ═══════════════════════════════════════════════════════
       Photos attach to a product that ALREADY EXISTS, which is why this is a
       per-product action and not a field on the create form: the Storage path
       is product-images/{sellerUid}/{productId}/{i}.jpg, so there is no path to
       write to until the product has an id.

       This surface chooses files and reports what happened. It performs no
       upload of its own — SokoniMerchantData.attachProductImages owns the
       sequence (ownership, then Storage, then the record, then the projections),
       and the record is only ever told about addresses Storage actually
       returned. */

    function mediaModule () {
      var m = (typeof window !== 'undefined') && window.SokoniMerchantMedia;
      if (!m || typeof m.validateAll !== 'function') {
        throw new Error('The photo uploader is not available just now.');
      }
      return m;
    }

    function openPhotos (product) {
      S.editor = {
        mode: 'photos',
        product: product,
        values: {},
        busy: false,
        err: null,
        blocked: null,
        rejected: [],          /* files refused before any upload was attempted */
        progress: null,        /* {done, total} while bytes are moving */
      };
      paint();
    }

    /* Chosen files are held here rather than read from the input at submit time:
       a repaint replaces the <input type=file>, and a replaced file input is
       empty. Reading it later would silently upload nothing. */
    var _picked = [];
    /* Pre-edit copies, so an AI edit can be undone without re-picking the photo. */
    var _originals = [];
    var _previewUrls = [];

    /* Photos are chosen in TWO places now: the per-product sheet, and the create wizard.
       In the wizard nothing is uploaded while choosing — the Storage path needs a product
       id that does not exist yet — so the files are held and sent once the product is
       written. Everything else (validation, AI editing, undo) is the same code. */
    function picksPhotos (E) { return !!E && (E.mode === 'photos' || E.mode === 'create'); }

    function onFiles (fileList, append) {
      var E = S.editor;
      if (!picksPhotos(E)) return;
      var M;
      try { M = mediaModule(); } catch (e) { E.err = e.message; return paint(); }

      var check = M.validateAll(fileList);
      if (append) {
        /* A camera shot ADDS. Replacing would throw away the angles already taken, and a
           merchant cannot re-take a photo of goods they have already packed away.
           _originals stays index-aligned: the new entries simply have nothing to undo to. */
        _picked = _picked.concat(check.accepted);
      } else {
        _picked = check.accepted;
        _originals = [];               /* a new selection has nothing to undo back to */
      }
      E.rejected = check.rejected;
      E.err = null;
      /* Every refusal is shown, and the acceptable files are still offered —
         one bad file in a selection of four must not discard the other three. */
      paint();
    }

    function submitPhotos () {
      var E = S.editor;
      if (!E || E.busy) return;
      if (!_picked.length) { E.err = 'Choose at least one photo first.'; return paint(); }

      E.busy = true; E.err = null; E.progress = { done: 0, total: _picked.length };
      paint();

      uploadPicked(E.product.id, function (res) {
        if (S.destroyed) return;
        _picked = [];
        S.editor = null;
        if (res.complete) {
          say(res.urls.length === 1 ? 'Photo added.' : res.urls.length + ' photos added.');
        } else {
          /* The photo IS on the product; it has not reached the till's copy. */
          say('Photo saved to your product. The till’s copy has not updated yet — ' +
              'open Products again to finish syncing.');
        }
        S.rows = null; load();
      }, function (e) {
        if (S.destroyed) return;
        E.busy = false;
        E.progress = null;
        /* The writer sets wrote:false when nothing reached the product record.
           Saying so plainly is the difference between a merchant who retries and
           one who believes a broken image is live. */
        E.err = (e && e.message) || 'The photo could not be uploaded.';
        E.wroteNothing = (e && e.wrote === false);
        paint();
      });
    }

    /* ── THE ONLY CALL INTO THE MEDIA WRITER ──────────────────────────────
       Both surfaces that send photos — the per-product sheet and the create
       wizard — come through here, so there is exactly ONE media entry point to
       audit. That is not bookkeeping: a second upload path is a second place the
       ownership-then-Storage-then-record-then-projections sequence could be
       skipped, which is why test-merchant-v2-products-2b asserts there is one.

       It owns no policy. The caller decides what to say and what to do next,
       because the two surfaces genuinely differ: the sheet is finished when the
       upload is, while the wizard has already created a product whose existence
       must be reported whatever the photos do. */
    function uploadPicked (productId, onDone, onFail) {
      var M;
      try { M = md(); mediaModule(); }
      catch (e) { return onFail(e); }

      M.attachProductImages({
        scope: ctx.scope, db: ctx.db, media: mediaModule(), storage: ctx.storage,
        id: productId, files: _picked,
        onProgress: function (done, total) {
          if (S.destroyed || !S.editor) return;
          S.editor.progress = { done: done, total: total };
          paint();
        },
      }).then(onDone, onFail);
    }


    /* ── AI PHOTO EDITING ─────────────────────────────────────────────────────
       The tools already exist: sokoni-creative.js has removeBackground,
       enhanceProduct and smartCrop, each returning a canvas. This connects them to the
       product being created. Nothing here is a second image pipeline.

       WHAT IT CHANGES. The IMAGE, and only the image. An edit replaces the pending File
       in _picked and nothing else — name, price, stock, SKU, specifications and variants
       are canonical product data and are not this feature's business. The upload path is
       untouched: submitPhotos still uploads _picked through the same media module and the
       same Storage convention, so the rule that checks request.auth.uid == uid is still
       what stops a bad write.

       HONEST PROVENANCE: seller.html labelled its product-image input "✨ AI enhanced" and
       nothing behind it did anything — addProductImages() made a blob URL and
       sokoni-creative.js was never loaded on that page. This is the first time product
       photos are actually edited, so it is a build rather than a restore.

       THE QUOTA IS NOT OURS TO DECIDE. SokoniAISubs.checkAndGate() owns entitlement and
       shows its own upgrade prompt; a refusal here is a refusal, never a silent downgrade
       to running the tool anyway. */
    var AI_TOOLS = [
      { id: 'rmbg',    label: '✨ Remove background', feature: 'removeBackground', fn: 'removeBackground' },
      { id: 'enhance', label: '💡 Enhance',           feature: 'enhanceImage',     fn: 'enhanceProduct' },
      { id: 'crop',    label: '⬜ Square crop',        feature: 'smartCrop',        fn: 'smartCrop' },
    ];

    function creative () {
      return (typeof window !== 'undefined' && window.SokoniCreative) || null;
    }

    /* A canvas back to a File, keeping the original name so the upload path and any
       error message still refer to the photo the merchant chose. PNG for a removed
       background — JPEG has no alpha, and re-encoding a cut-out as JPEG silently paints
       the transparency black. */
    function canvasToFile (canvas, original, tool) {
      return new Promise(function (resolve, reject) {
        var png = (tool === 'rmbg');
        var type = png ? 'image/png' : 'image/jpeg';
        var name = String((original && original.name) || 'photo').replace(/\.[^.]+$/, '') +
                   (png ? '.png' : '.jpg');
        try {
          canvas.toBlob(function (blob) {
            if (!blob) return reject(new Error('The edited photo could not be prepared.'));
            try {
              resolve(new File([blob], name, { type: type }));
            } catch (e) {
              /* Older WebKit has no File constructor — the Blob carries the data and the
                 media module reads .name/.type defensively. */
              blob.name = name;
              resolve(blob);
            }
          }, type, png ? undefined : 0.92);
        } catch (e) { reject(e); }
      });
    }

    async function applyAiTool (index, toolId) {
      var E = S.editor;
      if (!picksPhotos(E)) return;
      var tool = null;
      AI_TOOLS.forEach(function (t) { if (t.id === toolId) tool = t; });
      var file = _picked[index];
      var C = creative();
      if (!tool || !file || !C || typeof C[tool.fn] !== 'function') {
        E.err = 'The photo editor is not available just now.';
        return paint();
      }

      /* Entitlement FIRST, before any work — a merchant must not watch a photo process
         and then be told they cannot have it. */
      var gate = (typeof window !== 'undefined') && window.SokoniAISubs;
      if (gate && typeof gate.checkAndGate === 'function') {
        var allowed = false;
        try { allowed = await gate.checkAndGate(tool.feature, tool.label); }
        catch (e) { allowed = false; }
        if (!allowed) return;              /* the authority showed its own prompt */
      }

      E.aiBusy = index; E.err = null; paint();
      try {
        var canvas = await C[tool.fn](file);
        var edited = await canvasToFile(canvas, file, toolId);
        /* Keep the ORIGINAL so an edit can be undone without re-picking the photo. */
        _originals[index] = _originals[index] || file;
        _picked[index] = edited;
      } catch (e) {
        E.err = 'That edit could not be applied. The original photo is unchanged.';
      }
      E.aiBusy = null;
      paint();
    }

    function undoAiTool (index) {
      if (_originals[index]) { _picked[index] = _originals[index]; _originals[index] = null; }
      paint();
    }

    /* Per-photo preview + tools. Previously the sheet showed only a COUNT of chosen
       photos, so a merchant could not see what they were about to upload, let alone edit
       it. objectURLs are revoked on the next paint to avoid leaking one per repaint. */
    function pickedHTML () {
      if (!_picked.length) return '';
      var C = creative();
      var E = S.editor || {};
      _revokePreviews();
      return '<div class="pr-picks">' + _picked.map(function (f, i) {
        var url = null;
        try { url = URL.createObjectURL(f); _previewUrls.push(url); } catch (_) {}
        var busy = E.aiBusy === i;
        return '<div class="pr-pick">' +
          (url ? '<img class="pr-pimg" alt="" src="' + esc(url) + '">' : '<div class="pr-pimg"></div>') +
          '<div class="pr-ptools">' +
            (C ? AI_TOOLS.map(function (t) {
                   return '<button class="pr-ptool" data-pr="ai" data-i="' + i + '" data-tool="' + t.id + '"' +
                     (busy ? ' disabled' : '') + '>' + t.label + '</button>';
                 }).join('')
               : '<div class="pr-note">Photo editing is unavailable on this device.</div>') +
            (_originals[i] ? '<button class="pr-ptool" data-pr="aiundo" data-i="' + i + '">↩︎ Undo edit</button>' : '') +
          '</div>' +
          (busy ? '<div class="pr-pbusy">Working…</div>' : '') +
        '</div>';
      }).join('') + '</div>';
    }

    function _revokePreviews () {
      _previewUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
      _previewUrls = [];
    }

    function photosHTML () {
      var E = S.editor, p = E.product || {};
      var M = (typeof window !== 'undefined') && window.SokoniMerchantMedia;
      var have = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
      var accept = (M && M.accept) || 'image/*';

      var thumbs = have.length
        ? '<div class="pr-thumbs">' + have.map(function (u) {
            return '<img class="pr-thumb" alt="" src="' + esc(u) + '">';
          }).join('') + '</div>'
        : '<div class="pr-note" style="margin-bottom:14px">This product has no photos yet. ' +
          'It can still be sold — a photo simply helps it sell.</div>';

      var chosen = _picked.length
        ? pickedHTML() + '<div class="pr-note">' + _picked.length +
          (_picked.length === 1 ? ' photo ready to upload.' : ' photos ready to upload.') + '</div>'
        : '';

      var rejected = (E.rejected && E.rejected.length)
        ? '<div class="pr-block">' + E.rejected.map(function (r) {
            return esc((r.name ? r.name + ': ' : '') + r.reason);
          }).join('<br>') + '</div>'
        : '';

      var progress = E.progress
        ? '<div class="pr-note">Uploading ' + E.progress.done + ' of ' + E.progress.total + '…</div>'
        : '';

      return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div>' +
        '<div class="pr-panel" role="dialog" aria-modal="true" aria-label="Product photos">' +
        '<div class="pr-ph2">Photos</div>' +
        '<div class="pr-psub">' + esc(p.name || 'Untitled') + '</div>' +
        thumbs + rejected +
        '<div class="pr-f"><label class="pr-l" for="pf-photos">Add photos</label>' +
          /* `accept` mirrors the deployed Storage rule's safeImageOnly list, and
             no `capture` attribute — on iOS `capture` forces the camera and takes
             away the merchant's photo library, which is where their product
             pictures already are. */
          '<div class="pr-pickrow">' +
            /* THE LIBRARY. No `capture` attribute: on iOS it forces the camera and takes
               away the photo library, which is where a merchant's product pictures already
               are. Taking a photo is offered SEPARATELY, below, so neither costs the other. */
            '<input class="pr-file" type="file" id="pf-photos" data-pf="photos" ' +
              'accept="' + esc(accept) + '" multiple>' +
            '<label class="pr-pickbtn" for="pf-photos">🖼️ ' +
              (_picked.length ? 'Change photos' : 'Choose photos') + '</label>' +
            /* THE CAMERA. `capture` asks for the rear lens, which is the one pointed at
               the goods. It ADDS to the selection rather than replacing it, so a merchant
               photographing three angles does not lose the first two. */
            '<input class="pr-file" type="file" id="pf-shoot" data-pf="photo-capture" ' +
              'accept="image/*" capture="environment">' +
            '<label class="pr-pickbtn shoot" for="pf-shoot">📸 Take photo</label>' +
          '</div>' +
          '<div class="pr-note">JPEG, PNG, WebP, GIF or AVIF, up to 15 MB each. ' +
          'Large photos are shrunk before upload.</div></div>' +
        chosen + progress +
        (E.err ? '<div class="pr-err">' + esc(E.err) +
          (E.wroteNothing ? '<br>Nothing was changed — your product is exactly as it was.' : '') +
          '</div>' : '') +
        '<div class="pr-foot">' +
          '<button class="pr-cancel" data-pr="close">' + (E.busy ? 'Close' : 'Done') + '</button>' +
          '<button class="pr-save" data-pr="submit-photos"' + (E.busy ? ' disabled' : '') + '>' +
            (E.busy ? 'Uploading…' : 'Upload') + '</button>' +
        '</div></div></div>';
    }

    /* THE WIZARD'S PHOTO STEP. Identical machinery to the per-product sheet — the same
       validation, the same AI tools, the same undo — but no upload happens here: the
       Storage path is product-images/{sellerUid}/{productId}/{i}.jpg and there is no id
       until the product is written. The files are held and sent immediately afterwards,
       so the merchant adds a product WITH its photos in one pass.

       Nothing here claims a photo is saved. The only success message comes after Storage
       has actually returned addresses. */
    function createPhotosHTML () {
      var E = S.editor;
      var M = (typeof window !== 'undefined') && window.SokoniMerchantMedia;
      var accept = (M && M.accept) || 'image/*';
      var rejected = (E.rejected && E.rejected.length)
        ? '<div class="pr-block">' + E.rejected.map(function (r) {
            return esc((r.name ? r.name + ': ' : '') + r.reason);
          }).join('<br>') + '</div>'
        : '';
      var prog = (E.phase === 'photos' && E.progress)
        ? '<div class="pr-note">Uploading photo ' + E.progress.done + ' of ' + E.progress.total + '…</div>'
        : '';
      return '<div class="pr-sec">Photos</div>' +
        '<div class="pr-f"><label class="pr-l" for="pf-photos">Add photos</label>' +
          /* No `capture` attribute: on iOS it forces the camera and takes away the photo
             library, which is where a merchant's product pictures already are. */
          '<div class="pr-pickrow">' +
            /* THE LIBRARY. No `capture` attribute: on iOS it forces the camera and takes
               away the photo library, which is where a merchant's product pictures already
               are. Taking a photo is offered SEPARATELY, below, so neither costs the other. */
            '<input class="pr-file" type="file" id="pf-photos" data-pf="photos" ' +
              'accept="' + esc(accept) + '" multiple>' +
            '<label class="pr-pickbtn" for="pf-photos">🖼️ ' +
              (_picked.length ? 'Change photos' : 'Choose photos') + '</label>' +
            /* THE CAMERA. `capture` asks for the rear lens, which is the one pointed at
               the goods. It ADDS to the selection rather than replacing it, so a merchant
               photographing three angles does not lose the first two. */
            '<input class="pr-file" type="file" id="pf-shoot" data-pf="photo-capture" ' +
              'accept="image/*" capture="environment">' +
            '<label class="pr-pickbtn shoot" for="pf-shoot">📸 Take photo</label>' +
          '</div>' +
          '<div class="pr-note">Optional — a product sells without one. JPEG, PNG, WebP, GIF ' +
          'or AVIF, up to 15 MB each; large photos are shrunk. They upload as soon as the ' +
          'product is saved.</div></div>' +
        rejected + pickedHTML() +
        (_picked.length ? '<div class="pr-note">' + _picked.length +
          (_picked.length === 1 ? ' photo will be uploaded' : ' photos will be uploaded') +
          ' when you tap Add product.</div>' : '') +
        prog;
    }

    function fld (key, label, attrs, val, note) {
      return '<div class="pr-f"><label class="pr-l" for="pf-' + key + '">' + esc(label) + '</label>' +
        '<input class="pr-i" id="pf-' + key + '" data-pf="' + key + '" ' + attrs +
        ' value="' + esc(val == null ? '' : val) + '">' +
        (note ? '<div class="pr-note">' + esc(note) + '</div>' : '') + '</div>';
    }

    /* A field with a Scan button. The input keeps its data-pf, so a scanned value and
       a typed one reach S.editor.values by exactly the same route and the writer
       cannot tell them apart — the scanner is an input method, not a second path
       into the record.

       data-sokoni-scan opts this input in to the hardware wedge, so a merchant with a
       handheld can simply scan while the field has focus, with no button at all. Every
       OTHER field is left out of that opt-in deliberately: a wedge that captured
       keystrokes from the price box would eat what the merchant was typing. */
    function scanFld (key, label, attrs, val, note) {
      return '<div class="pr-f"><label class="pr-l" for="pf-' + key + '">' + esc(label) + '</label>' +
        '<div class="pr-scanrow">' +
          '<input class="pr-i" id="pf-' + key + '" data-pf="' + key + '" data-sokoni-scan ' + attrs +
          ' value="' + esc(val == null ? '' : val) + '">' +
          '<button type="button" class="pr-scan" data-pr="scanfield" data-field="' + esc(key) + '" ' +
            'aria-label="Scan ' + esc(label) + '">📷 Scan</button>' +
        '</div>' +
        (note ? '<div class="pr-note">' + esc(note) + '</div>' : '') + '</div>';
    }

    /* ══ THE REST OF THE UPLOAD FORM ═══════════════════════════════════════════════════════
       Migrated from seller.html. That form asked for far more than this one did — a category
       out of 99, a location, proof of ownership for high-theft goods, six food-licensing
       records, digital delivery, a KEBS number and a bulk-price tier — and Merchant V2 asked
       for a category as FREE TEXT and nothing else. A merchant moving across lost most of
       what they could describe about what they sell.

       SIX OF THOSE FIELDS WERE NEVER SAVED. The food permit, KEBS food number, KMC number,
       halal certificate, cold-chain type and slaughter route were collected by the legacy
       form and written nowhere. They are persisted here — see sokoni-merchant-data.js.

       THE FORM CHANGES SHAPE WITH THE CATEGORY. A phone needs an IMEI; a goat needs a
       slaughter record; an e-book needs a download link and none of the above. Showing every
       field to everyone is how an upload form becomes one merchants abandon halfway. The
       rules come from the taxonomy, which lifted them from the legacy form unchanged. */
    function tax () {
      return (typeof window !== 'undefined' && window.SokoniProductTaxonomy) || null;
    }

    /* The category the form is currently shaped by — the merchant's live choice while typing,
       falling back to what the product already carries. */
    function liveCategory (p) {
      var v = S.editor && S.editor.values;
      if (v && v.category !== undefined) return v.category;
      return (p && p.category) || '';
    }

    function sectionOpen (emoji, title, sub) {
      return '<div class="pr-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">' + emoji + '</span>' +
        '<span class="pr-sec-t">' + esc(title) + '</span></div>' +
        (sub ? '<div class="pr-sec-s">' + esc(sub) + '</div>' : '');
    }
    var sectionClose = '</div>';

    /* A <select> built from a taxonomy vocabulary. Every option carries its own emoji, so the
       list is scannable on a phone rather than a wall of words. */
    function selectHTML (key, label, list, cur, placeholder, note) {
      var T = tax();
      if (!T) return '';
      return '<div class="pr-f"><label class="pr-l" for="pf-' + key + '">' + esc(label) + '</label>' +
        '<select class="pr-i pr-sel" id="pf-' + key + '" data-pf="' + key + '">' +
        T.optionsHtml(list, cur, esc, placeholder) + '</select>' +
        (note ? '<div class="pr-note">' + esc(note) + '</div>' : '') + '</div>';
    }

    /* ── CATEGORY: 99 options in 20 groups, the whole marketplace ─────────────────────────
       It was an <input type="text">. A merchant typing "phones" produced a category nothing
       else on the platform recognises — not the storefront filters, not the commission lane,
       not the spec suggestions — and no message ever said so. A closed list cannot miss. */
    function categoryHTML (p) {
      var T = tax();
      var cur = liveCategory(p);
      if (!T) {
        /* The taxonomy script did not load. Fall back to the free-text field rather than
           offering an empty dropdown — a merchant must still be able to save. */
        return fld('category', 'Category', 'type="text" autocomplete="off" maxlength="64"', cur,
          'Category list unavailable — type it, and check it against your shop later.');
      }
      var info = T.infoFor(cur);
      return '<div class="pr-f"><label class="pr-l" for="pf-category">Category</label>' +
        '<select class="pr-i pr-sel" id="pf-category" data-pf="category">' +
        T.categoryOptionsHtml(cur, esc) + '</select>' +
        (info ? '<div class="pr-note">' + esc(info.groupEmoji + ' ' + info.group) +
                ' · this decides which details you are asked for below.</div>'
              : '<div class="pr-note">Pick the closest one — it decides how buyers find you ' +
                'and what you are asked for below.</div>') +
        (T.isAdult(cur)
          ? '<div class="pr-warn pr-warn--age">🔞 Age-restricted. Buyers must confirm ' +
            'they are 18+ before they can order, and you confirm you may legally sell this in Kenya.</div>'
          : '') +
        '</div>';
    }

    /* ── BULK / WHOLESALE ────────────────────────────────────────────────────────────────
       The saving is shown as the merchant types, because a bulk tier is easy to get backwards
       and the moment to notice is now — not when someone orders fifty. The figure is computed
       from the two numbers on screen and labelled as a preview; the writer re-checks it and
       refuses a wholesale price at or above the unit price. */
    function bulkHTML (p) {
      var v = (S.editor && S.editor.values) || {};
      var price = Number(v.price !== undefined ? v.price : p.price) || 0;
      var wp = Number(v.wholesalePrice !== undefined ? v.wholesalePrice : p.wholesalePrice) || 0;
      var wq = Number(v.minWholesaleQty !== undefined ? v.minWholesaleQty : p.minWholesaleQty) || 0;
      var strip = '';
      if (wp > 0 && price > 0) {
        if (wp >= price) {
          strip = '<div class="pr-warn">⚠️ That is not a discount — the bulk price is ' +
            'the same as or higher than your normal price.</div>';
        } else {
          var save = price - wp;
          var pct = Math.round((save / price) * 100);
          strip = '<div class="pr-bulk-strip">🏷️ <b>Bulk deal</b>' +
            '<span>Saves KES ' + esc(String(Math.round(save))) + ' each (' + pct + '%)</span>' +
            (wq > 1 ? '<span>from ' + esc(String(wq)) + ' units</span>' : '') + '</div>';
        }
      }
      return sectionOpen('📦', 'Bulk deal', 'Optional — a lower price for larger orders.') +
        '<div class="pr-row">' +
          fld('wholesalePrice', 'Bulk price (KES)', 'type="number" inputmode="decimal" min="0" step="any"',
              p.wholesalePrice, '') +
          fld('minWholesaleQty', 'Minimum quantity', 'type="number" inputmode="numeric" min="2" step="1"',
              p.minWholesaleQty, '') +
        '</div>' + strip +
        '<div class="pr-note">Leave both empty for no bulk deal. Minimum 2 — "bulk, minimum one" ' +
        'is just your normal price.</div>' + sectionClose;
    }

    /* ── OWNERSHIP: high-theft goods ─────────────────────────────────────────────────────
       Phones, laptops, consoles, cameras, vehicles, tyres, luxury goods. The taxonomy carries
       what to ask for per category — an IMEI is not a chassis number — and the wording is the
       legacy form's own. Only a reviewer can approve it: the writer clamps the status. */
    function ownershipHTML (p) {
      var T = tax(); if (!T) return '';
      var cat = liveCategory(p);
      var cfg = T.ownershipFor(cat);
      if (!cfg) return '';
      var own = p.ownership || {};
      return sectionOpen('🛡️', 'Proof of ownership', cfg.sub) +
        fld('ownership.serial', cfg.serial, 'type="text" autocomplete="off" maxlength="120"',
            own.serial, cfg.hint) +
        selectHTML('ownership.source', 'Where did you get it?', T.OWNER_SOURCES, own.source,
          '🤔 Select source', 'Optional, but it speeds up approval.') +
        (T.needsOwnerDoc(cat)
          ? '<div class="pr-note">📄 ' + esc(cfg.doc) +
            ' is required before this listing is approved. Upload it from the listing once saved.</div>'
          : '') +
        '<label class="pr-check"><input type="checkbox" data-pf="ownership.declared"' +
          (own.declared ? ' checked' : '') + '> ' +
          '<span>I confirm this item is mine to sell and the details above are true.</span></label>' +
        '<div class="pr-note">Listed as <b>pending review</b>. The "Verified owner" badge is ' +
        'added by SOKONI after checking — it is never something a listing can claim for itself.</div>' +
        sectionClose;
    }

    /* ── FOOD LICENSING ──────────────────────────────────────────────────────────────────
       Six records the legacy form collected and threw away. The county permit is the one that
       is legally required to trade, so the writer refuses a food listing without it. */
    function foodHTML (p) {
      var T = tax(); if (!T) return '';
      if (!T.needsFoodLicence(liveCategory(p))) return '';
      var fl = p.foodLicence || {};
      return sectionOpen('🥩', 'Food licensing',
        'Required to sell food in Kenya. These are stored with your listing.') +
        fld('foodLicence.permit', 'County food business permit no.',
            'type="text" autocomplete="off" maxlength="120" required', fl.permit,
            'Required — e.g. NRB-FBP-2024-XXXXX') +
        '<div class="pr-row">' +
          fld('foodLicence.kebs', 'KEBS / KEFRI no.', 'type="text" maxlength="120"', fl.kebs) +
          fld('foodLicence.kmc', 'KMC no. (meat)', 'type="text" maxlength="120"', fl.kmc) +
        '</div>' +
        fld('foodLicence.halal', 'Halal certificate', 'type="text" maxlength="120"', fl.halal) +
        selectHTML('foodLicence.storage', 'Storage / cold chain', T.FOOD_STORAGE, fl.storage,
          '🌡️ Select storage method') +
        selectHTML('foodLicence.slaughter', 'Slaughter / processing', T.FOOD_SLAUGHTER, fl.slaughter,
          '🚫 Not applicable') +
        sectionClose;
    }

    /* ── DIGITAL DELIVERY ────────────────────────────────────────────────────────────────
       Only https: a buyer who paid and then cannot fetch what they bought has been sold
       nothing, and a browser on an https page blocks an http download outright. */
    function digitalHTML (p) {
      var T = tax(); if (!T) return '';
      if (T.kindOf(liveCategory(p)) !== 'digital') return '';
      return sectionOpen('💾', 'Digital delivery',
        'The buyer gets this the moment payment clears.') +
        fld('digitalUrl', 'Download link', 'type="url" inputmode="url" maxlength="2048" ' +
            'placeholder="https://…"', p.digitalUrl, 'Must start with https://') +
        fld('digitalLicense', 'Licence key / access code', 'type="text" maxlength="200"',
            p.digitalLicense, 'Optional.') +
        sectionClose;
    }

    /* ── ✨ WRITE IT FOR ME ──────────────────────────────────────────────────────────────
       `generateProductMetadata` is a REAL deployed callable (functions/media-engine.js →
       index.js:10107): Gemini Pro Vision reads the product photograph and returns a title,
       a description, features, tags and a suggested price, with a rule-based fallback when
       the model is unavailable and a hard limit of 30 calls per merchant per day.

       IT NEEDS A PHOTOGRAPH, and says so. The callable's first act is to refuse an empty
       imageUrl, so a button offered before a photo exists would fail every time it was
       pressed. On CREATE the photo is still a local File — it has no URL until the product
       is saved and the upload runs — so the control explains that rather than pretending.
       seller.html labelled its image input "✨ AI enhanced" with nothing behind it; a second
       decorative AI button would be the same lie twice.

       IT PROPOSES, IT DOES NOT DECIDE. The result lands in the form for the merchant to edit
       and only reaches Firestore when they save. Nothing is auto-published, and the suggested
       price is shown as a suggestion — never written into the price field, which is a
       commercial decision and theirs. */
    function aiImageUrl (p) {
      var u = p && (p.image || (Array.isArray(p.images) && p.images[0]));
      return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;
    }

    function aiWriteHTML (p) {
      var creating = S.editor && S.editor.mode === 'create';
      var url = aiImageUrl(p);
      var st = (S.editor && S.editor.ai) || null;
      var body;
      if (creating || !url) {
        body = '<div class="pr-note">' + (creating
          ? 'Save the product with a photo first, then reopen it and SOKONI can write the ' +
            'description for you from the picture.'
          : 'Add a photo to this product and SOKONI can write its description from the picture.') +
          '</div>';
      } else {
        body = '<button type="button" class="pr-ai-btn" data-pr="ai-write"' +
          (st && st.busy ? ' disabled' : '') + '>' +
          (st && st.busy ? '✨ Reading your photo…' : '✨ Write it for me') + '</button>' +
          '<div class="pr-note">Reads your product photo and suggests a name, description ' +
          'and search tags. You can edit anything before saving. 30 a day.</div>';
      }
      return sectionOpen('🤖', 'SOKONI AI', 'Let the photo do the typing.') +
        body +
        (st && st.err ? '<div class="pr-err">' + esc(st.err) + '</div>' : '') +
        (st && st.price ? '<div class="pr-note">💡 Similar items sell around <b>KES ' +
          esc(String(st.price)) + '</b>. Your price stays yours — this is only a hint.</div>' : '') +
        (st && st.done ? '<div class="pr-ok">✅ Filled in below. Edit anything you like, ' +
          'then save.</div>' : '') +
        sectionClose;
    }

    function runAiWrite () {
      var E = S.editor;
      if (!E || E.mode === 'create') return;
      var p = E.product || {};
      var url = aiImageUrl(p);
      if (!url) return;
      if (typeof ctx.callAiMetadata !== 'function') {
        E.ai = { err: 'The AI writer is not available in this workspace.' };
        return paint();
      }
      captureForm();
      E.ai = { busy: true };
      paint();
      ctx.callAiMetadata({ imageUrl: url, category: liveCategory(p) || '' }).then(function (r) {
        if (!S.editor) return;
        var d = (r && r.data) || r || {};
        var m = d.metadata || d;
        var v = S.editor.values;
        /* Only fill what the merchant has not written. Overwriting a description someone
           just typed, because they pressed a button to get HELP, is the fastest way to make
           a feature untrusted. */
        if (m.title && !String(v.name || p.name || '').trim()) v.name = String(m.title).slice(0, 200);
        if (m.description) {
          var existing = String(v.description !== undefined ? v.description : (p.description || '')).trim();
          if (!existing) v.description = String(m.description).slice(0, 4000);
        }
        if (Array.isArray(m.tags) && m.tags.length) v.tags = m.tags.slice(0, 15).join(', ');
        S.editor.ai = {
          done: true,
          price: (m.suggestedPrice && isFinite(Number(m.suggestedPrice)))
            ? Math.round(Number(m.suggestedPrice)) : null
        };
        paint();
      }).catch(function (e) {
        if (!S.editor) return;
        /* The server's own sentence — including its "30 a day" refusal, which is the one a
           merchant most needs to read verbatim. */
        var msg = (e && (e.message || (e.details && e.details.message))) || '';
        msg = String(msg).replace(/^(FirebaseError:\s*)?(functions\/)?[a-z-]+:\s*/i, '');
        S.editor.ai = { err: msg || 'The AI writer could not be reached. Nothing was changed.' };
        paint();
      });
    }

    /* ── STANDARDS ───────────────────────────────────────────────────────────────────────
       Shown for the classes of physical goods where the KEBS mark applies. Never for a
       service or a download, which cannot carry one. */
    function kebsHTML (p) {
      var T = tax(); if (!T) return '';
      var cat = liveCategory(p);
      if (T.kindOf(cat) !== 'physical') return '';
      return '<div class="pr-f"><label class="pr-l" for="pf-kebsCert">KEBS certificate no.</label>' +
        '<input class="pr-i" id="pf-kebsCert" data-pf="kebsCert" type="text" maxlength="64" ' +
        'value="' + esc(p.kebsCert == null ? '' : p.kebsCert) + '">' +
        '<div class="pr-note">' + (T.showsKebs(cat)
          ? '✅ Buyers look for this on ' + esc(T.labelFor(cat) || 'this kind of product') + '. Optional.'
          : 'Optional.') + '</div></div>';
    }


    /* The specification model, or null when its script did not load. Specs are optional
       data: without the model the section is simply not offered and a product still saves
       with its name, price and stock. */
    function specModel () {
      return (typeof window !== 'undefined' && window.SokoniProductSpecs) || null;
    }

    /* A value + unit pair. The unit list comes from the model, so the editor cannot offer
       a unit the writer would then refuse. */
    function measureField (key, label, dim, cur, defUnit) {
      var SP = specModel();
      var units = (SP && SP.UNITS[dim]) ? Object.keys(SP.UNITS[dim].units) : [];
      var v = (cur && (cur.v !== undefined ? cur.v : cur.value));
      var u = (cur && (cur.u || cur.unit)) || defUnit || units[0] || '';
      return '<div class="pr-f pr-meas">' +
        '<label class="pr-l" for="pf-' + key + '-v">' + esc(label) + '</label>' +
        '<div class="pr-mrow">' +
          '<input class="pr-i" id="pf-' + key + '-v" data-pf="spec.' + key + '.v" type="number" ' +
            'inputmode="decimal" step="any" placeholder="—" value="' + esc(v == null ? '' : v) + '">' +
          '<select class="pr-i pr-u" aria-label="' + esc(label) + ' unit" data-pf="spec.' + key + '.u">' +
            /* One glyph for the whole dimension — 📏 for every length, ⚖️ for every
               weight. The emoji says what KIND of measurement this is, which is the useful
               distinction; three unrelated pictures for mm/cm/m would not be. */
            units.map(function (x) {
              var T = tax();
              return opt(x, (T ? T.dimensionEmoji(dim) + ' ' : '') + x, u);
            }).join('') +
          '</select>' +
        '</div></div>';
    }

    /* Dimensions read as one thing, so they are grouped rather than three loose rows. */
    /* A size is value + SYSTEM, and the value is never coerced to a number — "XL" is a
       real size that Number() would destroy. The system matters as much as the value: a
       38 is a different shoe in EU and in US. */
    function sizeField (key, label, cur) {
      var SP = specModel();
      var systems = (SP && SP.SIZE_SYSTEMS) ? Object.keys(SP.SIZE_SYSTEMS) : [];
      var val = cur && (cur.value !== undefined ? cur.value : cur.v);
      var sys = (cur && (cur.system || cur.u)) || "";
      var alpha = (SP && SP.SIZE_SYSTEMS.alpha.values) || [];
      return '<div class="pr-f pr-meas"><label class="pr-l" for="pf-' + key + '-v">' + esc(label) + '</label>' +
        '<div class="pr-mrow">' +
          '<input class="pr-i" id="pf-' + key + '-v" data-pf="spec.' + key + '.value" type="text" ' +
            'maxlength="20" list="pf-sizes" placeholder="e.g. XL or 38" value="' + esc(val == null ? "" : val) + '">' +
          '<select class="pr-i pr-u" aria-label="Size system" data-pf="spec.' + key + '.system">' +
            '<option value="">Auto</option>' +
            systems.map(function (x) { return opt(x, SP.SIZE_SYSTEMS[x].label, sys); }).join("") +
          '</select>' +
        '</div>' +
        '<datalist id="pf-sizes">' + alpha.map(function (a) { return '<option value="' + a + '">'; }).join("") + '</datalist>' +
      '</div>';
    }

    function dimensionField (cur) {
      var SP = specModel();
      var units = (SP && SP.UNITS.length) ? Object.keys(SP.UNITS.length.units) : [];
      var row = function (k, label) {
        var m = (cur && cur[k]) || null;
        var v = m && (m.v !== undefined ? m.v : m.value);
        var u = (m && (m.u || m.unit)) || 'cm';
        return '<div class="pr-dim">' +
          '<span>' + esc(label) + '</span>' +
          '<input class="pr-i" data-pf="spec.dimensions.' + k + '.v" type="number" inputmode="decimal" ' +
            'step="any" placeholder="—" aria-label="' + esc(label) + '" value="' + esc(v == null ? '' : v) + '">' +
          '<select class="pr-i pr-u" aria-label="' + esc(label) + ' unit" data-pf="spec.dimensions.' + k + '.u">' +
            /* Length, width and height are all lengths — one 📏 for the row, same rule as
               every other measurement select. This builder is separate from measureField(),
               which is why it needed the change twice. */
            units.map(function (x) {
              var T = tax();
              return opt(x, (T ? T.dimensionEmoji('length') + ' ' : '') + x, u);
            }).join('') + '</select>' +
        '</div>';
      };
      return '<div class="pr-f"><label class="pr-l">Dimensions</label>' +
        row('length', 'Length') + row('width', 'Width') + row('height', 'Height') + '</div>';
    }

    /* Category-suggested specifications. SUGGESTIONS, not a schema: an unknown category
       simply offers none, and the product is still complete. This is what stops a car
       getting a meaningless "size" and gives it mileage and engine capacity instead. */
    function suggestedHTML (category, specs) {
      var SP = specModel();
      if (!SP) return '';
      var list = SP.suggestionsFor(category);
      if (!list.length) return '';
      var label = (SP.categoryKey(category) || category || '').toString();
      return '<div class="pr-sec">' + esc(label.charAt(0).toUpperCase() + label.slice(1)) + ' details</div>' +
        list.map(function (d) {
          var cur = specs[d.key];
          if (d.type === 'size') return sizeField(d.key, d.label, cur);
          if (d.type === 'measure' && d.dim) return measureField(d.key, d.label, d.dim, cur, d.unit);
          if (d.type === 'measure') {
            /* A unit the dimension tables do not carry (mAh, cc) — fixed, and shown. */
            return '<div class="pr-f"><label class="pr-l" for="pf-' + d.key + '">' + esc(d.label) +
              ' <span class="pr-unit">' + esc(d.unit || '') + '</span></label>' +
              '<input class="pr-i" id="pf-' + d.key + '" data-pf="spec.' + d.key + '.v" type="number" ' +
              'inputmode="decimal" step="any" value="' + esc(cur && cur.v != null ? cur.v : '') + '">' +
              '<input type="hidden" data-pf="spec.' + d.key + '.u" value="' + esc(d.unit || '') + '">' +
              '</div>';
          }
          var val = (cur && cur.v !== undefined) ? cur.v : cur;
          var attrs = d.type === 'number' ? 'type="number" inputmode="numeric" step="1"'
                    : d.type === 'date' ? 'type="date"'
                    : 'type="text" autocomplete="off" maxlength="120"';
          return '<div class="pr-f"><label class="pr-l" for="pf-' + d.key + '">' + esc(d.label) + '</label>' +
            '<input class="pr-i" id="pf-' + d.key + '" data-pf="spec.' + d.key + '" ' + attrs +
            ' value="' + esc(val == null ? '' : val) + '"></div>';
        }).join('');
    }

    /* Merchant-defined specifications. The escape hatch that means an unusual product does
       not need a code change — a battery in mAh must not be forced into kilograms. */
    function customHTML (specs) {
      var rows = (specs && specs.custom) || [];
      var extra = S.editor && S.editor.customRows ? S.editor.customRows : 0;
      var n = Math.max(rows.length + extra, rows.length);
      var out = '';
      for (var i = 0; i < n; i++) {
        var r = rows[i] || {};
        out += '<div class="pr-cust">' +
          '<input class="pr-i" data-pf="spec.custom.' + i + '.name" type="text" maxlength="60" ' +
            'placeholder="Specification" aria-label="Specification name" value="' + esc(r.name || '') + '">' +
          '<input class="pr-i" data-pf="spec.custom.' + i + '.value" type="text" maxlength="60" ' +
            'placeholder="Value" aria-label="Value" value="' + esc(r.value == null ? '' : r.value) + '">' +
          '<input class="pr-i pr-u" data-pf="spec.custom.' + i + '.unit" type="text" maxlength="16" ' +
            'placeholder="Unit" aria-label="Unit" value="' + esc(r.unit || '') + '">' +
        '</div>';
      }
      return '<div class="pr-sec">More specifications</div>' + out +
        '<button type="button" class="pr-addspec" data-pr="addspec">＋ Add specification</button>';
    }

    /* What "20" means. Without this a stock figure is ambiguous the moment a shop counts
       in anything but pieces, which is precisely what POS and Inventory read. */
    function stockUnitHTML (p) {
      var SP = specModel();
      var units = SP ? SP.STOCK_UNITS : [];
      var su = p.stockUnit || {};
      return '<div class="pr-row">' +
        '<div class="pr-f"><label class="pr-l" for="pf-su">Counted in</label>' +
          '<select class="pr-i" id="pf-su" data-pf="stockUnit.name">' +
            '<option value="">📦 —</option>' +
            /* Emoji per unit, from the taxonomy: a select of bare words ("kg", "boxes",
               "crates") is the hardest kind to scan on a phone, and every other dropdown in
               this form now carries one. */
            units.map(function (x) {
              var T = tax();
              return opt(x, (T ? T.stockUnitEmoji(x) + ' ' : '') + x, su.name || '');
            }).join('') +
          '</select></div>' +
        '<div class="pr-f"><label class="pr-l" for="pf-supp">Units per pack</label>' +
          '<input class="pr-i" id="pf-supp" data-pf="stockUnit.perPack" type="number" inputmode="numeric" ' +
            'min="1" step="1" placeholder="—" value="' + esc(su.perPack == null ? '' : su.perPack) + '">' +
          '<div class="pr-note">For boxes, crates or packs — how many pieces are inside one.</div>' +
        '</div></div>';
    }


    /* Option names declared once, then a row per combination. Reading the existing product
       back out: its variants carry attrs keyed by the merchant's own names, so the option
       columns are recovered from the union of those keys rather than stored separately —
       one source, and no way for the columns and the rows to drift apart. */
    function variantOptionNames (p) {
      var typed = (S.editor && S.editor.values) || {};
      var fromForm = [];
      Object.keys(typed).forEach(function (k) {
        var m = /^vopt\.(\d+)$/.exec(k);
        if (m) fromForm[Number(m[1])] = typed[k];
      });
      if (fromForm.length) return fromForm;
      var names = [];
      (p.variants || []).forEach(function (v) {
        Object.keys(v.attrs || {}).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); });
      });
      return names.length ? names : [''];
    }

    function variantsHTML (p) {
      if (!specModel()) return '';
      var names = variantOptionNames(p);
      var rows = (p.variants || []);
      var extra = (S.editor && S.editor.variantRows) || 0;
      var n = rows.length + extra;

      /* ── UNIVERSAL VARIANTS ──────────────────────────────────────────────────────
         The mechanism was ALREADY universal: the option names are the merchant's own free
         text and every row carries its own price, stock, SKU and barcode. What was not
         universal was the WORDING — "colour, size, capacity" is a shop's vocabulary, and a
         restaurant reading it does not realise the same grid gives them Regular / Large,
         or a salon 30 / 60 / 90 minutes.

         So the guidance and the placeholder follow the listing type. The datalist offers
         those names without imposing them: a merchant may still type anything, which is
         what keeps one variant system serving every vertical. */
      var VAR_HINT = {
        food:     { eg: 'Portion',  list: ['Portion', 'Size', 'Spice level', 'Add-on'],
                    note: 'Same dish, different options — portion, size, extras.' },
        drink:    { eg: 'Size',     list: ['Size', 'Serving', 'Flavour'],
                    note: 'Same drink, different options — serving size, flavour.' },
        room:     { eg: 'Room type', list: ['Room type', 'Occupancy', 'View', 'Board'],
                    note: 'Same property, different rooms — type, occupancy, board.' },
        service:  { eg: 'Duration', list: ['Duration', 'Tier', 'Provider'],
                    note: 'Same service, different options — duration, tier, provider.' },
        event:    { eg: 'Ticket',   list: ['Ticket', 'Tier', 'Seating'],
                    note: 'Same event, different tickets — tier, seating.' },
        rental:   { eg: 'Period',   list: ['Period', 'Size', 'Condition'],
                    note: 'Same item, different terms — period, size.' },
        vehicle:  { eg: 'Trim',     list: ['Trim', 'Colour', 'Transmission'],
                    note: 'Same model, different options — trim, colour.' },
        property: { eg: 'Unit',     list: ['Unit', 'Floor', 'Bedrooms'],
                    note: 'Same development, different units — floor, bedrooms.' },
      };
      var _lsv = studio();
      var _vt = _lsv ? _lsv.typeIdOf(liveListing(p)) : 'product';
      var vh = VAR_HINT[_vt] || { eg: 'Colour', list: ['Colour', 'Size', 'Capacity', 'Material'],
                    note: 'Same product, different options — colour, size, capacity.' };

      var head = '<div class="pr-sec">🔀 Variants</div>' +
        '<div class="pr-note" style="margin:-4px 0 10px">' +
          esc(vh.note) + ' Each keeps its own stock, price and SKU, ' +
          'and the product total becomes their sum.' +
        '</div>' +
        '<datalist id="pf-varopts">' +
          vh.list.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') +
        '</datalist>' +
        '<div class="pr-vopts">' +
          names.map(function (nm, i) {
            return '<input class="pr-i" data-pf="vopt.' + i + '" type="text" maxlength="30" ' +
              'list="pf-varopts" ' +
              'placeholder="Option ' + (i + 1) + ' (e.g. ' + esc(vh.eg) + ')" ' +
              'aria-label="Option name ' + (i + 1) + '" ' +
              'value="' + esc(nm || '') + '">';
          }).join('') +
          (names.length < 3
            ? '<button type="button" class="pr-addopt" data-pr="addopt" aria-label="Add option">＋</button>'
            : '') +
        '</div>';

      var body = '';
      for (var r = 0; r < n; r++) {
        var row = rows[r] || { attrs: {}, stock: '' };
        body += '<div class="pr-vrow">' +
          names.map(function (nm, i) {
            var val = nm ? (row.attrs || {})[nm] : '';
            return '<input class="pr-i" data-pf="variant.' + r + '.v.' + i + '" type="text" maxlength="40" ' +
              'placeholder="' + esc(nm || 'Value') + '" aria-label="' + esc(nm || 'Option value') + '" ' +
              'value="' + esc(val == null ? '' : val) + '">';
          }).join('') +
          '<input class="pr-i pr-vqty" data-pf="variant.' + r + '.stock" type="number" inputmode="numeric" ' +
            'min="0" step="1" placeholder="Qty" aria-label="Quantity" ' +
            'value="' + esc(row.stock == null ? '' : row.stock) + '">' +
        '</div>' +
        '<div class="pr-vrow2">' +
          '<input class="pr-i" data-pf="variant.' + r + '.sku" type="text" maxlength="64" ' +
            'placeholder="SKU" aria-label="Variant SKU" value="' + esc(row.sku || '') + '">' +
          '<input class="pr-i" data-pf="variant.' + r + '.barcode" type="text" maxlength="64" inputmode="numeric" ' +
            'placeholder="Barcode" aria-label="Variant barcode" value="' + esc(row.barcode || '') + '">' +
          '<input class="pr-i" data-pf="variant.' + r + '.price" type="number" inputmode="decimal" min="0" ' +
            'step="any" placeholder="Price" aria-label="Variant price" ' +
            'value="' + esc(row.price == null ? '' : row.price) + '">' +
        '</div>';
      }

      /* The sum the till will read, shown while typing so the merchant is never surprised
         by a product-level figure they did not set. Rendered from the SAME totalStock the
         writer uses, not a second addition. */
      var SP = specModel();
      var typedRows = fieldsFromForm().variants || [];
      var total = (SP && typedRows.length) ? SP.totalStock(typedRows, null) : null;

      return head + body +
        '<button type="button" class="pr-addspec" data-pr="addvariant">＋ Add variant</button>' +
        (total !== null
          ? '<div class="pr-vtot">Product stock becomes <b>' + esc(total) + '</b> — the sum of every variant.</div>'
          : '');
    }

    function specsHTML (p) {
      if (!specModel()) return '';
      var specs = p.specs || {};
      return '<div class="pr-sec">📏 Specifications</div>' +
        fld('spec.brand', 'Brand', 'type="text" autocomplete="off" maxlength="80"', specs.brand) +
        /* The barcode is the one field on this form a machine can fill in correctly
           and a person routinely cannot: thirteen digits copied by eye is how a
           product ends up unscannable at the till for a single transposed pair. */
        scanFld('spec.barcode', 'Barcode', 'type="text" autocomplete="off" maxlength="64" inputmode="numeric"',
                specs.barcode, 'Scan it rather than typing it — this is what the till matches when the item is scanned at the counter.') +
        measureField('weight', 'Weight', 'weight', specs.weight, 'kg') +
        dimensionField(specs.dimensions) +
        measureField('capacity', 'Capacity', 'volume', specs.capacity, 'l') +
        suggestedHTML(p.category, specs) +
        customHTML(specs) +
        variantsHTML(p);
    }


    /* ── PRODUCT DETAIL ───────────────────────────────────────────────────────
       Renders the product AS STORED. Every field here comes from the record the
       authority returned — nothing is derived, defaulted or invented for display. A
       product with no category shows no category row rather than "Uncategorised", which
       would be this surface asserting something the merchant never entered. */
    function specRows (p) {
      var SP = specModel();
      var specs = p.specs || {};
      var rows = [];

      var show = function (label, val) {
        if (val === null || val === undefined || val === '') return;
        rows.push([label, val]);
      };
      /* A measurement prints in the merchant's OWN unit, not the comparison base. The
         base exists for sorting; showing "1010000 g" to someone who typed 1010 kg would
         be technically the same figure and practically wrong. */
      var measure = function (label, m) {
        if (!m) return;
        var v = (m.v !== undefined) ? m.v : m.value;
        if (v === null || v === undefined || v === '') return;
        show(label, v + (m.u ? ' ' + m.u : ''));
      };

      show('Brand', specs.brand);
      show('Barcode', specs.barcode);
      show('Condition', specs.condition);
      measure('Weight', specs.weight);
      measure('Capacity', specs.capacity);
      if (specs.dimensions) {
        var d = specs.dimensions;
        var part = function (m) { return m ? ((m.v !== undefined ? m.v : m.value) + (m.u ? m.u : '')) : null; };
        var bits = [part(d.length), part(d.width), part(d.height)].filter(Boolean);
        if (bits.length) show('Dimensions', bits.join(' × '));
      }
      /* Category-suggested keys, labelled the way the editor labelled them. */
      if (SP) {
        SP.suggestionsFor(p.category).forEach(function (def) {
          var val = specs[def.key];
          if (val === undefined) return;
          if (val && typeof val === 'object') measure(def.label, val);
          else show(def.label, val);
        });
      }
      (specs.custom || []).forEach(function (c) {
        show(c.name, (c.value === '' ? c.number : c.value) + (c.unit ? ' ' + c.unit : ''));
      });
      return rows;
    }

    function detailHTML (p, i) {
      var img = p.image || (Array.isArray(p.images) && p.images[0]) || null;
      var price = money(p.price);
      var rows = specRows(p);
      var vars = p.variants || [];

      return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div>' +
        '<div class="pr-panel pr-detail" role="dialog" aria-modal="true" aria-label="Product detail">' +
        (img ? '<img class="pr-dimg" alt="" src="' + esc(img) + '">'
             : '<div class="pr-dph" aria-hidden="true">📦</div>') +
        '<div class="pr-dname">' + esc(p.name || p.title || 'Untitled') + '</div>' +
        '<div class="pr-dprice">' + esc(price === null ? '—' : price) + '</div>' +
        '<div class="pr-dpill">' + statusPill(p) + '</div>' +

        '<div class="pr-dgrid">' +
          '<div class="pr-dcell"><small>Inventory</small><b>' + stockLine(p) + '</b></div>' +
          (p.category ? '<div class="pr-dcell"><small>Category</small><b>' + esc(p.category) + '</b></div>' : '') +
          (p.sku ? '<div class="pr-dcell"><small>SKU</small><b>' + esc(p.sku) + '</b></div>' : '') +
        '</div>' +

        (p.description ? '<div class="pr-ddesc">' + esc(p.description) + '</div>' : '') +

        (rows.length
          ? '<div class="pr-sec">📏 Specifications</div>' +
            '<div class="pr-dspecs">' + rows.map(function (r) {
              return '<div class="pr-dspec"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
            }).join('') + '</div>'
          : '') +

        (vars.length
          ? '<div class="pr-sec">🔀 Variants</div>' +
            '<div class="pr-dvars">' + vars.map(function (v) {
              var label = Object.keys(v.attrs || {}).map(function (k) {
                return esc(k) + ': ' + esc(v.attrs[k]);
              }).join(' · ');
              return '<div class="pr-dvar"><span>' + label + '</span>' +
                '<b>' + esc(v.stock == null ? '—' : v.stock) + '</b>' +
                (v.price != null ? '<i>' + esc(money(v.price) || '') + '</i>' : '') + '</div>';
            }).join('') + '</div>'
          : '') +

        /* Actions. Adjust inventory ROUTES through the shell — stock corrections belong to
           Inventory, which writes them through merchantAdjustStock so a correction is never
           recorded as a sale. This sheet reads stock; it does not change it. */
        '<div class="pr-dacts">' +
          '<button class="pr-add" data-pr="edit" data-i="' + i + '">✏️ Edit product</button>' +
          '<button class="pr-btn" data-pr="go" data-route="inventory">📦 Adjust inventory</button>' +
          '<button class="pr-btn" data-pr="photos" data-i="' + i + '">📸 Photos</button>' +
          '<button class="pr-btn danger" data-pr="del" data-i="' + i + '">🗑️ Remove</button>' +
        '</div>' +
        '<button class="pr-cancel" style="width:100%;margin-top:10px" data-pr="close">Close</button>' +
        '</div></div>';
    }

    /* ══ THE LISTING STUDIO ════════════════════════════════════════════════════════════
       What turns this editor from a product uploader into a listing editor. It is drawn by
       sokoni-listing-studio.js INTO this form — not beside it, not in a second panel and
       not in a second page — because a merchant who sells goods, serves food and lets rooms
       should have one place to describe all three.

       ABSENT WHEN THE MODULE HAS NOT LOADED. Every call below returns '' if the Studio is
       missing, so the form degrades to exactly the product editor it was rather than to a
       half-rendered one. */
    function studio () {
      return (typeof window !== 'undefined' && window.SokoniListingStudio) || null;
    }

    /* The listing as it stands RIGHT NOW — stored record plus whatever is typed — so the
       quality score and the preview describe what the merchant is looking at. Scoring the
       saved record instead would report a percentage for a listing that no longer exists. */
    function liveListing (p) {
      var LS = studio();
      return LS ? LS.applyFormValues(p || {}, p || {}) : (p || {});
    }

    /* Keys the NATIVE form already draws, which the Studio must not draw again. The fixed
       half is this form's own top-level inputs; the rest is whatever the specifications
       section is currently offering for the chosen category, which is why `model` appears
       under Vehicle but not under a phone — the specs already asked for it there.

       Derived rather than listed, so a field added to either side cannot end up as two
       boxes for one value with the writer unable to tell which the merchant meant. */
    function studioSkipKeys (p) {
      var keys = ['name', 'description', 'price', 'category', 'location',
                  'condition', 'brand', 'sku', 'stock', 'warranty'];
      var SP = specModel();
      if (SP && typeof SP.suggestionsFor === 'function') {
        try {
          (SP.suggestionsFor(liveCategory(p)) || []).forEach(function (s) {
            if (s && s.key) keys.push(s.key);
          });
        } catch (_) { /* a taxonomy miss must not take the form down with it */ }
      }
      return keys;
    }

    /* The four reports that close the form. Built as one string so they can be re-rendered
       together into their container without rebuilding the sheet. */
    function studioReportHTML (p, device) {
      var LS = studio();
      if (!LS) return '';
      var live = liveListing(p);
      return LS.mediaGroupsHTML(live) + LS.lifecycleHTML(live) +
             LS.qualityHTML(live) + LS.previewHTML(live, device);
    }

    /* REPAINTS ONLY THE REPORTS, never the sheet — the same rule repaintWarranty() follows,
       and for the same reason: rebuilding the editor on every field the merchant leaves
       would move the caret and lose the selection, which is exactly the behaviour that
       makes a long form feel broken.

       It is called on `change`, so the score answers the merchant's last completed edit
       rather than each keystroke. A percentage that flickers on every letter is noise. */
    function refreshStudioReport () {
      var box = host.querySelector && host.querySelector('[data-ls-report]');
      if (!box || !S.editor) return;
      captureForm();
      box.innerHTML = studioReportHTML(S.editor.values || {}, S.editor.device);
    }

    function editorHTML () {
      var E = S.editor;
      if (E.mode === 'photos') return photosHTML();
      if (E.mode === 'detail') return detailHTML(E.product || {}, E.index);
      /* Render from the TYPED values, falling back to the stored record. */
      var p = (E.mode === 'delete') ? (E.product || {}) : (E.values || {});
      if (E.mode === 'delete') {
        return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div><div class="pr-panel" role="dialog" aria-modal="true" aria-label="Delete product">' +
          '<div class="pr-ph2">Delete this product?</div>' +
          '<div class="pr-psub">' + esc(p.name || 'Untitled') + '</div>' +
          '<div class="pr-warn">It will be removed from your catalogue and from the till. ' +
          'Orders already placed keep their record. This cannot be undone.</div>' +
          (E.err ? '<div class="pr-err">' + esc(E.err) + '</div>' : '') +
          '<div class="pr-foot">' +
            '<button class="pr-cancel" data-pr="close">Keep it</button>' +
            '<button class="pr-danger" data-pr="submit"' + (E.busy ? ' disabled' : '') + '>' +
              (E.busy ? 'Deleting…' : 'Delete') + '</button>' +
          '</div></div></div>';
      }
      var creating = E.mode === 'create';
      return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div><div class="pr-panel" role="dialog" aria-modal="true" aria-label="' +
        (creating ? 'Add a product' : 'Edit product') + '">' +
        '<div class="pr-ph2">' + (creating ? 'Add a product' : 'Edit product') + '</div>' +
        '<div class="pr-psub">' + (creating
          ? 'It goes to your shop, your Inventory and the till.'
          : esc(p.name || 'Untitled')) + '</div>' +
        (E.blocked ? '<div class="pr-block">' + esc(E.blocked) + '</div>' : '') +
        (studio() ? studio().typePickerHTML(liveListing(p)) : '') +
        fld('name', 'Product name', 'type="text" autocomplete="off" maxlength="200" required', p.name) +
        '<div class="pr-row">' +
          fld('price', 'Price (KES)', 'type="number" inputmode="decimal" min="1" step="any" required', p.price) +
          fld('costPrice', 'Cost (KES)', 'type="number" inputmode="decimal" min="0" step="any"', p.costPrice) +
        '</div>' +
        '<div class="pr-row">' +
          /* CREATE takes an opening quantity — it becomes the product's first inventory
             movement, through merchantAdjustStock, not a metadata field.
             EDIT shows the figure and does NOT offer to change it: an existing product's shelf
             count is inventory movement and belongs to Inventory. Rendering an input here that
             the writer then refused would be a control that lies about what it does. */
          (creating
            ? fld('stock', 'Opening stock', 'type="number" inputmode="numeric" min="0" step="1"', p.stock)
            : stockReadHTML(p)) +
          fld('sku', 'SKU', 'type="text" autocomplete="off" maxlength="64"', p.sku) +
        '</div>' +
        categoryHTML(p) +
        /* Condition and location are what a buyer asks first about anything second-hand or
           bulky, and neither existed in V2 at all. */
        '<div class="pr-row">' +
          (tax() ? selectHTML('condition', 'Condition', tax().CONDITIONS, p.condition,
                              '✨ Select condition') : '') +
          fld('brand', 'Brand', 'type="text" autocomplete="off" maxlength="80"', p.brand) +
        '</div>' +
        (tax() ? selectHTML('location', 'Where it is', tax().LOCATIONS, p.location,
                            '📍 Select location',
                            'Buyers filter by town, and delivery is quoted from here.') : '') +
        fld('deliveryCost', 'Delivery cost (KES)', 'type="number" inputmode="decimal" min="0" step="any"',
            p.deliveryCost, 'Leave empty or 0 for free delivery.') +
        stockUnitHTML(p) +
        bulkHTML(p) +
        specsHTML(p) +
        (studio() ? studio().extraFieldsHTML(liveListing(p), studioSkipKeys(p)) : '') +
        ownershipHTML(p) +
        foodHTML(p) +
        digitalHTML(p) +
        kebsHTML(p) +
        warrantyHTML(p) +
        aiWriteHTML(p) +
        '<div class="pr-f"><label class="pr-l" for="pf-description">Description</label>' +
          '<textarea class="pr-i" id="pf-description" data-pf="description" maxlength="4000">' +
          esc((S.editor && S.editor.values.description !== undefined)
              ? S.editor.values.description : (p.description || '')) + '</textarea></div>' +
        fld('tags', 'Search tags', 'type="text" autocomplete="off" maxlength="400"',
            (S.editor && S.editor.values.tags !== undefined)
              ? S.editor.values.tags
              : (Array.isArray(p.tags) ? p.tags.join(', ') : p.tags),
            'Comma separated. Helps buyers find this — up to 15.') +
        '<div class="pr-f"><label class="pr-l" for="pf-status">Visibility</label>' +
          '<select class="pr-i" id="pf-status" data-pf="status">' +
            (tax()
              ? tax().VISIBILITY.map(function (v) {
                  return opt(v.value, v.emoji + ' ' + v.label, p.status || 'active');
                }).join('')
              : opt('active', 'Active — on sale', p.status || 'active') +
                opt('draft', 'Draft — hidden', p.status || 'active')) +
          '</select>' +
          (creating ? '' : '<div class="pr-note">Photos are added separately. A product sells without one.</div>') +
          '</div>' +
        (creating ? createPhotosHTML() : '') +
        /* The closing half of the Studio: the shot list, where this listing sits in its
           lifecycle, what is still missing, and what a buyer will see. Placed last because
           all four are reports on the form above them — a completeness score shown before
           the fields it scores would only ever read 0%. */
        '<div data-ls-report>' + studioReportHTML(p, E.device) + '</div>' +
        (E.err ? '<div class="pr-err">' + esc(E.err) + '</div>' : '') +
        '<div class="pr-foot">' +
          '<button class="pr-cancel" data-pr="close">Cancel</button>' +
          /* A price tag can only be printed for a product that EXISTS. While
             creating there is no id, no stored price and no canonical SKU, so the
             button is present but disabled and says why — a hidden control reads
             as a missing feature, and printing an unsaved form would put a price
             on a shelf for a product the till has never heard of. */
          '<button class="pr-print" data-pr="printtag" title="' +
            (creating ? 'Add the product first, then reopen it to print its tag'
                      : 'Print a shelf price tag for this product') + '"' +
            ((creating || E.busy || E.printing) ? ' disabled' : '') + '>' +
            (E.printing ? 'Printing…' : '🖨 Print price tag') + '</button>' +
          '<button class="pr-save" data-pr="submit"' + (E.busy ? ' disabled' : '') + '>' +
            (E.busy ? 'Saving…' : (creating ? 'Add product' : 'Save changes')) + '</button>' +
        '</div></div></div>';
    }

    var _t = null;
    function onInput (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      /* Every keystroke in the editor is mirrored into state, so a repaint
         mid-edit keeps the merchant's work. */
      if (S.editor && el.getAttribute('data-pf')) {
        S.editor.values[el.getAttribute('data-pf')] = el.value;
        return;
      }
      var k = el.getAttribute('data-pr');
      if (k === 'q') {
        clearTimeout(_t);
        var v = el.value;
        _t = setTimeout(function () {
          S.q = v; S.menu = null;
          paint();
          var s = host.querySelector('[data-pr="q"]');
          if (s) { s.focus(); try { s.setSelectionRange(v.length, v.length); } catch (_) {} }
        }, 200);
      }
    }
    function onChange (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      if (S.editor && el.getAttribute('data-pf') === 'photos') return onFiles(el.files);
      if (S.editor && el.getAttribute('data-pf') === 'photo-capture') return onFiles(el.files, true);
      if (S.editor && el.getAttribute('data-pf')) {
        var pf = el.getAttribute('data-pf');
        S.editor.values[pf] = (el.type === 'checkbox') ? (el.checked ? '1' : '') : el.value;
        /* THE CATEGORY DECIDES WHICH SECTIONS EXIST. Changing it from a phone to a goat has
           to swap an IMEI field for a slaughter record, so this one repaints. captureForm()
           first, or everything typed so far is thrown away by the rebuild. */
        if (pf === 'category') { captureForm(); paint(); return; }
        /* Every other completed edit updates the quality report and the preview in place,
           so the merchant can see a listing get stronger as they fill it in. */
        refreshStudioReport();
        return;
      }
      var k = el.getAttribute('data-pr');
      if (k === 'status') { S.status = el.value; S.menu = null; paint(); }
      if (k === 'sort')   { S.sort = el.value; S.menu = null; paint(); }
    }
    function onClick (ev) {
      /* One more empty custom row. captureForm() first, so the rows the merchant has
         already typed survive the repaint — rebuilding the sheet without capturing would
         discard them, which is the kind of loss that makes people distrust a form. */
      /* Tapping the card BODY opens the detail sheet. Checked after the explicit action
         buttons below would have matched, and guarded on the tap not landing on one of
         them — otherwise Edit would open a detail sheet instead of the editor. */
      /* The overflow menu. One open at a time, and tapping the same control closes it —
         a menu that only ever opens is a menu a merchant has to navigate away from. */
      /* Checked BEFORE [data-pr="ai"], because `closest('[data-pr="ai"]')` would not match
         "ai-write" but the reverse order still reads confusingly to the next editor. The two
         are different features: this one writes TEXT from the photograph, that one edits the
         photograph itself. */
      /* The getAttribute re-check is not belt-and-braces, it is the established idiom in this
         file (see [data-pr="ai"] below) and it is load-bearing: closest() is stubbed in the
         suites, and a stub that answers every selector would let this branch swallow the
         SUBMIT click — one tap on "Add product" would run the AI writer and save nothing.
         Matching the selector is not the same as being the element. */
      /* WARRANTY TILES. Checked first because they carry no data-pr and would otherwise
         fall through to the card-body branch, which opens a detail sheet — a seller
         choosing a remedy would find the product opening instead.

         The getAttribute re-check is this file's established idiom and is load-bearing:
         closest() is stubbed in the suites, and a stub answering every selector would let
         this branch swallow the submit click. */
      /* ── LISTING STUDIO CONTROLS ────────────────────────────────────────────────────
         The type chips and the preview's device toggle. Checked before the warranty tiles
         and the card body for the same reason those are checked early: they carry no
         data-pr, and would otherwise fall through to a branch that opens a detail sheet.

         captureForm() runs first so that repainting the sheet keeps whatever the merchant
         has already typed. A picker that emptied the form it is attached to would be worse
         than no picker. */
      /* ── BATCH SELECTION ────────────────────────────────────────────────────────────
         Checked BEFORE the card-body branch, which is the whole point: a tick must never
         also open the product. The tick's own control carries data-pr="pick", and the
         getAttribute re-check is this file's established idiom because closest() is stubbed
         in the suites and a stub answering every selector would swallow other clicks. */
      var pickBtn = ev.target.closest && ev.target.closest('[data-pr="pick"]');
      if (pickBtn && pickBtn.getAttribute && pickBtn.getAttribute('data-pr') === 'pick') {
        ev.preventDefault(); ev.stopPropagation();
        var pp = (S.painted || [])[Number(pickBtn.getAttribute('data-i'))];
        if (!pp || !pp.id) return;
        S.selected = S.selected || {};
        if (S.selected[pp.id]) delete S.selected[pp.id]; else S.selected[pp.id] = true;
        return paint();
      }

      var lsBtn = ev.target.closest && ev.target.closest('[data-ls]');
      if (lsBtn && lsBtn.getAttribute && lsBtn.getAttribute('data-ls') && S.editor) {
        var lsKind = lsBtn.getAttribute('data-ls');
        if (lsKind === 'type') {
          ev.preventDefault();
          captureForm();
          S.editor.values.listingType = lsBtn.getAttribute('data-type') || '';
          paint();
          return;
        }
        if (lsKind === 'device') {
          ev.preventDefault();
          S.editor.device = lsBtn.getAttribute('data-device') === 'desktop' ? 'desktop' : 'mobile';
          /* Only the reports redraw. Rebuilding the whole sheet to switch a preview between
             phone and desktop would scroll the merchant back to the top of a long form. */
          refreshStudioReport();
          return;
        }
      }

      var wtyTile = ev.target.closest && ev.target.closest('[data-wty]');
      if (wtyTile && wtyTile.getAttribute && wtyTile.getAttribute('data-wty')) {
        var kind = wtyTile.getAttribute('data-wty');
        if (kind === 'duration' || kind === 'remedy' || kind === 'reason') {
          ev.preventDefault();
          if (kind === 'duration') {
            /* One duration. A policy with two lengths is not a policy. */
            var all = host.querySelectorAll('[data-wty="duration"]');
            Array.prototype.forEach.call(all, function (b) {
              b.setAttribute('aria-pressed', 'false');
              if (b.classList) b.classList.remove('is-on');
            });
            wtyTile.setAttribute('aria-pressed', 'true');
            if (wtyTile.classList) wtyTile.classList.add('is-on');
          } else {
            var on = wtyTile.getAttribute('aria-pressed') !== 'true';
            wtyTile.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (wtyTile.classList) wtyTile.classList.toggle('is-on', on);
          }
          repaintWarranty();
          return;
        }
      }

      var aiWrite = ev.target.closest && ev.target.closest('[data-pr="ai-write"]');
      if (aiWrite && aiWrite.getAttribute && aiWrite.getAttribute('data-pr') === 'ai-write') {
        runAiWrite();
        return;
      }
      var aiBtn = ev.target.closest && ev.target.closest('[data-pr="ai"]');
      if (aiBtn && aiBtn.getAttribute && aiBtn.getAttribute('data-pr') === 'ai') {
        applyAiTool(Number(aiBtn.getAttribute('data-i')), aiBtn.getAttribute('data-tool'));
        return;
      }
      var aiUndo = ev.target.closest && ev.target.closest('[data-pr="aiundo"]');
      if (aiUndo && aiUndo.getAttribute && aiUndo.getAttribute('data-pr') === 'aiundo') {
        undoAiTool(Number(aiUndo.getAttribute('data-i')));
        return;
      }

      var menuBtn = ev.target.closest && ev.target.closest('[data-pr="menu"]');
      if (menuBtn && menuBtn.getAttribute && menuBtn.getAttribute('data-pr') === 'menu') {
        var mi = Number(menuBtn.getAttribute('data-i'));
        S.menu = (S.menu === mi) ? null : mi;
        paint();
        return;
      }

      var openCard = ev.target.closest && ev.target.closest('[data-pr="open"]');
      if (openCard && openCard.getAttribute && openCard.getAttribute('data-pr') === 'open' &&
          !(ev.target.closest && ev.target.closest('[data-pr="edit"],[data-pr="photos"],[data-pr="del"],[data-pr="menu"]'))) {
        var oi = Number(openCard.getAttribute('data-i'));
        var op = S.painted && S.painted[oi];
        if (op) { S.editor = { mode: 'detail', product: op, index: oi }; paint(); }
        return;
      }

      var addvar = ev.target.closest && ev.target.closest('[data-pr="addvariant"]');
      if (addvar && addvar.getAttribute && addvar.getAttribute('data-pr') === 'addvariant') {
        captureForm();
        S.editor.variantRows = (S.editor.variantRows || 0) + 1;
        paint();
        return;
      }
      var addopt = ev.target.closest && ev.target.closest('[data-pr="addopt"]');
      if (addopt && addopt.getAttribute && addopt.getAttribute('data-pr') === 'addopt') {
        captureForm();
        var names = variantOptionNames((S.editor && S.editor.values) || {});
        S.editor.values['vopt.' + names.length] = '';
        paint();
        return;
      }
      var addspec = ev.target.closest && ev.target.closest('[data-pr="addspec"]');
      if (addspec && addspec.getAttribute && addspec.getAttribute('data-pr') === 'addspec') {
        captureForm();
        S.editor.customRows = (S.editor.customRows || 0) + 1;
        paint();
        return;
      }

      /* Filter chips write the SAME S.status the select does — one filter state, so the
         chip strip and the dropdown can never disagree about what is being shown. */
      var chip = ev.target.closest && ev.target.closest('[data-pr="chip"]');
      /* MATCHED, THEN VERIFIED. closest() is trusted only as far as the attribute it was
         asked for actually being present: the certification harness stubs closest() to
         return the same button for EVERY selector, so trusting it alone made this branch
         swallow the submit click and no product was ever created. Reading the value and
         requiring it is both harness-proof and stricter than the original. */
      var chip = ev.target.closest && ev.target.closest('[data-pr="chip"]');
      var chipKey = chip && ((chip.dataset && chip.dataset.chip) ||
                             (chip.getAttribute && chip.getAttribute('data-chip')));
      if (chipKey) { S.status = chipKey; S.menu = null; paint(); return; }


      /* Navigation belongs to the SHELL. This module never sets location and never links
         to seller.html; it asks merchant-v2 to route, so Back, reload and the deep link
         keep working and there is no floating back control to get wrong. */
      var go = ev.target.closest && ev.target.closest('[data-pr="go"]');
      var goRoute = go && ((go.dataset && go.dataset.route) || (go.getAttribute && go.getAttribute('data-route')));
      if (goRoute) {
        var r = goRoute;
        try {
          if (typeof ctx.go === 'function') ctx.go(r);
          else if (window.SokoniShell && typeof window.SokoniShell.go === 'function') window.SokoniShell.go(r);
        } catch (_) {}
        return;
      }

      var el = ev.target && ev.target.closest && ev.target.closest('[data-pr]');
      if (!el) return;
      var k = el.getAttribute('data-pr');

      if (k === 'retry') { S.err = null; S.rows = null; return load(); }
      if (k === 'add')   return openEditor('create', null);
      if (k === 'scanadd') return scanToAdd();
      /* The field is named by the button, never inferred from position: a Scan button
         that wrote to whichever input happened to be nearest would silently fill the
         wrong field the first time this form is reordered. */
      if (k === 'scanfield') {
        var sf = el.getAttribute('data-field');
        return sf ? scanIntoField(sf) : undefined;
      }
      if (k === 'close') { if (S.editor && S.editor.busy) return; return closeEditor(); }
      if (k === 'submit') return submit();
      if (k === 'printtag') return printPriceTag();
      /* Batch: the selection, or one product straight from its row menu. */
      if (k === 'tagsel')  return printSelectedTags();
      if (k === 'tag1') {
        var t1 = (S.painted || [])[Number(el.getAttribute('data-i'))];
        S.menu = null;
        return t1 && t1.id ? printTags([t1])
                           : say('Add the product first, then print its tag.');
      }
      if (k === 'pickall') {
        S.selected = S.selected || {};
        /* Only what is ON SCREEN. "All" meaning the whole catalogue behind a filter is how
           someone prints four hundred tags intending to print four. */
        (S.painted || []).forEach(function (p) { if (p && p.id) S.selected[p.id] = true; });
        return paint();
      }
      if (k === 'pickno') { S.selected = {}; return paint(); }
      if (k === 'submit-photos') return submitPhotos();

      if (k === 'edit' || k === 'del' || k === 'photos') {
        /* Resolve through the rows captured at paint time. An index into a list
           that has since been re-filtered would open the wrong product — and for
           `del` that is a merchant losing a product they did not choose. */
        var i = Number(el.getAttribute('data-i'));
        var p = (S.painted || [])[i];
        if (!p) return say('That product is no longer in view — reopen Products and try again.');
        if (k === 'photos') return openPhotos(p);
        return openEditor(k === 'edit' ? 'edit' : 'delete', p);
      }
    }

    /* Escape closes the sheet, but never mid-write: dismissing the form while a
       mutation is in flight would leave the merchant with no idea whether it
       landed. */
    function onKey (ev) {
      if (ev.key !== 'Escape' || !S.editor || S.editor.busy) return;
      closeEditor();
    }

    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    load();

    return {
      refresh: function () { S.rows = null; S.err = null; return load(); },
      destroy: function () {
        S.destroyed = true;
        clearTimeout(_t);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onChange);
        host.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        if (host && host.classList) host.classList.remove(HOST_CLASS);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount };
}));
