/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Seller product hydration

   THE DEFECT THIS FIXES
   The merchant dashboard and the marketplace read different collections.

     seller.js:814       displaySellerProducts() renders localStorage
                         'sellerProducts'
     sokoni-sync.js:255  pull() hydrates that key ONLY from
                         userSync/{uid}/products — a private per-user mirror
     store.html, checkout, index, product.js
                         read the canonical 'products' collection

   So a product written straight to `products` — which is what an ownership
   migration, an admin tool, or any server-side create does — reaches the
   storefront and never reaches the dashboard. KASS VAPES shows three vapes to
   the public and zero to its owner, and both are behaving exactly as written.

   WHY HYDRATION RATHER THAN REWRITING THE READ SITES
   'sellerProducts' is read at ~50 places in seller.js — the product list, the
   stats tiles, feature/boost flows, bulk edit, CSV export, POS seeding. Porting
   all of them to Firestore would be a rewrite of the page's entire data layer,
   which is precisely the kind of change that breaks working flows to fix a
   broken one.

   Instead this makes the cache honest. One hydration at the top of the page
   fills 'sellerProducts' from the canonical collection, and all ~50 read sites
   become correct without being touched. localStorage stays what it should
   always have been: an offline cache, never the source of truth.

   WHAT IT WRITES
   Nothing to the canonical `products` collection. It never creates a document,
   never changes ownership, never edits a product. Its only write is the local
   cache.

   One consequence is worth stating rather than hiding: sokoni-sync.js:120
   patches localStorage.setItem, so writing the cache also pushes the merged
   list up to userSync/{uid}/products — the merchant's own private mirror. That
   is a real write, and it is the desirable one: it repairs the stale mirror
   that caused this defect, using data Firestore already holds. It touches no
   other user's data and no shared collection.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniSellerProducts = (() => {
  'use strict';

  const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  const KEY = 'sellerProducts';

  /* Deliberately goes through the patched setItem. sokoni-sync.js keeps its
     original reference module-private (it exports only {init, pull, pushAll,
     clear}), so there is no supported way to bypass it — and bypassing it would
     be the wrong choice anyway. Letting the write through repairs
     userSync/{uid}/products, so the next pull() no longer reintroduces the
     stale list this module just corrected. */
  function writeCache(value) {
    localStorage.setItem(KEY, JSON.stringify(value));
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; }
    catch (_) { return []; }
  }

  /* A base64 image that seller.js:751 truncated to dodge the 1 MiB document cap
     is a broken image, not a smaller one — it decodes to a torn JPEG. That line
     cuts with substring(0, 200000), so a data URL at or above that length is
     assumed truncated. Storage URLs are always fine; anything else is not an
     image this code recognises, so it is treated as unusable rather than
     assumed good. */
  const TRUNCATED_AT = 200000;
  function usableImage(v) {
    if (!v || typeof v !== 'string') return false;
    if (/^https?:\/\//i.test(v)) return true;
    if (v.indexOf('data:') !== 0) return false;
    return v.length > 512 && v.length < TRUNCATED_AT;
  }

  function hasUsableImages(p) {
    if (!p) return false;
    if (usableImage(p.image)) return true;
    return Array.isArray(p.images) && p.images.some(usableImage);
  }

  /* ── merge ────────────────────────────────────────────────────────────────
     Canonical wins, with one deliberate exception.

     Firestore is authoritative for every field EXCEPT images, because the write
     path may have degraded them: seller.js:751 truncates oversized base64
     before saving. When that happened, the local copy holds the only intact
     image. Letting canonical win there would replace a working image with a
     broken one on every page load — a visible regression caused by a
     correctness fix.

     Local-only entries are kept, not dropped. A product created offline lives
     only in localStorage until it syncs; deleting it here because Firestore has
     not seen it yet would destroy the merchant's work. */
  function merge(canonical, local) {
    const localById = new Map(local.map((p) => [String(p.id), p]));
    const stats = { canonical: canonical.length, localOnly: 0, imagesPreserved: 0 };

    const merged = canonical.map((c) => {
      const l = localById.get(String(c.id));
      if (!l) return c;
      if (!hasUsableImages(c) && hasUsableImages(l)) {
        stats.imagesPreserved++;
        return Object.assign({}, c, { image: l.image, images: l.images });
      }
      return c;
    });

    const canonIds = new Set(canonical.map((p) => String(p.id)));
    local.forEach((l) => {
      if (!canonIds.has(String(l.id))) {
        stats.localOnly++;
        merged.push(Object.assign({}, l, { _pendingSync: true }));
      }
    });

    return { merged, stats };
  }

  /* ── hydrate ──────────────────────────────────────────────────────────── */
  async function hydrate(opts) {
    opts = opts || {};
    const t0 = Date.now();
    const uid = opts.uid ||
      (window.firebaseAuth && window.firebaseAuth.currentUser && window.firebaseAuth.currentUser.uid);

    if (!uid) return { ok: false, reason: 'no-uid' };
    const db = opts.db || window.firebaseDB;
    if (!db) return { ok: false, reason: 'no-db' };

    let fs;
    try { fs = opts.fs || await import(FS_URL); }
    catch (e) { return fail('sdk-load', e); }

    /* Two queries, not one. seller.js:742-743 writes BOTH `uid` and `sellerUid`
       with the same value, and older documents may carry only one. An `in`
       filter cannot span two different fields, so this unions them and dedupes
       by document id — a product matching both is one product, not two. */
    let snaps;
    try {
      snaps = await Promise.all([
        fs.getDocs(fs.query(fs.collection(db, 'products'), fs.where('sellerUid', '==', uid))),
        fs.getDocs(fs.query(fs.collection(db, 'products'), fs.where('uid', '==', uid))),
      ]);
    } catch (e) { return fail('query', e); }

    const byId = new Map();
    snaps.forEach((snap) => snap.forEach((d) => {
      if (!byId.has(d.id)) byId.set(d.id, Object.assign({ id: d.id }, d.data()));
    }));
    const canonical = Array.from(byId.values());

    const local = readCache();

    /* Refuse the one destructive case. If Firestore returns nothing but the
       cache holds products, that is far more likely a rules denial, an offline
       read or a wrong-account session than a merchant who deleted everything —
       and overwriting the cache would erase the only copy of unsynced work.
       Doing nothing is the safe failure here. */
    if (canonical.length === 0 && local.length > 0) {
      return fail('empty-canonical-nonempty-cache', new Error(
        'Firestore returned 0 products but the local cache holds ' + local.length +
        '. Cache left untouched — this is more likely a permission or account ' +
        'problem than an empty catalogue.'), { localCount: local.length });
    }

    const { merged, stats } = merge(canonical, local);
    const mode = writeCache(merged);

    const result = {
      ok: true,
      uid,
      canonical: stats.canonical,
      localOnly: stats.localOnly,
      imagesPreserved: stats.imagesPreserved,
      total: merged.length,
      changed: merged.length !== local.length,
      writeMode: mode,
      ms: Date.now() - t0,
    };

    console.log('%c[SellerProducts] hydrated ' + result.canonical + ' canonical' +
      (result.localOnly ? ' + ' + result.localOnly + ' pending sync' : '') +
      (result.imagesPreserved ? ' (' + result.imagesPreserved + ' image(s) preserved from cache)' : '') +
      '  ' + result.ms + 'ms', 'color:#71ff00');

    /* Repaint whatever is already on screen. The page renders from the cache at
       load; without this the corrected data sits in localStorage until the next
       navigation, which looks identical to the bug. */
    if (opts.repaint !== false) repaint();

    window.dispatchEvent(new CustomEvent('sokoniSellerProductsHydrated', { detail: result }));
    return result;

    function fail(reason, err, extra) {
      const detail = Object.assign({ reason, message: err && err.message }, extra || {});
      console.warn('[SellerProducts] hydration skipped: ' + reason, detail);
      try {
        if (window.SokoniAsync) {
          window.SokoniAsync.report('SellerProducts', 'hydrate', err || new Error(reason), detail);
        }
      } catch (_) {}
      return Object.assign({ ok: false }, detail);
    }
  }

  function repaint() {
    try { if (typeof window.displaySellerProducts === 'function') window.displaySellerProducts(); } catch (_) {}
    try { if (typeof window.updateSellerStats === 'function') window.updateSellerStats(); } catch (_) {}
  }

  /* ── boot ─────────────────────────────────────────────────────────────────
     Auth resolves after this script executes, so hydrating immediately would
     read a null uid and no-op — the failure mode being fixed. Wait for the
     signal, with a bounded poll for pages that never emit it. */
  function boot() {
    let done = false;
    const go = () => {
      if (done) return;
      const u = window.firebaseAuth && window.firebaseAuth.currentUser;
      if (!u) return;
      done = true;
      hydrate();
    };
    window.addEventListener('sokoniAuthReady', go);
    let tries = 0;
    const iv = setInterval(() => {
      if (done || ++tries > 100) return clearInterval(iv);   /* 20s ceiling */
      go();
    }, 200);
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { hydrate, merge, readCache, _usableImage: usableImage, _hasUsableImages: hasUsableImages };
})();
