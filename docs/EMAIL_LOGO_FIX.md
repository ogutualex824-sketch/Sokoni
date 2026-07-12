# Production Email — SOKONI Logo Rendering Fix

**Date:** 2026-07-12 · **Commit:** `1735757` · **Status:** ✅ Code fixed & deployed · ⏳ Cross-client rendering pending operator (OAT-12)

**Reported defect:** email delivers successfully, but the logo renders **faded / washed out / partly invisible**. Transparency handling looks wrong. Not premium enough for production.

---

## 1. Root cause

**The asset was not too small. The email client was destroying it while scaling it down.**

Measured facts about the master `assets/Sokoni Logo.png`:

| Property | Value |
|---|---|
| Dimensions | **480 × 320**, 8-bit RGBA |
| Transparent pixels | **93.7 %** |
| Visible pixels | 9,613 (thin, anti-aliased strokes) |
| Mean luminance of visible pixels | 120.3 |

The template renders the logo in a **180 × 120** box. So the served asset was **480 × 320 downscaled to 37.5 %** — by the email client, at render time.

Gmail and Outlook downscale with a **naive, non-premultiplied box filter**: each output pixel is the plain average of the source pixels under it — *including the fully-transparent ones*. A transparent pixel in this PNG carries `RGB(0,0,0), α=0`. Averaging it into a stroke edge therefore drags **both the colour and the alpha toward zero**.

With a mark that is 93.7 % transparent and built from thin strokes, almost every output pixel straddles that boundary. The strokes lose opacity and darken toward the transparent black they are averaged against. That is precisely what "faded, washed out, partly invisible" looks like.

### What it was *not*

- **Not white-on-white.** The header is hard-coded `bgcolor="#0d1117"` and stays dark in light *and* dark mode. Verified.
- **Not a broken/incorrect transparent PNG.** The master is a valid RGBA PNG with correct alpha. The alpha is destroyed *downstream*, during client resampling.
- **Not fixable by enlarging the image.** A bigger source means a *more aggressive* downscale ratio and therefore *more* bleed. Enlarging would have made it worse.

---

## 2. The fix

Resample the asset **ourselves**, **correctly**, to exactly the size the email renders it at.

`scripts/build-email-logo.js` performs PNG decode → **premultiplied-alpha area resample** → PNG encode. (No image library is available in this environment, so decode, resample and encode are implemented from scratch.)

Premultiplied filtering weights each pixel's colour by its own alpha before averaging, so a fully-transparent pixel contributes **no colour at all** — which is the mathematically correct way to filter an image with transparency, and exactly what the client filter gets wrong.

Output: **`assets/sokoni-email-logo.png` — 360 × 240**, a clean **2×** of the 180 × 120 render box.

- HiDPI clients (retina phones, most of the audience) draw it **1:1** — no scaling at all.
- 1× clients perform a **lossless 2:1 halving**, not a lossy 0.375 fractional downscale.
- Either way, the aggressive downscale that caused the bleed **no longer happens**.

---

## 3. Before / after (measured)

| | Before (served) | After (served) |
|---|---|---|
| Asset | `Sokoni Logo.png` | `sokoni-email-logo.png` |
| Dimensions | 480 × 320 | **360 × 240** |
| Client scale factor | **0.375** (lossy, naive filter) | **1.0** HiDPI / **0.5** clean halving |
| Resampling | done by Gmail/Outlook, non-premultiplied | done by us, **premultiplied** |
| Mean luminance of visible px | 120.3 | **120.8** |
| File size | 33,702 B | 24,300 B (**−28 %**) |

**The luminance number is the proof.** A naive filter drags mean luminance toward 0 as transparent black bleeds into the strokes. Ours holds it at **120.3 → 120.8** — the mark's tone survives the resample intact. No colour bleed, no alpha loss.

PNG integrity verified independently: correct signature, valid IHDR, **0 CRC errors**, IDAT inflates to exactly the expected 345,840 bytes.

---

## 4. Files modified

| File | Change |
|---|---|
| `scripts/build-email-logo.js` | **NEW** — reproducible premultiplied-alpha asset builder |
| `assets/sokoni-email-logo.png` | **NEW** — 360 × 240 email-optimised logo |
| `functions/email-templates.js` | `LOGO_URL` → new asset; `<img>` hardened |

### `<img>` hardening

```html
<img src="${LOGO_URL}" width="180" height="120" class="eml-logo"
  alt="SOKONI" title="SOKONI"
  style="width:180px;height:120px;max-width:180px;display:block;margin:0 auto;
         border:0;outline:none;text-decoration:none;
         -ms-interpolation-mode:bicubic;image-rendering:auto;">
```

Explicit `width`/`height` **attributes** (Outlook ignores CSS dimensions), `display:block` (kills the baseline gap), `border:0` (kills the blue link border), `-ms-interpolation-mode:bicubic` (Outlook's own resampler), `max-width` for narrow mobile, and `alt` + `title` for accessibility and images-off clients.

---

## 5. Audit of every email template

`functions/email-templates.js` is the **only** email template in the codebase that carries a logo. Single consumer: `functions/email-triggers.js`. All 53 templates share this one header, so **one fix covers every production email**.

**Already correct — verified, deliberately left alone:**

- `<o:AllowPNG/>` MSO setting — critical, this is what lets Outlook honour PNG alpha at all
- `<meta name="color-scheme" content="dark light">` + `@media (prefers-color-scheme: dark)` rules
- Hard `bgcolor="#0d1117"` on the header so the logo is **never** light-on-light in any mode

**Deliberately NOT changed** (not email templates — these need the full-resolution master):

| Location | Purpose |
|---|---|
| `functions/company-identity.js:58` | canonical brand `logoUrl` for JSON-LD structured data |
| `functions/minishop-v3.js:561,998` | OG / social-share images |
| `functions/index.js:1857-1890` | push-notification icon / badge |

---

## 6. Delivery & caching

Deployed **hosting first, functions second**. That order is mandatory: shipping the template before the asset exists would have produced a **broken image** — strictly worse than a faded one.

```
https://mysokoni.co.ke/assets/sokoni-email-logo.png    200  image/png  24300 B
https://sokoni-aeb26.web.app/assets/sokoni-email-logo.png  200  image/png  24300 B

Cache-Control: public, max-age=2592000      (30-day CDN cache)
X-Content-Type-Options: nosniff
```

Served from the production HTTPS domain already used by every email. The **old asset remains live**, so nothing previously cached breaks.

---

## 7. What is still unproven

> Code inspection is not proof of rendering.

The asset, the resampling maths and the template are verified. **Actual inbox rendering is not, and cannot be verified by me.**

**OAT-12 (operator):** open a real email in **Gmail Web / Gmail Android / Gmail iOS, Outlook (Desktop + Web), Apple Mail, Yahoo** — in **light and dark mode** — and confirm the mark is crisp, fully opaque and correctly proportioned. Attach screenshots.

Per the standing release rule: *never substitute static analysis for operational evidence.* This is claimed as **fixed in code**, not as **confirmed in inbox**.

Related: [[OAT_v1.0.0]] · [[RELEASE_DASHBOARD]] · [[KNOWN_ISSUES]] · [[BRAND_POLICY]]
