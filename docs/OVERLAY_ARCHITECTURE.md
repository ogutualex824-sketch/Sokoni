# SOKONI — Overlay Architecture

**Status:** Mandatory. **Enforced by:** `scripts/test-overlays.js` (CI-blocking)
**Related:** [[Design Tokens]] · [[Notification Centre]] · [[Accessibility]]

---

## The one rule

> ## If it covers the header, it must out-rank the header.

That sentence is the whole architecture. Everything below is a consequence of it.

---

## Drawer or sheet?

| | **Drawer** | **Sheet** |
| --- | --- | --- |
| Covers the screen? | No — sits *within* the page | **Yes — covers everything** |
| Header visible? | Yes, still usable | No, the sheet is over it |
| Token | `--sk-z-drawer` (**600**) | `--sk-z-sheet` (**100010**) |
| Above the header (100001)? | **No, by design** | **Yes, always** |
| Examples | filter panel, side nav | Notifications, payment modal, image lightbox |

**The test:** *does the user need to dismiss this before they can use the page again?*
Yes → **sheet**. No → **drawer**.

---

## What went wrong (why this document exists)

The Notification Centre was built as a **drawer** (`--sk-z-drawer`, 600) but **behaves as a
full-screen modal**. The global header is `100001`.

So the header rendered **on top of it** — over the title, over "Mark all read", over the
search box, and over the **✕**.

Measured: `elementFromPoint` at the centre of the close button returned `NAV#sk-top-nav`.
**The ✕ was present, 44px, and physically unreachable.** A user could open Notifications
and then had no way out.

Every symptom reported — *"header overlaps the nav"*, *"the X is tiny and half hidden"*,
*"controls overlap"*, *"the search bars stack"*, *"no way to dismiss"* — was **that one
stacking mistake, seen from five angles**.

### It was never one component's bug

An audit found **223 full-screen dismissible overlays** across the platform with a
**hardcoded z-index below the header**:

```
.aos-modal           1000     .adm-lock-overlay    9999
#bidSheet             500     .drawer-overlay       200
.modal-bg             300     .sokoni-access-modal 9999
.mpesa-overlay      99999  ← the modal a customer PAYS inside
```

Every one of them is the same bug, waiting. The token scale was never wrong —
`--sk-z-drawer` correctly means *"a drawer within the page"*. **Nothing in the system
stopped a component from picking the wrong tier.** That is what has been fixed.

---

## How it is enforced now — three layers

### 1. The token
```css
--sk-z-drawer: 600;      /* within the page, below the header */
--sk-z-header: 100001;
--sk-z-sheet:  100010;   /* covers the screen, ABOVE the header */
```
**Never hardcode a z-index on an overlay.** Use the token.

### 2. The component — `sokoni-sheet.js`
```js
const sheet = SokoniSheet.create({
  title: 'Notifications',
  actions: '<button class="sk-sheet-act">Mark all read</button>',
  onClose: () => {},
});
sheet.body.innerHTML = '…';
sheet.open();
```
You get, without writing any of it: the correct tier · safe-area on all four edges ·
focus trap · focus restoration · `aria-modal` · **`inert` background** · body scroll lock ·
a **44×44** close button · and **five ways out** — ✕, Escape, backdrop, **browser Back**,
swipe-down.

> **Five, because one way out is one bug away from none.** Back matters most: on iOS the
> swipe-back *gesture* **is** the back button, so a sheet that ignores it strands the phone
> users who never look for a ✕.

**Pick the component, get the tier.**

### 3. The safety net — runtime auto-promotion
Any **visible** overlay that is `position:fixed`, covers **≥92% of the viewport**, and has a
z-index **at or below the header** is raised to `--sk-z-sheet` automatically.

*Verified:* a legacy `.aos-modal` at `z-index:1000` is promoted to `100010`, and its close
button becomes tappable. It is marked `data-sk-promoted="1000"` so it is auditable in
DevTools.

**Deliberately NOT promoted:** anything that does not cover the viewport (toasts, badges,
FABs, sticky bars) and genuine side drawers — those *belong* below the header, and raising
them would break the stacking order on purpose.

This is why the 223 legacy overlays did not need 223 edits. **Fix the architecture, not the
pages.**

---

## The ratchet

`scripts/test-overlays.js` records the count of legacy hardcoded overlays in
`scripts/.overlay-baseline.json`.

**The number may fall. It may never rise.** New code that hardcodes a z-index on a
full-screen overlay fails the build. Every migration ratchets the baseline down permanently.

---

## Checklist for any new overlay

- [ ] Does it cover the header? → it is a **sheet**, not a drawer
- [ ] Built with `SokoniSheet.create()`? (If not — why not?)
- [ ] Z-index from a **token**, never a number
- [ ] Close target **≥ 44×44** and `flex:0 0 44px` so a long title cannot squeeze it
- [ ] Safe-area insets on **all four** edges
- [ ] Closes via ✕ **and** Escape **and** backdrop **and** browser Back
- [ ] Focus trapped, and returned to the trigger on close
- [ ] No horizontal overflow at **320px**
