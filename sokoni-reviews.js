/**
 * SOKONI Reviews & Ratings Client SDK v1.0
 * Drop-in review widget for any hub page.
 *
 * Usage:
 *   <div data-reviews-for="seller_abc123" data-reviews-type="seller"></div>
 *   <script src="sokoni-reviews.js" defer></script>
 *
 * Or programmatic:
 *   const rv = new SokoniReviews("product_xyz", "product");
 *   await rv.render(document.getElementById("reviewsContainer"));
 *
 * Public API:
 *   SokoniReviews(targetId, targetType, opts?)
 *     .render(el)         — full widget (summary + list + form)
 *     .renderSummary(el)  — star badge only (for cards)
 *
 *   SokoniReviews.renderAll()  — auto-init all [data-reviews-for] elements
 */

(function (root) {
  "use strict";

  const CF_BASE = "https://us-central1-sokoni-aeb26.cloudfunctions.net";

  /* ── helpers ── */
  function _esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function _stars(rating, size = 16) {
    const full  = Math.floor(rating);
    const half  = rating - full >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    const color = "#f59e0b";
    const s = (fill) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" style="display:inline-block;vertical-align:middle;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`;
    let html = "";
    for (let i = 0; i < full;  i++) html += s(color);
    if (half)                        html += s("url(#hg)");
    for (let i = 0; i < empty; i++) html += s("#333");
    return html;
  }

  function _starHtml(n) {
    const colors = ["#ef4444","#f97316","#eab308","#84cc16","#22c55e"];
    return `
    <svg width="0" height="0" style="position:absolute"><defs>
      <linearGradient id="hg"><stop offset="50%" stop-color="#f59e0b"/><stop offset="50%" stop-color="#333"/></linearGradient>
    </defs></svg>
    ${_stars(n)}`;
  }

  function _timeAgo(iso) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)   return "just now";
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff/86400)}d ago`;
    return new Date(iso).toLocaleDateString("en-KE", { day:"numeric", month:"short", year:"numeric" });
  }

  async function _callCF(name, data) {
    const res = await fetch(`${CF_BASE}/${name}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ data }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "CF error");
    return json.result;
  }

  /* ── SokoniReviews class ── */
  function SokoniReviews(targetId, targetType, opts = {}) {
    this.targetId   = targetId;
    this.targetType = targetType;
    this.targetName = opts.targetName || "";
    this._page      = [];
    this._lastId    = null;
    this._hasMore   = false;
    this._summary   = null;
    this._sort      = "recent";
  }

  SokoniReviews.prototype.render = async function (container) {
    if (!container) return;
    container.innerHTML = `<div style="text-align:center;padding:32px;color:rgba(255,255,255,0.3);">Loading reviews…</div>`;
    try {
      const result = await _callCF("getReviews", {
        targetId: this.targetId,
        sort:     this._sort,
        limit:    10,
      });
      this._page    = result.reviews || [];
      this._lastId  = result.lastId;
      this._hasMore = result.hasMore;
      this._summary = result.summary;
      container.innerHTML = this._buildWidget();
      this._bindEvents(container);
    } catch (e) {
      container.innerHTML = `<p style="color:#ef4444;padding:16px;">Could not load reviews. Try again later.</p>`;
    }
  };

  SokoniReviews.prototype.renderSummary = async function (el) {
    if (!el) return;
    try {
      const result = await _callCF("getReviews", { targetId: this.targetId, limit: 1 });
      const s = result.summary || { avg: 0, count: 0 };
      el.innerHTML = s.count > 0
        ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:#f59e0b;">
             ${_stars(s.avg, 13)}&nbsp;<span style="color:rgba(255,255,255,0.7);">${s.avg.toFixed(1)} (${s.count})</span>
           </span>`
        : `<span style="font-size:11px;color:rgba(255,255,255,0.3);">No reviews yet</span>`;
    } catch (_) {}
  };

  SokoniReviews.prototype._buildWidget = function () {
    const s = this._summary || { avg: 0, count: 0 };
    return `
    <div class="sk-reviews-widget" style="font-family:inherit;">
      ${this._buildSummaryBar(s)}
      ${this._buildSortBar()}
      <div class="sk-reviews-list">
        ${this._page.map(r => this._buildCard(r)).join("") || `<p style="color:rgba(255,255,255,0.3);padding:24px 0;text-align:center;">No reviews yet. Be the first!</p>`}
      </div>
      ${this._hasMore ? `<button class="sk-load-more" style="width:100%;padding:12px;margin-top:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:rgba(255,255,255,0.6);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Load more reviews</button>` : ""}
      ${this._buildForm()}
    </div>`;
  };

  SokoniReviews.prototype._buildSummaryBar = function (s) {
    if (s.count === 0) return `<div style="padding:16px 0 8px;color:rgba(255,255,255,0.35);font-size:13px;">No reviews yet</div>`;
    const pct = Math.round((s.avg / 5) * 100);
    return `
    <div style="display:flex;align-items:center;gap:20px;padding:16px 0 12px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:14px;">
      <div style="text-align:center;">
        <div style="font-size:42px;font-weight:900;color:#f59e0b;line-height:1;">${s.avg.toFixed(1)}</div>
        <div style="margin:4px 0 2px;">${_starHtml(s.avg)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);">${s.count} review${s.count !== 1 ? "s" : ""}</div>
      </div>
      <div style="flex:1;">
        <div style="height:6px;background:rgba(255,255,255,0.07);border-radius:99px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#f59e0b,#fb923c);border-radius:99px;transition:width .6s;"></div>
        </div>
      </div>
    </div>`;
  };

  SokoniReviews.prototype._buildSortBar = function () {
    const opts = [["recent","Most Recent"],["highest","Highest Rated"],["lowest","Lowest Rated"],["helpful","Most Helpful"]];
    return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">
      ${opts.map(([v,l]) => `<button class="sk-sort-btn ${this._sort===v?"sk-sort-active":""}" data-sort="${v}" style="padding:5px 12px;border-radius:99px;border:1px solid rgba(255,255,255,${this._sort===v?"0.25":"0.08"});background:rgba(255,255,255,${this._sort===v?"0.07":"0.02"});color:rgba(255,255,255,${this._sort===v?"0.9":"0.45"});font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">${l}</button>`).join("")}
    </div>`;
  };

  SokoniReviews.prototype._buildCard = function (r) {
    return `
    <div class="sk-review-card" data-review-id="${r.id}" style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#a855f7);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#fff;flex-shrink:0;">
          ${_esc(r.authorName).charAt(0).toUpperCase()}
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.9);">${_esc(r.authorName)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.35);">${_timeAgo(r.createdAt)}</div>
        </div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:2px;">${_starHtml(r.rating)}</div>
      </div>
      ${r.title ? `<div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.8);margin-bottom:4px;">${_esc(r.title)}</div>` : ""}
      <div style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.6;">${_esc(r.body)}</div>
      ${r.images && r.images.length ? `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">${r.images.map(u=>`<img src="${_esc(u)}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.1);" loading="lazy" alt="Review photo">`).join("")}</div>` : ""}
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px;">
        <button class="sk-helpful-btn" data-review-id="${r.id}" style="display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.45);font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">
          👍 Helpful${r.helpful > 0 ? ` (${r.helpful})` : ""}
        </button>
        <button class="sk-flag-btn" data-review-id="${r.id}" style="background:none;border:none;color:rgba(255,255,255,0.2);font-size:11px;cursor:pointer;padding:0;font-family:inherit;">⚑ Flag</button>
      </div>
    </div>`;
  };

  SokoniReviews.prototype._buildForm = function () {
    return `
    <div class="sk-review-form-wrap" style="margin-top:24px;padding:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;">
      <div style="font-size:14px;font-weight:800;color:rgba(255,255,255,0.85);margin-bottom:14px;">✍️ Write a Review</div>
      <div class="sk-form-error" style="display:none;padding:8px 12px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:8px;color:#ef4444;font-size:12px;margin-bottom:10px;"></div>
      <div class="sk-form-success" style="display:none;padding:8px 12px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.25);border-radius:8px;color:#22c55e;font-size:12px;margin-bottom:10px;"></div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;">Rating *</div>
        <div class="sk-star-picker" style="display:flex;gap:4px;cursor:pointer;">
          ${[1,2,3,4,5].map(n => `<span class="sk-star-pick" data-val="${n}" style="font-size:28px;color:#333;transition:color .1s;cursor:pointer;">★</span>`).join("")}
        </div>
        <input type="hidden" class="sk-rating-val" value="0">
      </div>
      <input class="sk-title-inp" type="text" placeholder="Summary (optional)" maxlength="120" style="width:100%;box-sizing:border-box;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:rgba(255,255,255,0.8);font-size:13px;font-family:inherit;margin-bottom:10px;outline:none;">
      <textarea class="sk-body-inp" placeholder="Share your experience…" maxlength="2000" rows="4" style="width:100%;box-sizing:border-box;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:rgba(255,255,255,0.8);font-size:13px;font-family:inherit;resize:vertical;margin-bottom:12px;outline:none;"></textarea>
      <button class="sk-submit-btn" style="padding:11px 24px;background:linear-gradient(135deg,#6366f1,#a855f7);border:none;border-radius:12px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;transition:opacity .2s;">Submit Review</button>
    </div>`;
  };

  SokoniReviews.prototype._bindEvents = function (container) {
    const self = this;

    // Sort buttons
    container.querySelectorAll(".sk-sort-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        self._sort  = btn.dataset.sort;
        self._lastId = null;
        await self.render(container);
      });
    });

    // Load more
    const loadMore = container.querySelector(".sk-load-more");
    if (loadMore) {
      loadMore.addEventListener("click", async () => {
        loadMore.textContent = "Loading…";
        loadMore.disabled = true;
        try {
          const result = await _callCF("getReviews", {
            targetId:   self.targetId,
            sort:       self._sort,
            limit:      10,
            startAfter: self._lastId,
          });
          self._page    = [...self._page, ...(result.reviews || [])];
          self._lastId  = result.lastId;
          self._hasMore = result.hasMore;
          const list = container.querySelector(".sk-reviews-list");
          if (list) {
            (result.reviews || []).forEach(r => {
              list.insertAdjacentHTML("beforeend", self._buildCard(r));
            });
          }
          if (!self._hasMore && loadMore.parentNode) loadMore.remove();
          else { loadMore.textContent = "Load more reviews"; loadMore.disabled = false; }
        } catch (_) {
          loadMore.textContent = "Load more reviews";
          loadMore.disabled = false;
        }
      });
    }

    // Helpful buttons (delegated)
    container.addEventListener("click", async (e) => {
      const btn = e.target.closest(".sk-helpful-btn");
      if (!btn) return;
      const reviewId = btn.dataset.reviewId;
      if (!reviewId) return;
      btn.disabled = true;
      try {
        await _callCF("markReviewHelpful", { reviewId });
        btn.style.color = "#f59e0b";
        btn.style.borderColor = "rgba(245,158,11,.35)";
      } catch (_) { btn.disabled = false; }
    });

    // Flag buttons
    container.addEventListener("click", async (e) => {
      const btn = e.target.closest(".sk-flag-btn");
      if (!btn) return;
      const reviewId = btn.dataset.reviewId;
      if (!reviewId) return;
      const reason = prompt("Reason for flagging this review:");
      if (!reason) return;
      try {
        await _callCF("flagReview", { reviewId, reason });
        btn.textContent = "⚑ Flagged";
        btn.style.color = "#ef4444";
        btn.disabled = true;
      } catch (err) { alert(err.message || "Could not flag review."); }
    });

    // Star picker
    const stars = container.querySelectorAll(".sk-star-pick");
    const ratingInput = container.querySelector(".sk-rating-val");
    stars.forEach(star => {
      star.addEventListener("mouseenter", () => {
        const val = Number(star.dataset.val);
        stars.forEach(s => { s.style.color = Number(s.dataset.val) <= val ? "#f59e0b" : "#333"; });
      });
      star.addEventListener("mouseleave", () => {
        const cur = Number(ratingInput?.value || 0);
        stars.forEach(s => { s.style.color = Number(s.dataset.val) <= cur ? "#f59e0b" : "#333"; });
      });
      star.addEventListener("click", () => {
        const val = Number(star.dataset.val);
        if (ratingInput) ratingInput.value = val;
        stars.forEach(s => { s.style.color = Number(s.dataset.val) <= val ? "#f59e0b" : "#333"; });
      });
    });

    // Submit review
    const submitBtn = container.querySelector(".sk-submit-btn");
    if (submitBtn) {
      submitBtn.addEventListener("click", async () => {
        const errEl  = container.querySelector(".sk-form-error");
        const okEl   = container.querySelector(".sk-form-success");
        const rating = Number(container.querySelector(".sk-rating-val")?.value || 0);
        const title  = container.querySelector(".sk-title-inp")?.value.trim() || "";
        const body   = container.querySelector(".sk-body-inp")?.value.trim() || "";

        const showErr = (msg) => {
          if (errEl) { errEl.textContent = msg; errEl.style.display = "block"; }
          if (okEl)  okEl.style.display = "none";
        };

        if (rating < 1 || rating > 5) return showErr("Please select a rating (1–5 stars).");
        if (!body) return showErr("Please write something about your experience.");

        submitBtn.textContent = "Submitting…";
        submitBtn.disabled    = true;
        if (errEl) errEl.style.display = "none";

        try {
          const res = await _callCF("submitReview", {
            targetId:   self.targetId,
            targetType: self.targetType,
            targetName: self.targetName,
            rating,
            title,
            body,
          });
          if (okEl) {
            okEl.textContent  = res.status === "approved" ? "✅ Review published! Thank you." : "⏳ Review submitted for moderation.";
            okEl.style.display = "block";
          }
          submitBtn.textContent = "Submitted ✓";
          // Reload list to include new review
          setTimeout(() => self.render(container), 1200);
        } catch (err) {
          showErr(err.message || "Submission failed. Please try again.");
          submitBtn.textContent = "Submit Review";
          submitBtn.disabled    = false;
        }
      });
    }
  };

  // ── Static auto-init ───────────────────────────────────────────────────────
  SokoniReviews.renderAll = function () {
    document.querySelectorAll("[data-reviews-for]").forEach(el => {
      const targetId   = el.dataset.reviewsFor;
      const targetType = el.dataset.reviewsType || "seller";
      const targetName = el.dataset.reviewsName || "";
      const mode       = el.dataset.reviewsMode || "full";
      if (!targetId) return;
      const rv = new SokoniReviews(targetId, targetType, { targetName });
      if (mode === "summary") {
        rv.renderSummary(el);
      } else {
        rv.render(el);
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", SokoniReviews.renderAll);
  } else {
    SokoniReviews.renderAll();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.SokoniReviews = SokoniReviews;
})(window);
