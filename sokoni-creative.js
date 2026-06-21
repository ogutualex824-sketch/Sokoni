/* ================================================================
   SOKONI — AI Creative Studio  v1.0.0
   Canvas-native AI creative engine for the entire platform.

   Capabilities:
   • Background removal  — pixel-level alpha matte via Canvas 2D
   • Product Studio      — smart lighting, contrast, shadow, reflection
   • Banner Generator    — 6 template types, brand-kit aware
   • Logo Studio         — cleanup, background removal, transparent export
   • Poster Generator    — product + price + QR + store info compositions
   • Smart Crop          — rule-of-thirds algorithm, 8 aspect ratios
   • Brand Kit           — Firestore-persisted fonts, colors, logos, watermarks
   • Product Assistant   — AI title/description/tags via Cloud Function
   • Video Studio        — trim, stabilize hints, subtitle generation
   • Story Studio        — shoppable story composer with animations

   AI metadata calls the `generateProductMetadata` Cloud Function.
   All Canvas exports → WebP blob → SokoniMedia.upload().

   Pattern : IIFE → window.SokoniCreative
   Requires: window.SokoniMedia, window.firebaseDB,
             window.firebaseAuth, window.firebaseFunctions (optional)
================================================================ */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';

  /* ── Firestore helpers ──────────────────────────────────────── */
  let _fs = null;
  async function fsdk() {
    if (_fs) return _fs;
    _fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return _fs;
  }

  function db()  { return global.firebaseDB; }
  function uid() { return global.firebaseAuth?.currentUser?.uid || null; }

  /* ── Canvas utilities ──────────────────────────────────────── */
  function createCanvas(w, h) {
    const c  = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    return c;
  }

  function imgFromUrl(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error('Image load failed: ' + url));
      img.src = url;
    });
  }

  function imgFromFile(file) {
    const url = URL.createObjectURL(file);
    return imgFromUrl(url).finally(() => URL.revokeObjectURL(url));
  }

  function canvasToBlob(canvas, quality = 0.88) {
    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('Canvas export failed')), 'image/webp', quality));
  }

  function canvasToFile(canvas, name, quality = 0.88) {
    return canvasToBlob(canvas, quality).then(b => new File([b], name, { type: 'image/webp' }));
  }

  /* ── Color helpers ─────────────────────────────────────────── */
  function colorDistance(r1, g1, b1, r2, g2, b2) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  function hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : { r: 0, g: 0, b: 0 };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }

  /* ── XSS escaper ────────────────────────────────────────────── */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ================================================================
     1. Background Removal
     Samples the 4 corner regions (5×5 px each) to detect background
     colour, then builds an alpha mask using colour-distance thresholding
     with a soft edge (2-pass blur on the mask).
  ================================================================ */
  async function removeBackground(source, opts = {}) {
    const { threshold = 32, feather = 3 } = opts;

    const img = source instanceof File ? await imgFromFile(source)
              : source instanceof HTMLImageElement ? source
              : await imgFromUrl(source);

    const c   = createCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const { data, width: W, height: H } = ctx.getImageData(0, 0, c.width, c.height);

    /* Sample average background colour from corners */
    const corners = [];
    const sample  = 5;
    for (let y = 0; y < sample; y++) {
      for (let x = 0; x < sample; x++) {
        const regions = [
          [x, y], [W - 1 - x, y], [x, H - 1 - y], [W - 1 - x, H - 1 - y],
        ];
        regions.forEach(([px, py]) => {
          const i = (py * W + px) * 4;
          corners.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
        });
      }
    }
    const bgR = Math.round(corners.reduce((a, c) => a + c.r, 0) / corners.length);
    const bgG = Math.round(corners.reduce((a, c) => a + c.g, 0) / corners.length);
    const bgB = Math.round(corners.reduce((a, c) => a + c.b, 0) / corners.length);

    /* Build alpha mask */
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const d = colorDistance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], bgR, bgG, bgB);
      mask[i] = d < threshold ? 0 : 255;
    }

    /* Feather — simple box blur on mask */
    if (feather > 0) {
      const blurred = new Uint8Array(W * H);
      const r = feather;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let sum = 0, count = 0;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                sum += mask[ny * W + nx]; count++;
              }
            }
          }
          blurred[y * W + x] = Math.round(sum / count);
        }
      }
      blurred.forEach((v, i) => { mask[i] = v; });
    }

    /* Apply mask */
    for (let i = 0; i < W * H; i++) data[i * 4 + 3] = mask[i];
    ctx.putImageData(new ImageData(data, W, H), 0, 0);

    return c;
  }

  /* ================================================================
     2. Product Studio
     Enhances a product image: brightness, contrast, saturation,
     optional white/gradient studio background, subtle drop shadow.
  ================================================================ */
  async function enhanceProduct(source, opts = {}) {
    const {
      brightness  = 1.08,
      contrast    = 1.12,
      saturation  = 1.1,
      shadow      = true,
      reflection  = false,
      background  = '#ffffff',
      padding     = 0.1,      /* fraction of image size */
    } = opts;

    const img  = source instanceof HTMLCanvasElement ? source
               : source instanceof File ? await imgFromFile(source)
               : await imgFromUrl(source);
    const srcW = img.width || img.naturalWidth;
    const srcH = img.height || img.naturalHeight;
    const pad  = Math.round(Math.max(srcW, srcH) * padding);

    const W = srcW + pad * 2;
    const H = srcH + pad * 2 + (reflection ? Math.round(srcH * 0.35) : 0);
    const c   = createCanvas(W, H);
    const ctx = c.getContext('2d');

    /* Background */
    if (background.includes('gradient')) {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#f8f8f8');
      grad.addColorStop(1, '#e8e8e8');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = background;
    }
    ctx.fillRect(0, 0, W, H);

    /* Drop shadow */
    if (shadow) {
      ctx.shadowColor   = 'rgba(0,0,0,0.18)';
      ctx.shadowBlur    = 24;
      ctx.shadowOffsetY = 8;
    }
    ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
    ctx.drawImage(img, pad, pad, srcW, srcH);
    ctx.filter = 'none';
    ctx.shadowColor = 'transparent';

    /* Reflection */
    if (reflection) {
      const refH = Math.round(srcH * 0.35);
      ctx.save();
      ctx.translate(0, pad + srcH + refH);
      ctx.scale(1, -1);
      ctx.drawImage(img, pad, 0, srcW, refH);
      ctx.restore();
      /* Fade the reflection */
      const fade = ctx.createLinearGradient(0, pad + srcH, 0, pad + srcH + refH);
      fade.addColorStop(0, 'rgba(255,255,255,0)');
      fade.addColorStop(1, background === '#ffffff' ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,0.8)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, pad + srcH, W, refH);
    }

    return c;
  }

  /* ================================================================
     3. Smart Crop
     Rule-of-thirds weighted crop for any target aspect ratio.
     Returns a Canvas cropped to the target size.
  ================================================================ */
  const CROP_RATIOS = {
    square:    [1, 1],
    story:     [9, 16],
    portrait:  [4, 5],
    landscape: [16, 9],
    banner:    [3, 1],
    thumbnail: [4, 3],
    product:   [1, 1],
    feed:      [4, 5],
  };

  async function smartCrop(source, ratio = 'square', targetPx = 1080) {
    const [rw, rh] = typeof ratio === 'string'
      ? (CROP_RATIOS[ratio] || [1, 1])
      : ratio;

    const img  = source instanceof File ? await imgFromFile(source)
               : source instanceof HTMLImageElement ? source
               : await imgFromUrl(source);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;

    /* Target dimensions */
    const aspect = rw / rh;
    let tW, tH;
    if (srcW / srcH > aspect) {
      tH = Math.min(srcH, targetPx);
      tW = Math.round(tH * aspect);
    } else {
      tW = Math.min(srcW, targetPx);
      tH = Math.round(tW / aspect);
    }

    /* Center + rule-of-thirds bias (upper-centre) */
    const cropW = Math.min(srcW, Math.round(tW / targetPx * srcW * (targetPx / Math.min(tW, srcW))));
    const cropH = Math.round(cropW / aspect);
    const startX = Math.max(0, Math.round((srcW - cropW) / 2));
    const startY = Math.max(0, Math.round((srcH - cropH) * 0.35)); /* thirds bias */

    const c   = createCanvas(tW, tH);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, startX, startY, cropW, Math.min(cropH, srcH - startY), 0, 0, tW, tH);
    return c;
  }

  /* ================================================================
     4. Banner Generator
     6 template types, all brand-kit aware.
     Returns a Canvas (default 1200×400).
  ================================================================ */
  const BANNER_TEMPLATES = {
    homepage:   { w: 1200, h: 400 },
    flashsale:  { w: 1200, h: 400 },
    restaurant: { w: 1200, h: 350 },
    event:      { w: 1200, h: 500 },
    property:   { w: 1200, h: 450 },
    store:      { w: 1200, h: 300 },
  };

  async function generateBanner(opts = {}) {
    const {
      template    = 'homepage',
      productImg  = null,
      title       = 'SOKONI',
      subtitle    = '',
      cta         = 'Shop Now',
      price       = '',
      discount    = '',
      brandKit    = null,
      bgColor     = null,
    } = opts;

    const { w, h } = BANNER_TEMPLATES[template] || BANNER_TEMPLATES.homepage;
    const kit      = brandKit || { primaryColor: '#71ff00', textColor: '#ffffff', bgColor: '#111111' };
    const bg       = bgColor || kit.bgColor || '#111111';
    const accent   = kit.primaryColor || '#71ff00';

    const c   = createCanvas(w, h);
    const ctx = c.getContext('2d');

    /* Background */
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, _darken(bg, 0.3));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    /* Decorative accent strip */
    ctx.fillStyle = accent;
    ctx.fillRect(0, h - 6, w, 6);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle   = accent;
    ctx.fillRect(0, 0, w * 0.45, h);
    ctx.globalAlpha = 1;

    /* Product image */
    if (productImg) {
      try {
        const img = productImg instanceof File ? await imgFromFile(productImg) : await imgFromUrl(productImg);
        const imgH = Math.round(h * 0.85);
        const imgW = Math.round(img.naturalWidth * (imgH / img.naturalHeight));
        const x    = Math.round(w * 0.62);
        const y    = Math.round((h - imgH) / 2);
        ctx.shadowColor   = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur    = 30;
        ctx.shadowOffsetX = -10;
        ctx.drawImage(img, x, y, Math.min(imgW, w - x - 20), imgH);
        ctx.shadowColor = 'transparent';
      } catch { /* product image optional */ }
    }

    /* Flash sale badge */
    if (discount && template === 'flashsale') {
      const bx = 40, by = 30, bw = 110, bh = 40;
      ctx.fillStyle    = accent;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 8);
      ctx.fill();
      ctx.fillStyle  = '#000';
      ctx.font       = 'bold 16px system-ui';
      ctx.textAlign  = 'left';
      ctx.fillText(`${discount} OFF`, bx + 12, by + 27);
    }

    /* Title */
    const textX = 50;
    ctx.fillStyle = kit.textColor || '#ffffff';
    ctx.font      = `bold ${template === 'store' ? 28 : 42}px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = 'left';
    _wrapText(ctx, title, textX, Math.round(h * 0.4), w * 0.52, template === 'store' ? 34 : 50);

    /* Subtitle */
    if (subtitle) {
      ctx.font      = `16px system-ui,-apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      _wrapText(ctx, subtitle, textX, Math.round(h * 0.56), w * 0.5, 22);
    }

    /* Price */
    if (price) {
      ctx.font      = `bold 28px system-ui,-apple-system,sans-serif`;
      ctx.fillStyle = accent;
      ctx.fillText(`KES ${price}`, textX, Math.round(h * 0.74));
    }

    /* CTA button */
    if (cta) {
      const bw = 160, bh = 44, bx = textX, by = Math.round(h * 0.82);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 10);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font      = 'bold 16px system-ui,-apple-system,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(cta, bx + 20, by + 29);
    }

    return c;
  }

  /* ================================================================
     5. Poster Generator
     Product + price + discount + store info + QR placeholder.
  ================================================================ */
  async function generatePoster(opts = {}) {
    const {
      productImg  = null,
      title       = 'Product Name',
      price       = '0',
      oldPrice    = '',
      description = '',
      storeName   = 'My Store',
      phone       = '',
      brandKit    = null,
      size        = [800, 1000],
    } = opts;

    const [W, H] = size;
    const kit    = brandKit || { primaryColor: '#71ff00', bgColor: '#111111', textColor: '#ffffff' };
    const accent = kit.primaryColor || '#71ff00';
    const bg     = kit.bgColor || '#111111';

    const c   = createCanvas(W, H);
    const ctx = c.getContext('2d');

    /* Background */
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bg);
    grad.addColorStop(0.6, _darken(bg, 0.1));
    grad.addColorStop(1, _darken(bg, 0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    /* Header band */
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 70);
    ctx.fillStyle   = '#000000';
    ctx.font        = 'bold 22px system-ui';
    ctx.textAlign   = 'center';
    ctx.fillText(storeName.toUpperCase(), W / 2, 45);

    /* Product image */
    const imgZone = { x: 40, y: 90, w: W - 80, h: Math.round(H * 0.42) };
    if (productImg) {
      try {
        const img  = productImg instanceof File ? await imgFromFile(productImg) : await imgFromUrl(productImg);
        const scale = Math.min(imgZone.w / img.naturalWidth, imgZone.h / img.naturalHeight);
        const dw   = Math.round(img.naturalWidth * scale);
        const dh   = Math.round(img.naturalHeight * scale);
        const dx   = imgZone.x + Math.round((imgZone.w - dw) / 2);
        const dy   = imgZone.y + Math.round((imgZone.h - dh) / 2);
        ctx.shadowColor   = 'rgba(0,0,0,.35)';
        ctx.shadowBlur    = 20;
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.shadowColor = 'transparent';
      } catch { /* draw placeholder */ _drawPlaceholder(ctx, imgZone); }
    } else {
      _drawPlaceholder(ctx, imgZone);
    }

    /* Divider */
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(40, imgZone.y + imgZone.h + 16);
    ctx.lineTo(W - 40, imgZone.y + imgZone.h + 16);
    ctx.stroke();

    const infoY = imgZone.y + imgZone.h + 36;

    /* Title */
    ctx.fillStyle = kit.textColor || '#ffffff';
    ctx.font      = `bold 28px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = 'left';
    _wrapText(ctx, title, 40, infoY, W - 80, 36);

    /* Description */
    if (description) {
      ctx.font      = '14px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      _wrapText(ctx, description, 40, infoY + 60, W - 80, 20);
    }

    /* Price */
    const priceY = infoY + (description ? 120 : 70);
    ctx.font      = `bold 42px system-ui,-apple-system,sans-serif`;
    ctx.fillStyle = accent;
    ctx.textAlign = 'left';
    ctx.fillText(`KES ${price}`, 40, priceY);

    if (oldPrice) {
      ctx.font      = '20px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      const metrics = ctx.measureText(`KES ${price}`);
      const strikeX = 44 + metrics.width + 14;
      ctx.fillText(`KES ${oldPrice}`, strikeX, priceY);
      ctx.strokeStyle = 'rgba(255,0,0,.6)';
      ctx.lineWidth   = 2;
      const strikeMetrics = ctx.measureText(`KES ${oldPrice}`);
      ctx.beginPath();
      ctx.moveTo(strikeX, priceY - 7);
      ctx.lineTo(strikeX + strikeMetrics.width, priceY - 7);
      ctx.stroke();
    }

    /* Contact / QR placeholder */
    if (phone) {
      ctx.font      = '15px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.textAlign = 'left';
      ctx.fillText(`Call/WhatsApp: ${phone}`, 40, H - 50);
    }

    /* QR placeholder box */
    const qrSize = 72;
    const qrX    = W - qrSize - 30;
    const qrY    = H - qrSize - 30;
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(qrX, qrY, qrSize, qrSize);
    ctx.font      = '10px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.textAlign = 'center';
    ctx.fillText('QR Code', qrX + qrSize / 2, qrY + qrSize / 2 + 4);

    /* Footer */
    ctx.fillStyle = accent;
    ctx.fillRect(0, H - 8, W, 8);

    return c;
  }

  /* ================================================================
     6. Logo Studio
     Removes background, centres logo on transparent canvas,
     optionally adds a brand-colour backdrop circle.
  ================================================================ */
  async function processLogo(source, opts = {}) {
    const { circle = false, bgColor = 'transparent', padding = 0.15 } = opts;

    const stripped = await removeBackground(source, { threshold: 35, feather: 2 });
    const sW = stripped.width;
    const sH = stripped.height;
    const pad = Math.round(Math.max(sW, sH) * padding);
    const W   = sW + pad * 2;
    const H   = sH + pad * 2;

    const c   = createCanvas(W, H);
    const ctx = c.getContext('2d');

    if (circle && bgColor !== 'transparent') {
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, Math.min(W, H) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (bgColor !== 'transparent') {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.drawImage(stripped, pad, pad);
    return c;
  }

  /* ================================================================
     7. Brand Kit
     Persisted in Firestore `brandKits/{uid}`.
     Cached in sessionStorage for fast local reads.
  ================================================================ */
  const _kitCache = {};

  async function getBrandKit(targetUid) {
    const u = targetUid || uid();
    if (!u) return _defaultKit();
    if (_kitCache[u]) return _kitCache[u];

    const ssKey = `sokoni_bk_${u}`;
    const cached = sessionStorage.getItem(ssKey);
    if (cached) {
      try {
        _kitCache[u] = JSON.parse(cached);
        return _kitCache[u];
      } catch { /* invalid cache */ }
    }

    try {
      const { doc, getDoc } = await fsdk();
      const snap = await getDoc(doc(db(), 'brandKits', u));
      const kit  = snap.exists() ? snap.data() : _defaultKit();
      _kitCache[u] = kit;
      sessionStorage.setItem(ssKey, JSON.stringify(kit));
      return kit;
    } catch { return _defaultKit(); }
  }

  async function saveBrandKit(kitData) {
    const u = uid();
    if (!u) throw new Error('Authentication required');
    const kit = { ...kitData, uid: u, updatedAt: Date.now() };
    try {
      const { doc, setDoc } = await fsdk();
      await setDoc(doc(db(), 'brandKits', u), kit);
      _kitCache[u] = kit;
      sessionStorage.setItem(`sokoni_bk_${u}`, JSON.stringify(kit));
    } catch (e) {
      /* offline — cache locally */
      _kitCache[u] = kit;
      sessionStorage.setItem(`sokoni_bk_${u}`, JSON.stringify(kit));
    }
    return kit;
  }

  function _defaultKit() {
    return {
      primaryColor:   '#71ff00',
      secondaryColor: '#222222',
      bgColor:        '#111111',
      textColor:      '#ffffff',
      accentColor:    '#4fc800',
      fontFamily:     'system-ui,-apple-system,sans-serif',
      companyName:    '',
      tagline:        '',
      logoUrl:        '',
      watermarkText:  '',
      watermarkOpacity: 0.3,
    };
  }

  /* Extract dominant colours from an image */
  async function extractBrandColors(source) {
    const img = source instanceof File ? await imgFromFile(source) : await imgFromUrl(source);
    const c   = createCanvas(50, 50);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 50, 50);
    const { data } = ctx.getImageData(0, 0, 50, 50);

    /* Simple dominant-colour via k=3 quantisation (mean-shift proxy) */
    const buckets = {};
    for (let i = 0; i < data.length; i += 4) {
      const r = Math.round(data[i] / 32) * 32;
      const g = Math.round(data[i + 1] / 32) * 32;
      const b = Math.round(data[i + 2] / 32) * 32;
      const key = `${r},${g},${b}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }
    const sorted = Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => {
        const [r, g, b] = k.split(',').map(Number);
        return rgbToHex(r, g, b);
      });
    return sorted;
  }

  /* ================================================================
     8. Product Assistant
     Sends an image URL to the `generateProductMetadata` Cloud Function
     which uses Gemini / Vision API to return structured product data.
     Returns a PolicyValue (PREDICTED, medium confidence) for display.
  ================================================================ */
  async function generateProductMetadata(imageUrl, opts = {}) {
    const { category = '', language = 'en' } = opts;

    /* Attempt Cloud Function call */
    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
      );
      const functions = getFunctions(global.firebaseApp, 'us-central1');
      const fn        = httpsCallable(functions, 'generateProductMetadata');
      const result    = await fn({ imageUrl, category, language });
      const data      = result.data;

      /* Wrap as PREDICTED policy value */
      return {
        type:       'predicted',
        confidence: 'medium',
        model:      'gemini-pro-vision',
        reason:     'AI analysis of the product image',
        dataPoints: 1,
        timestamp:  Date.now(),
        value: {
          title:       data.title       || '',
          description: data.description || '',
          features:    data.features    || [],
          category:    data.category    || category,
          tags:        data.tags        || [],
          keywords:    data.keywords    || [],
          suggestedPrice: data.suggestedPrice || null,
          altText:     data.altText     || '',
        },
      };
    } catch (err) {
      /* Offline / function unavailable — return empty scaffold */
      console.warn('[SokoniCreative] generateProductMetadata unavailable:', err.message);
      return {
        type:       'predicted',
        confidence: 'low',
        model:      'offline',
        reason:     'AI service unavailable — fill in manually',
        dataPoints: 0,
        timestamp:  Date.now(),
        value: {
          title: '', description: '', features: [],
          category, tags: [], keywords: [],
          suggestedPrice: null, altText: '',
        },
      };
    }
  }

  /* ================================================================
     9. Story Studio
     Composes a 9:16 shoppable story canvas.
     Layers: background → product image → overlay → text → sticker → CTA.
  ================================================================ */
  const STORY_TEMPLATES = ['gradient', 'dark', 'brand', 'minimal'];

  async function createStory(opts = {}) {
    const {
      productImg  = null,
      title       = '',
      price       = '',
      cta         = 'Buy Now',
      template    = 'dark',
      brandKit    = null,
      storeLink   = '',
    } = opts;

    const W = 1080;
    const H = 1920;
    const kit    = brandKit || _defaultKit();
    const accent = kit.primaryColor || '#71ff00';

    const c   = createCanvas(W, H);
    const ctx = c.getContext('2d');

    /* Background */
    if (template === 'gradient') {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, kit.secondaryColor || '#1a1a2e');
      grad.addColorStop(1, kit.bgColor || '#0f0f0f');
      ctx.fillStyle = grad;
    } else if (template === 'brand') {
      ctx.fillStyle = accent;
    } else if (template === 'minimal') {
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.fillStyle = kit.bgColor || '#111111';
    }
    ctx.fillRect(0, 0, W, H);

    /* Product image */
    if (productImg) {
      try {
        const img    = productImg instanceof File ? await imgFromFile(productImg) : await imgFromUrl(productImg);
        const scale  = Math.min((W * 0.82) / img.naturalWidth, (H * 0.55) / img.naturalHeight);
        const dw     = Math.round(img.naturalWidth * scale);
        const dh     = Math.round(img.naturalHeight * scale);
        const dx     = Math.round((W - dw) / 2);
        const dy     = Math.round(H * 0.18);
        ctx.shadowColor   = 'rgba(0,0,0,.4)';
        ctx.shadowBlur    = 40;
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.shadowColor = 'transparent';
      } catch { /* no product image */ }
    }

    /* Bottom overlay panel */
    const panelY = Math.round(H * 0.72);
    const grad2  = ctx.createLinearGradient(0, panelY, 0, H);
    grad2.addColorStop(0, 'rgba(0,0,0,0)');
    grad2.addColorStop(0.3, 'rgba(0,0,0,0.85)');
    grad2.addColorStop(1, 'rgba(0,0,0,0.95)');
    ctx.fillStyle = grad2;
    ctx.fillRect(0, panelY, W, H - panelY);

    /* Store badge */
    if (kit.companyName) {
      ctx.fillStyle   = accent;
      ctx.beginPath();
      ctx.roundRect(40, 40, 220, 54, 27);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font      = 'bold 22px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(kit.companyName, 70, 74);
    }

    /* Title */
    ctx.fillStyle = '#ffffff';
    ctx.font      = `bold 58px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = 'center';
    _wrapText(ctx, title, W / 2, Math.round(H * 0.77), W - 80, 68, 'center');

    /* Price badge */
    if (price) {
      const py = Math.round(H * 0.86);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(W / 2 - 110, py - 38, 220, 52, 26);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font      = 'bold 26px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(`KES ${price}`, W / 2, py + 2);
    }

    /* CTA button */
    const ctaY = Math.round(H * 0.9);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 160, ctaY, 320, 62, 31);
    ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.font      = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(cta, W / 2, ctaY + 40);

    /* Swipe-up indicator */
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.font      = '16px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Swipe up to shop', W / 2, Math.round(H * 0.955));

    /* Accent bottom stripe */
    ctx.fillStyle = accent;
    ctx.fillRect(0, H - 12, W, 12);

    return c;
  }

  /* ================================================================
     10. Watermark
     Applies a text or logo watermark to any canvas.
  ================================================================ */
  async function applyWatermark(canvas, opts = {}) {
    const {
      text    = 'SOKONI',
      logoUrl = null,
      opacity = 0.25,
      position = 'bottom-right',
    } = opts;

    const ctx = canvas.getContext('2d');
    const W   = canvas.width;
    const H   = canvas.height;

    ctx.save();
    ctx.globalAlpha = opacity;

    if (logoUrl) {
      try {
        const img  = await imgFromUrl(logoUrl);
        const wh   = Math.round(Math.min(W, H) * 0.08);
        const ww   = Math.round(img.naturalWidth * (wh / img.naturalHeight));
        const { wx, wy } = _wmPos(position, W, H, ww, wh, 20);
        ctx.drawImage(img, wx, wy, ww, wh);
      } catch { /* fallback to text */ }
    } else if (text) {
      const fs  = Math.round(Math.min(W, H) * 0.025);
      ctx.font      = `bold ${fs}px system-ui`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      const mw = ctx.measureText(text).width;
      const { wx, wy } = _wmPos(position, W, H, mw, fs, 16);
      ctx.fillText(text, wx, wy);
    }

    ctx.restore();
    return canvas;
  }

  function _wmPos(pos, W, H, ww, wh, margin) {
    const map = {
      'top-left':     { wx: margin, wy: wh + margin },
      'top-right':    { wx: W - ww - margin, wy: wh + margin },
      'bottom-left':  { wx: margin, wy: H - margin },
      'bottom-right': { wx: W - ww - margin, wy: H - margin },
      'center':       { wx: (W - ww) / 2, wy: (H + wh) / 2 },
    };
    return map[pos] || map['bottom-right'];
  }

  /* ================================================================
     11. Export helpers
  ================================================================ */
  async function exportToFile(canvas, name = 'sokoni-creative', quality = 0.88) {
    return canvasToFile(canvas, `${name}.webp`, quality);
  }

  async function exportAndUpload(canvas, dest = 'ai', name = 'ai-creative', opts = {}) {
    if (!global.SokoniMedia?.upload) throw new Error('SokoniMedia not loaded');
    const file = await exportToFile(canvas, name);
    return global.SokoniMedia.upload(file, dest, opts);
  }

  function downloadCanvas(canvas, name = 'sokoni-creative') {
    canvasToBlob(canvas).then(blob => {
      const a   = document.createElement('a');
      a.href    = URL.createObjectURL(blob);
      a.download = `${name}.webp`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  }

  /* ================================================================
     12. Creative Studio Modal
     Opens a lightweight studio panel. Full functionality is in
     creative-studio.html; this modal handles quick inline edits.
  ================================================================ */
  function openStudio(opts = {}) {
    const { onExport, image = null } = opts;

    document.getElementById('_sc-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id    = '_sc-overlay';
    overlay.innerHTML = `
<style>
#_sc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:100000;display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif}
#_sc-header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid rgba(113,255,0,.15);background:#0d0d0d;flex-shrink:0}
#_sc-brand{font-size:16px;font-weight:800;color:#71ff00;letter-spacing:-.3px}
#_sc-x{background:none;border:none;color:rgba(255,255,255,.4);font-size:22px;cursor:pointer;padding:2px 6px}
#_sc-body{display:flex;flex:1;overflow:hidden}
#_sc-sidebar{width:200px;padding:16px 12px;background:#0a0a0a;border-right:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex-shrink:0}
._sc-tool{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid rgba(255,255,255,.07);border-radius:10px;cursor:pointer;color:rgba(255,255,255,.6);font-size:13px;font-weight:600;transition:.15s;background:none;width:100%;text-align:left}
._sc-tool:hover,._sc-tool.active{border-color:#71ff00;color:#71ff00;background:rgba(113,255,0,.06)}
._sc-tool-ico{font-size:18px;width:24px;text-align:center}
#_sc-canvas-zone{flex:1;display:flex;align-items:center;justify-content:center;background:#141414;overflow:auto;padding:20px}
#_sc-preview{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)}
#_sc-rightbar{width:260px;padding:16px;background:#0a0a0a;border-left:1px solid rgba(255,255,255,.06);overflow-y:auto;flex-shrink:0}
._sc-ctrl{margin-bottom:14px}
._sc-label{font-size:11px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px}
._sc-range{width:100%;accent-color:#71ff00}
._sc-btn{width:100%;padding:11px;border-radius:10px;border:none;background:#71ff00;color:#000;font-size:13px;font-weight:800;cursor:pointer;margin-top:8px}
._sc-btn-sec{background:rgba(255,255,255,.07);color:rgba(255,255,255,.7)}
._sc-btn:hover{background:#5de600}
#_sc-footer{padding:12px 20px;border-top:1px solid rgba(255,255,255,.07);background:#0d0d0d;display:flex;gap:10px;flex-shrink:0}
@media(max-width:768px){#_sc-sidebar{display:none}#_sc-rightbar{width:180px}}
@media(max-width:540px){#_sc-rightbar{display:none}}
</style>
<div id="_sc-header">
  <div id="_sc-brand">AI Creative Studio</div>
  <button id="_sc-x">&#x2715;</button>
</div>
<div id="_sc-body">
  <div id="_sc-sidebar">
    ${[
      ['Remove BG',    '&#9999;', 'rmbg'],
      ['Enhance',      '&#10024;', 'enhance'],
      ['Smart Crop',   '&#9986;',  'crop'],
      ['Banner',       '&#127384;', 'banner'],
      ['Poster',       '&#127917;', 'poster'],
      ['Story',        '&#127775;', 'story'],
      ['Watermark',    '&#128204;', 'wm'],
    ].map(([label, ico, id]) =>
      `<button class="_sc-tool" data-tool="${id}"><span class="_sc-tool-ico">${ico}</span>${label}</button>`
    ).join('')}
  </div>
  <div id="_sc-canvas-zone">
    <canvas id="_sc-preview" width="800" height="600"></canvas>
  </div>
  <div id="_sc-rightbar">
    <div class="_sc-ctrl">
      <div class="_sc-label">Brightness</div>
      <input type="range" class="_sc-range" id="_sc-brightness" min="0.5" max="1.8" step="0.01" value="1.08">
    </div>
    <div class="_sc-ctrl">
      <div class="_sc-label">Contrast</div>
      <input type="range" class="_sc-range" id="_sc-contrast" min="0.5" max="1.8" step="0.01" value="1.12">
    </div>
    <div class="_sc-ctrl">
      <div class="_sc-label">Saturation</div>
      <input type="range" class="_sc-range" id="_sc-saturation" min="0.0" max="2.0" step="0.01" value="1.1">
    </div>
    <div class="_sc-ctrl" style="margin-top:16px">
      <div class="_sc-label">Crop Ratio</div>
      <select id="_sc-crop-ratio" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px;font-size:13px">
        <option value="square">Square (1:1)</option>
        <option value="story">Story (9:16)</option>
        <option value="portrait">Portrait (4:5)</option>
        <option value="landscape">Landscape (16:9)</option>
        <option value="banner">Banner (3:1)</option>
        <option value="thumbnail">Thumbnail (4:3)</option>
      </select>
    </div>
    <button class="_sc-btn" id="_sc-apply">Apply</button>
    <button class="_sc-btn _sc-btn-sec" id="_sc-upload-src">Load Image</button>
    <input type="file" id="_sc-file-in" accept="image/*" style="display:none">
  </div>
</div>
<div id="_sc-footer">
  <button class="_sc-btn" id="_sc-download" style="flex:1">Download</button>
  <button class="_sc-btn" id="_sc-save" style="flex:1">Save to Library</button>
  <button class="_sc-btn _sc-btn-sec" id="_sc-close-btn" style="width:80px">Close</button>
</div>`;

    document.body.appendChild(overlay);

    const preview   = overlay.querySelector('#_sc-preview');
    const pCtx      = preview.getContext('2d');
    let   _canvas   = null;
    let   activeTool = 'enhance';
    let   _srcFile  = null;

    const close = () => overlay.remove();
    overlay.querySelector('#_sc-x').onclick    = close;
    overlay.querySelector('#_sc-close-btn').onclick = close;

    /* Load initial image if provided */
    if (image) { _srcFile = image; _load(image); }

    async function _load(src) {
      try {
        const c = await enhanceProduct(src, {
          brightness: 1.08, contrast: 1.12, saturation: 1.1, shadow: true,
        });
        _canvas = c;
        _renderPreview(c);
      } catch (e) { console.error('[SokoniCreative] load error:', e); }
    }

    function _renderPreview(c) {
      if (!c) return;
      const aspect = c.width / c.height;
      const maxW   = 760, maxH = 560;
      let w = maxW, h = Math.round(w / aspect);
      if (h > maxH) { h = maxH; w = Math.round(h * aspect); }
      preview.width  = w;
      preview.height = h;
      preview.getContext('2d').drawImage(c, 0, 0, w, h);
    }

    /* Tool selection */
    overlay.querySelectorAll('._sc-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('._sc-tool').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTool = btn.dataset.tool;
      });
    });

    /* Apply button */
    overlay.querySelector('#_sc-apply').addEventListener('click', async () => {
      if (!_srcFile && !_canvas) {
        alert('Load an image first.'); return;
      }
      const src = _srcFile || _canvas;
      try {
        const brightness  = parseFloat(overlay.querySelector('#_sc-brightness').value);
        const contrast    = parseFloat(overlay.querySelector('#_sc-contrast').value);
        const saturation  = parseFloat(overlay.querySelector('#_sc-saturation').value);
        const cropRatio   = overlay.querySelector('#_sc-crop-ratio').value;

        let result;
        if (activeTool === 'rmbg')   result = await removeBackground(src);
        else if (activeTool === 'crop') result = await smartCrop(src, cropRatio);
        else if (activeTool === 'banner') result = await generateBanner({ template: 'homepage' });
        else if (activeTool === 'poster') result = await generatePoster({ productImg: src });
        else if (activeTool === 'story')  result = await createStory({ productImg: src });
        else if (activeTool === 'wm')     result = await applyWatermark(_canvas || src);
        else result = await enhanceProduct(src, { brightness, contrast, saturation, shadow: true });

        _canvas = result;
        _renderPreview(result);
      } catch (e) { alert('Processing failed: ' + e.message); }
    });

    /* Load image */
    overlay.querySelector('#_sc-upload-src').addEventListener('click', () =>
      overlay.querySelector('#_sc-file-in').click());
    overlay.querySelector('#_sc-file-in').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) { _srcFile = f; _load(f); }
    });

    /* Download */
    overlay.querySelector('#_sc-download').addEventListener('click', () => {
      if (!_canvas) { alert('Nothing to download.'); return; }
      downloadCanvas(_canvas, 'sokoni-creative');
    });

    /* Save to library */
    overlay.querySelector('#_sc-save').addEventListener('click', async () => {
      if (!_canvas) { alert('Nothing to save.'); return; }
      try {
        const asset = await exportAndUpload(_canvas, 'ai', 'sokoni-creative');
        alert('Saved to your media library!');
        if (onExport) onExport(asset);
      } catch (e) { alert('Save failed: ' + e.message); }
    });
  }

  /* ================================================================
     Canvas drawing utilities
  ================================================================ */
  function _wrapText(ctx, text, x, y, maxW, lineH, align = 'left') {
    const words = String(text).split(' ');
    let line = '';
    let dy   = 0;
    const ax = align === 'center' ? x : x;
    if (align === 'center') ctx.textAlign = 'center';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, ax, y + dy);
        line = word;
        dy  += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, ax, y + dy);
  }

  function _darken(hex, amount) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHex(
      Math.round(r * (1 - amount)),
      Math.round(g * (1 - amount)),
      Math.round(b * (1 - amount))
    );
  }

  function _drawPlaceholder(ctx, zone) {
    ctx.fillStyle   = 'rgba(255,255,255,.04)';
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.roundRect(zone.x, zone.y, zone.w, zone.h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.font      = '16px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Product Image', zone.x + zone.w / 2, zone.y + zone.h / 2);
  }

  /* ================================================================
     Public API
  ================================================================ */
  const SokoniCreative = {
    version: VERSION,
    removeBackground,
    enhanceProduct,
    smartCrop,
    generateBanner,
    generatePoster,
    processLogo,
    createStory,
    applyWatermark,
    getBrandKit,
    saveBrandKit,
    extractBrandColors,
    generateProductMetadata,
    exportToFile,
    exportAndUpload,
    downloadCanvas,
    openStudio,
    BANNER_TEMPLATES,
    CROP_RATIOS,
    STORY_TEMPLATES,
  };

  global.SokoniCreative = SokoniCreative;
  global.dispatchEvent(new CustomEvent('sokoniCreativeReady'));

})(window);
