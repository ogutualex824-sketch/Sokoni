# SOKONI Design System v1.0

> **Canonical engine. Never duplicate. Every page assembles components instead of writing UI from scratch.**

---

## Architecture

The Design System is three co-ordinated layers. Each layer builds on the one above it.

| Layer | File | What it provides |
|---|---|---|
| **Tokens** | `sokoni-tokens.css` | All CSS custom properties: colours, spacing, typography, radius, shadows, z-index, breakpoints, transitions |
| **Components** | `sokoni-components.css` + `sokoni-quality.css` | `.sk-card`, `.sk-btn*`, `.sk-badge*`, `.sk-chip*`, `.sk-stat`, `.sk-table*`, `.sk-alert*`, `.sk-skeleton*`, `.sk-spinner*`, `.sk-empty*`, forms, `.so-*` mirrors, toasts CSS, dialog CSS |
| **Extensions** | `sokoni-ds.css` + `sokoni-ds.js` | Gap-filling: search bars, tabs, tooltip, dropdown, pagination, chart wrapper, typography scale, switch, quick actions, `.sk-progress`, animation utilities, form feedback, page headers |
| **JS Runtime** | `sokoni-ui.js` → `window.SokoniUI` | `toast()`, `openModal()`, `confirm()`, `showPageLoader()`, `showSkeletons()`, `renderEmpty/Error/Offline()` |
| **Unified API** | `sokoni-ds.js` → `window.SK` | Delegates to SokoniUI; adds `SK.form.*`, `SK.search.init()`, `SK.tabs.init()`, `SK.dropdown.init()`, `SK.loading.btn*`, `SK.alert()`, `SK.badge()` |

All layers are injected **automatically on every page** via `shared-header.js`. Pages never need to link them manually.

---

## Design Tokens

All tokens are CSS custom properties defined in `sokoni-tokens.css`. Reference them; never hardcode hex values.

### Colour

```css
/* Brand */
var(--sk-green)          /* #71ff00 — primary accent */
var(--sk-green-dim)      /* rgba(113,255,0,0.15) */
var(--sk-green-border)   /* rgba(113,255,0,0.25) */

/* Surfaces */
var(--sk-bg-base)        /* #050f05 — page background */
var(--sk-bg-card)        /* #111e11 — card background */
var(--sk-bg-raised)      /* #0f200f — raised element */
var(--sk-bg-overlay)     /* #162416 — overlay/popup */
var(--sk-bg-input)       /* rgba(255,255,255,0.05) */
var(--sk-bg-hover)       /* rgba(113,255,0,0.06) */

/* Text */
var(--sk-text-primary)   /* rgba(255,255,255,0.95) */
var(--sk-text-secondary) /* rgba(255,255,255,0.6) */
var(--sk-text-tertiary)  /* rgba(255,255,255,0.35) */
var(--sk-text-disabled)  /* rgba(255,255,255,0.2) */

/* Borders */
var(--sk-border)         /* rgba(255,255,255,0.08) */
var(--sk-border-strong)  /* rgba(255,255,255,0.16) */
var(--sk-border-brand)   /* rgba(113,255,0,0.3) */
var(--sk-border-focus)   /* rgba(113,255,0,0.6) */

/* Semantic */
var(--sk-success)        var(--sk-success-bg)   var(--sk-success-border)
var(--sk-error)          var(--sk-error-bg)     var(--sk-error-border)
var(--sk-warning)        var(--sk-warning-bg)   var(--sk-warning-border)
var(--sk-info)           var(--sk-info-bg)      var(--sk-info-border)
```

### Spacing

```
--sk-space-1: 4px   --sk-space-4: 16px   --sk-space-8:  32px
--sk-space-2: 8px   --sk-space-5: 20px   --sk-space-10: 40px
--sk-space-3: 12px  --sk-space-6: 24px   --sk-space-12: 48px
```

### Typography

```
--sk-text-xs: 11px   --sk-text-lg: 18px   --sk-font-normal:  400
--sk-text-sm: 13px   --sk-text-xl: 20px   --sk-font-medium:  500
--sk-text-base:15px  --sk-text-2xl:24px   --sk-font-semibold:600
--sk-text-md: 16px   --sk-text-3xl:28px   --sk-font-bold:    700
                     --sk-text-4xl:34px   --sk-font-black:   900
```

### Border radius

```
--sk-radius-sm: 6px    --sk-radius-xl:  20px
--sk-radius-md: 10px   --sk-radius-2xl: 28px
--sk-radius-lg: 14px   --sk-radius-pill:999px
--sk-radius-card: 16px  --sk-radius-modal:24px
```

---

## Components Reference

### Cards

```html
<!-- Base (sokoni-components.css) -->
<div class="sk-card">...</div>
<div class="sk-card sk-card-interactive">...</div>
<div class="sk-card sk-card-glow">...</div>

<!-- Variants (sokoni-ds.css) -->
<div class="sk-card-elevated">...</div>
<div class="sk-card-bordered">...</div>
<div class="sk-card-ghost">...</div>

<!-- With parts -->
<div class="sk-card">
  <div class="sk-card-header">
    <div>
      <div class="sk-card-title">Title</div>
      <div class="sk-card-subtitle">Subtitle</div>
    </div>
    <button class="sk-btn sk-btn-ghost sk-btn-sm">Action</button>
  </div>
  <!-- body content -->
  <div class="sk-card-footer">
    <button class="sk-btn sk-btn-primary sk-btn-sm">Save</button>
  </div>
</div>
```

### Buttons

```html
<!-- Variants (sokoni-components.css) -->
<button class="sk-btn sk-btn-primary">Primary</button>
<button class="sk-btn sk-btn-secondary">Secondary</button>
<button class="sk-btn sk-btn-ghost">Ghost</button>
<button class="sk-btn sk-btn-danger">Danger</button>

<!-- Sizes -->
<button class="sk-btn sk-btn-primary sk-btn-sm">Small</button>
<button class="sk-btn sk-btn-primary sk-btn-lg">Large</button>

<!-- Icon only -->
<button class="sk-btn sk-btn-ghost sk-btn-icon">⋯</button>

<!-- Loading state (SK.loading.btn) -->
<button class="sk-btn sk-btn-primary" id="saveBtn">Save</button>
<script>
  SK.loading.btn(document.getElementById('saveBtn'));
  // later:
  SK.loading.btnDone(document.getElementById('saveBtn'));
</script>
```

### Forms

```html
<form class="sk-form" id="myForm">
  <div class="sk-form-group">
    <label class="sk-label sk-label-required" for="name">Full Name</label>
    <input class="sk-input" id="name" type="text" required placeholder="Enter name" />
    <div class="sk-field-error"></div>
  </div>

  <!-- Input with icon -->
  <div class="sk-form-group">
    <label class="sk-label" for="search">Search</label>
    <div class="sk-input-wrap">
      <span class="sk-input-icon">🔍</span>
      <input class="sk-input" id="search" type="text" placeholder="Search..." />
    </div>
  </div>

  <!-- Switch -->
  <label class="sk-checkbox-wrap">
    <label class="sk-switch">
      <input type="checkbox" />
      <span class="sk-switch-track"></span>
    </label>
    Enable notifications
  </label>

  <button class="sk-btn sk-btn-primary sk-w-full" type="submit">Submit</button>
</form>
<script>
  document.getElementById('myForm').addEventListener('submit', function(e) {
    e.preventDefault();
    if (!SK.form.validate(this)) return;
    // proceed
  });
</script>
```

### Typography Scale

```html
<h1 class="sk-display">Hero headline</h1>
<h1 class="sk-h1">Page title</h1>
<h2 class="sk-h2">Section title</h2>
<h3 class="sk-h3">Subsection</h3>
<h4 class="sk-h4">Card title</h4>
<h5 class="sk-h5">Label</h5>
<p class="sk-body">Body text</p>
<p class="sk-body-sm">Small body</p>
<span class="sk-caption">Caption / meta</span>
<span class="sk-label-text">UPPERCASE LABEL</span>
<code class="sk-mono">code snippet</code>
```

### Statistics / KPI Grid

```html
<div class="sk-stat-grid">
  <div class="sk-stat">
    <div class="sk-stat-icon">💰</div>
    <div class="sk-stat-label">Revenue Today</div>
    <div class="sk-stat-value">KES 48,200</div>
    <div class="sk-stat-change up">↑ 12% vs yesterday</div>
  </div>
  <div class="sk-stat">...</div>
</div>
```

### Badges, Chips, Tags

```html
<!-- Badges (sokoni-components.css) -->
<span class="sk-badge sk-badge-green">Active</span>
<span class="sk-badge sk-badge-red">Overdue</span>
<span class="sk-badge sk-badge-yellow">Pending</span>
<span class="sk-badge sk-badge-blue">In Progress</span>
<span class="sk-badge sk-badge-live">Live</span>

<!-- JS factory -->
<script>el.innerHTML = SK.badge('Verified', 'accent');</script>

<!-- Chips (sokoni-components.css) -->
<button class="sk-chip sk-chip-active">All</button>
<button class="sk-chip">Orders</button>

<!-- Removable tags (sokoni-ds.css) -->
<div class="sk-tag-group">
  <span class="sk-tag">Kenya <button class="sk-tag-remove" onclick="this.closest('.sk-tag').remove()">×</button></span>
  <span class="sk-tag sk-tag-accent">Nairobi</span>
</div>
```

### Tables

```html
<div class="sk-table-wrap">
  <table class="sk-table">
    <thead><tr>
      <th>Order</th>
      <th>Customer</th>
      <th class="sk-table-num">Amount</th>
      <th>Status</th>
    </tr></thead>
    <tbody>
      <tr><td>#1024</td><td>Jane Doe</td><td class="sk-table-num">KES 1,200</td>
          <td><span class="sk-badge sk-badge-green">Paid</span></td></tr>
    </tbody>
  </table>
</div>
```

### Tabs

```html
<div class="sk-tabs" role="tablist">
  <button class="sk-tab active" data-tab="overview">Overview <span class="sk-tab-count">3</span></button>
  <button class="sk-tab" data-tab="orders">Orders</button>
  <button class="sk-tab" data-tab="settings">Settings</button>
</div>
<div class="sk-tab-panels">
  <div class="sk-tab-panel active" data-tab="overview">...</div>
  <div class="sk-tab-panel" data-tab="orders">...</div>
  <div class="sk-tab-panel" data-tab="settings">...</div>
</div>
<script>SK.tabs.init(document.querySelector('.sk-tabs'));</script>
```

### Search Bar

```html
<div class="sk-search-wrap">
  <span class="sk-search-icon">🔍</span>
  <input class="sk-search" type="search" placeholder="Search products..." id="productSearch" />
  <button class="sk-search-clear" aria-label="Clear">✕</button>
  <div class="sk-search-results" id="productResults"></div>
</div>
<script>
SK.search.init(document.getElementById('productSearch'), function(query, resultsEl) {
  if (!query) { resultsEl.classList.remove('open'); return; }
  resultsEl.innerHTML = '<div class="sk-search-empty">Searching...</div>';
  resultsEl.classList.add('open');
  // fetch results and fill resultsEl:
  // resultsEl.innerHTML = results.map(r =>
  //   `<button class="sk-search-result">
  //     <span class="sk-search-result-icon">📦</span>
  //     <span class="sk-search-result-body">
  //       <span class="sk-search-result-label">${SK.esc(r.name)}</span>
  //       <span class="sk-search-result-sub">${SK.esc(r.category)}</span>
  //     </span>
  //   </button>`
  // ).join('');
});
</script>
```

### Quick Actions

```html
<div class="sk-qa-grid">
  <button class="sk-qa-btn" onclick="location.href='orders.html'">
    <span class="sk-qa-icon">📦</span>
    <span class="sk-qa-label">New Order</span>
  </button>
  <button class="sk-qa-btn">
    <span class="sk-qa-icon">💳</span>
    <span class="sk-qa-label">Payment</span>
  </button>
</div>
```

### Dropdown Menu

```html
<div class="sk-dropdown">
  <button class="sk-btn sk-btn-ghost" id="menuTrigger">More ▾</button>
  <div class="sk-dropdown-menu right">
    <button class="sk-dropdown-item"><span class="sk-dropdown-item-icon">✏️</span>Edit</button>
    <button class="sk-dropdown-item"><span class="sk-dropdown-item-icon">📋</span>Duplicate</button>
    <div class="sk-dropdown-sep"></div>
    <button class="sk-dropdown-item danger"><span class="sk-dropdown-item-icon">🗑️</span>Delete</button>
  </div>
</div>
<script>SK.dropdown.init(document.getElementById('menuTrigger'));</script>
```

### Tooltip

```html
<!-- Pure CSS — no JS needed -->
<button class="sk-btn sk-btn-ghost sk-btn-icon" data-tooltip="Copy to clipboard">📋</button>
<span data-tooltip="Trust Score is based on verified identity, KRA PIN, and bank account" 
      class="sk-tooltip-bottom">ℹ️</span>
```

### Pagination

```html
<div class="sk-pagination">
  <button class="sk-page-btn sk-page-nav" onclick="prevPage()">← Prev</button>
  <button class="sk-page-btn active">1</button>
  <button class="sk-page-btn">2</button>
  <button class="sk-page-btn">3</button>
  <span class="sk-page-ellipsis">…</span>
  <button class="sk-page-btn">12</button>
  <button class="sk-page-btn sk-page-nav" onclick="nextPage()">Next →</button>
</div>
```

### Progress Bar

```html
<!-- Determinate (sokoni-ds.css .sk-progress) -->
<div class="sk-progress">
  <div class="sk-progress-fill" style="width: 72%"></div>
</div>

<!-- Indeterminate -->
<div class="sk-progress indeterminate">
  <div class="sk-progress-fill"></div>
</div>

<!-- Sizes and colours -->
<div class="sk-progress sk-progress-lg">
  <div class="sk-progress-fill danger" style="width: 90%"></div>
</div>
```

### Alerts (Inline)

```html
<!-- Static HTML -->
<div class="sk-alert sk-alert-success" role="alert">
  <span class="sk-alert-icon">✓</span>
  <span class="sk-alert-body">Payment processed successfully.</span>
</div>

<!-- Injected via SK.alert() -->
<div id="formAlert"></div>
<script>
  SK.alert(document.getElementById('formAlert'), 'danger', 'Invalid phone number.', true);
</script>
```

### Toasts

```javascript
SK.toast('Order placed successfully!', 'success');
SK.toast('Payment failed — try again.', 'danger');
SK.toast('Low stock alert: Sugar', 'warn');
SK.toast('3 new messages', 'info');
```

### Dialogs

```javascript
// Modal
SK.dialog.open({
  title: 'Confirm Deletion',
  body: '<p class="sk-body">This action cannot be undone.</p>',
  actions: [
    { label: 'Cancel', type: 'ghost' },
    { label: 'Delete', type: 'danger', onClick: function() { deleteItem(); } },
  ],
});

// Confirm shortcut
SK.dialog.confirm(
  'Are you sure you want to cancel this order?',
  function() { cancelOrder(); },          // onConfirm
  null,                                   // onCancel
  { title: 'Cancel Order', confirmLabel: 'Yes, cancel', confirmType: 'danger' }
);
```

### Skeletons

```javascript
// Show
SK.skeleton.cards(document.getElementById('productGrid'), 6);
SK.skeleton.list(document.getElementById('orderList'), 5);

// Clear
SK.skeleton.clear(document.getElementById('productGrid'));
```

### Empty / Error States

```javascript
SK.empty(container, { icon: '📦', title: 'No orders yet', desc: 'Orders will appear here once customers place them.' });
SK.empty(container, { error: 'Failed to load products', onRetry: loadProducts });
SK.empty(container, { offline: true, onRetry: reload });
```

### Chart Wrapper

```html
<div class="sk-chart-wrap">
  <div class="sk-chart-header">
    <div>
      <div class="sk-chart-title">Revenue Overview</div>
      <div class="sk-chart-subtitle">Last 30 days</div>
    </div>
    <div class="sk-chart-controls">
      <button class="sk-btn sk-btn-ghost sk-btn-sm">7d</button>
      <button class="sk-btn sk-btn-ghost sk-btn-sm sk-chip-active">30d</button>
    </div>
  </div>
  <div class="sk-chart-canvas">
    <canvas id="revenueChart"></canvas>
  </div>
  <div class="sk-chart-legend">
    <div class="sk-chart-legend-item">
      <div class="sk-chart-legend-dot" style="background:#71ff00"></div>Revenue
    </div>
  </div>
</div>
```

### Page Header

```html
<div class="sk-page-header">
  <div>
    <h1 class="sk-page-title">Orders</h1>
    <p class="sk-page-desc">Manage and track all customer orders</p>
  </div>
  <div class="sk-page-actions">
    <button class="sk-btn sk-btn-ghost sk-btn-sm">Export</button>
    <button class="sk-btn sk-btn-primary">New Order</button>
  </div>
</div>
```

### Animation Utilities

```html
<!-- Apply on mount — elements animate in automatically -->
<div class="sk-card sk-anim-slide-up">...</div>
<div class="sk-card sk-anim-slide-up sk-anim-d2">...</div>
<div class="sk-card sk-anim-slide-up sk-anim-d3">...</div>

<!-- Available: sk-anim-fade-in, sk-anim-slide-up, sk-anim-scale-in, sk-anim-pulse, sk-anim-spin -->
<!-- Delays: sk-anim-d1 (50ms) through sk-anim-d6 (300ms) -->
```

---

## `window.SK` — Unified JS API

```javascript
// Toast
SK.toast(message, type, duration)  // type: 'success'|'danger'|'warn'|'info'

// Dialog
SK.dialog.open({ title, body, actions, dismissible, onClose })
SK.dialog.confirm(message, onConfirm, onCancel, opts)
SK.dialog.close()

// Button loading
SK.loading.btn(buttonEl)           // adds spinner, disables
SK.loading.btnDone(buttonEl)       // restores original text, enables
SK.loading.page(label)             // full-page overlay
SK.loading.pageDone()

// Skeleton loaders
SK.skeleton.cards(containerEl, count)   // grid of card skeletons
SK.skeleton.list(containerEl, rows)     // list row skeletons
SK.skeleton.clear(containerEl)

// Empty / error states
SK.empty(containerEl, { icon, title, desc, action, onAction, error, offline, onRetry })

// Inline alerts
SK.alert(containerEl, type, message, dismissible)
// type: 'success'|'warn'|'danger'|'info'

// Form validation
SK.form.validate(formEl)              // → boolean; marks invalid fields
SK.form.fieldError(inputEl, message)  // mark field invalid
SK.form.fieldClear(inputEl)           // clear error state
SK.form.clearAll(formEl)              // clear all errors

// Search bar
SK.search.init(inputEl, onSearch, opts)
// opts: { delay: 280, minLength: 0 }
// onSearch(query, resultsEl) — populate .sk-search-results

// Tabs
SK.tabs.init(tabsEl, opts)
// opts: { panels: panelWrapEl, onChange: fn(tabKey, tabEl) }

// Dropdown
SK.dropdown.init(triggerEl, opts)   // → { open, close, toggle }
// opts: { menu: menuEl }

// Badge HTML string
SK.badge(text, type)  // type: 'accent'|'success'|'warn'|'danger'|'info'|'neutral'

// Utilities
SK.esc(string)        // XSS-safe HTML escape
SK.uid(prefix)        // random unique ID
SK.search.debounce(fn, delay)
```

---

## Rules for Every Page Author

1. **Never write raw hex values** — use `var(--sk-*)` tokens.
2. **Never write custom toast/modal/spinner JS** — use `SK.*` or `SokoniUI.*`.
3. **Never write custom form validation** — use `SK.form.validate()`.
4. **Never write custom search debounce** — use `SK.search.init()`.
5. **Never write custom empty-state HTML** — use `SK.empty()` or `.sk-empty`.
6. **Never write `display:grid` with hardcoded px** — use `.sk-stat-grid`, `.sk-qa-grid`, `.sk-grid-2/3/4`.
7. **Never write custom animations** — use `.sk-anim-*` classes.
8. **Never create a new `.sk-` class for something that already exists** — search this document first.

---

## When Something Is Missing

1. Check `sokoni-components.css` → search for the class.
2. Check `sokoni-quality.css` → search for the `.so-*` equivalent.
3. Check `sokoni-ds.css` → it may already be there.
4. If genuinely missing: add it to `sokoni-ds.css` (CSS) or `sokoni-ds.js` (JS), then update this document.
5. Run through the [[Architecture Review Gate]] before merging.

---

*Design System v1.0 — SOKONI Engineering — 2026-07-13*

[[Architecture Review Gate]] | [[Platform Constitution]] | [[Profile Engine]]
