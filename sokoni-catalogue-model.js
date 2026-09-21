/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI — CATALOGUE MODEL (pure)
   sokoni-catalogue-model.js

   One catalogue, two commerce types. This module decides what a `posProducts`
   row IS, what may be created, and how an edit is merged — with no DOM, no
   Firestore and no network, so all of it is testable.

   ── ONE COLLECTION, NOT TWO ────────────────────────────────────────────────

   A service is a `posProducts` row with `trackStock: false`, a `unit`, and
   optionally `variablePrice: true`. There is no `posServices` collection and
   there must never be one: search, reports, receipts, the POS basket and
   marketplace sync all read `posProducts`, and a second catalogue would have
   to be taught to every one of them.

   ── A FIELD THAT HAD NO WRITER ─────────────────────────────────────────────

   `trackStock` is read in exactly two places — `pos.js:3104` (excluded from
   low-stock alerts) and `functions/shared/pos-service-pricing.js` (product vs
   service) — and until this module, **nothing in the repository ever wrote
   it**. Every existing row has it ABSENT.

   Absent must therefore keep meaning PRODUCT, which is what both readers
   already assume (`trackStock !== false`). This module writes the field
   EXPLICITLY on both kinds so new rows stop relying on that default, and
   leaves every existing row's meaning unchanged.

   A separate field, plain `track`, is written by `pos-inventory-sync.js:109`
   and `pos.js:750` and read by nothing in a product context. It is NOT
   touched here: reconciling the two is an inventory-semantics change, which
   this slice is explicitly forbidden from making. Noted, not "fixed".

   ── EDITS MERGE, THEY DO NOT REPLACE ───────────────────────────────────────

   A catalogue row carries fields this editor never shows — `cost`, `batch`,
   `expiryDate`, `barcode`, `merchantId`, sync bookkeeping. `applyEdit` starts
   from the existing row and overlays only what the editor owns, so opening and
   saving an item cannot silently strip data another subsystem depends on.
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniCatalogueModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND = Object.freeze({ PRODUCT: 'product', SERVICE: 'service' });

  /* Fields this editor owns. Anything NOT here survives an edit untouched —
     that is the whole contract of applyEdit(). */
  const PRODUCT_FIELDS = Object.freeze([
    'name', 'description', 'price', 'sku', 'category', 'unit',
    'stock', 'lowStockThreshold', 'image', 'active',
  ]);
  const SERVICE_FIELDS = Object.freeze([
    'name', 'description', 'price', 'category', 'unit',
    'variablePrice', 'active',
  ]);

  /* ── Classification ──────────────────────────────────────────────────────
     The ONE place the product/service question is answered on the client, and
     it matches the server pricer exactly: absent is a PRODUCT. */
  function kindOf(row) {
    return (row && row.trackStock === false) ? KIND.SERVICE : KIND.PRODUCT;
  }
  function isService(row) { return kindOf(row) === KIND.SERVICE; }
  function isProduct(row) { return kindOf(row) === KIND.PRODUCT; }

  /* A service is variable-priced only when it SAYS so. A product never is —
     product pricing is the catalogue's job, and a cashier-editable product
     price is the defect the fixed-price rule exists to prevent. */
  function isVariable(row) {
    return isService(row) && row.variablePrice === true;
  }

  function isArchived(row) { return !!row && row.active === false; }

  /* ── What may be created ─────────────────────────────────────────────────
     Scope comes from the caller (business-scope.js), never from this file, and
     never from a self-declared field on the merchant's own record. This maps
     an already-resolved scope onto buttons; it decides no authority itself.
     The SERVER re-decides on every write and on every sale. */
  function creatableKinds(scope) {
    const out = [];
    if (scope && scope.sellsProducts)    out.push(KIND.PRODUCT);
    if (scope && scope.providesServices) out.push(KIND.SERVICE);
    return out;
  }
  function mayCreate(scope, kind) {
    return creatableKinds(scope).indexOf(kind) !== -1;
  }

  /* Why a kind is unavailable — so the UI can explain instead of showing a
     dead button. Mirrors business-scope's `reasons`. */
  function unavailableReason(scope, kind) {
    if (mayCreate(scope, kind)) return null;
    const side = kind === KIND.SERVICE ? 'services' : 'products';
    const r = (scope && scope.reasons && scope.reasons[side]) || 'not_applied';
    if (r === 'pending_review') {
      return kind === KIND.SERVICE
        ? 'Your application to provide services is still in review.'
        : 'Your application to sell products is still in review.';
    }
    if (r === 'suspended') {
      return kind === KIND.SERVICE
        ? 'Your services approval is suspended, so services cannot be added.'
        : 'Your products approval is suspended, so products cannot be added.';
    }
    if (r === 'rejected') {
      return kind === KIND.SERVICE
        ? 'Your application to provide services was not approved.'
        : 'Your application to sell products was not approved.';
    }
    return kind === KIND.SERVICE
      ? 'Apply to provide services to add them to your catalogue.'
      : 'Apply to sell products to add them to your catalogue.';
  }

  /* ── Display ─────────────────────────────────────────────────────────────
     Presentation only. No total is computed here and no money decision is
     made — the server prices every sale. */
  function priceLabel(row, fmt) {
    const money = fmt || ((n) => 'KES ' + Number(n || 0).toLocaleString('en-KE'));
    if (isVariable(row)) return 'Variable price';
    const p = Number(row && row.price);
    if (!Number.isFinite(p) || p <= 0) return 'No price set';
    const unit = row && row.unit ? String(row.unit) : '';
    return unit ? money(p) + ' / ' + unit : money(p);
  }

  function stockLabel(row) {
    if (isService(row)) return null;            /* services are unmetered */
    const s = row && row.stock;
    /* ABSENT stock is UNMETERED, not zero. Rendering "Stock: 0" for a row that
       simply never tracked stock would read as out-of-stock and stop a sale
       that should happen. */
    if (s === null || s === undefined || s === '') return 'Not tracked';
    const n = Number(s);
    if (!Number.isFinite(n)) return 'Not tracked';
    return 'Stock: ' + n;
  }

  function badgesFor(row) {
    const b = [kindOf(row) === KIND.SERVICE ? 'SERVICE' : 'PRODUCT'];
    if (isService(row)) b.push(isVariable(row) ? 'VARIABLE' : 'FIXED');
    else {
      const s = row && row.stock;
      if (s !== null && s !== undefined && s !== '' && Number.isFinite(Number(s))) {
        b.push(Number(s) > 0 ? 'IN STOCK' : 'OUT OF STOCK');
      }
    }
    b.push(isArchived(row) ? 'ARCHIVED' : 'ACTIVE');
    return b;
  }

  /* ── Filtering ───────────────────────────────────────────────────────────
     Client-side over rows already loaded. No search backend is introduced. */
  function filterRows(rows, o) {
    o = o || {};
    const q = String(o.query || '').trim().toLowerCase();
    const tab = o.tab || 'all';
    const status = o.status || 'any';
    return (rows || []).filter((r) => {
      if (tab === 'products' && !isProduct(r)) return false;
      if (tab === 'services' && !isService(r)) return false;
      if (status === 'active'   && isArchived(r)) return false;
      if (status === 'archived' && !isArchived(r)) return false;
      if (!q) return true;
      const hay = [r && r.name, r && r.sku, r && r.category, r && r.description]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function emptyMessage(scope, tab) {
    const p = !!(scope && scope.sellsProducts);
    const s = !!(scope && scope.providesServices);
    if (tab === 'products') return { t: 'No products yet.', s: 'Add your first product to start selling.' };
    if (tab === 'services') return { t: 'No services yet.', s: 'Add your first service to start taking service orders.' };
    if (p && s) return { t: 'Your catalogue is empty.', s: 'Add products, services, or both.' };
    if (p)      return { t: 'No products yet.', s: 'Add your first product to start selling.' };
    if (s)      return { t: 'No services yet.', s: 'Add your first service to start taking service orders.' };
    return { t: 'Your catalogue is empty.', s: 'Apply for a SOKONI business to start adding items.' };
  }

  /* ── Draft validation ────────────────────────────────────────────────────
     Refuses before a write. The server is still the authority; this exists so
     a merchant is told what is wrong without a round trip. */
  function validateDraft(kind, d) {
    d = d || {};
    const problems = [];
    const name = String(d.name == null ? '' : d.name).trim();
    if (!name) problems.push('A name is required.');
    if (name.length > 140) problems.push('The name is too long.');

    if (kind === KIND.SERVICE && d.variablePrice === true) {
      /* A variable service is priced at the counter, so a catalogue price is
         optional — but if one is given it must be sane, because it is shown
         to the cashier as the starting figure. */
      if (d.price !== '' && d.price !== null && d.price !== undefined) {
        const p = Number(d.price);
        if (!Number.isFinite(p) || p < 0) problems.push('Enter a valid starting price, or leave it blank.');
      }
    } else {
      const p = Number(d.price);
      if (!Number.isFinite(p) || p <= 0) problems.push('Enter a price greater than zero.');
    }

    if (kind === KIND.SERVICE && !String(d.unit || '').trim()) {
      /* "KES 20" means nothing; "KES 20 / page" is a price. */
      problems.push('A unit is required — page, document, session, hour…');
    }
    if (kind === KIND.PRODUCT && d.stock !== '' && d.stock !== null && d.stock !== undefined) {
      const s = Number(d.stock);
      if (!Number.isFinite(s) || s < 0) problems.push('Stock cannot be negative.');
    }
    return { ok: problems.length === 0, problems };
  }

  /* ── Build / merge ───────────────────────────────────────────────────────
     `applyEdit` starts from `existing` so unknown fields survive. That is the
     data-safety property this module exists to guarantee. */
  function applyEdit(existing, kind, d) {
    const row = Object.assign({}, existing || {});
    d = d || {};
    const own = kind === KIND.SERVICE ? SERVICE_FIELDS : PRODUCT_FIELDS;

    const set = (k, v) => { if (own.indexOf(k) !== -1) row[k] = v; };

    set('name', String(d.name || '').trim());
    set('description', String(d.description || '').trim());
    set('category', String(d.category || '').trim() || (row.category || ''));
    set('active', d.active === undefined ? (row.active !== false) : !!d.active);

    if (kind === KIND.SERVICE) {
      row.trackStock   = false;                 /* THE discriminator */
      row.variablePrice = d.variablePrice === true;
      set('unit', String(d.unit || '').trim());
      const p = Number(d.price);
      set('price', Number.isFinite(p) && p > 0 ? p : 0);
      /* A service never carries stock. Deleting the keys rather than zeroing
         them matters: 0 reads as OUT OF STOCK and would hide the service from
         a till filtering on availability. */
      delete row.stock;
      delete row.lowStockThreshold;
    } else {
      row.trackStock = true;
      /* A product is never counter-priced. */
      delete row.variablePrice;
      set('sku', String(d.sku || '').trim());
      set('unit', String(d.unit || '').trim() || 'piece');
      set('image', String(d.image || '').trim());
      const p = Number(d.price);
      set('price', Number.isFinite(p) ? p : 0);
      if (d.stock === '' || d.stock === null || d.stock === undefined) {
        /* Left blank means UNMETERED, which is absent — not zero. */
        delete row.stock;
      } else {
        const s = Number(d.stock);
        set('stock', Number.isFinite(s) ? s : 0);
      }
      if (d.lowStockThreshold === '' || d.lowStockThreshold === null || d.lowStockThreshold === undefined) {
        delete row.lowStockThreshold;
      } else {
        const l = Number(d.lowStockThreshold);
        set('lowStockThreshold', Number.isFinite(l) ? l : 0);
      }
    }
    return row;
  }

  /* Archive is a merge patch, matching the existing contract
     (pos-inventory-pro.js:1709). No hard delete is offered, because the
     catalogue contract does not have one. */
  function archivePatch(actorUid) {
    return { active: false, deletedAt: new Date().toISOString(), deletedBy: actorUid || null };
  }
  function restorePatch() { return { active: true }; }

  return {
    KIND, PRODUCT_FIELDS, SERVICE_FIELDS,
    kindOf, isService, isProduct, isVariable, isArchived,
    creatableKinds, mayCreate, unavailableReason,
    priceLabel, stockLabel, badgesFor,
    filterRows, emptyMessage,
    validateDraft, applyEdit, archivePatch, restorePatch,
  };
}));
