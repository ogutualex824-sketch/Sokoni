# Performance Budget — SOKONI v2.0

**Owner:** Engineering  
**Enforced from:** v2.0 (2026-06-25)  
**Review cycle:** Every sprint

---

## Lighthouse Score Targets

Every page in the SOKONI platform must meet or exceed these scores before release:

| Category | Minimum | Target |
|----------|---------|--------|
| Performance | 90 | 95 |
| Accessibility | 90 | 95 |
| Best Practices | 90 | 95 |
| SEO | 90 | 95 |

### How to measure

Run Lighthouse from Chrome DevTools → Lighthouse tab, or via CLI:

```bash
npx lighthouse https://sokoni-aeb26.web.app/[page].html --view
```

Run in mobile mode and desktop mode separately.

If a page scores below minimum, block the release and fix it.

---

## Asset Budget

New pages must not add more than the budget allows.

| Asset type | Max per page | Notes |
|-----------|-------------|-------|
| JavaScript (uncompressed) | 200 KB | Use dynamic `import()` for non-critical paths |
| CSS | 50 KB | Shared tokens are already loaded via sokoni-tokens.css |
| Images (total uncompressed) | 500 KB | Use WebP, max 1200px wide |
| Fonts | 0 new fonts | Use system-ui or already loaded fonts only |
| External scripts | 0 new CDN dependencies | Use existing Firebase SDK endpoints |

### Existing shared budget (already loaded on all pages)

These are already on every page via `shared-header.js` and service worker cache:

- `sokoni-tokens.css` (design tokens)
- `sokoni-ui.js` (component helpers)
- `sokoni-layout.js` (layout utilities)
- `sokoni-bootstrap.js` (platform init)
- Firebase SDK modules (imported on demand from gstatic.com CDN)

New pages should reuse these — do not re-import or re-declare.

---

## Firestore Read Budget

Every new Cloud Function must declare its read cost.

| Function type | Max reads per invocation | Notes |
|--------------|------------------------|-------|
| User-facing callable (public) | 5 | Use caching, aggregate collections |
| Admin callable | 50 | Batch with `Promise.all()` |
| Scheduled (hourly) | 100 | Cost multiplied by 24 × 30 per month |
| Scheduled (daily) | 500 | Cost multiplied by 30 per month |

### High-read functions (already approved)

These were accepted because they run on a schedule or are admin-only:

| Function | Est. reads/run | Frequency | Monthly total |
|----------|---------------|-----------|--------------|
| `getMarketplaceQualityReport` | ≤ 2,000 | On-demand admin | Variable |
| `getSearchInsights` | ≤ 200 | On-demand admin | Variable |
| `getPlatformHealthScores` | ≤ 800 | On-demand admin | Variable |
| `aggregateSellerPerformance` | ≤ 2,000 | Daily | 60,000 |
| `triggerPriceAlerts` | ≤ 1,000 | Daily | 30,000 |
| `scheduledDailyOpsReport` | ≤ 500 | Daily | 15,000 |

**Any new function that exceeds its budget must either:**
1. Use an aggregate collection instead of scanning documents
2. Be downgraded from scheduled to on-demand admin callable
3. Have its budget explicitly approved via a Feature Proposal

---

## Cloud Function Invocation Budget

| Tier | Functions | Budget per day |
|------|-----------|---------------|
| Public (user-facing) | recordFunnelEvent, recordSearchQuery, recordRecentlyViewed | Unlimited (maxInstances: 200) |
| Auth-required | saveSearch, createPriceAlert, etc. | Unlimited |
| Admin | getMarketplaceQualityReport, etc. | < 100/day |
| Scheduled | 8 scheduled jobs | Fixed by schedule |

If a new user-facing function is added, its `maxInstances` must be set explicitly.
Do not omit `maxInstances` on public functions — it prevents cost spikes.

---

## Search Latency Budget

| Query type | Target | Maximum |
|------------|--------|---------|
| Algolia full-text search | < 50ms | 200ms |
| Firestore single-document get | < 20ms | 100ms |
| Firestore collection query (indexed) | < 50ms | 200ms |
| Cloud Function cold start (Gen2) | < 2s | 4s |
| Cloud Function warm invocation | < 200ms | 1s |

If a page-critical operation exceeds its maximum latency budget, it must use:
1. Optimistic UI with loading skeleton
2. Background loading with visible progress
3. Caching in localStorage or sessionStorage

---

## Bundle Size Rules

1. **No new client-side libraries** without a Feature Proposal.
   The current stack (Firebase, vanilla JS) is sufficient for all planned features.

2. **Lazy-load non-critical code.** Any code path not needed on first paint must be loaded
   with dynamic `import()` inside an event handler, not in the module top-level.

3. **No jQuery, React, Vue, or Angular.** The platform uses vanilla JS with ES modules.
   This is a deliberate architectural decision. Do not introduce a framework.

4. **Module size check.** If any JS file grows beyond 400 lines, review whether it can be
   split. The precedent is `sokoni-search-pro.js` (1379 lines — too large; refactor in v2.1).

---

## Accessibility Requirements

All pages must:
- Use semantic HTML (`<main>`, `<nav>`, `<article>`, `<section>`)
- Include `alt` text on all `<img>` elements
- Have sufficient colour contrast (WCAG AA minimum)
- Use minimum 16px font size on all interactive elements (input, button, select)
- Be navigable by keyboard
- Include `aria-label` on icon-only buttons

---

## SEO Requirements

All public pages (non-admin, non-auth) must:
- Include `<title>` and `<meta name="description">`
- Include Open Graph tags (`og:title`, `og:description`, `og:image`)
- Use `<h1>` exactly once per page
- Use heading hierarchy (h1 → h2 → h3, no skipping)
- Include `<link rel="canonical">` on pages with query parameters
- Not include `<meta name="robots" content="noindex">` unless intentional (auth pages, admin)

---

## Pre-deploy Performance Checklist

Before deploying any new page or significant change:

- [ ] Lighthouse Performance ≥ 90 on mobile
- [ ] Lighthouse Accessibility ≥ 90
- [ ] Lighthouse SEO ≥ 90 (public pages only)
- [ ] No new external CDN dependencies introduced
- [ ] All `<img>` elements have `alt` attributes
- [ ] All input elements have `font-size: 16px` or equivalent
- [ ] No `console.error` in production path
- [ ] Service worker version bumped
- [ ] No secrets or API keys hardcoded in HTML/JS

---

*SOKONI's performance target is to remain below 3 seconds on 3G network in Nairobi.
Every byte and every read matters at that constraint.*
