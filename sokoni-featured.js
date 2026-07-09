/* ============================================================
   SOKONI FEATURED ENGINE  v1.0
   Loads active featured listings and approved ad campaigns
   from Firestore and injects them into page containers.
   Called by category.html, index.html, services.html.
============================================================ */

window.SokoniFeatured = (() => {
  const _FIREBASE = {
    apiKey:"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
    authDomain:"sokoni-aeb26.firebaseapp.com",
    projectId:"sokoni-aeb26",
    storageBucket:"sokoni-aeb26.firebasestorage.app",
    messagingSenderId:"24799054989",
    appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  };

  let _db = null, _dbMod = null;

  async function _ensureDb() {
    if (_db) return;
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    _dbMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const app = getApps().find(a => a.name === "sokoni-featured") || initializeApp(_FIREBASE, "sokoni-featured");
    _db = _dbMod.getFirestore(app);
  }

  /* ── Query active featured listings for a hub ── */
  async function loadFeatured(hub) {
    await _ensureDb();
    const { collection, query, where, getDocs } = _dbMod;
    try {
      const snap = await getDocs(query(
        collection(_db, "featuredListings"),
        where("status", "==", "active"),
        where("hub", "==", hub)
      ));
      const now = Date.now();
      const items = [];
      snap.forEach(d => {
        const r = d.data();
        const end = r.endDate?._seconds ? r.endDate._seconds * 1000 : (r.endDate?.toMillis ? r.endDate.toMillis() : 0);
        if (!end || end > now) items.push({ id: d.id, ...r });
      });
      return items;
    } catch (e) { return []; }
  }

  /* ── Query active ads for a hub ── */
  async function loadAds(hub) {
    await _ensureDb();
    const { collection, query, where, getDocs } = _dbMod;
    try {
      const snap = await getDocs(query(collection(_db, "sokoAds"), where("status", "==", "active")));
      const ads = [];
      snap.forEach(d => {
        const r = d.data();
        if (r.targetHub === "all" || r.targetHub === hub) ads.push({ id: d.id, ...r });
      });
      return ads.sort(() => Math.random() - 0.5).slice(0, 4);
    } catch (e) { return []; }
  }

  /* ── Track impression / click ── */
  async function _track(adId, type) {
    try {
      await _ensureDb();
      const { doc, updateDoc, increment, addDoc, collection, serverTimestamp } = _dbMod;
      await updateDoc(doc(_db, "sokoAds", adId), { [type === "click" ? "clicks" : "impressions"]: increment(1) });
      addDoc(collection(_db, "adImpressions"), {
        adId, type, createdAt: serverTimestamp(),
      }).catch(() => {});
    } catch (e) {}
  }

  /* ── Render a featured listings strip ── */
  function _renderFeaturedStrip(items) {
    if (!items.length) return "";
    return `
      <div class="skfeat-strip" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="background:#71ff0022;color:#71ff00;border:1px solid #71ff0044;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:800">⭐ Featured</span>
          <span style="font-size:11px;color:#555">Promoted listings</span>
        </div>
        <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none">
          ${items.map(item => `
            <div onclick="${item.ctaUrl ? `window.open('${item.ctaUrl}','_blank')` : `window.location.href='category.html?cat=${item.hub}'`}"
                 style="flex:0 0 auto;width:160px;background:#0d1a0d;border:1.5px solid #71ff0044;border-radius:12px;padding:12px;cursor:pointer;transition:.2s"
                 onmouseover="this.style.borderColor='#71ff00'" onmouseout="this.style.borderColor='#71ff0044'">
              <div style="font-size:9px;color:#71ff00;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">⭐ Featured</div>
              <div style="font-size:13px;font-weight:800;color:#fff;line-height:1.3;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${item.itemTitle || item.itemType || "Featured"}</div>
              ${item.hub ? `<div style="font-size:10px;color:#555;text-transform:capitalize">${item.hub}</div>` : ""}
              <div style="font-size:11px;color:#71ff00;margin-top:6px;font-weight:700">Shop Now →</div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  /* ── Render a sponsored ads strip ── */
  function _renderAdStrip(ads) {
    if (!ads.length) return "";
    return `
      <div class="skad-strip" style="margin-bottom:16px" id="skAdStrip_${Date.now()}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="background:#ffffff11;color:#666;border:1px solid #333;padding:3px 12px;border-radius:20px;font-size:11px">Sponsored</span>
        </div>
        <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none">
          ${ads.map(ad => `
            <div onclick="window.SokoniFeatured._click('${ad.id}','${ad.ctaUrl||''}')"
                 style="flex:0 0 auto;width:190px;background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:14px;cursor:pointer;transition:.2s"
                 onmouseover="this.style.borderColor='#333'" onmouseout="this.style.borderColor='#1e1e1e'"
                 data-adid="${ad.id}">
              <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Sponsored · ${ad.adType || "Ad"}</div>
              <div style="font-size:13px;font-weight:800;color:#fff;line-height:1.3;margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${ad.title || ""}</div>
              ${ad.description ? `<div style="font-size:11px;color:#888;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${ad.description}</div>` : ""}
              <div style="font-size:11px;color:#71ff00;font-weight:700">Learn more →</div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  /* ── Public: inject above a grid container ── */
  async function inject(hub, gridId, opts = {}) {
    const container = document.getElementById(gridId);
    if (!container) return;

    const [featured, ads] = await Promise.all([loadFeatured(hub), loadAds(hub)]);

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "grid-column:1/-1;margin-bottom:8px";

    let html = "";
    if (featured.length && opts.showFeatured !== false) html += _renderFeaturedStrip(featured);
    if (ads.length && opts.showAds !== false)           html += _renderAdStrip(ads);
    if (!html) return;

    wrapper.innerHTML = html;
    container.insertBefore(wrapper, container.firstChild);

    // Track impressions for ads
    ads.forEach(ad => _track(ad.id, "impression"));
  }

  /* ── Public: inject featured + sponsored section before a sibling element ── */
  async function injectBefore(hub, beforeId, opts = {}) {
    const beforeEl = document.getElementById(beforeId);
    if (!beforeEl) return;

    const [featured, ads] = await Promise.all([loadFeatured(hub), loadAds(hub)]);
    if (!featured.length && !ads.length) return;

    let html = "";
    if (featured.length && opts.showFeatured !== false) html += _renderFeaturedStrip(featured);
    if (ads.length     && opts.showAds     !== false)  html += _renderAdStrip(ads);
    if (!html) return;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "margin-bottom:8px";
    wrapper.innerHTML = html;
    beforeEl.parentNode.insertBefore(wrapper, beforeEl);
    ads.forEach(ad => _track(ad.id, "impression"));
  }

  /* ── Public: inject featured providers above a providers grid ── */
  async function injectFeaturedProviders(hub, gridId) {
    const container = document.getElementById(gridId);
    if (!container) return;

    const featured = await loadFeatured(hub);
    if (!featured.length) return;

    const strip = document.createElement("div");
    strip.style.cssText = "margin-bottom:16px";
    strip.innerHTML = _renderFeaturedStrip(featured);
    container.insertBefore(strip, container.firstChild);
  }

  /* ── Public: standalone homepage ad section ── */
  async function injectHomeAds(hub, afterId) {
    const afterEl = document.getElementById(afterId);
    if (!afterEl) return;

    const [featured, ads] = await Promise.all([loadFeatured(hub), loadAds(hub)]);
    if (!featured.length && !ads.length) return;

    const section = document.createElement("section");
    section.style.cssText = "padding:0 16px 16px";
    section.innerHTML = `
      ${featured.length ? _renderFeaturedStrip(featured) : ""}
      ${ads.length     ? _renderAdStrip(ads) : ""}`;

    afterEl.insertAdjacentElement("afterend", section);
    ads.forEach(ad => _track(ad.id, "impression"));
  }

  async function _click(adId, url) {
    _track(adId, "click");
    if (url) window.open(url, "_blank");
  }

  return { inject, injectBefore, injectFeaturedProviders, injectHomeAds, loadFeatured, loadAds, _track, _click };
})();
