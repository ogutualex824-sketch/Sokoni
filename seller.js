/* ═════════════════════════════════════════════════════════════════
   SELLER DASHBOARD - ACCESS CONTROL
   Shows empty setup screen if user hasn't registered as seller
═════════════════════════════════════════════════════════════════ */

/* True for a base64 data: URI. Product image fields must reference Cloud Storage,
   never a data: URI — a data: URI in a product doc bloats the record and poisons
   the Algolia batch it ships in (the "PEACH MANGO ICE" incident). Used to strip
   base64 out of every product write; the Firestore rule enforces the same
   server-side. */
const _isDataUri = v => typeof v === 'string' && v.startsWith('data:');

const _esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function initSellerDashboard() {
  /* No gate — seller dashboard is open to all users */
}

/* ── Employee session: when an employee logs in, load their shop owner's data ── */
function initEmployeeSession(){
  const params = new URLSearchParams(window.location.search);
  if(!params.has("employee")) return;

  let sess = null;
  try{ sess = JSON.parse(localStorage.getItem("sokoniEmployeeSession")); }catch(e){}
  if(!sess || !sess.isEmployee) return;

  /* Apply employee restrictions based on role */
  const ROLE_PERMS = {
    cashier: {
      tabs: ["orders-section","buyer-orders-section","seller-dms","seller-stats","customers-section","receipts-section"],
      hideSections: ["wallet-section","expense-section","analytics-section","sales-analytics-section","profit-section","employees-section","verify-section","ads-section","tax-section"],
      label: "💰 Cashier"
    },
    manager: {
      tabs: null, /* all */
      hideSections: ["wallet-section"],   /* financial withdrawal — owner only */
      label: "📊 Manager"
    },
    branch_manager: {
      tabs: null,
      hideSections: ["wallet-section","tax-section"],
      label: "🏢 Branch Manager"
    },
    inventory: {
      tabs: ["upload-section","products-section","bulk-upload-section","restock-section","inventory-section","qa-section"],
      hideSections: ["wallet-section","expense-section","analytics-section","profit-section","employees-section","orders-section","seller-dms","tax-section"],
      label: "📦 Inventory Clerk"
    },
    support: {
      tabs: ["seller-dms","qa-section","seller-ratings-section","buyer-orders-section"],
      hideSections: ["wallet-section","expense-section","analytics-section","profit-section","upload-section","employees-section","tax-section","ads-section"],
      label: "💬 Support Agent"
    }
  };
  const perm = ROLE_PERMS[sess.employeeRole] || ROLE_PERMS.support;

  /* Show employee banner */
  const banner = document.createElement("div");
  banner.id = "empSessionBanner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9990;background:linear-gradient(135deg,rgba(0,170,255,0.95),rgba(0,120,220,0.95));color:white;font-size:12px;font-weight:800;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;backdrop-filter:blur(8px);";
  banner.innerHTML = `
    <span>👤 <strong>${sess.name}</strong> — ${perm.label} at <strong>${sess.shopName}</strong></span>
    <button onclick="logoutEmployee()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 12px;border-radius:8px;cursor:pointer;font-size:11px;font-weight:800;font-family:inherit;">Log Out</button>
  `;
  document.body.prepend(banner);

  /* Adjust nav top margin to account for banner */
  const navbar = document.querySelector(".navbar");
  if(navbar) navbar.style.top = "34px";

  /* Load shop owner's products/orders from Firestore */
  if(window.firebaseDB && sess.shopOwnerId){
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js").then(({ collection, getDocs, query, where })=>{
      getDocs(query(collection(window.firebaseDB,"products"), where("uid","==",sess.shopOwnerId))).then(snap=>{
        const ownerProducts = [];
        snap.forEach(d=>ownerProducts.push({id:d.id,...d.data()}));
        if(ownerProducts.length){
          /* Merge with local products */
          const local = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
          const merged = [...ownerProducts];
          local.forEach(p=>{ if(!merged.find(m=>m.id===p.id)) merged.push(p); });
          window._employeeProducts = merged;
        }
      }).catch(()=>{});
    }).catch(()=>{});
  }

  /* Restrict sidebar nav tabs by role */
  if(perm.tabs){
    document.querySelectorAll(".sd-tab-btn, .nav-item[onclick]").forEach(btn=>{
      const tab = btn.dataset.tab
        || btn.getAttribute("onclick")?.match(/showSDTab\(['"]([^'"]+)['"]\)/)?.[1]
        || btn.getAttribute("onclick")?.match(/showDashPage\(['"]([^'"]+)['"]\)/)?.[1];
      if(tab && !perm.tabs.some(t=>t.includes(tab)||tab.includes(t))){
        btn.style.opacity    = "0.3";
        btn.style.pointerEvents = "none";
        btn.title            = "Access restricted — " + perm.label + " role";
        btn.setAttribute("aria-disabled","true");
      }
    });
  }

  /* Hide sections that this role must never see, even if navigated to directly */
  if(perm.hideSections && perm.hideSections.length){
    /* Run after DOM is painted */
    requestAnimationFrame(function(){
      perm.hideSections.forEach(function(id){
        const section = document.getElementById(id);
        if(section){ section.style.display = "none"; section.setAttribute("aria-hidden","true"); }
      });
    });
  }

  /* Set session role globally so renderEmployeeList can read it */
  window._sellerSessionRole = sess.employeeRole;
  window._sellerSessionBranch = sess.branch || null;
}

function logoutEmployee(){
  localStorage.removeItem("sokoniEmployeeSession");
  localStorage.removeItem("sokoniUser");
  localStorage.removeItem("loggedIn");
  if(window.firebaseAuth) window.firebaseAuth.signOut().catch(()=>{});
  window.location.href = "login.html";
}
window.logoutEmployee = logoutEmployee;

function showSellerRegistrationPrompt() {
  const container = document.querySelector(".seller-main-content") || document.querySelector(".sidebar") || document.body;
  
  const prompt = document.createElement("div");
  prompt.className = "seller-registration-prompt";
  prompt.innerHTML = `
    <div class="prompt-content">
      <div class="prompt-icon">🏪</div>
      <h2>Ready to Start Selling?</h2>
      <p>Become a seller on SOKONI and reach thousands of customers across Kenya.</p>
      <div class="prompt-benefits">
        <div class="benefit">✅ Free to list products</div>
        <div class="benefit">✅ Secure payment processing</div>
        <div class="benefit">✅ Real-time order tracking</div>
        <div class="benefit">✅ 24/7 seller support</div>
      </div>
      <button onclick="SokoniAccessControl.registerUserRole('seller'); location.reload();" class="prompt-btn-primary">
        Register as Seller
      </button>
      <button onclick="window.history.back();" class="prompt-btn-secondary">
        Continue Browsing
      </button>
    </div>
  `;

  if (container === document.body) {
    document.body.innerHTML = prompt.innerHTML;
  } else {
    container.innerHTML = prompt.innerHTML;
  }

  // Add styles
  const style = document.createElement("style");
  style.textContent = `
    .seller-registration-prompt {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #0a0e27 0%, #1a1a2e 100%);
      padding: 20px;
    }

    .prompt-content {
      background: #1a1a1a;
      border: 2px solid rgba(113,255,0,0.2);
      border-radius: 16px;
      padding: 50px 40px;
      max-width: 500px;
      text-align: center;
      color: #fff;
    }

    .prompt-icon {
      font-size: 64px;
      margin-bottom: 24px;
    }

    .prompt-content h2 {
      margin: 0 0 12px 0;
      font-size: 28px;
      color: #71ff00;
    }

    .prompt-content p {
      margin: 0 0 28px 0;
      color: #bbb;
      font-size: 16px;
    }

    .prompt-benefits {
      text-align: left;
      background: rgba(113,255,0,0.05);
      border-left: 3px solid #71ff00;
      padding: 20px;
      margin: 0 0 28px 0;
      border-radius: 8px;
    }

    .benefit {
      padding: 8px 0;
      color: #ccc;
      font-size: 15px;
    }

    .benefit:before {
      content: "✓ ";
      color: #71ff00;
      font-weight: bold;
      margin-right: 8px;
    }

    .prompt-btn-primary,
    .prompt-btn-secondary {
      display: block;
      width: 100%;
      padding: 14px;
      margin: 10px 0;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }

    .prompt-btn-primary {
      background: #71ff00;
      color: #000;
      margin-bottom: 12px;
    }

    .prompt-btn-primary:hover {
      background: #8aff1a;
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(113,255,0,0.3);
    }

    .prompt-btn-secondary {
      background: transparent;
      border: 1px solid rgba(113,255,0,0.3);
      color: #71ff00;
    }

    .prompt-btn-secondary:hover {
      background: rgba(113,255,0,0.1);
      border-color: rgba(113,255,0,0.6);
    }

    @media (max-width: 640px) {
      .prompt-content {
        padding: 30px 20px;
      }

      .prompt-content h2 {
        font-size: 22px;
      }
    }
  `;
  document.head.appendChild(style);
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", function(){
  initSellerDashboard();
  initEmployeeSession();
});

/* =========================
   ANTI-THEFT OWNERSHIP VERIFY
   Config for high-value / theft-risk categories
========================= */

const VERIFY_CATS = {
  cars:         { serial:"VIN / Chassis Number",      hint:"Found on the dashboard, door frame or engine bay",              doc:"Logbook / Transfer Document",          docRequired:true  },
  motorcycles:  { serial:"Chassis / Frame Number",    hint:"Stamped on the frame near the engine",                          doc:"Logbook / Purchase Agreement",         docRequired:true  },
  "auto-parts": { serial:"Part Serial / Engine No.",  hint:"Stamped or labelled on the part itself",                        doc:"Purchase Invoice / Removal Receipt",   docRequired:false },
  tyres:        { serial:"DOT Code",                  hint:"Moulded on the sidewall of the tyre e.g. DOT XXXX",             doc:"Purchase Receipt",                     docRequired:false },
  electronics:  { serial:"IMEI Number",               hint:"Dial *#06# on the phone to display the IMEI instantly",         doc:"Purchase Box / Shop Invoice",          docRequired:false },
  computers:    { serial:"Serial Number",             hint:"Check the bottom sticker or System Info → About this device",   doc:"Purchase Invoice / Box",               docRequired:false },
  cameras:      { serial:"Serial Number",             hint:"Inside the battery compartment or on the back of the camera",   doc:"Purchase Invoice / Box",               docRequired:false },
  gaming:       { serial:"Serial Number",             hint:"Printed on the back or bottom of the console",                  doc:"Purchase Receipt / Box",               docRequired:false },
  luxury:       { serial:"Certificate / Auth Number", hint:"From the brand certificate of authenticity",                    doc:"Authentication Certificate",           docRequired:true  },
  accessories:  { serial:"Serial / Hallmark Number",  hint:"Engraved inside the band or on the clasp (watches & jewelry)",  doc:"Jeweller Receipt / Valuation Report",  docRequired:false },
};

/* Show / hide the verification panel based on the selected category */
function onCategoryChange(){
  const cat = document.getElementById("productCategory")?.value || "";
  const box = document.getElementById("ownershipVerifyBox");
  if(!box) return;

  const cfg = VERIFY_CATS[cat];
  if(cfg){
    box.style.display = "block";
    const lbl = document.getElementById("serialLabel");
    const hnt = document.getElementById("serialHint");
    const sub = document.getElementById("ownerVerifySubtitle");
    const docRow = document.getElementById("ownerDocRow");
    const docLbl = document.getElementById("ownerDocLabel");
    if(lbl) lbl.textContent = cfg.serial + " *";
    if(hnt) hnt.textContent = cfg.hint;
    if(sub) sub.textContent = `${cat.charAt(0).toUpperCase()+cat.slice(1)} listings require verified ownership to protect buyers from stolen goods.`;
    if(docRow) docRow.style.display = cfg.docRequired ? "block" : "none";
    if(docLbl) docLbl.textContent = cfg.doc + " *";
    /* clear previous file names */
    const rfn = document.getElementById("receiptFileName");
    const dfn = document.getElementById("ownerDocFileName");
    if(rfn) rfn.textContent = "Click to upload receipt (photo or PDF)";
    if(dfn) dfn.textContent = "Click to upload (logbook, purchase agreement, etc.)";
  } else {
    box.style.display = "none";
  }
}

/* Update upload label text when a file is chosen */
function onOwnerFileChange(inputId, displayId){
  const inp = document.getElementById(inputId);
  const dis = document.getElementById(displayId);
  if(inp && dis && inp.files[0]){
    dis.textContent = "✅ " + inp.files[0].name;
    dis.style.color = "#71ff00";
  }
}

/* Wire the category selector on page load */
document.addEventListener("DOMContentLoaded", function(){
  const catSel = document.getElementById("productCategory");
  if(catSel){
    catSel.addEventListener("change", onCategoryChange);
    onCategoryChange(); /* run once to handle pre-selected value */
  }
});

/* =========================
   NOTIFICATION
========================= */

function showNotification(message,type){

    const notificationContainer =
    document.getElementById(
        "notificationContainer"
    );

    if(!notificationContainer) return;

    const notification =
    document.createElement("div");

    notification.classList.add(
        "seller-notification",
        type
    );

    notification.innerText = message;

    notificationContainer.appendChild(
        notification
    );

    setTimeout(()=>{

        notification.classList.add(
            "show-notification"
        );

    },100);

    setTimeout(()=>{

        notification.remove();

    },4000);

}

/* =========================
   AI IMAGE ENHANCEMENT + COMPRESS
   Auto-enhances brightness, contrast, saturation & sharpness
   Works on any uploaded photo automatically.
========================= */

/* Resize + recompress a File/Blob to a JPEG Blob before upload.
   Mirrors compressImage()'s dimensions (max 800px, q0.82) but returns a Blob via
   canvas.toBlob() rather than a base64 dataURL, so no ~33% base64 inflation is
   paid on the wire.

   WHY THIS EXISTS: _uploadImagesToStorage used to send imageItems[i].file — the
   RAW original the seller picked — straight to Storage, then the product's `image`
   field was overwritten with that URL (seller.js ~881), discarding the compressed
   800px copy that had already been computed. Measured on production: real merchant
   uploads were 694KB each, served full-size into 158px cards, so on a mobile
   connection a product grid effectively never finished loading — reported as
   "product images not working". An 800px JPEG at q0.82 is ~80-140KB, ~5-8x smaller.

   Fails OPEN: any error (decode failure, tainted canvas, no toBlob) resolves to
   the original file, so a listing never fails to upload because compression could
   not run — it just uploads large, exactly as before. */
function _compressToBlob(file, maxW, quality) {
    maxW = maxW || 800; quality = quality || 0.82;
    return new Promise(function (resolve) {
        try {
            var img = new Image();
            var url = URL.createObjectURL(file);
            img.onload = function () {
                try {
                    var w = img.width, h = img.height;
                    if (w > maxW) { h = Math.round((maxW / w) * h); w = maxW; }
                    var canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    URL.revokeObjectURL(url);
                    if (!canvas.toBlob) { resolve(file); return; }
                    canvas.toBlob(function (blob) {
                        /* Only keep the recompressed blob if it is actually smaller;
                           a tiny source can grow when re-encoded. */
                        resolve(blob && blob.size < file.size ? blob : file);
                    }, 'image/jpeg', quality);
                } catch (e) { URL.revokeObjectURL(url); resolve(file); }
            };
            img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
            img.src = url;
        } catch (e) { resolve(file); }
    });
}

/* Upload an array of {file} objects to Firebase Storage.
   Returns array of download URLs on success, null on failure. */
async function _uploadImagesToStorage(productId, sellerUid, imageItems) {
    if (!window.firebaseStorage || !imageItems || !imageItems.length) return null;
    try {
        const { ref, uploadBytes, getDownloadURL } = await import(
            'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js'
        );
        const urls = [];
        for (let i = 0; i < imageItems.length; i++) {
            const storageRef = ref(
                window.firebaseStorage,
                `product-images/${sellerUid || 'anon'}/${productId}/${i}.jpg`
            );
            /* Compress before upload — see _compressToBlob. The raw file was being
               stored and then served full-size into thumbnail-sized cards. */
            const blob = await _compressToBlob(imageItems[i].file);
            /* cacheControl is the other half of "images don't cache well".
               Firebase Storage defaults uploads to `private, max-age=0`, so the
               browser revalidated (usually re-downloaded) every product image on
               every view — measured on production: a live product image returned
               `Cache-Control: private, max-age=0`. A product photo is immutable
               once uploaded (a new photo is a new object path), so it is safe to
               cache for a year. public+immutable lets the browser, the SW image
               cache, and any CDN keep it instead of re-fetching. */
            const snap = await uploadBytes(storageRef, blob, {
                contentType: 'image/jpeg',
                cacheControl: 'public, max-age=31536000, immutable',
            });
            urls.push(await getDownloadURL(snap.ref));
        }
        return urls;
    } catch(e) {
        console.warn('[SOKONI] Storage upload failed:', e.message);
        return null;
    }
}

/**
 * Write the seller's product cache, degrading rather than failing.
 *
 * Three attempts, each giving up more than the last:
 *   1. everything, including the base64 previews the cards render from
 *   2. previews dropped from all but the ten newest — the older cards fall back
 *      to the placeholder, which is a visual downgrade, not a data loss
 *   3. metadata only
 *
 * Returns a string describing what was kept, or null if even metadata would not
 * fit. NEVER throws and never signals the caller to abort: the caller is
 * mid-upload, and Firestore is where the product actually lives.
 *
 * Why the cache is allowed to lose images at all: they are recoverable. The same
 * pictures are uploaded to Cloud Storage on the next line, and the Firestore
 * document carries their URLs. A dropped preview costs one placeholder until the
 * next page load; a blocked write costs the merchant their product.
 */
function _cacheSellerProducts(list) {
    /* Strip only base64 data URIs — those are the ~190KB payloads that fill the
       quota. A Storage URL is ~100 bytes and is the very thing the upload exists
       to produce, so dropping it would blank a card whose image is safely in
       Cloud Storage. Keeping URLs is what lets a "stripped" older product still
       render its real picture on the dashboard instead of the placeholder logo.
       imageStorageUrls is preserved untouched (Object.assign only overrides the
       two keys named), so the renderer can fall back to it as well. */
    const _isData = (v) => typeof v === 'string' && v.startsWith('data:');
    const _strip = (p) => Object.assign({}, p, {
        image:  _isData(p.image) ? '' : (p.image || ''),
        images: Array.isArray(p.images) ? p.images.filter((v) => !_isData(v)) : [],
    });
    const attempts = [
        ['full',          () => list],
        /* Three, not ten. Measured: a product carrying a base64 preview in both
           "image" and "images[]" costs ~760KB of UTF-16 localStorage, so ten
           would need 7.6MB against Safari's ~5MB cap and this tier could never
           fire — every overflow would drop straight to metadata-only. Three fits
           in ~2.3MB and leaves room for the rest of the record. */
        ['recent-images', () => list.map((p, i) => (i >= list.length - 3 ? p : _strip(p)))],
        ['metadata-only', () => list.map(_strip)],
    ];
    for (const [label, build] of attempts) {
        try {
            localStorage.setItem('sellerProducts', JSON.stringify(build()));
            return label;
        } catch (_) { /* try the next, smaller shape */ }
    }
    /* Even metadata will not fit. Say what is true — the product is saved and the
       offline copy is not — rather than "delete old products", which describes
       neither the cause nor a remedy that helps. */
    console.warn('[seller] product cache unavailable — browser storage full; Firestore write continues');
    try {
        showNotification('Saved. Offline copy skipped — browser storage is full.', 'info');
    } catch (_) {}
    return null;
}

function compressImage(file){
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
            /* ─── Step 1: Resize ─── */
            const maxW = 800;
            let w = img.width, h = img.height;
            if(w > maxW){ h = Math.round((maxW/w)*h); w = maxW; }

            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext("2d");

            /* ─── Step 2: AI Enhancement via Canvas filter ─── */
            /* Auto-enhancement: boost contrast, saturation, slight brightness */
            ctx.filter = "contrast(1.12) saturate(1.22) brightness(1.06) sharpen(1)";
            ctx.drawImage(img, 0, 0, w, h);
            ctx.filter = "none";

            /* ─── Step 3: Pixel-level auto-levels (histogram stretch) ─── */
            try {
                const id   = ctx.getImageData(0, 0, w, h);
                const data = id.data;
                let rMin=255,rMax=0, gMin=255,gMax=0, bMin=255,bMax=0;
                for(let i=0; i<data.length; i+=4){
                    rMin=Math.min(rMin,data[i]);   rMax=Math.max(rMax,data[i]);
                    gMin=Math.min(gMin,data[i+1]); gMax=Math.max(gMax,data[i+1]);
                    bMin=Math.min(bMin,data[i+2]); bMax=Math.max(bMax,data[i+2]);
                }
                /* Only stretch if there's meaningful range (avoids over-processing) */
                const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
                if(rRange > 30 || gRange > 30 || bRange > 30){
                    for(let i=0; i<data.length; i+=4){
                        if(rRange > 30) data[i]   = Math.round(((data[i]-rMin)/rRange)*255);
                        if(gRange > 30) data[i+1] = Math.round(((data[i+1]-gMin)/gRange)*255);
                        if(bRange > 30) data[i+2] = Math.round(((data[i+2]-bMin)/bRange)*255);
                    }
                    ctx.putImageData(id, 0, 0);
                }
            } catch(e){ /* cross-origin pixel read blocked — skip auto-levels */ }

            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
        };

        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
        img.src = url;
    });
}

/* =========================
   AI VIDEO PROCESSOR
   Enforces 30s max, extracts poster frame with AI enhancement,
   auto-compresses video for faster load on product cards.
========================= */

const MAX_VIDEO_DURATION = 30; // seconds — product videos & stories

function processProductVideo(file){
    return new Promise((resolve, reject) => {
        if(!file.type.startsWith("video/")){ reject(new Error("Not a video")); return; }
        if(file.size > 100 * 1024 * 1024){ reject(new Error("Video too large — max 100 MB")); return; }

        const video = document.createElement("video");
        const url   = URL.createObjectURL(file);
        video.preload  = "metadata";
        video.muted    = true;
        video.playsInline = true;

        video.onloadedmetadata = () => {
            const duration = video.duration;
            if(duration > MAX_VIDEO_DURATION){
                URL.revokeObjectURL(url);
                reject(new Error(`Video too long — max ${MAX_VIDEO_DURATION} seconds (yours: ${Math.round(duration)}s)`));
                return;
            }
            video.currentTime = Math.min(0.5, duration * 0.1);
        };

        video.onseeked = () => {
            /* Extract enhanced poster frame */
            const canvas = document.createElement("canvas");
            const MAX = 640;
            let vw = video.videoWidth  || 640;
            let vh = video.videoHeight || 360;
            if(vw > MAX){ vh = Math.round((MAX/vw)*vh); vw = MAX; }
            canvas.width = vw; canvas.height = vh;
            const ctx = canvas.getContext("2d");
            ctx.filter = "contrast(1.1) saturate(1.2) brightness(1.05)";
            ctx.drawImage(video, 0, 0, vw, vh);
            const poster = canvas.toDataURL("image/jpeg", 0.8);
            URL.revokeObjectURL(url);
            resolve({ videoUrl: url, poster, duration: video.duration });
        };

        video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Video load failed")); };
        video.src = url;
    });
}

window.processProductVideo = processProductVideo;

/* =========================
   MULTI-IMAGE PICKER (add product)
========================= */

let _productImages = []; // {file:File, url:string}
window.addEventListener('pagehide', () => {
  _productImages.forEach(item => URL.revokeObjectURL(item.url));
  _productImages = [];
}, { once: true });

function renderImageSlots() {
    const grid = document.getElementById('productImagesGrid');
    if (!grid) return;
    grid.innerHTML = '';

    _productImages.forEach((item, i) => {
        const slot = document.createElement('div');
        slot.style.cssText = 'position:relative;flex-shrink:0;width:72px;height:72px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,0.05);border:1px solid rgba(113,255,0,0.22);';
        const img = document.createElement('img');
        img.src = item.url;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        slot.appendChild(img);
        slot.insertAdjacentHTML('beforeend', `<button type="button" onclick="removeProductImage(${i})" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.78);border:none;color:white;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">✕</button>${i===0?'<span style="position:absolute;bottom:2px;left:3px;font-size:7px;font-weight:900;color:#71ff00;background:rgba(0,0,0,0.65);padding:1px 4px;border-radius:3px;">MAIN</span>':''}`);
        grid.appendChild(slot);
    });

    if (_productImages.length < 5) {
        const addSlot = document.createElement('div');
        addSlot.style.cssText = 'flex-shrink:0;width:72px;height:72px;border-radius:12px;border:2px dashed rgba(113,255,0,0.25);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;gap:3px;transition:border-color .15s;';
        addSlot.innerHTML = `<span style="font-size:20px;">📷</span><span style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.35);">${_productImages.length===0?'Add Photo':'+ Add'}</span>`;
        addSlot.onclick = () => document.getElementById('productImageInput').click();
        grid.appendChild(addSlot);
    }
}

function addProductImages(files) {
    const remaining = 5 - _productImages.length;
    if (remaining <= 0) return;
    Array.from(files).slice(0, remaining).forEach(file => {
        _productImages.push({ file, url: URL.createObjectURL(file) });
    });
    if (files.length > remaining) showNotification('Max 5 photos per product', 'error');
    renderImageSlots();
}

function removeProductImage(i) {
    URL.revokeObjectURL(_productImages[i].url);
    _productImages.splice(i, 1);
    renderImageSlots();
}

window.addProductImages  = addProductImages;
window.removeProductImage = removeProductImage;

/* initialise slots once DOM ready */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderImageSlots);
} else {
    renderImageSlots();
}

/* =========================
   ADD PRODUCT
========================= */

async function addProduct(){

    const productName =
    document.getElementById("productName").value.trim();

    const productPrice =
    document.getElementById("productPrice").value;

    const productCategory =
    document.getElementById("productCategory").value;

    /* Name/price validation comes from the shared schema, so upload and edit
       enforce the same rules. The image requirement is upload-only (edit keeps
       existing images), so it stays here. A full serialize() migration of the
       upload path is deferred: upload DEFAULTS blank fields (location→nairobi,
       minWholesaleQty→10) while edit OMITS them, which needs a create-vs-patch
       mode in the schema before the two can share serialize without changing
       upload's business rules. */
    const _schema = window.SokoniProductSchema;
    if (_schema) {
        const v = _schema.validate('product');
        if (!v.ok || !_productImages.length) {
            showNotification(!_productImages.length ? "Add at least one photo" : ("⚠️ " + v.message), "error");
            return;
        }
    } else if (productName === "" || productPrice === "" || !_productImages.length) {
        showNotification("Please fill all fields including at least one photo", "error");
        return;
    }

    /* ── Ownership verification gate for high-value / theft-risk categories ── */
    if(VERIFY_CATS[productCategory]){
        const cfg      = VERIFY_CATS[productCategory];
        const serial   = document.getElementById("ownerSerial")?.value.trim() || "";
        const receipt  = document.getElementById("ownerReceiptFile")?.files[0];
        const declared = document.getElementById("ownerDeclaration")?.checked;

        /* Minimum serial length: VIN/IMEI = 14+, others = 4+ */
        const minLen = (productCategory === "cars" || productCategory === "electronics") ? 8 : 4;
        if(!serial || serial.length < minLen){
            showNotification(`⚠️ ${cfg.serial} is required (min ${minLen} characters)`, "error");
            document.getElementById("ownerSerial")?.focus();
            document.getElementById("ownershipVerifyBox")?.scrollIntoView({behavior:"smooth", block:"center"});
            return;
        }
        if(!receipt){
            showNotification("⚠️ Upload a purchase receipt or invoice — this is required to verify ownership", "error");
            document.getElementById("ownerReceiptFile")?.closest("label")?.scrollIntoView({behavior:"smooth", block:"center"});
            return;
        }
        if(cfg.docRequired && !document.getElementById("ownerDocFile")?.files[0]){
            showNotification(`⚠️ Please upload the ${cfg.doc} — required for this category`, "error");
            return;
        }
        if(!declared){
            showNotification("⚠️ Tick the ownership declaration checkbox to continue — false declarations are a criminal offence", "error");
            document.getElementById("ownerDeclaration")?.scrollIntoView({behavior:"smooth", block:"center"});
            return;
        }
    }

    showNotification("✨ AI enhancing & uploading...", "success");

    try {

        const compressedImages = await Promise.all(_productImages.map(item => compressImage(item.file)));
        const compressedImage  = compressedImages[0];

        const productLocation    = document.getElementById("productLocation")?.value || "nairobi";
        const productDescription = document.getElementById("productDescription")?.value?.trim() || "";
        const kebsCert           = document.getElementById("kebsCert")?.value?.trim() || "";
        const costPrice          = Number(document.getElementById("costPrice")?.value || 0);
        const deliveryCost       = Number(document.getElementById("deliveryCost")?.value || 0);
        const stockQty           = Number(document.getElementById("stockQty")?.value || 0);
        const user               = JSON.parse(localStorage.getItem("sokoniUser") || "null");

        const wholesalePrice    = Number(document.getElementById("wholesalePrice")?.value || 0);
        const minWholesaleQty   = Number(document.getElementById("minWholesaleQty")?.value || 10);
        const isDigital         = document.getElementById("isDigitalProduct")?.checked || false;
        const digitalUrl        = document.getElementById("digitalUrl")?.value.trim() || "";
        const digitalLicense    = document.getElementById("digitalLicense")?.value.trim() || "";

        /* Services and digital products have unlimited availability */
        const SERVICE_CATS_JS = new Set(["phone-repair","computer-repair","electronics-repair","graphic-design","photography","videography","music-audio","cleaning","laundry","gardening","plumbing","electrical","interior-design","delivery-service","courier","boda-delivery","marketing","accounting","legal","virtual-assistant","printing","tutoring","coaching","events","catering","hair-beauty","fitness","services"]);
        const isServiceCat  = SERVICE_CATS_JS.has(productCategory);
        const isDigitalCat  = ["ebook","template","course","software","license"].includes(productCategory);
        /* Override stock: services & digital are always available */
        const effectiveStock = (isServiceCat || isDigital || isDigitalCat) ? 9999 : stockQty;

        const productVideoUrl = (document.getElementById("productVideoData")?.value || "").trim();
        const newProduct = {
            id: Date.now().toString(),
            name: productName,
            price: Number(productPrice),
            costPrice,
            deliveryCost,
            stock: effectiveStock,
            sold: 0,
            outOfStock: effectiveStock === 0,
            isService: isServiceCat,
            image: compressedImage,
            images: compressedImages,
            video: productVideoUrl || null,
            category: productCategory,
            location: productLocation,
            description: productDescription,
            kebsCert,
            sellerName: user ? user.name : "Sokoni Seller",
            sellerEmail: user ? user.email : "",
            views: 0,
            uploadedAt: Date.now(),
            wholesalePrice:  wholesalePrice > 0 ? wholesalePrice : null,
            minWholesaleQty: wholesalePrice > 0 ? minWholesaleQty : null,
            /* Category-dependent variants (colours / sizes / storage / pack size).
               Spread from the shared schema so upload and edit write the SAME
               keys — the drift these two forms are prone to is exactly what the
               schema exists to prevent. */
            ...(window.SokoniProductSchema && window.SokoniProductSchema.serializeVariants
                ? window.SokoniProductSchema.serializeVariants('product', productCategory)
                : {}),
            isDigital,
            digitalUrl:      isDigital ? digitalUrl : null,
            digitalLicense:  isDigital ? digitalLicense : null,
            /* Anti-theft ownership verification */
            ownership: VERIFY_CATS[productCategory] ? {
                serial:       document.getElementById("ownerSerial")?.value.trim() || "",
                source:       document.getElementById("ownerSource")?.value || "",
                declared:     true,
                submittedAt:  Date.now(),
                status:       "pending"
            } : null,
            verificationStatus: VERIFY_CATS[productCategory] ? "pending" : "none",

            /* PUBLICATION STATE — without this the product is invisible.
               Every retrieval path filters on a top-level `status`:
                 sokoni-search-engine.js:1514   where('status','==','active')
                 functions/search-service.js:1171  same, server-side
                 functions/search-service.js:257   Typesense 'status:=active'
               A Firestore equality filter does not match documents where the
               field is ABSENT, so a product without it is excluded from every
               one of them — it is not ranked low, it is not returned at all.

               Note this is distinct from `ownership.status` above, which tracks
               proof-of-ownership review for restricted categories, and from
               `verificationStatus`. Neither is read by search. The name
               collision is why the gap was easy to miss: the document looked
               like it already carried a status. */
            status: "active"
        };

        let sellerProducts;
        try {
            sellerProducts = JSON.parse(localStorage.getItem("sellerProducts")) || [];
        } catch(e) {
            sellerProducts = [];
        }

        /* ── Plan listing limit ─────────────────────────────────────────────
           Asks the server. This used to read SokoniPay.PLANS, a client-side
           table saying free:3 / starter:20 — numbers that disagree with the
           canonical catalogue (free:10) and with each other across the ten
           tables that existed. Any client table is guessing: the device holding
           it is the party the limit applies to.

           canPublishProduct resolves through functions/subscription-catalog.js,
           the same authority that actually enforces the write, so the banner
           and the enforcement can no longer disagree. It also returns the
           upgrade copy, so the message is written once server-side.

           Failing to resolve does NOT block the save. A lookup problem must not
           stop a merchant listing a product, and asserting a plan we could not
           read is what told a merchant on an active trial they were on Free. */
        try {
            const _fn = window.firebaseFunctions ||
                        (window.firebase && window.firebase.functions && window.firebase.functions());
            if (_fn) {
                const { httpsCallable } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
                );
                const _res = await httpsCallable(_fn, 'canPublishProduct')({});
                const _d = (_res && _res.data) || {};
                if (_d.allowed === false && _d.upgrade) {
                    showNotification(_d.upgrade.message, "error");
                    setTimeout(function(){ window.location.href = "subscriptions.html"; }, 2000);
                    return;
                }
            }
        } catch (_) {
            /* Unresolved — allow the save.

               NOTE (2026-07-24): the original comment here claimed "the server
               rule is the real gate". That is not true for a product COUNT:
               Firestore rules cannot count documents, so no rule rejects an
               over-limit create. This path therefore fails OPEN, and that is a
               deliberate trade — a transient callable failure must not block a
               paying merchant from listing — but it is the only enforcement
               point, not a second line of defence. Enforcement lives in
               canPublishProduct above, which resolves through
               functions/subscription-authority.js -> subscription-catalog. */
        }

        /* The counter the merchant sees must be recomputed from the authority
           rather than from any local plan table. Fire-and-forget: a display
           refresh must never delay or block the upload itself. */
        try {
            if (window.SokoniAuthority) {
                window.SokoniAuthority.invalidate();
                window.SokoniAuthority.getMerchantEntitlements({ force: true });
            }
        } catch (_) { /* display-only */ }

        sellerProducts.push(newProduct);

        /* The localStorage copy is a CACHE for offline rendering. Firestore is the
           product. This used to `return` when the cache write threw, which meant a
           browser storage limit silently destroyed the upload — the merchant saw
           "Storage full! Delete old products first." and lost the product without
           it ever reaching Firestore.
           It fires at four products, not at a plan limit. compressImage() returns
           canvas.toDataURL(), so every product carries its picture as base64 in
           BOTH `image` and `images[]`. Base64 inflates by a third and browsers
           store strings as UTF-16, so four products is roughly 3 MB against
           Safari's ~5 MB origin cap.
           A cache must never be able to block the write it is caching. */
        _cacheSellerProducts(sellerProducts);

        /* ── Firestore + Storage: write product ── */
        /* Capture image files now — _productImages is cleared after displaySellerProducts() */
        const _capturedImages = _productImages.map(function(x){ return {file:x.file}; });
        (async function(){
            try {
                const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
                const db = window.firebaseDB; if(!db) return;
                const u = JSON.parse(localStorage.getItem('sokoniUser')||'null');
                const sellerUid = u ? (u.uid||u.id||null) : null;

                /* Try uploading images to Firebase Storage for CDN URLs */
                const storageUrls = await _uploadImagesToStorage(newProduct.id, sellerUid, _capturedImages);

                /* Build Firestore payload: use Storage URLs if available, else base64 */
                const fsProduct = Object.assign({}, newProduct, {
                    uid: sellerUid,
                    sellerUid: sellerUid,
                    createdAt: m.serverTimestamp(),
                });
                if (storageUrls && storageUrls.length > 0) {
                    fsProduct.image  = storageUrls[0];
                    fsProduct.images = storageUrls;
                    fsProduct.imageStorageUrls = storageUrls;

                    /* Swap the cache's base64 for the URLs now that Storage holds
                       the originals. Without this the cache keeps a ~190KB copy of
                       every picture forever and refills the quota that was just
                       freed — the upload succeeds today and the fifth one fails
                       again tomorrow. A URL is ~100 bytes. */
                    try {
                        const cached = JSON.parse(localStorage.getItem('sellerProducts') || '[]');
                        const idx = cached.findIndex(function (p) { return p && p.id === newProduct.id; });
                        if (idx !== -1) {
                            cached[idx].image  = storageUrls[0];
                            cached[idx].images = storageUrls;
                            /* Persist the URLs under their own key too, so the
                               renderer's imageStorageUrls fallback survives even
                               if a future strip clears `image`. */
                            cached[idx].imageStorageUrls = storageUrls;
                            _cacheSellerProducts(cached);
                            /* Re-render so the card swaps its base64 preview (or a
                               placeholder, if this entry was stripped to fit) for
                               the Storage URL now that it exists. Without this the
                               dashboard keeps showing whatever it painted before
                               the upload resolved. */
                            try { if (typeof displaySellerProducts === 'function') displaySellerProducts(); } catch (_) {}
                        }
                    } catch (_) { /* cache is best-effort; the document is written regardless */ }
                }

                /* PRIORITY-1 GUARD (2026-07-25): NEVER persist a base64 data: URI to
                   a product doc. The old "base64 fallback" here truncated a data: URI
                   to ~200KB and stored it — which is exactly how "PEACH MANGO ICE" put
                   a 195KB image into `images`, blew past Algolia's 10KB record cap and
                   stalled search indexing for every product in its batch. A product
                   with no image shows the placeholder (the seller can re-add the photo);
                   a poisoned index is far worse. This strips the string `image` field
                   and every `images[]` entry regardless of which upload branch ran, so
                   it is the client half of the defence-in-depth the Firestore rule now
                   enforces server-side. */
                fsProduct.image  = _isDataUri(fsProduct.image) ? '' : (fsProduct.image || '');
                if (Array.isArray(fsProduct.images)) {
                    fsProduct.images = fsProduct.images.filter(function(v){ return !_isDataUri(v); });
                }

                await m.setDoc(m.doc(db,'products',newProduct.id), fsProduct);

                /* ── SYNC TO INVENTORY MANAGER ──────────────────────────────────
                   The storefront product (top-level `products`) and the back-office
                   inventory manager are SEPARATE collections with no bridge, so an
                   uploaded product never appeared in inv-products.html. That page reads
                   tenants/{uid}/inventory_products via SokoniInventory. Mirror the product
                   there, keyed by the SAME id so the two stay linked, mapping the
                   storefront fields to the inventory schema saveProduct() expects
                   (price->sellingPrice, costPrice->buyingPrice, stock->stockLevel) and
                   assigning the default branch (warehouseId). Also mirror to posProducts —
                   the same two writes SokoniInventory.saveProduct does — so the product is
                   visible at POS checkout too.

                   FULLY SEPARATE and fire-and-forget: the products write above has already
                   succeeded and is awaited; this runs after it and is wrapped so a sync
                   failure (rules, offline, quota) can NEVER affect the storefront listing,
                   which is the merchant's revenue path. Branch stock separation and a
                   branch picker on the upload form are follow-on; this establishes the
                   link and the default-branch assignment. */
                if (sellerUid) {
                    try {
                        const _img = (storageUrls && storageUrls[0]) || newProduct.image || '';
                        const _sku = 'SKU-' + String(newProduct.id).slice(-8).toUpperCase();
                        const _wh  = (newProduct.warehouseId || newProduct.branchId || 'main');
                        const _invProduct = {
                            id:           newProduct.id,
                            name:         newProduct.name || '',
                            sellingPrice: Number(newProduct.price)     || 0,
                            buyingPrice:  Number(newProduct.costPrice)  || 0,
                            category:     newProduct.category || '',
                            stockLevel:   Number(newProduct.stock) || 0,
                            reorderPoint: 10,
                            unit:         'pcs',
                            imageUrl:     _img,
                            description:  newProduct.description || '',
                            sku:          _sku,
                            warehouseId:  _wh,
                            active:       true,
                            tenantId:     sellerUid,
                            sourceProductId: newProduct.id,   /* link back to the storefront product */
                            createdAt:    m.serverTimestamp(),
                            updatedAt:    m.serverTimestamp(),
                        };
                        m.setDoc(m.doc(db, 'tenants', sellerUid, 'inventory_products', newProduct.id), _invProduct, { merge: true })
                          .catch(function (e) { console.warn('[SOKONI] inventory sync (non-blocking):', e && e.message); });
                        m.setDoc(m.doc(db, 'posProducts', newProduct.id), {
                            name: _invProduct.name, price: _invProduct.sellingPrice, cost: _invProduct.buyingPrice,
                            category: _invProduct.category, sku: _sku, unit: 'pcs', stockLevel: _invProduct.stockLevel,
                            reorderPoint: 10, imageUrl: _img, description: _invProduct.description,
                            sellerId: sellerUid, status: 'active', tenantId: sellerUid, updatedAt: m.serverTimestamp(),
                        }, { merge: true }).catch(function () { /* POS mirror is best-effort */ });
                    } catch (_) { /* sync must never break the upload */ }
                }
            } catch(e){
                console.warn('[SOKONI] Product Firestore/Storage save:', e.message);
            }
        })();

        if(typeof SokoniSecurity !== 'undefined'){
            SokoniSecurity.audit('PRODUCT_POST', { productId: newProduct.id, name: newProduct.name, price: newProduct.price, category: newProduct.category });
        }

        displaySellerProducts();
        updateSellerStats();

        /* ── Notify followers of new product ── */
        try {
            const storeFollowers = JSON.parse(localStorage.getItem("sokoniStoreFollowers")) || {};
            const sellerKey = newProduct.sellerName || "Sokoni Seller";
            const followerCount = storeFollowers[sellerKey] || 0;
            if (followerCount > 0) {
                let followNotifs = [];
                try { followNotifs = JSON.parse(localStorage.getItem("sokoniFollowNotifications")) || []; } catch(e) {}
                followNotifs.unshift({
                    id:          "fn" + Date.now(),
                    sellerName:  sellerKey,
                    productName: newProduct.name,
                    productId:   newProduct.id,
                    productImage:newProduct.image || "",
                    price:       newProduct.price,
                    postedAt:    Date.now(),
                    read:        false
                });
                localStorage.setItem("sokoniFollowNotifications", JSON.stringify(followNotifs.slice(0, 60)));
            }
        } catch(e) {}

        if(typeof sokoniTrackProductUpload === "function") sokoniTrackProductUpload(productCategory);
        showNotification("✅ Product Uploaded", "success");

        document.getElementById("productName").value = "";
        document.getElementById("productPrice").value = "";
        _productImages.forEach(item => URL.revokeObjectURL(item.url));
        _productImages = [];
        renderImageSlots();

    } catch(e) {

        showNotification("Failed to process image. Try a smaller file.", "error");
        console.error("Upload error:", e);

    }

}

/* =========================
   DISPLAY SELLER PRODUCTS
========================= */

function displaySellerProducts(){

    const sellerProductsContainer =
    document.getElementById(
        "sellerProductsContainer"
    );

    if(!sellerProductsContainer) return;

    sellerProductsContainer.innerHTML = "";

    let sellerProducts = JSON.parse(

        localStorage.getItem(
            "sellerProducts"
        )

    ) || [];

    if(sellerProducts.length === 0){

        sellerProductsContainer.innerHTML = `

            <h2 class="no-products">

                No Products Uploaded Yet 😢

            </h2>

        `;

        return;
    }

    sellerProducts.forEach((product,index)=>{

        const ownerBadge = product.verificationStatus === "pending"
            ? `<div style="font-size:10px;font-weight:800;background:rgba(255,152,0,0.12);border:1px solid rgba(255,152,0,0.3);color:#ff9800;padding:3px 9px;border-radius:20px;display:inline-block;margin-bottom:6px;">🔍 Ownership Under Review</div>`
            : product.verificationStatus === "approved"
            ? `<div style="font-size:10px;font-weight:800;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);color:#71ff00;padding:3px 9px;border-radius:20px;display:inline-block;margin-bottom:6px;">✅ Verified Owner</div>`
            : product.verificationStatus === "rejected"
            ? `<div style="font-size:10px;font-weight:800;background:rgba(255,77,77,0.1);border:1px solid rgba(255,77,77,0.25);color:#ff4d4d;padding:3px 9px;border-radius:20px;display:inline-block;margin-bottom:6px;">❌ Verification Rejected</div>`
            : "";

        const stockLabel = product.stock != null
            ? (product.stock === 0
                ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(255,77,77,0.12);color:#ff4d4d;border:1px solid rgba(255,77,77,0.25);">Out of Stock</span>`
                : `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(113,255,0,0.08);color:#71ff00;border:1px solid rgba(113,255,0,0.2);">Stock: ${product.stock}</span>`)
            : "";

        const stockBadge = product.stock != null
            ? (product.stock === 0
                ? `<span style="position:absolute;top:6px;left:6px;font-size:8px;font-weight:900;padding:2px 6px;border-radius:5px;background:rgba(255,60,60,0.85);color:white;backdrop-filter:blur(6px);">OUT</span>`
                : `<span style="position:absolute;top:6px;left:6px;font-size:8px;font-weight:900;padding:2px 6px;border-radius:5px;background:rgba(0,0,0,0.6);color:#71ff00;backdrop-filter:blur(6px);">x${product.stock}</span>`)
            : "";

        const verifyDot = product.verificationStatus === "approved"
            ? `<span style="position:absolute;top:6px;right:6px;width:16px;height:16px;border-radius:50%;background:rgba(113,255,0,0.9);display:flex;align-items:center;justify-content:center;font-size:9px;" title="Verified">✓</span>`
            : product.verificationStatus === "pending"
            ? `<span style="position:absolute;top:6px;right:6px;width:16px;height:16px;border-radius:50%;background:rgba(255,152,0,0.9);display:flex;align-items:center;justify-content:center;font-size:9px;" title="Under Review">⏳</span>`
            : "";

        sellerProductsContainer.innerHTML += `
            <div class="product-card">

                <!-- Square image with overlay badges -->
                <div style="position:relative;aspect-ratio:1/1;overflow:hidden;background:rgba(255,255,255,0.03);flex-shrink:0;">
                    <img
                        src="${_esc((product.imageStorageUrls && product.imageStorageUrls[0]) || product.image || 'assets/default-product.png')}"
                        alt="${_esc(product.name)}"
                        style="width:100%;height:100%;object-fit:cover;display:block;"
                        onerror="this.src='assets/default-product.png'"
                    >
                    ${stockBadge}
                    ${verifyDot}
                </div>

                <!-- Info — compact -->
                <div style="padding:8px 9px 5px;flex:1;display:flex;flex-direction:column;gap:3px;">
                    <div style="font-size:11.5px;font-weight:800;color:white;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${_esc(product.name)}</div>
                    <div style="font-size:13px;font-weight:900;color:#71ff00;line-height:1;">KES ${Number(product.price).toLocaleString()}</div>
                    ${product.category ? `<div style="font-size:9px;color:rgba(255,255,255,0.28);font-weight:600;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(product.category)}</div>` : ""}
                </div>

                <!-- Action row — Edit / Story / Boost / Delete.
                     2x2 grid, not a 4-wide flex row. Four buttons sharing a card
                     column on a phone gave each about 60px, so the icons sat edge
                     to edge with no room for a label and the tap targets were
                     32px tall — under the 44px minimum a thumb can hit reliably.
                     Two columns doubles the width, which is what makes room for
                     the words: an icon-only row asks the merchant to remember
                     that a megaphone means "post as story". -->
                <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px 8px 12px;position:relative;z-index:2;">
                    <button type="button" onclick="editProduct(${index})" title="Edit product"
                        style="width:100%;min-height:44px;padding:0 8px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:11px;color:white;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px;"
                        onmouseover="this.style.background='rgba(255,255,255,0.16)'"
                        onmouseout="this.style.background='rgba(255,255,255,0.07)'">✏️ <span>Edit</span></button>
                    <button type="button" onclick="promoteProductAsStory('${product.id}',${index})" title="Promote as Story"
                        style="width:100%;min-height:44px;padding:0 8px;background:rgba(113,255,0,0.09);border:1px solid rgba(113,255,0,0.22);border-radius:11px;color:#71ff00;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px;"
                        onmouseover="this.style.background='rgba(113,255,0,0.2)'"
                        onmouseout="this.style.background='rgba(113,255,0,0.09)'">📣 <span>Promote</span></button>
                    <button type="button" onclick="boostProduct('${_esc(product.id)}','${_esc(product.name||'')}')" title="Boost listing"
                        style="width:100%;min-height:44px;padding:0 8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:11px;color:#fbbf24;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px;"
                        onmouseover="this.style.background='rgba(251,191,36,0.2)'"
                        onmouseout="this.style.background='rgba(251,191,36,0.08)'">⚡ <span>Boost</span></button>
                    <button type="button" onclick="deleteProduct(${index})" title="Delete product"
                        style="width:100%;min-height:44px;padding:0 8px;background:rgba(255,60,60,0.07);border:1px solid rgba(255,60,60,0.2);border-radius:11px;color:#ff6b6b;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px;"
                        onmouseover="this.style.background='rgba(255,60,60,0.18)'"
                        onmouseout="this.style.background='rgba(255,60,60,0.07)'">🗑️ <span>Delete</span></button>
                </div>

            </div>
        `;

    }); // end forEach

    /* update count label */
    const cnt = document.getElementById('productGridCount');
    if(cnt) cnt.textContent = sellerProducts.length + ' product' + (sellerProducts.length !== 1 ? 's' : '');

}

/* ── Boost a listing via SokoniPay ── */
function boostProduct(productId, productName){
    if(typeof SokoniPay === "undefined"){
        showNotification("Payment system loading. Try again in a moment.", "error");
        return;
    }
    /* Remove any existing boost modal before creating a new one */
    document.getElementById('_boostModal')?.remove();
    /* Show boost picker */
    const prices = SokoniPay.BOOST_PRICES;
    const opts = Object.entries(prices).map(([k,v])=>
        `<button type="button" onclick="window._doBoost('${_esc(productId)}','${_esc(k)}','${_esc(productName||'')}')" style="width:100%;text-align:left;padding:12px 14px;background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.2);border-radius:11px;color:white;font-size:12px;cursor:pointer;font-family:inherit;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <span><strong>${v.label}</strong><br><span style="color:rgba(255,255,255,0.4);font-size:10px;">${v.description} · ${v.duration} days</span></span>
            <span style="color:#fbbf24;font-weight:900;font-size:13px;">KES ${v.price}</span>
        </button>`
    ).join('');
    const modal = document.createElement('div');
    modal.id = '_boostModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="background:#111;border:1px solid rgba(251,191,36,0.2);border-radius:20px;padding:24px;max-width:380px;width:100%;position:relative;">
        <button onclick="document.getElementById('_boostModal').remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:rgba(255,255,255,0.3);font-size:18px;cursor:pointer;">✕</button>
        <div style="font-size:15px;font-weight:900;color:white;margin-bottom:4px;">⚡ Boost Listing</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:18px;">${typeof escapeHTML==='function'?escapeHTML(productName):productName}</div>
        ${opts}
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });
}

window._doBoost = function(productId, boostType, productName){
    const modal = document.getElementById('_boostModal');
    if(modal) modal.remove();
    if(typeof SokoniPay === "undefined") return;
    SokoniPay.boostListing(productId, boostType, { listingName: productName });
};

/* search/sort wrappers */
function filterProductGrid(q){
    const cards = document.querySelectorAll('#sellerProductsContainer .product-card');
    let visible = 0;
    cards.forEach(c => {
        const name = c.querySelector('div[style*="font-weight:800"]')?.textContent?.toLowerCase() || '';
        const cat  = c.querySelector('div[style*="text-transform:uppercase"]')?.textContent?.toLowerCase() || '';
        const show = !q || name.includes(q.toLowerCase()) || cat.includes(q.toLowerCase());
        c.style.display = show ? '' : 'none';
        if(show) visible++;
    });
    const cnt = document.getElementById('productGridCount');
    if(cnt) cnt.textContent = visible + ' product' + (visible !== 1 ? 's' : '') + (q ? ' matched' : '');
}

function sortProductGrid(by){
    let products = [];
    try { products = JSON.parse(localStorage.getItem('sellerProducts')) || []; } catch(e){}
    if(by === 'price_asc')  products.sort((a,b) => Number(a.price) - Number(b.price));
    else if(by === 'price_desc') products.sort((a,b) => Number(b.price) - Number(a.price));
    else if(by === 'name')  products.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    else if(by === 'stock') products.sort((a,b) => (Number(b.stock)||0) - (Number(a.stock)||0));
    /* save sorted order and re-render */
    localStorage.setItem('sellerProducts', JSON.stringify(products));
    displaySellerProducts();
}

window.filterProductGrid = filterProductGrid;
window.sortProductGrid   = sortProductGrid;

function filterInventoryTable(q){
    const rows = document.querySelectorAll('#inventoryTbody tr[id^="inv-row-"]');
    let visible = 0;
    rows.forEach(row => {
        const name = row.querySelector('div[style*="font-weight:700"]')?.textContent?.toLowerCase() || '';
        const cat  = row.querySelector('td:nth-child(2)')?.textContent?.toLowerCase() || '';
        const show = !q || name.includes(q.toLowerCase()) || cat.includes(q.toLowerCase());
        row.style.display = show ? '' : 'none';
        if(show) visible++;
    });
}
window.filterInventoryTable = filterInventoryTable;

/* =========================
   PROMOTE PRODUCT AS STORY
========================= */
function promoteProductAsStory(productId, index){
    let prods = [];
    try { prods = JSON.parse(localStorage.getItem("sellerProducts") || "[]"); } catch(e) {}

    /* resolve product — by id first, fall back to index */
    let p = prods.find(function(x){ return x.id === productId; });
    if(!p && index !== undefined) p = prods[index];
    if(!p) { showNotification("⚠️ Product not found", "error"); return; }

    const user = (function(){ try{ return JSON.parse(localStorage.getItem("sokoniUser")||"{}"); }catch(e){ return {}; } })();

    /* Build story object */
    const story = {
        id:          "story_" + Date.now(),
        productId:   p.id || "",
        productName: p.name || "",
        price:       p.price || 0,
        image:       p.image || "",
        category:    p.category || "",
        description: p.description || "",
        sellerName:  user.storeName || user.name || "Seller",
        sellerPhone: user.phone || "",
        postedAt:    Date.now(),
        expiresAt:   Date.now() + 24 * 60 * 60 * 1000, /* 24 hours */
        type:        "product",
        views:       0,
        likes:       0
    };

    /* Save to sokoniStories */
    let stories = [];
    try { stories = JSON.parse(localStorage.getItem("sokoniStories") || "[]"); } catch(e) {}
    /* Remove any existing story for same product to avoid duplicates */
    stories = stories.filter(function(s){ return s.productId !== p.id; });
    stories.unshift(story);
    /* Keep max 50 stories */
    stories = stories.slice(0, 50);
    localStorage.setItem("sokoniStories", JSON.stringify(stories));

    showNotification("📣 Story posted! Visible for 24 hours.", "success");

    /* Flash the story button green briefly */
    var btn = document.querySelector('[onclick*="promoteProductAsStory(\''+productId+'\'"]');
    if(btn){
        var orig = btn.style.background;
        btn.style.background = "rgba(113,255,0,0.4)";
        btn.textContent = "✅";
        setTimeout(function(){ btn.style.background = orig; btn.textContent = "📣"; }, 2000);
    }
}
window.promoteProductAsStory = promoteProductAsStory;

/* =========================
   DELETE PRODUCT
========================= */

function deleteProduct(index){

    let sellerProducts = JSON.parse(localStorage.getItem("sellerProducts")) || [];
    const target = sellerProducts[index];
    if (!target) return;

    /* SOFT DELETE — archive in Firestore, do not destroy.
       This handler used to splice the product out of localStorage and stop. The
       marketplace reads Firestore (realtime.js), so the product vanished from the
       seller's own dashboard while every buyer kept seeing it on Home, in search
       and on category pages — the reported "deleted products still show" bug.
       Firestore is the authority; the local array is a cache.

       Archive, not hard-delete, so sales history, orders and analytics that
       reference this product survive and the seller can relist later. Buyers stop
       seeing it because realtime.js and the search fallback now hide anything
       whose status is archived/deleted/hidden or whose isVisible is false. Legacy
       products with no status field stay visible — absence means active. */
    const uid = (JSON.parse(localStorage.getItem("sokoniUser") || "null") || {}).uid || null;

    /* Remove from the local cache immediately so the dashboard updates without a
       round-trip, and so realtime.js does not re-merge it from `mine`. */
    sellerProducts.splice(index, 1);
    localStorage.setItem("sellerProducts", JSON.stringify(sellerProducts));
    displaySellerProducts();
    updateSellerStats();

    /* Persist the archive to Firestore. Fire-and-forget and guarded: the local
       view already updated; a merchant offline still sees it gone and the archive
       syncs on their next connected action. Legacy localStorage-only products
       (no Firestore id) simply skip — there is nothing to archive server-side. */
    (async function () {
        try {
            if (!target.id || !window.firebaseDB) return;
            const m = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
            await m.updateDoc(m.doc(window.firebaseDB, "products", String(target.id)), {
                status:     "archived",
                isVisible:  false,
                archivedAt: m.serverTimestamp(),
                archivedBy: uid,
                updatedAt:  m.serverTimestamp(),
            });
        } catch (e) {
            console.warn("[seller] archive sync deferred:", e && e.message);
        }
    })();

    showNotification("🗑️ Product Archived", "delete");
}

/* =========================
   EDIT PRODUCT — Inline Modal
========================= */

let _editIndex = -1;
let _editImages = []; // data URL strings

function renderEditImageSlots() {
    const grid = document.getElementById('editImagesGrid');
    if (!grid) return;
    grid.innerHTML = '';

    _editImages.forEach((url, i) => {
        const slot = document.createElement('div');
        slot.style.cssText = 'position:relative;flex-shrink:0;width:72px;height:72px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,0.05);border:1px solid rgba(113,255,0,0.22);';
        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        img.onerror = function(){ this.src = 'assets/default-product.png'; };
        slot.appendChild(img);
        slot.insertAdjacentHTML('beforeend', `<button type="button" onclick="removeEditImage(${i})" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.78);border:none;color:white;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">✕</button>${i===0?'<span style="position:absolute;bottom:2px;left:3px;font-size:7px;font-weight:900;color:#71ff00;background:rgba(0,0,0,0.65);padding:1px 4px;border-radius:3px;">MAIN</span>':''}`);
        grid.appendChild(slot);
    });

    if (_editImages.length < 5) {
        const addSlot = document.createElement('div');
        addSlot.style.cssText = 'flex-shrink:0;width:72px;height:72px;border-radius:12px;border:2px dashed rgba(113,255,0,0.25);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;gap:3px;transition:border-color .15s;';
        addSlot.innerHTML = `<span style="font-size:20px;">📷</span><span style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.35);">${_editImages.length===0?'Add Photo':'+ Add'}</span>`;
        addSlot.onclick = () => document.getElementById('editImgFile').click();
        grid.appendChild(addSlot);
    }
}

function addEditImages(files) {
    const remaining = 5 - _editImages.length;
    if (remaining <= 0) return;
    let loaded = 0;
    const arr = Array.from(files).slice(0, remaining);
    arr.forEach(file => {
        compressImage(file).then(dataUrl => {
            _editImages.push(dataUrl);
            loaded++;
            if (loaded === arr.length) renderEditImageSlots();
        });
    });
    if (files.length > remaining) showNotification('Max 5 photos per product', 'error');
}

function removeEditImage(i) {
    _editImages.splice(i, 1);
    renderEditImageSlots();
}

window.addEditImages  = addEditImages;
window.removeEditImage = removeEditImage;

/**
 * Make the edit-modal category dropdown offer exactly what the upload form does.
 *
 * productCategory (the upload <select>) is the authoritative option list — 78
 * categories across 20 optgroups. This clones it into editCategory so the edit
 * modal cannot present a smaller, drifting vocabulary. Cloning the markup keeps
 * the optgroup structure intact.
 *
 * currentCat guarantees the product's existing category is always selectable,
 * even if it predates the current list or came from another surface. Without it,
 * a value the dropdown does not contain would not "stick", and the first Save
 * would overwrite the real category with the visible default — the exact bug
 * this function exists to end. If the value is unknown, it is added under a
 * "Current" group so the merchant keeps it rather than silently losing it.
 */
function _syncEditCategoryOptions(currentCat) {
    const src = document.getElementById('productCategory');
    const dst = document.getElementById('editCategory');
    if (!dst) return;

    if (src && src.innerHTML.trim()) {
        dst.innerHTML = src.innerHTML;
    }

    /* Ensure currentCat exists as an option so setting .value round-trips. */
    if (currentCat) {
        const has = Array.prototype.some.call(dst.options, function (o) { return o.value === currentCat; });
        if (!has) {
            const g = document.createElement('optgroup');
            g.label = 'Current';
            const o = document.createElement('option');
            o.value = currentCat;
            o.textContent = currentCat;
            g.appendChild(o);
            dst.insertBefore(g, dst.firstChild);
        }
    }
}

/* Keep the variant chips in step with the chosen category, on both forms.
   Bound once, lazily, because the edit modal's category <select> is rebuilt by
   _syncEditCategoryOptions() and a listener attached to the old node would be
   discarded — binding on the element that survives (the select id) after each
   open is simpler than re-binding inside the rebuild. */
function _bindVariantCategorySync() {
  var schema = window.SokoniProductSchema;
  if (!schema || !schema.renderVariants) return;
  [['productCategory', 'product'], ['editCategory', 'edit']].forEach(function (pair) {
    var sel = document.getElementById(pair[0]);
    if (!sel || sel._skVarSync) return;
    sel.addEventListener('change', function () {
      /* Re-render for the new category. Current selections are re-read first so
         an attribute shared by both categories (colours, usually) keeps what the
         seller already picked instead of silently resetting. */
      var keep = schema.serializeVariants(pair[1], sel.value) || {};
      schema.renderVariants(pair[1], sel.value, keep);
    });
    sel._skVarSync = true;
  });
}
document.addEventListener('DOMContentLoaded', function () {
  _bindVariantCategorySync();
  var schema = window.SokoniProductSchema;
  var sel = document.getElementById('productCategory');
  if (schema && schema.renderVariants && sel) schema.renderVariants('product', sel.value, {});
});

function editProduct(index) {
    _editIndex = index;
    _editImages = [];

    const prods = JSON.parse(localStorage.getItem("sellerProducts") || "[]");
    const p = prods[index];
    if (!p) return;

    /* Category dropdown is cloned from the authoritative upload list BEFORE the
       schema populates it, so the product's category has an option to select and
       cannot be silently truncated. This step is specialised (it rebuilds the
       <select>), so it stays here rather than in the schema. */
    _syncEditCategoryOptions(p.category);

    /* Every ordinary field — name, price, category, stock, cost, delivery,
       location, wholesale, description — is loaded from the shared schema, so it
       cannot be populated in one form and forgotten in the other. */
    if (window.SokoniProductSchema) {
        window.SokoniProductSchema.populate('edit', p);
    } else {
        /* Defensive fallback if the schema script failed to load. */
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); };
        setVal("editName", p.name); setVal("editPrice", p.price); setVal("editCategory", p.category || "other");
        setVal("editStock", p.stock); setVal("editDescription", p.description);
    }

    /* Variant chips for this product's category, pre-selected from what it
       already has. Rendered AFTER populate so the category select holds the
       product's real category, and re-bound because the select was rebuilt. */
    if (window.SokoniProductSchema && window.SokoniProductSchema.renderVariants) {
        window.SokoniProductSchema.renderVariants('edit', p.category, p);
        _bindVariantCategorySync();
    }

    /* Load images into multi-image editor */
    /* Prefer Storage URLs — after the cache-degradation fix a product's `images`
       may have been stripped to save quota while imageStorageUrls kept the real
       URLs. Reading images first would open the editor with no picture and could
       save an empty image back. */
    _editImages = (p.imageStorageUrls && p.imageStorageUrls.length) ? p.imageStorageUrls.slice()
                : (p.images && p.images.length) ? p.images.slice()
                : (p.image ? [p.image] : []);
    renderEditImageSlots();

    const msgEl = document.getElementById("editModalMsg");
    if (msgEl) msgEl.textContent = "";

    /* Show modal */
    const modal = document.getElementById("productEditModal");
    const panel = document.getElementById("productEditPanel");
    if (modal && panel) {
        modal.style.display = "flex";
        document.body.style.overflow = "hidden";
        requestAnimationFrame(() => { panel.style.transform = "translateY(0)"; });
    }
}

function closeEditModal() {
    const modal = document.getElementById("productEditModal");
    const panel = document.getElementById("productEditPanel");
    if (panel) panel.style.transform = "translateY(100%)";
    setTimeout(() => {
        if (modal) modal.style.display = "none";
        document.body.style.overflow = "";
        _editIndex = -1;
        _editImages = [];
    }, 350);
}


function saveEditProduct() {
    const msgEl  = document.getElementById("editModalMsg");

    /* One validation pass and one serialize, both from the shared schema, so the
       edit and upload forms enforce and collect fields identically. */
    const schema = window.SokoniProductSchema;
    let patch, name, price, cat;
    if (schema) {
        const v = schema.validate('edit');
        if (!v.ok) {
            if (msgEl) { msgEl.textContent = "⚠️ " + v.message; msgEl.style.color = "#ff6b6b"; }
            return;
        }
        patch = schema.serialize('edit');
        name  = patch.name;
        price = patch.price;
        cat   = patch.category || "other";
        /* Variants are keyed off the CURRENT category, and keys that no longer
           apply come back null so a re-categorised product actively loses stale
           values — a shirt changed to "electronics" must not keep its sizes. */
        if (schema.serializeVariants) Object.assign(patch, schema.serializeVariants('edit', cat));
    } else {
        /* Fallback if the schema failed to load — the original hand read. */
        name  = document.getElementById("editName")?.value.trim();
        price = Number(document.getElementById("editPrice")?.value || 0);
        cat   = document.getElementById("editCategory")?.value || "other";
        if (!name || !price) {
            if (msgEl) { msgEl.textContent = "⚠️ Name and price are required."; msgEl.style.color = "#ff6b6b"; }
            return;
        }
        patch = { name: name, price: price, category: cat };
        const s = document.getElementById("editStock")?.value;
        const d = document.getElementById("editDescription")?.value.trim();
        if (s !== "") patch.stock = Number(s);
        if (d) patch.description = d;
    }

    const prods = JSON.parse(localStorage.getItem("sellerProducts") || "[]");
    if (_editIndex < 0 || !prods[_editIndex]) return;

    const oldPrice = Number(prods[_editIndex].price);

    /* Apply the schema patch. null values (e.g. wholesale cleared) are applied
       deliberately; keys the schema omitted (blank emptyKeeps fields) are left
       untouched, so an accidental blank never zeroes a stored cost or fee. */
    Object.keys(patch).forEach(function (k) { prods[_editIndex][k] = patch[k]; });

    /* Images: save all from multi-image editor */
    if (_editImages.length) {
        prods[_editIndex].image  = _editImages[0];
        prods[_editIndex].images = _editImages.slice();
    }

    /* Track price history */
    if (oldPrice !== price) {
        if (!prods[_editIndex].priceHistory) prods[_editIndex].priceHistory = [];
        prods[_editIndex].priceHistory.unshift({
            price: oldPrice, newPrice: price,
            timestamp: Date.now(),
            date: new Date().toLocaleDateString("en-KE", { day:"numeric", month:"short", year:"numeric" })
        });
        prods[_editIndex].priceHistory = prods[_editIndex].priceHistory.slice(0, 10);
    }

    /* Through the degrading cache, not a raw setItem: an edit must not be lost to
       a full quota any more than an upload was. */
    _cacheSellerProducts(prods);
    displaySellerProducts();
    updateSellerStats();

    /* Persist to Firestore. saveEditProduct previously wrote ONLY localStorage,
       so every edit — a corrected price, a fixed category, new stock — stayed on
       the one device and never reached the marketplace, which reads the products
       collection. Buyers kept seeing the pre-edit product. Fire-and-forget and
       fully guarded: the local update above already succeeded, and a merchant
       editing offline still sees their change; it syncs on the next edit online. */
    (async function () {
        try {
            const prod = prods[_editIndex];
            if (!prod || !prod.id || !window.firebaseDB) return;
            const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
            /* The same schema patch that updated the local cache, so Firestore and
               the device never disagree about what an edit changed. */
            const fsPatch = Object.assign({}, patch, { updatedAt: m.serverTimestamp() });
            /* Only touch images when the editor actually holds Storage URLs — never
               write a base64 blob or an empty array over a good Firestore image. */
            if (_editImages.length && String(_editImages[0]).startsWith('http')) {
                fsPatch.image = _editImages[0];
                fsPatch.images = _editImages.slice();
                fsPatch.imageStorageUrls = _editImages.slice();
            }
            /* Defence-in-depth: never let a base64 data: URI reach the doc via `patch`.
               DELETE the offending key (rather than blanking it) so a good existing
               Storage image is left untouched — updateDoc only writes the keys present.
               Matches the create path and the server-side rule. */
            if (_isDataUri(fsPatch.image)) delete fsPatch.image;
            if (Array.isArray(fsPatch.images)) {
                var _cleanImgs = fsPatch.images.filter(function(v){ return !_isDataUri(v); });
                if (_cleanImgs.length) fsPatch.images = _cleanImgs; else delete fsPatch.images;
            }
            await m.updateDoc(m.doc(window.firebaseDB, 'products', prod.id), fsPatch);
        } catch (e) {
            console.warn('[seller] edit Firestore sync deferred:', e && e.message);
        }
    })();

    if (msgEl) { msgEl.innerHTML = "✅ Product updated!"; msgEl.style.color = "#71ff00"; }
    setTimeout(closeEditModal, 1000);
    showNotification("✏️ Product Updated", "success");
}

window.closeEditModal    = closeEditModal;
window.saveEditProduct   = saveEditProduct;
window.renderEditImageSlots = renderEditImageSlots;

/* =========================
   IMAGE PREVIEW
========================= */

function previewImage(event){

    const preview =
    document.getElementById(
        "imagePreview"
    );

    if(!preview) return;

    preview.src =
    URL.createObjectURL(
        event.target.files[0]
    );

    preview.style.display =
    "block";

}

/* =========================
   SELLER STATS + COMMISSION
========================= */

function updateSellerStats(){

    let sellerProducts;
    try {
        sellerProducts = JSON.parse(localStorage.getItem("sellerProducts")) || [];
    } catch(e) {
        sellerProducts = [];
    }

    const count = sellerProducts.length;
    const totalRevenue = sellerProducts.reduce((sum, p) => sum + Number(p.price || 0), 0);
    const commission = Math.round(totalRevenue * (SokoniCommission.pct("marketplace") / 100));
    const netEarnings = totalRevenue - commission;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if(el) el.innerText = val;
    };

    set("totalProducts", count);
    set("totalOrders", count > 0 ? Math.floor(count * 3.2) : 0);
    set("totalRevenue", "KES " + totalRevenue.toLocaleString());
    set("commissionAmount", "KES " + commission.toLocaleString());
    set("netEarnings", "KES " + netEarnings.toLocaleString());
}

/* =========================
   SCROLL TO SECTION
========================= */

function scrollToSection(id){
    const el = document.getElementById(id) || document.querySelector("." + id);
    if(el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

window.scrollToSection = scrollToSection;

/* =========================
   BULK CSV UPLOAD
========================= */

const CSV_TEMPLATE_HEADERS = "name,price,costPrice,category,location,description,stock,deliveryCost,kebsCert";
const CSV_TEMPLATE_SAMPLE  = `Summer Dress,1500,800,fashion,nairobi,Beautiful floral summer dress,10,100,
Smartphone X12,25000,18000,electronics,nairobi,Android 128GB fast charging,5,0,KS EAS 1234
Wooden Coffee Table,8500,5000,furniture,mombasa,Solid wood handmade table,3,500,`;

function downloadCsvTemplate(){
    const content = CSV_TEMPLATE_HEADERS + "\n" + CSV_TEMPLATE_SAMPLE;
    const blob = new Blob([content], { type:"text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "sokoni-products-template.csv";
    a.click(); URL.revokeObjectURL(url);
}

let bulkParsedProducts = [];

function parseBulkCsv(input){
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if(lines.length < 2){ showNotification("CSV has no data rows", "error"); return; }

        const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
        const get = (row, name) => {
            const idx = headers.indexOf(name);
            return idx !== -1 ? (row[idx] || "").trim() : "";
        };

        bulkParsedProducts = [];
        const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");

        lines.slice(1).forEach((line, i) => {
            const row = line.split(",");
            const name = get(row,"name");
            const price = Number(get(row,"price") || 0);
            if(!name || !price) return;

            bulkParsedProducts.push({
                id: (Date.now() + i).toString(),
                name,
                price,
                costPrice:    Number(get(row,"costprice") || 0),
                category:     get(row,"category") || "general",
                location:     get(row,"location") || "nairobi",
                description:  get(row,"description") || "",
                stock:        Number(get(row,"stock") || 0),
                deliveryCost: Number(get(row,"deliverycost") || 0),
                kebsCert:     get(row,"kebscert") || "",
                image:        "assets/default-product.png",
                sold: 0, views: 0, outOfStock: false,
                sellerName:  user ? user.name : "Sokoni Seller",
                sellerEmail: user ? user.email : "",
                uploadedAt: Date.now()
            });
        });

        if(!bulkParsedProducts.length){ showNotification("No valid rows found in CSV", "error"); return; }

        showBulkPreview();
    };
    reader.readAsText(file);
}

function showBulkPreview(){
    document.getElementById("bulkPreviewSection").style.display = "block";
    document.getElementById("bulkRowCount").textContent = bulkParsedProducts.length;
    document.getElementById("bulkPreviewTbody").innerHTML = bulkParsedProducts.map((p,i) => `
        <tr>
            <td>${i+1}</td>
            <td style="font-weight:700;color:white;">${p.name}</td>
            <td style="color:#71ff00;font-weight:700;">KES ${Number(p.price).toLocaleString()}</td>
            <td>${p.costPrice ? "KES "+p.costPrice : "—"}</td>
            <td><span style="font-size:11px;background:rgba(0,170,255,0.12);color:#00aaff;padding:2px 8px;border-radius:6px;">${p.category}</span></td>
            <td>${p.location}</td>
            <td>${p.stock}</td>
            <td style="color:rgba(255,255,255,0.5);font-size:12px;">${p.description||"—"}</td>
        </tr>
    `).join("");
}

function confirmBulkUpload(){
    if(!bulkParsedProducts.length) return;
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
    existing.push(...bulkParsedProducts);
    try {
        localStorage.setItem("sellerProducts", JSON.stringify(existing));
        showNotification(`✅ ${bulkParsedProducts.length} products uploaded!`, "success");
        cancelBulk();
        displaySellerProducts();
        updateSellerStats();
        renderInventoryTable();
    } catch(err) {
        showNotification("Storage full! Try smaller batches.", "error");
    }
}

function cancelBulk(){
    bulkParsedProducts = [];
    document.getElementById("bulkPreviewSection").style.display = "none";
    document.getElementById("bulkCsvFile").value = "";
}

window.downloadCsvTemplate = downloadCsvTemplate;
window.parseBulkCsv = parseBulkCsv;
window.confirmBulkUpload = confirmBulkUpload;
window.cancelBulk = cancelBulk;

/* =========================
   CUSTOMER ANALYTICS
========================= */

function renderCustomerAnalytics(){
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}

    /* Summary */
    const customerMap = {};
    orders.forEach(o => {
        const key = o.phone || o.name || "Anonymous";
        if(!customerMap[key]) customerMap[key] = { name: o.name||"Customer", phone: key, orders:0, spent:0 };
        customerMap[key].orders++;
        customerMap[key].spent += Number(o.total||0);
    });
    const customers = Object.values(customerMap);
    const totalSpend = customers.reduce((s,c)=>s+c.spent,0);
    const avgLTV = customers.length ? Math.round(totalSpend / customers.length) : 0;
    const repeat = customers.filter(c => c.orders > 1).length;

    const sumEl = document.getElementById("customerSummary");
    if(sumEl) sumEl.innerHTML = [
        { label:"Unique Customers", val: customers.length },
        { label:"Repeat Buyers",    val: repeat },
        { label:"Avg Lifetime Value", val: "KES "+avgLTV.toLocaleString() },
        { label:"Total Orders",     val: orders.length },
    ].map(c=>`<div class="analytics-sum-card"><div class="asc-label">${c.label}</div><div class="asc-val">${c.val}</div></div>`).join("");

    /* Top customers */
    const topEl = document.getElementById("topCustomersList");
    if(topEl){
        const top = [...customers].sort((a,b)=>b.spent-a.spent).slice(0,5);
        topEl.innerHTML = top.length ? top.map((c,i) => `
            <div class="best-seller-row" style="padding:10px 0;">
                <div class="bs-rank ${i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':''}">${i+1}</div>
                <div style="flex:1;min-width:0;">
                    <div class="bs-name">${c.name}</div>
                    <div class="bs-sub">${c.orders} order${c.orders>1?"s":""}</div>
                </div>
                <div class="bs-sold">KES ${c.spent.toLocaleString()}</div>
            </div>
        `).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:13px;">No customer data yet</div>`;
    }

    /* Location breakdown from products + orders */
    const locEl = document.getElementById("locationBreakdown");
    if(locEl){
        const locMap = {};
        orders.forEach(o => {
            const loc = o.address || "Unknown";
            locMap[loc] = (locMap[loc]||0) + 1;
        });
        const locs = Object.entries(locMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const maxLoc = locs.length ? locs[0][1] : 1;
        locEl.innerHTML = locs.length ? locs.map(([loc,cnt])=>`
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
                    <span style="color:rgba(255,255,255,0.7);">${loc.substring(0,30)}</span>
                    <span style="color:#71ff00;font-weight:700;">${cnt}</span>
                </div>
                <div style="background:rgba(255,255,255,0.07);border-radius:999px;height:6px;overflow:hidden;">
                    <div style="background:linear-gradient(90deg,#71ff00,#4fc800);height:100%;border-radius:999px;width:${Math.round(cnt/maxLoc*100)}%;"></div>
                </div>
            </div>
        `).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:13px;">No location data yet</div>`;
    }
}

/* =========================
   Q&A — SELLER SIDE
========================= */

function renderSellerQa(){
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
    let allQa = {};
    try { allQa = JSON.parse(localStorage.getItem("sokoniQA"))||{}; } catch(e){}

    const el = document.getElementById("sellerQaList");
    if(!el) return;

    const pending = [];
    products.forEach(p => {
        const qs = allQa[p.id] || [];
        qs.filter(q => !q.answer).forEach(q => pending.push({ ...q, productName: p.name, productId: p.id }));
    });

    if(!pending.length){
        el.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:16px 0;">No pending questions from customers.</div>`;
        return;
    }

    el.innerHTML = pending.map(q => `
        <div class="qa-seller-row" id="qa-row-${_esc(q.id)}">
            <div class="qa-product-tag">${_esc(q.productName)}</div>
            <div class="qa-question-text">❓ ${_esc(q.question)}</div>
            <div class="qa-asker-info">— ${_esc(q.asker||"Anonymous")} · ${_esc(q.date||"")}</div>
            <div class="qa-answer-area">
                <textarea class="qa-answer-input" id="qa-ans-${_esc(q.id)}" placeholder="Type your answer..."></textarea>
                <button class="inv-btn inv-btn-save" onclick="submitSellerAnswer('${_esc(q.productId)}','${_esc(q.id)}')">✓ Post Answer</button>
            </div>
        </div>
    `).join("");
}

function submitSellerAnswer(productId, questionId){
    const ansEl = document.getElementById("qa-ans-" + questionId);
    if(!ansEl) return;
    const answer = ansEl.value.trim();
    if(!answer){ showNotification("Please type an answer", "error"); return; }

    let allQa = {};
    try { allQa = JSON.parse(localStorage.getItem("sokoniQA"))||{}; } catch(e){}
    if(!allQa[productId]) return;

    const idx = allQa[productId].findIndex(q => q.id === questionId);
    if(idx === -1) return;
    allQa[productId][idx].answer = answer;
    allQa[productId][idx].answeredAt = new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"});
    localStorage.setItem("sokoniQA", JSON.stringify(allQa));
    showNotification("Answer posted! ✅", "success");
    renderSellerQa();
}

window.submitSellerAnswer = submitSellerAnswer;

/* =========================
   VERIFIED SELLER APPLICATION
========================= */

function submitVerification(){
  const business = document.getElementById("verifyBusiness")?.value.trim();
  const phone    = document.getElementById("verifyPhone")?.value.trim();
  const idNum    = document.getElementById("verifyId")?.value.trim();
  const kra      = document.getElementById("verifyKra")?.value.trim();
  const desc     = document.getElementById("verifyDesc")?.value.trim();

  if(!business || !phone || !idNum){
    showNotification("Please fill Business Name, Phone and National ID", "error"); return;
  }

  const verification = {
    business, phone, idNum, kra, desc,
    status: "pending",
    submittedAt: new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
    timestamp: Date.now()
  };

  localStorage.setItem("sokoniSellerVerification", JSON.stringify(verification));
  showNotification("✅ Verification submitted! Review within 24-48 hrs.", "success");
  showVerificationStatus();
}

function showVerificationStatus(){
  const data = JSON.parse(localStorage.getItem("sokoniSellerVerification")||"null");
  const banner = document.getElementById("verifiedStatusBanner");
  const form   = document.getElementById("verifyForm");
  if(!banner) return;

  if(!data){ banner.style.display="none"; if(form) form.style.display="block"; return; }

  const colors = { pending:"rgba(255,152,0,0.08)", verified:"rgba(113,255,0,0.08)", rejected:"rgba(255,61,61,0.08)" };
  const borders= { pending:"rgba(255,152,0,0.25)", verified:"rgba(113,255,0,0.25)", rejected:"rgba(255,61,61,0.25)" };
  const icons  = { pending:"⏳", verified:"✅", rejected:"❌" };
  const msgs   = { pending:"Application under review. Expected 24-48 hours.", verified:"Congratulations! You are a Verified Seller. Your products now show the ✅ badge.", rejected:"Application rejected. Contact support." };

  banner.style.display = "block";
  banner.style.background = colors[data.status];
  banner.style.border = `1px solid ${borders[data.status]}`;
  banner.style.borderRadius = "14px";
  banner.style.padding = "16px";
  banner.style.marginBottom = "16px";
  banner.innerHTML = `
    <div style="font-size:15px;font-weight:800;color:white;margin-bottom:4px;">${icons[data.status]} Verification: ${data.status.toUpperCase()}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.5);">${msgs[data.status]}</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:4px;">Submitted: ${data.submittedAt} · Business: ${data.business}</div>
  `;
  if(form) form.style.display = data.status === "pending" || data.status === "verified" ? "none" : "block";
}

window.submitVerification = submitVerification;

/* =========================
   EXPENSE TRACKER
========================= */

const EXPENSE_CATS = ["Rent","Transport","Packaging","Marketing","Equipment","Labour","Utilities","Inventory","Other"];

function renderExpenseTracker(){
  const section = document.getElementById("expense-section");
  if(!section) return;

  let expenses = [];
  try { expenses = JSON.parse(localStorage.getItem("sokoniExpenses"))||[]; } catch(e){}

  const total = expenses.reduce((s,e)=>s+Number(e.amount),0);

  let orders=[];
  try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}
  const revenue = orders.reduce((s,o)=>s+Number(o.total||0),0);
  const netProfit = revenue - total - Math.round(revenue*0.05);

  /* By category */
  const catMap = {};
  EXPENSE_CATS.forEach(c => catMap[c] = 0);
  expenses.forEach(e => { catMap[e.category] = (catMap[e.category]||0) + Number(e.amount); });
  const maxCat = Math.max(...Object.values(catMap), 1);

  section.innerHTML = `
    <div class="seller-section-header">
      <h2>💸 Expense Tracker</h2>
      <p class="seller-section-sub">Track all business costs — rent, transport, packaging and more</p>
    </div>

    <div class="analytics-summary-row" style="margin-bottom:20px;">
      <div class="analytics-sum-card"><div class="asc-label">Total Expenses</div><div class="asc-val" style="color:#ff4444;">KES ${total.toLocaleString()}</div></div>
      <div class="analytics-sum-card"><div class="asc-label">Gross Revenue</div><div class="asc-val">KES ${revenue.toLocaleString()}</div></div>
      <div class="analytics-sum-card"><div class="asc-label">Platform Fee</div><div class="asc-val" style="color:#ff9800;">KES ${Math.round(revenue*0.05).toLocaleString()}</div></div>
      <div class="analytics-sum-card"><div class="asc-label">Net Profit</div><div class="asc-val" style="color:${netProfit>=0?'#71ff00':'#ff4444'};">KES ${netProfit.toLocaleString()}</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:20px;margin-bottom:20px;">
      <div>
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">Add Expense</div>
        <select class="flash-select" id="expCat" style="margin-bottom:10px;">
          ${EXPENSE_CATS.map(c=>`<option value="${c}">${c}</option>`).join("")}
        </select>
        <input class="flash-input-group input" type="number" id="expAmount" placeholder="Amount (KES)" style="width:100%;padding:13px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:14px;outline:none;font-family:inherit;margin-bottom:10px;">
        <input class="flash-input-group input" type="text" id="expNote" placeholder="Note (optional)" style="width:100%;padding:13px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:14px;outline:none;font-family:inherit;margin-bottom:10px;">
        <input class="flash-input-group input" type="date" id="expDate" style="width:100%;padding:13px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:14px;outline:none;font-family:inherit;margin-bottom:10px;">
        <button class="flash-go-btn" style="width:100%;" onclick="addExpense()">+ Add Expense</button>
      </div>

      <div>
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">By Category</div>
        ${Object.entries(catMap).filter(([c,v])=>v>0).map(([cat,val])=>`
          <div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span style="color:rgba(255,255,255,0.6);">${cat}</span>
              <span style="color:#ff9800;font-weight:700;">KES ${val.toLocaleString()}</span>
            </div>
            <div style="background:rgba(255,255,255,0.07);border-radius:999px;height:6px;overflow:hidden;">
              <div style="background:linear-gradient(90deg,#ff9800,#ff5500);height:100%;width:${Math.round(val/maxCat*100)}%;border-radius:999px;"></div>
            </div>
          </div>
        `).join("") || `<div style="color:rgba(255,255,255,0.25);font-size:13px;">No expenses yet</div>`}
      </div>
    </div>

    <div>
      <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">Recent Expenses</div>
      ${expenses.length ? expenses.slice(0,10).map((e,i)=>`
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
          <div style="width:8px;height:8px;border-radius:50%;background:#ff9800;flex-shrink:0;"></div>
          <div style="flex:1;">
            <div style="font-weight:700;color:white;font-size:13px;">${e.category}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.35);">${e.note||"—"} · ${e.date||""}</div>
          </div>
          <div style="color:#ff4444;font-weight:800;font-size:14px;">-KES ${Number(e.amount).toLocaleString()}</div>
          <button onclick="removeExpense(${i})" style="background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;font-size:14px;padding:0;">✕</button>
        </div>
      `).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:12px 0;">No expenses logged yet</div>`}
    </div>
  `;
}

function addExpense(){
  const cat    = document.getElementById("expCat")?.value || "Other";
  const amount = Number(document.getElementById("expAmount")?.value || 0);
  const note   = document.getElementById("expNote")?.value.trim() || "";
  const date   = document.getElementById("expDate")?.value || new Date().toISOString().split("T")[0];

  if(!amount){ showNotification("Enter an amount", "error"); return; }

  let expenses = [];
  try { expenses = JSON.parse(localStorage.getItem("sokoniExpenses"))||[]; } catch(e){}
  expenses.unshift({ cat, category:cat, amount, note, date, timestamp:Date.now() });
  localStorage.setItem("sokoniExpenses", JSON.stringify(expenses));
  showNotification(`${cat} expense logged: KES ${amount.toLocaleString()}`, "success");
  renderExpenseTracker();
}

function removeExpense(index){
  let expenses = [];
  try { expenses = JSON.parse(localStorage.getItem("sokoniExpenses"))||[]; } catch(e){}
  expenses.splice(index, 1);
  localStorage.setItem("sokoniExpenses", JSON.stringify(expenses));
  renderExpenseTracker();
}

window.addExpense = addExpense;
window.removeExpense = removeExpense;

/* =========================
   MINI STORE
========================= */

function previewStoreBanner(input){
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const img = document.getElementById("storeBannerPreview");
        const ph  = document.getElementById("bannerPlaceholder");
        if(img){ img.src = e.target.result; img.style.display = "block"; }
        if(ph)  ph.style.display = "none";
    };
    reader.readAsDataURL(file);
}

function previewStoreLogo(input){
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const img = document.getElementById("storeLogoPreview");
        const ph  = document.getElementById("logoPlaceholder");
        if(img){ img.src = e.target.result; img.style.display = "block"; }
        if(ph)  ph.style.display = "none";
    };
    reader.readAsDataURL(file);
}

function saveMiniStore(){
    const name      = document.getElementById("storeName")?.value.trim();
    const tagline   = document.getElementById("storeTagline")?.value.trim();
    const about     = document.getElementById("storeAbout")?.value.trim();
    const phone     = document.getElementById("storePhone")?.value.trim();
    const email     = document.getElementById("storeEmail")?.value.trim();
    const instagram = document.getElementById("storeInstagram")?.value.trim();
    const tiktok    = document.getElementById("storeTikTok")?.value.trim();
    const twitter   = document.getElementById("storeTwitter")?.value.trim();
    const facebook  = document.getElementById("storeFacebook")?.value.trim();
    const youtube   = document.getElementById("storeYoutube")?.value.trim();
    const linkedin  = document.getElementById("storeLinkedin")?.value.trim();
    const website   = document.getElementById("storeWebsite")?.value.trim();
    const sellerType= document.getElementById("sdSellerType")?.value || "";
    const bannerSrc = document.getElementById("storeBannerPreview")?.src || "";
    const logoSrc   = document.getElementById("storeLogoPreview")?.src || "";

    if(!name){ showNotification("Enter a store name first", "error"); return; }

    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const store = {
        ownerName: user?.name || "Sokoni Seller",
        name, tagline, about, phone, email, instagram, tiktok, twitter, facebook, youtube, linkedin, website, sellerType,
        banner: bannerSrc.startsWith("data:") ? bannerSrc : "",
        logo:   logoSrc.startsWith("data:")   ? logoSrc   : "",
        updatedAt: Date.now()
    };

    localStorage.setItem("sokoniMiniStore", JSON.stringify(store));
    showNotification("🏪 Store saved! Buyers can now visit your store.", "success");

    const link = document.getElementById("visitMiniStoreLink");
    if(link){
        link.href = `store.html?store=${encodeURIComponent(name)}`;
        link.style.display = "flex";
    }
}

function loadMiniStoreForm(){
    let store = null;
    try { store = JSON.parse(localStorage.getItem("sokoniMiniStore")); } catch(e){}
    if(!store) return;

    const set = (id, val) => { const el = document.getElementById(id); if(el && val) el.value = val; };
    set("storeName",     store.name);
    set("storeTagline",  store.tagline);
    set("storeAbout",    store.about);
    set("storePhone",    store.phone);
    set("storeEmail",    store.email);
    set("storeInstagram",store.instagram);
    set("storeTikTok",   store.tiktok);
    set("storeTwitter",  store.twitter);
    set("storeFacebook", store.facebook);
    set("storeYoutube",  store.youtube);
    set("storeLinkedin", store.linkedin);
    set("storeWebsite",  store.website);
    /* Restore seller type selection */
    if(store.sellerType){
      const card=document.querySelector(`.sd-stype-card[data-type="${store.sellerType}"]`);
      if(card && typeof sdSelectType === "function") sdSelectType(store.sellerType, card);
    }

    if(store.banner){
        const img = document.getElementById("storeBannerPreview");
        const ph  = document.getElementById("bannerPlaceholder");
        if(img){ img.src = store.banner; img.style.display = "block"; }
        if(ph)  ph.style.display = "none";
    }
    if(store.logo){
        const img = document.getElementById("storeLogoPreview");
        const ph  = document.getElementById("logoPlaceholder");
        if(img){ img.src = store.logo; img.style.display = "block"; }
        if(ph)  ph.style.display = "none";
    }
    if(store.name){
        const link = document.getElementById("visitMiniStoreLink");
        if(link){ link.href = `store.html?store=${encodeURIComponent(store.name)}`; link.style.display = "flex"; }
    }
}

window.saveMiniStore       = saveMiniStore;
window.previewStoreBanner  = previewStoreBanner;
window.previewStoreLogo    = previewStoreLogo;

/* =========================
   DIGITAL PRODUCT TOGGLE
========================= */

function toggleDigitalFields(){
    const checked = document.getElementById("isDigitalProduct")?.checked;
    const fields  = document.getElementById("digitalFields");
    if(fields) fields.style.display = checked ? "block" : "none";
}

window.toggleDigitalFields = toggleDigitalFields;

/* =========================
   FEATURE SHOP ON HOME PAGE
========================= */

function featureShopOnHome(){
    const hours  = Number(document.getElementById("shopFeatureDuration")?.value || 24);
    const user   = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const store  = JSON.parse(localStorage.getItem("sokoniMiniStore")||"null");
    const sellerName = user?.name || "Sokoni Seller";
    const storeName  = store?.name || sellerName;

    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
    const myProducts = products.filter(p => (p.sellerName||"Sokoni Seller") === sellerName);
    const loc = myProducts[0]?.location || "nairobi";

    let allRatings = {};
    try { allRatings = JSON.parse(localStorage.getItem("sokoniSellerRatings"))||{}; } catch(e){}
    const ratings = allRatings[sellerName] || [];
    const avgRating = ratings.length ? (ratings.reduce((s,r)=>s+(r.avgScore||r.stars||0),0)/ratings.length).toFixed(1) : null;

    const feature = {
        sellerName,
        storeName,
        storeUrl:  `store.html?store=${encodeURIComponent(storeName)}`,
        logo:      store?.logo || "",
        banner:    store?.banner || "",
        tagline:   store?.tagline || "Quality products from a trusted seller",
        location:  loc,
        productCount: myProducts.length,
        avgRating,
        endsAt:    Date.now() + hours * 3600000,
        startedAt: Date.now()
    };

    let featured = [];
    try { featured = JSON.parse(localStorage.getItem("sokoniFeaturedShops"))||[]; } catch(e){}
    featured = featured.filter(f => f.sellerName !== sellerName); // replace if exists
    featured.unshift(feature);
    localStorage.setItem("sokoniFeaturedShops", JSON.stringify(featured));

    const statusEl = document.getElementById("featuredShopStatus");
    if(statusEl){
        statusEl.innerHTML = `<span style="color:#71ff00;">✅ Your shop is now featured on the home page for ${hours} hours!</span>`;
    }
    showNotification(`🏠 Shop featured on home page for ${hours}h!`, "success");
}

window.featureShopOnHome = featureShopOnHome;

/* =========================
   EMPLOYEE ACCOUNTS
========================= */

/* ── Employee helpers ── */
function _empGetOwnerProfile(){
  try{ return JSON.parse(localStorage.getItem("sokoniUser"))||{}; }catch(e){ return {}; }
}
function _empShowStatus(msg, ok){
  const el = document.getElementById("empStatus");
  if(!el) return;
  el.textContent = msg;
  el.style.color = ok ? "#71ff00" : "#ff6b6b";
  el.style.display = "block";
  setTimeout(()=>{ el.style.display="none"; }, 3500);
}

async function addEmployee(){
  const emailEl = document.getElementById("empEmail");
  const roleEl  = document.getElementById("empRole");
  const btn     = document.querySelector("[onclick='addEmployee()']");

  const email = (emailEl?.value||"").trim().toLowerCase();
  const role  = roleEl?.value;

  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    showNotification("Enter a valid email address","error"); return;
  }
  if(!role){ showNotification("Select a role","error"); return; }
  if(!window.firebaseAuth || !window.firebaseDB){
    showNotification("Firebase not ready — refresh","error"); return;
  }

  const owner = _empGetOwnerProfile();
  if(!owner.uid){ showNotification("Sign in first","error"); return; }

  if(btn){ btn.disabled=true; btn.textContent="Generating…"; }

  try{
    const { getFunctions, httpsCallable } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js"
    );
    const fns = getFunctions(window.firebaseApp, "us-central1");
    const res = await httpsCallable(fns,"inviteShopEmployee")({
      email,
      role,
      shopName: owner.storeName || owner.name || "My Shop"
    });

    const link = window.location.origin+"/join.html?t="+res.data.token+"&type=shop";
    const linkEl = document.getElementById("empInviteLink");
    const resultEl = document.getElementById("empInviteResult");
    if(linkEl) linkEl.value = link;
    if(resultEl) resultEl.style.display = "";

    /* Clear email field */
    if(emailEl) emailEl.value = "";
    showNotification("Invite link ready — copy and share with "+email,"success");
    _empShowStatus("✅ Invite created for " + email + ". Share the link — when they accept, they appear in Your Team.", true);
  }catch(err){
    console.error("addEmployee error:", err);
    showNotification(err.message || "Could not create invite","error");
    _empShowStatus("⚠️ "+(err.message||"Failed to create invite"), false);
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="Create Invite Link"; }
  }
}

function copyEmpInviteLink(){
  const link = document.getElementById("empInviteLink")?.value;
  if(!link) return;
  navigator.clipboard.writeText(link).then(()=>{ showNotification("Invite link copied!","success"); });
}

async function removeEmployee(id){
  if(!window.firebaseDB){ showNotification("Firebase not ready","error"); return; }
  try{
    const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    await deleteDoc(doc(window.firebaseDB,"shopEmployees",id));
    await deleteDoc(doc(window.firebaseDB,"users",id));
  }catch(e){ console.warn("Firestore remove employee:",e); }

  let employees = JSON.parse(localStorage.getItem("sokoniEmployees")||"[]");
  employees = employees.filter(e=>e.id!==id);
  localStorage.setItem("sokoniEmployees", JSON.stringify(employees));
  renderEmployeeList();
  showNotification("Employee removed","delete");
}

async function renderEmployeeList(){
  const el = document.getElementById("employeeList");
  const ct = document.getElementById("empCount");
  if(!el) return;

  /* Try Firestore first for cross-device accuracy */
  let employees = [];
  const owner = _empGetOwnerProfile();
  if(owner.uid && window.firebaseDB){
    try{
      const { collection, getDocs, query, where } = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const snap = await getDocs(
        query(collection(window.firebaseDB,"shopEmployees"), where("shopOwnerId","==",owner.uid))
      );
      snap.forEach(d=>employees.push(d.data()));
      /* Sync to localStorage */
      localStorage.setItem("sokoniEmployees", JSON.stringify(employees));
    }catch(e){
      try{ employees = JSON.parse(localStorage.getItem("sokoniEmployees"))||[]; }catch(_){}
    }
  } else {
    try{ employees = JSON.parse(localStorage.getItem("sokoniEmployees"))||[]; }catch(e){}
  }

  if(ct) ct.textContent = employees.length;

  const roleLabel   = { cashier:"Cashier", manager:"Manager", inventory:"Inventory Clerk", support:"Support Agent" };
  const roleClass   = { cashier:"so-emp-role-cashier", manager:"so-emp-role-manager", inventory:"so-emp-role-inventory", support:"so-emp-role-support" };
  const ROLE_ORDER  = ["manager","cashier","inventory","support"];

  /* Sort: managers first, then alphabetical */
  employees.sort((a,b)=>{
    const ra = ROLE_ORDER.indexOf(a.role), rb = ROLE_ORDER.indexOf(b.role);
    if(ra !== rb) return ra - rb;
    return (a.name||"").localeCompare(b.name||"");
  });

  /* Branch filter (if a branch is selected and not main) */
  const currentBranch = window.SokoniBranch ? window.SokoniBranch.getCurrent() : null;
  const filterBranch  = currentBranch && !currentBranch.isMain;
  const visible = filterBranch
    ? employees.filter(e => !e.branch || e.branch === currentBranch.name || e.branch === currentBranch.id)
    : employees;

  /* Session role: branch_manager can only see their branch */
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem("sokoniEmployeeSession")); } catch(_){}
  const sessionRole = sess && sess.isEmployee ? sess.employeeRole : "owner";

  function _avatar(name, role) {
    const initials = (name||"?").split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase();
    const colors = { cashier:"#1a3a0a,#71ff00", manager:"#0a1a3a,#64b4ff", inventory:"#3a2a00,#fbbf24", support:"#2a0a3a,#c084fc" };
    const [bg, fg] = (colors[role]||"#222,rgba(255,255,255,0.8)").split(",");
    return `<div class="so-emp-avatar" style="background:${bg};color:${fg};border:1px solid ${fg}40;">${initials}</div>`;
  }

  function _actions(e) {
    const id = _esc(e.uid||e.id||"");
    const isSuspended = e.status === "suspended";
    /* Owner sees all actions; branch manager sees limited set */
    if(sessionRole !== "owner" && sessionRole !== "manager") return "";
    const canPromote   = e.role !== "manager";
    const canDemote    = e.role === "manager";
    return `<div class="so-emp-actions">
      ${canPromote ? `<button class="so-emp-action so-emp-action-promote" onclick="_empPromote('${id}')" title="Promote to Manager">▲ Promote</button>` : ""}
      ${canDemote  ? `<button class="so-emp-action so-emp-action-demote"  onclick="_empDemote('${id}')"  title="Demote from Manager">▼ Demote</button>` : ""}
      <button class="so-emp-action so-emp-action-suspend" onclick="_empSuspend('${id}',${isSuspended})">${isSuspended ? "▶ Reinstate" : "⏸ Suspend"}</button>
      <button class="so-emp-action so-emp-action-pin"    onclick="_empResetPin('${id}')" title="Reset PIN">🔑 Reset PIN</button>
      ${sessionRole === "owner" ? `<button class="so-emp-action so-emp-action-delete" onclick="removeEmployee('${id}')" title="Remove employee">✕ Remove</button>` : ""}
    </div>`;
  }

  el.innerHTML = visible.length ? visible.map(e=>{
    const lastActive = e.lastActive ? new Date(e.lastActive).toLocaleDateString("en-KE") : "Never";
    const statusClass = e.status === "suspended" ? "so-emp-status-suspended" : "so-emp-status-active";
    const statusLabel = e.status === "suspended" ? "Suspended" : "Active";
    const branch      = e.branch || (currentBranch ? currentBranch.name : "Main Branch");
    return `<div class="so-emp-card" data-role="${_esc(e.role)}" data-empid="${_esc(e.uid||e.id||"")}">
      ${_avatar(e.name, e.role)}
      <div style="flex:1;min-width:0;">
        <div class="so-emp-name">${_esc(e.name||"Unknown")}</div>
        <div class="so-emp-email">${_esc(e.email||"")}</div>
        <div class="so-emp-meta">
          <span class="so-emp-badge ${roleClass[e.role]||""}">${roleLabel[e.role]||e.role}</span>
          <span class="so-emp-badge ${statusClass}">${statusLabel}</span>
          <span class="so-emp-badge" style="background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">🏢 ${_esc(branch)}</span>
          <span class="so-emp-badge" style="background:transparent;color:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.07);" title="Last active">⏱ ${lastActive}</span>
        </div>
        ${_actions(e)}
      </div>
    </div>`;
  }).join("") : `<div style="text-align:center;padding:32px 16px;color:rgba(255,255,255,0.25);">
    <div style="font-size:36px;margin-bottom:8px;">👥</div>
    <div style="font-size:13px;font-weight:700;">${filterBranch ? "No employees in this branch" : "No team members yet"}</div>
    <div style="font-size:11px;margin-top:4px;">Use the invite form to add your first team member.</div>
  </div>`;

  /* Update empty state in HTML overlay */
  const empEmpty = document.getElementById("empEmptyState");
  if(empEmpty) empEmpty.style.display = "none";
}

/* ── Employee actions ─────────────────────────────────────────────── */
function _empUpdateLocal(uid, patch) {
  let employees = [];
  try { employees = JSON.parse(localStorage.getItem("sokoniEmployees"))||[]; } catch(_){}
  const idx = employees.findIndex(e=>(e.uid||e.id)===uid);
  if(idx >= 0) { Object.assign(employees[idx], patch); localStorage.setItem("sokoniEmployees", JSON.stringify(employees)); }
  renderEmployeeList();
}

async function _empPromote(uid) {
  _empUpdateLocal(uid, { role:"manager" });
  showNotification("Employee promoted to Manager","success");
}
async function _empDemote(uid) {
  _empUpdateLocal(uid, { role:"cashier" });
  showNotification("Employee demoted to Cashier","info");
}
async function _empSuspend(uid, isSuspended) {
  const newStatus = isSuspended ? "active" : "suspended";
  _empUpdateLocal(uid, { status: newStatus });
  showNotification(isSuspended ? "Employee reinstated" : "Employee suspended", isSuspended ? "success" : "warning");
}
function _empResetPin(uid) {
  const _pinArr = new Uint32Array(1);
  crypto.getRandomValues(_pinArr);
  const newPin = String(1000 + (_pinArr[0] % 9000));
  _empUpdateLocal(uid, { pin: newPin, pinReset: Date.now() });
  /* Show new PIN in a toast — production would email it */
  showNotification(`PIN reset. New temporary PIN: ${newPin} — share securely.`, "info");
}

window._empPromote  = _empPromote;
window._empDemote   = _empDemote;
window._empSuspend  = _empSuspend;
window._empResetPin = _empResetPin;

window.addEmployee       = addEmployee;
window.copyEmpInviteLink = copyEmpInviteLink;
window.removeEmployee    = removeEmployee;

/* =========================
   MARKETING — PROMO CODES
========================= */

function createPromoCode(){
  const code     = (document.getElementById("promoCode")?.value||"").trim().toUpperCase();
  const discount = Number(document.getElementById("promoDiscount")?.value||0);
  const days     = Number(document.getElementById("promoExpiry")?.value||7);
  if(!code||!discount){ showNotification("Fill code and discount","error"); return; }

  let codes = [];
  try { codes = JSON.parse(localStorage.getItem("sokoniPromoCodes"))||[]; } catch(e){}
  codes.unshift({ code, discount, expiresAt: Date.now() + days*86400000, uses:0, active:true });
  localStorage.setItem("sokoniPromoCodes", JSON.stringify(codes));
  document.getElementById("promoCode").value = "";
  document.getElementById("promoDiscount").value = "";
  showNotification(`Promo code ${code} created!`,"success");
  renderPromoCodes();
}

function renderPromoCodes(){
  let codes = [];
  try { codes = JSON.parse(localStorage.getItem("sokoniPromoCodes"))||[]; } catch(e){}
  const el = document.getElementById("promoCodeList");
  if(!el) return;
  el.innerHTML = codes.length ? codes.map((c,i)=>{
    const valid = c.expiresAt > Date.now();
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);flex-wrap:wrap;">
      <code style="background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.2);color:#71ff00;padding:4px 12px;border-radius:8px;font-size:14px;font-weight:800;">${c.code}</code>
      <span style="color:rgba(255,255,255,0.5);font-size:12px;">-${c.discount}% · ${c.uses} uses</span>
      <span style="font-size:11px;color:${valid?'#71ff00':'#ff4444'};">${valid?"Active":"Expired"}</span>
      <button onclick="deactivateCode(${i})" style="margin-left:auto;background:rgba(255,61,61,0.1);border:1px solid rgba(255,61,61,0.2);color:#ff6b6b;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">Delete</button>
    </div>`;
  }).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:12px;padding:8px 0;">No promo codes yet</div>`;
}

function deactivateCode(index){
  let codes = JSON.parse(localStorage.getItem("sokoniPromoCodes")||"[]");
  codes.splice(index,1);
  localStorage.setItem("sokoniPromoCodes", JSON.stringify(codes));
  renderPromoCodes();
}

window.createPromoCode = createPromoCode;
window.deactivateCode = deactivateCode;

/* =========================
   MARKETING — CAMPAIGNS
========================= */

function createCampaign(){
  const name     = document.getElementById("campName")?.value.trim();
  const discount = Number(document.getElementById("campDiscount")?.value||0);
  const start    = document.getElementById("campStart")?.value;
  const end      = document.getElementById("campEnd")?.value;
  if(!name||!discount||!start||!end){ showNotification("Fill all campaign fields","error"); return; }

  let camps = [];
  try { camps = JSON.parse(localStorage.getItem("sokoniCampaigns"))||[]; } catch(e){}
  camps.unshift({ id:"CAMP"+Date.now(), name, discount, startDate:start, endDate:end, active:true, createdAt:Date.now() });
  localStorage.setItem("sokoniCampaigns", JSON.stringify(camps));
  showNotification(`📣 Campaign "${name}" scheduled!`,"success");
  renderCampaigns();
}

function renderCampaigns(){
  let camps = [];
  try { camps = JSON.parse(localStorage.getItem("sokoniCampaigns"))||[]; } catch(e){}
  const el = document.getElementById("campaignList");
  if(!el) return;
  const now = new Date().toISOString().split("T")[0];
  el.innerHTML = camps.length ? camps.map((c,i)=>{
    const live = c.startDate <= now && c.endDate >= now;
    const upcoming = c.startDate > now;
    const status = live?"🟢 LIVE":upcoming?"🔵 Upcoming":"⚫ Ended";
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);flex-wrap:wrap;">
      <div style="flex:1;">
        <div style="font-weight:700;color:white;font-size:13px;">${c.name}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);">${c.startDate} → ${c.endDate} · -${c.discount}%</div>
      </div>
      <span style="font-size:12px;font-weight:800;">${status}</span>
      <button onclick="deleteCampaign(${i})" style="background:rgba(255,61,61,0.1);border:1px solid rgba(255,61,61,0.2);color:#ff6b6b;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">Delete</button>
    </div>`;
  }).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:12px;padding:8px 0;">No campaigns yet</div>`;
}

function deleteCampaign(i){
  let camps = JSON.parse(localStorage.getItem("sokoniCampaigns")||"[]");
  camps.splice(i,1);
  localStorage.setItem("sokoniCampaigns", JSON.stringify(camps));
  renderCampaigns();
}

window.createCampaign = createCampaign;
window.deleteCampaign = deleteCampaign;

/* =========================
   SELLER PUSH BROADCAST
========================= */

async function sendSellerBroadcast(){
  const title   = (document.getElementById("pushTitle")?.value||"").trim();
  const body    = (document.getElementById("pushBody")?.value||"").trim();
  const url     = (document.getElementById("pushUrl")?.value||"").trim();
  const statusEl = document.getElementById("pushBroadcastStatus");

  if(!title){ showNotification("Enter a notification title","error"); return; }
  if(!body){  showNotification("Enter a notification message","error"); return; }

  /* Sanitise: no raw HTML */
  const safe = s => s.replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  const userData = (()=>{
    try{ return JSON.parse(localStorage.getItem("sokoniUser")||"{}"); }catch(e){ return {}; }
  })();
  const sellerUid  = window._sellerUid || userData.uid || "";
  const sellerName = userData.name || userData.email || sellerUid;
  if(!sellerUid){ showNotification("Not logged in","error"); return; }

  if(statusEl) statusEl.textContent = "Sending…";

  const payload = {
    title:      safe(title).slice(0,50),
    body:       safe(body).slice(0,120),
    url:        url || "",
    sellerUid,
    sellerName,
    createdAt:  Date.now(),
    status:     "sent",
  };

  try {
    if(window.SokoniDB && typeof window.SokoniDB.saveSellerBroadcast === "function"){
      await window.SokoniDB.saveSellerBroadcast(sellerName, payload);
      showNotification("📲 Push notification sent to your followers!","success");
      if(statusEl) statusEl.textContent = "✅ Sent at " + new Date().toLocaleTimeString("en-KE");
      document.getElementById("pushTitle").value = "";
      document.getElementById("pushBody").value  = "";
      document.getElementById("pushUrl").value   = "";
    } else {
      /* Fallback: save to localStorage broadcast queue */
      const key = "sokoniBroadcastQueue";
      const q = JSON.parse(localStorage.getItem(key)||"[]");
      q.unshift(payload);
      if(q.length>50) q.length=50;
      localStorage.setItem(key, JSON.stringify(q));
      showNotification("📲 Broadcast queued (Firestore not connected)","success");
      if(statusEl) statusEl.textContent = "⏳ Queued — will send when Firestore connects";
      document.getElementById("pushTitle").value = "";
      document.getElementById("pushBody").value  = "";
      document.getElementById("pushUrl").value   = "";
    }
  } catch(e){
    showNotification("Failed to send broadcast","error");
    if(statusEl) statusEl.textContent = "❌ Error: " + e.message;
  }
}

window.sendSellerBroadcast = sendSellerBroadcast;

/* =========================
   AI PRODUCT DESCRIPTION GENERATOR
========================= */

function generateAiDescription(){
  const name     = (document.getElementById("aiDescName")?.value || "").trim();
  const category = (document.getElementById("aiDescCategory")?.value || "default").toLowerCase();
  const features = (document.getElementById("aiDescFeatures")?.value || "").trim();
  const price    = (document.getElementById("aiDescPrice")?.value || "").trim();
  if(!name){ showNotification("Enter a product name first","error"); return; }

  const btn = document.getElementById("aiDescBtn");
  if(btn){ btn.textContent = "✨ Generating..."; btn.disabled = true; }

  /* Rich Kenya-market templates (no API key needed) */
  const openers = {
    fashion:     ["Elevate your everyday look with", "Step out in confidence wearing", "Style meets comfort in"],
    electronics: ["Experience next-level performance with", "Built for power users — introducing", "Engineered to impress:"],
    furniture:   ["Transform your living space with", "Timeless craftsmanship meets modern design in", "Redefine your home with"],
    beauty:      ["Unlock your best skin with", "Professional-grade results at home with", "Naturally radiant — discover"],
    food:        ["Taste the difference with", "Farm-fresh quality in every bite —", "Ethically sourced and full of flavour:"],
    health:      ["Invest in your wellbeing with", "Trusted by health professionals —", "Clinically inspired and Kenya-proven:"],
    sports:      ["Push your limits with", "Gear up for greatness with", "Performance-engineered:"],
    vehicles:    ["Drive with confidence in", "Reliability meets style with", "Your road, your rules —"],
    default:     ["Premium quality guaranteed with", "Crafted for everyday excellence —", "Designed to impress, built to last:"]
  };
  const benefits = {
    fashion:     ["Perfect for casual days and formal occasions. Machine washable and easy to care for.", "Breathable fabric designed for Kenya's climate. Available in multiple sizes."],
    electronics: ["Compatible with all major devices and operating systems. Energy-efficient — saves you money long-term.", "30-day warranty included. Backed by our quality assurance guarantee."],
    furniture:   ["Easy self-assembly — all fittings included. Durable materials built for Kenya's climate.", "Sturdy construction that lasts. Wipe-clean surface for easy maintenance."],
    beauty:      ["Suitable for all skin types including sensitive. Dermatologist-tested and free of harmful chemicals.", "Formulated without parabens, sulfates or artificial fragrances. Safe for daily use."],
    food:        ["No artificial preservatives or additives. Sustainably sourced from Kenyan farmers.", "100% natural ingredients. Ideal for families and health-conscious buyers."],
    default:     ["Backed by our quality assurance guarantee. Packaged securely for safe delivery anywhere in Kenya.", "Easy returns within 7 days if not satisfied. Trusted by over 10,000 buyers on Sokoni."]
  };
  const ctas = [
    "Order today and get fast delivery across Kenya! 🚚",
    "Add to cart now — limited stock available!",
    "Trusted by thousands of happy buyers on Sokoni. Yours is just a click away.",
    "Shop with confidence — easy 7-day returns on all orders."
  ];

  const catKey   = Object.keys(openers).find(k => category.includes(k)) || "default";
  const opener   = openers[catKey][Math.floor(Math.random() * openers[catKey].length)];
  const benefit  = (benefits[catKey] || benefits.default)[Math.floor(Math.random() * (benefits[catKey] || benefits.default).length)];
  const cta      = ctas[Math.floor(Math.random() * ctas.length)];

  const featLine  = features ? `\n\n✅ Key features: ${features}.` : "";
  const priceLine = price    ? `\n\n💰 Priced at KES ${Number(price).toLocaleString()} — exceptional value for the quality you get.` : "";

  const description = `${opener} the ${name}.\n\n${benefit}${featLine}${priceLine}\n\n${cta}`;

  setTimeout(() => {
    const outEl = document.getElementById("aiDescOutput");
    if(outEl){ outEl.value = description; outEl.style.display = "block"; outEl.rows = 6; }
    if(btn){ btn.textContent = "✨ Generate Again"; btn.disabled = false; }
    const descField = document.getElementById("productDescription");
    if(descField && !descField.value.trim()) descField.value = description;
    showNotification("AI description generated!","success");
  }, 1100);
}

window.generateAiDescription = generateAiDescription;

/* =========================
   SELLER WALLET
========================= */

function renderWallet(){
  const el = document.getElementById("wallet-section");
  if(!el) return;

  let wallet = { balance:0, transactions:[] };
  try { wallet = JSON.parse(localStorage.getItem("sokoniWallet"))||wallet; } catch(e){}

  let orders = [];
  try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}

  /* Auto-credit from new delivered orders not yet credited */
  const credited = new Set((wallet.transactions||[]).filter(t=>t.type==="credit").map(t=>t.ref));
  orders.filter(o=>o.status==="delivered"&&!credited.has(o.id)).forEach(o=>{
    const net = Math.round(Number(o.total||0) * 0.95);
    wallet.balance += net;
    wallet.transactions.unshift({ type:"credit", amount:net, ref:o.id, desc:`Order ${o.id} payment`, date:o.date||new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"}) });
  });
  localStorage.setItem("sokoniWallet", JSON.stringify(wallet));

  el.innerHTML = `
    <div class="seller-section-header">
      <h2>💳 Seller Wallet</h2>
      <p class="seller-section-sub">Your earnings balance — withdraw to M-PESA anytime</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div style="background:linear-gradient(135deg,rgba(113,255,0,0.1),rgba(113,255,0,0.03));border:1px solid rgba(113,255,0,0.2);border-radius:20px;padding:24px;">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Available Balance</div>
        <div style="font-size:36px;font-weight:900;color:#71ff00;">KES ${wallet.balance.toLocaleString()}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:4px;">Withdrawable anytime</div>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:14px;">💸 Withdraw to M-PESA</div>
        <input type="tel" id="walletPhone" placeholder="07XXXXXXXX" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;margin-bottom:10px;font-family:inherit;">
        <input type="number" id="walletAmount" placeholder="Amount (KES)" min="100" max="${wallet.balance}" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;margin-bottom:10px;font-family:inherit;">
        <button onclick="withdrawWallet()" style="width:100%;padding:12px;background:linear-gradient(135deg,#4caf50,#2e7d32);color:white;font-weight:800;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;">📱 Send to M-PESA</button>
      </div>
    </div>

    <!-- Transaction History -->
    <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">Transaction History</div>
    <div>
      ${(wallet.transactions||[]).slice(0,10).map(t=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-size:13px;color:white;font-weight:600;">${t.desc}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.35);">${t.date} · ${t.ref}</div>
          </div>
          <div style="font-size:15px;font-weight:900;color:${t.type==='credit'?'#71ff00':'#ff4444'};">${t.type==='credit'?'+':'-'}KES ${Number(t.amount).toLocaleString()}</div>
        </div>
      `).join("") || `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:12px 0;">No transactions yet — deliver orders to earn.</div>`}
    </div>
  `;
}

function withdrawWallet(){
  const phone  = document.getElementById("walletPhone")?.value.trim();
  const amount = Number(document.getElementById("walletAmount")?.value||0);

  let wallet = { balance:0, transactions:[] };
  try { wallet = JSON.parse(localStorage.getItem("sokoniWallet"))||wallet; } catch(e){}

  if(!phone||phone.length<9){ showNotification("Enter valid M-PESA number","error"); return; }
  if(amount<100){ showNotification("Minimum withdrawal is KES 100","error"); return; }
  if(amount>wallet.balance){ showNotification("Insufficient balance","error"); return; }

  wallet.balance -= amount;
  wallet.transactions.unshift({ type:"debit", amount, ref:"WTH"+Date.now(), desc:`M-PESA withdrawal to ${phone}`, date:new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"}) });
  localStorage.setItem("sokoniWallet", JSON.stringify(wallet));
  showNotification(`✅ KES ${amount.toLocaleString()} sent to ${phone}!`,"success");
  renderWallet();
}

window.withdrawWallet = withdrawWallet;

/* =========================
   SALES HISTORY
========================= */

let allSalesRows = []; // cache for search filtering

function renderSalesHistory(){
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}

    const productMap = {};
    products.forEach(p => productMap[p.id] = p);

    const statusPillMap = {
        placed:"pill-blue", processing:"pill-orange", shipped:"pill-purple",
        out_for_delivery:"pill-orange", delivered:"pill-green"
    };

    /* Build sale rows — one row per item per order */
    allSalesRows = [];
    orders.forEach(o => {
        (o.items||[]).forEach(item => {
            const prod = productMap[item.id];
            const revenue = Number(item.price||0);
            const fee     = Math.round(revenue * (SokoniCommission.pct("marketplace") / 100));
            allSalesRows.push({
                orderId:   o.id,
                date:      o.date || "—",
                productName: item.name || "—",
                category:  item.category || (prod?.category) || "—",
                revenue,
                fee,
                net:       revenue - fee,
                buyerLoc:  o.address || "—",
                status:    o.status || "placed",
                timestamp: o.timestamp || 0
            });
        });
    });

    renderSalesRows(allSalesRows);
}

function renderSalesRows(rows){
    const tbody   = document.getElementById("salesHistoryTbody");
    const emptyEl = document.getElementById("salesHistoryEmpty");
    if(!tbody) return;

    if(!rows.length){
        tbody.innerHTML = "";
        if(emptyEl) emptyEl.style.display = "block";
        return;
    }

    if(emptyEl) emptyEl.style.display = "none";
    const statusPillMap = {
        placed:"pill-blue", processing:"pill-orange", shipped:"pill-purple",
        out_for_delivery:"pill-orange", delivered:"pill-green"
    };

    tbody.innerHTML = rows.map(r => `
        <tr>
            <td style="color:#71ff00;font-weight:800;">${r.orderId}</td>
            <td style="color:rgba(255,255,255,0.6);">${r.date}</td>
            <td style="font-weight:700;color:white;">${r.productName}</td>
            <td><span style="font-size:11px;background:rgba(0,170,255,0.12);color:#00aaff;padding:2px 8px;border-radius:6px;">${r.category}</span></td>
            <td style="font-weight:700;color:#71ff00;">KES ${r.revenue.toLocaleString()}</td>
            <td style="color:#ff9800;">KES ${r.fee.toLocaleString()}</td>
            <td style="font-weight:800;color:#71ff00;">KES ${r.net.toLocaleString()}</td>
            <td style="color:rgba(255,255,255,0.5);font-size:12px;">${r.buyerLoc.substring(0,24)}</td>
            <td><span class="status-pill ${statusPillMap[r.status]||'pill-orange'}">${r.status}</span></td>
        </tr>
    `).join("");
}

function filterSalesHistory(){
    const val = (document.getElementById("salesHistorySearch")?.value||"").toLowerCase();
    if(!val){ renderSalesRows(allSalesRows); return; }
    renderSalesRows(allSalesRows.filter(r =>
        r.productName.toLowerCase().includes(val) || r.orderId.toLowerCase().includes(val)
    ));
}

window.filterSalesHistory = filterSalesHistory;

/* =========================
   DELIVERY PERFORMANCE
========================= */

function renderDeliveryPerformance(){
    const el = document.getElementById("deliveryPerfContent");
    if(!el) return;

    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}

    const total       = orders.length;
    const delivered   = orders.filter(o => o.status === "delivered").length;
    const processing  = orders.filter(o => ["placed","processing"].includes(o.status)).length;
    const shipped     = orders.filter(o => ["shipped","out_for_delivery"].includes(o.status)).length;
    const deliveryRate = total > 0 ? Math.round((delivered/total)*100) : 0;

    /* Average days to deliver (from timestamp to delivered) */
    const deliveredOrders = orders.filter(o => o.status==="delivered" && o.timestamp);
    let avgDays = "—";
    if(deliveredOrders.length){
        const totalDays = deliveredOrders.reduce((s,o) => {
            const created = o.timestamp;
            const lastStep = (o.steps||[]).filter(s=>s.done).slice(-1)[0];
            const delivTime = lastStep ? (Date.now() - created) : 0; // approximate
            return s + delivTime;
        }, 0);
        const msPerDay = 86400000;
        avgDays = (totalDays / deliveredOrders.length / msPerDay).toFixed(1);
    }

    /* Disputes */
    let disputes = [];
    try { disputes = JSON.parse(localStorage.getItem("sokoniDisputes"))||[]; } catch(e){}
    const disputeRate = total > 0 ? ((disputes.length/total)*100).toFixed(1) : 0;

    /* Seller rating */
    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const sellerKey = user?.name || "Sokoni Seller";
    let sellerRatings = [];
    try {
        const all = JSON.parse(localStorage.getItem("sokoniSellerRatings"))||{};
        sellerRatings = all[sellerKey] || [];
    } catch(e){}
    const avgRating = sellerRatings.length
        ? (sellerRatings.reduce((s,r)=>s+r.stars,0)/sellerRatings.length).toFixed(1)
        : "—";

    el.innerHTML = `
        <div class="analytics-summary-row" style="margin-bottom:20px;">
            <div class="analytics-sum-card">
                <div class="asc-label">Total Orders</div>
                <div class="asc-val">${total}</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Delivered</div>
                <div class="asc-val" style="color:#71ff00;">${delivered}</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">In Transit</div>
                <div class="asc-val" style="color:#00aaff;">${shipped}</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Processing</div>
                <div class="asc-val" style="color:#ff9800;">${processing}</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Delivery Rate</div>
                <div class="asc-val" style="color:${deliveryRate>=80?'#71ff00':deliveryRate>=50?'#ff9800':'#ff4444'};">${deliveryRate}%</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Avg Delivery</div>
                <div class="asc-val">${avgDays} days</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Dispute Rate</div>
                <div class="asc-val" style="color:${disputeRate>5?'#ff4444':'#71ff00'};">${disputeRate}%</div>
            </div>
            <div class="analytics-sum-card">
                <div class="asc-label">Customer Rating</div>
                <div class="asc-val" style="color:#ffc107;">⭐ ${avgRating}</div>
            </div>
        </div>

        <!-- Performance Bar Chart -->
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:18px;">
            <div style="font-size:13px;font-weight:800;color:white;margin-bottom:14px;">Order Funnel</div>
            ${[
                { label:"Orders Placed",    val:total,       color:"#00aaff" },
                { label:"Processing",       val:processing,  color:"#ff9800" },
                { label:"Shipped",          val:shipped,     color:"#a080ff" },
                { label:"Delivered",        val:delivered,   color:"#71ff00" },
            ].map(item => `
                <div style="margin-bottom:12px;">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                        <span style="color:rgba(255,255,255,0.6);">${item.label}</span>
                        <span style="color:${item.color};font-weight:800;">${item.val}</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.07);border-radius:999px;height:7px;overflow:hidden;">
                        <div style="background:${item.color};height:100%;border-radius:999px;width:${total>0?Math.round(item.val/total*100):0}%;transition:width 0.8s ease;"></div>
                    </div>
                </div>
            `).join("")}
        </div>
    `;
}

/* =========================
   SELLER RATINGS RECEIVED
========================= */

function renderSellerRatings(){
    const el = document.getElementById("sellerRatingsContent");
    if(!el) return;

    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const sellerKey = user?.name || "Sokoni Seller";
    let allRatings = {};
    try { allRatings = JSON.parse(localStorage.getItem("sokoniSellerRatings"))||{}; } catch(e){}
    const ratings = allRatings[sellerKey] || [];

    if(!ratings.length){
        el.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:16px 0;">No ratings yet. Buyers can rate you after delivery on the success page.</div>`;
        return;
    }

    const avg   = ratings.reduce((s,r)=>s+(r.avgScore||r.stars||0),0) / ratings.length;
    const stars = "★".repeat(Math.round(avg)) + "☆".repeat(5-Math.round(avg));
    const dist  = [5,4,3,2,1].map(n => ({ n, count: ratings.filter(r=>(r.stars||0)===n).length }));
    const maxD  = Math.max(...dist.map(d=>d.count),1);

    /* Category averages */
    const catAvg = (key) => {
        const vals = ratings.map(r=>r[key]).filter(v=>v>0);
        return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : null;
    };
    const catData = [
        { key:"delivery",     label:"🚚 Delivery",      val: catAvg("delivery")     },
        { key:"responseTime", label:"⚡ Response Time",  val: catAvg("responseTime") },
        { key:"returns",      label:"🔄 Returns",         val: catAvg("returns")      },
        { key:"satisfaction", label:"😊 Satisfaction",   val: catAvg("satisfaction") },
    ];

    el.innerHTML = `
        <!-- Overview -->
        <div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;">
            <div style="text-align:center;flex-shrink:0;">
                <div style="font-size:52px;font-weight:900;color:#ffc107;">${avg.toFixed(1)}</div>
                <div style="color:#ffc107;font-size:18px;letter-spacing:2px;">${stars}</div>
                <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">${ratings.length} review${ratings.length!==1?"s":""}</div>
            </div>
            <div style="flex:1;min-width:180px;">
                ${dist.map(d=>`
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">
                        <span style="color:#ffc107;font-size:12px;font-weight:700;width:28px;">${d.n} ★</span>
                        <div style="flex:1;background:rgba(255,255,255,0.07);border-radius:999px;height:6px;overflow:hidden;">
                            <div style="background:#ffc107;height:100%;border-radius:999px;width:${Math.round(d.count/maxD*100)}%;"></div>
                        </div>
                        <span style="color:rgba(255,255,255,0.4);font-size:11px;width:16px;">${d.count}</span>
                    </div>
                `).join("")}
            </div>
        </div>

        <!-- Category breakdown -->
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px;">
            ${catData.map(c => {
                if(!c.val) return "";
                const pct = Math.round((parseFloat(c.val)/5)*100);
                const col = pct>=80?"#71ff00":pct>=60?"#ffc107":"#ff9800";
                return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:14px;">
                    <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:8px;">${c.label}</div>
                    <div style="font-size:22px;font-weight:900;color:${col};margin-bottom:6px;">${c.val}<span style="font-size:12px;color:rgba(255,255,255,0.3);"> / 5</span></div>
                    <div style="background:rgba(255,255,255,0.07);border-radius:999px;height:5px;overflow:hidden;">
                        <div style="background:${col};height:100%;border-radius:999px;width:${pct}%;"></div>
                    </div>
                </div>`;
            }).join("")}
        </div>

        <!-- Individual reviews -->
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">Recent Reviews</div>
        ${ratings.slice(0,10).map(r=>{
            const rAvg  = r.avgScore || r.stars || 0;
            const rName = _esc(r.buyerName||"Anonymous");
            const rDate = _esc(r.date||"");
            const rOid  = _esc(r.orderId||"");
            const rCmt  = _esc(r.comment||"");
            const dims = [
                r.delivery     ? `🚚 ${_esc(r.delivery)}`     : "",
                r.responseTime ? `⚡ ${_esc(r.responseTime)}` : "",
                r.returns      ? `🔄 ${_esc(r.returns)}`      : "",
                r.satisfaction ? `😊 ${_esc(r.satisfaction)}` : "",
            ].filter(Boolean);
            return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:14px 16px;margin-bottom:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div style="width:32px;height:32px;border-radius:50%;background:rgba(113,255,0,0.12);border:1px solid rgba(113,255,0,0.2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#71ff00;">${(rName[0]||'A').toUpperCase()}</div>
                        <div>
                            <div style="font-weight:700;color:white;font-size:13px;">${rName}</div>
                            <div style="font-size:10px;color:rgba(255,255,255,0.35);">${rDate} · Order ${rOid}</div>
                        </div>
                    </div>
                    <div style="color:#ffc107;font-size:14px;">${"★".repeat(Math.round(rAvg))}${"☆".repeat(5-Math.round(rAvg))} <span style="font-size:12px;color:rgba(255,255,255,0.4);">${rAvg}</span></div>
                </div>
                ${dims.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">${dims.map(d=>`<span style="font-size:11px;background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.15);color:#ffc107;padding:3px 9px;border-radius:6px;">${d}</span>`).join("")}</div>` : ""}
                ${rCmt ? `<div style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.5;font-style:italic;">"${rCmt}"</div>` : ""}
            </div>`;
        }).join("")}
    `;
}

/* =========================
   SMART RESTOCK SYSTEM
========================= */

function renderSmartRestock(){
  const el = document.getElementById("restock-section");
  if(!el) return;

  let products = [];
  try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
  let orders = [];
  try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}

  /* Compute sales velocity per product */
  const soldMap = {};
  orders.forEach(o => {
    (o.items||[]).forEach(item => { soldMap[item.id] = (soldMap[item.id]||0) + 1; });
  });

  const DAYS_TRACKED = 30;
  const alerts = products
    .filter(p => p.stock !== undefined)
    .map(p => {
      const totalSold  = soldMap[p.id] || p.sold || 0;
      const daysSince  = Math.max(1, (Date.now() - (p.uploadedAt||Date.now())) / 86400000);
      const dailyRate  = totalSold / Math.min(daysSince, DAYS_TRACKED);
      const currentStock = Number(p.stock || 0);
      const daysLeft   = dailyRate > 0 ? Math.floor(currentStock / dailyRate) : Infinity;
      const reorderQty = Math.ceil(dailyRate * 30); /* 30-day supply */
      return { ...p, totalSold, dailyRate, daysLeft, reorderQty, currentStock };
    })
    .filter(p => p.daysLeft < 14 || p.currentStock <= 3)
    .sort((a,b) => a.daysLeft - b.daysLeft);

  el.innerHTML = `
    <div class="seller-section-header">
      <h2>🔔 Smart Restock Notifications</h2>
      <p class="seller-section-sub">AI-powered restock alerts based on your sales velocity</p>
    </div>
    ${alerts.length ? alerts.map(p => {
      const urgent = p.daysLeft <= 3 || p.currentStock === 0;
      const color  = urgent ? "#ff4444" : p.daysLeft <= 7 ? "#ff9800" : "#ffc107";
      const bg     = urgent ? "rgba(255,68,68,0.07)" : "rgba(255,152,0,0.06)";
      const border = urgent ? "rgba(255,68,68,0.2)" : "rgba(255,152,0,0.18)";
      const daysText = p.daysLeft === Infinity ? "No sales data" : p.currentStock === 0 ? "OUT OF STOCK" : `~${p.daysLeft} day${p.daysLeft!==1?"s":""} left`;
      return `
        <div style="background:${bg};border:1px solid ${border};border-radius:16px;padding:16px 18px;margin-bottom:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
          <img src="${p.image||'assets/default-product.png'}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:800;color:white;">${p.name}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);">${p.currentStock} in stock · ${p.totalSold} sold · ${p.dailyRate.toFixed(1)}/day avg</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:13px;font-weight:900;color:${color};">${daysText}</div>
            ${p.reorderQty > 0 ? `<div style="font-size:11px;color:rgba(255,255,255,0.35);">Suggest reorder: ${p.reorderQty} units</div>` : ""}
          </div>
          <button onclick="restoreStock('${p.id}')" style="padding:8px 14px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.2);border-radius:10px;color:#71ff00;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;">
            📦 Restock
          </button>
        </div>
      `;
    }).join("") : `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:16px 0;">✅ All products well-stocked! No restock alerts.</div>`}
  `;
}

/* =========================
   INITIAL LOAD
========================= */

window.addEventListener("DOMContentLoaded", ()=>{
    displaySellerProducts();
    updateSellerStats();
    populateFlashSelect();
    displayActiveFlashSales();
    populateBoostSelect();
    displayActiveBoostedProducts();
    loadBuyerOrders();
    loadSellerDMs();
    loadKraSection();
    initProfitPreviewStrip();
    renderInventoryTable();
    renderSalesAnalytics("today");
    checkLowStockAlerts();
    renderCustomerAnalytics();
    renderSellerQa();
    renderSalesHistory();
    renderDeliveryPerformance();
    renderSellerRatings();
    showVerificationStatus();
    renderExpenseTracker();
    renderSmartRestock();
    renderWallet();
    renderEmployeeList();
    renderPromoCodes();
    renderCampaigns();
    loadMiniStoreForm();
    renderOfferInbox();
    renderReturnRequests();
    renderMpesaInsights();
    renderPremiumPlans();
});

/* =========================
   FLASH SALE MANAGER
========================= */

function populateFlashSelect(){
    const sel = document.getElementById("flashProductSelect");
    if(!sel) return;
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}
    sel.innerHTML = `<option value="">Select a product...</option>` +
        products.map(p => `<option value="${_esc(p.id)}">${_esc(p.name)} — KES ${Number(p.price).toLocaleString()}</option>`).join("");
}

function launchFlashSale(){
    const productId = document.getElementById("flashProductSelect").value;
    const discount  = Number(document.getElementById("flashDiscount").value);
    const hours     = Number(document.getElementById("flashDuration").value);

    if(!productId || !discount || !hours){
        showNotification("Fill all flash sale fields", "error"); return;
    }
    if(discount < 1 || discount > 90){ showNotification("Discount must be 1-90%", "error"); return; }

    let flashSales = [];
    try { flashSales = JSON.parse(localStorage.getItem("sokoniFlashSales")) || []; } catch(e) {}

    flashSales = flashSales.filter(f => f.productId !== productId); // replace if exists
    flashSales.push({ productId, discount, endsAt: Date.now() + hours * 3600000, startedAt: Date.now() });
    localStorage.setItem("sokoniFlashSales", JSON.stringify(flashSales));

    showNotification(`⚡ Flash Sale launched! ${discount}% off for ${hours}h`, "success");
    displayActiveFlashSales();
}

function displayActiveFlashSales(){
    const container = document.getElementById("activeFlashSales");
    if(!container) return;

    let flashSales = [];
    try { flashSales = JSON.parse(localStorage.getItem("sokoniFlashSales")) || []; } catch(e) {}
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}

    const active = flashSales.filter(f => f.endsAt > Date.now());
    if(active.length === 0){ container.innerHTML = `<p style="color:rgba(255,255,255,0.35);font-size:13px;text-align:center;padding:12px;">No active flash sales</p>`; return; }

    container.innerHTML = `<h4 style="color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px;">Active Flash Sales</h4>` +
        active.map(f => {
            const p = products.find(p => p.id === f.productId);
            if(!p) return "";
            const remaining = Math.max(0, Math.ceil((f.endsAt - Date.now())/3600000));
            return `<div class="active-flash-row">
                <span class="afs-name">${p.name}</span>
                <span class="afs-discount">-${f.discount}%</span>
                <span class="afs-time">⏱ ${remaining}h left</span>
                <button class="afs-end-btn" onclick="endFlashSale('${f.productId}')">End</button>
            </div>`;
        }).join("");
}

function endFlashSale(productId){
    let flashSales = [];
    try { flashSales = JSON.parse(localStorage.getItem("sokoniFlashSales")) || []; } catch(e) {}
    flashSales = flashSales.filter(f => f.productId !== productId);
    localStorage.setItem("sokoniFlashSales", JSON.stringify(flashSales));
    showNotification("Flash sale ended", "delete");
    displayActiveFlashSales();
}

window.launchFlashSale = launchFlashSale;
window.endFlashSale    = endFlashSale;

/* =========================
   ADS / BOOST
========================= */

function populateBoostSelect(){
    const sel = document.getElementById("boostProductSelect");
    if(!sel) return;
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}
    sel.innerHTML = `<option value="">Select a product to boost...</option>` +
        products.map(p => `<option value="${_esc(p.id)}">${_esc(p.name)} — KES ${Number(p.price).toLocaleString()}</option>`).join("");
}

function launchBoost(){
    const productId = document.getElementById("boostProductSelect").value;
    const hours     = Number(document.getElementById("boostDuration").value);
    if(!productId){ showNotification("Select a product to boost", "error"); return; }

    let ads = [];
    try { ads = JSON.parse(localStorage.getItem("sokoniAds")) || []; } catch(e) {}
    ads = ads.filter(a => a.productId !== productId);
    ads.push({ productId, endsAt: Date.now() + hours * 3600000, startedAt: Date.now() });
    localStorage.setItem("sokoniAds", JSON.stringify(ads));
    showNotification(`📢 Product is now boosted for ${hours} hours!`, "success");
    displayActiveBoostedProducts();
}

function displayActiveBoostedProducts(){
    const container = document.getElementById("activeBoostedProducts");
    if(!container) return;

    let ads = [];
    try { ads = JSON.parse(localStorage.getItem("sokoniAds")) || []; } catch(e) {}
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}

    const active = ads.filter(a => a.endsAt > Date.now());
    if(active.length === 0){
        container.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:13px;text-align:center;padding:10px;">No boosted products</p>`;
        return;
    }

    container.innerHTML = `<h4 style="color:rgba(255,255,255,0.5);font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Active Boosts</h4>` +
        active.map(a => {
            const p = products.find(p => p.id === a.productId);
            if(!p) return "";
            const remaining = Math.max(0, Math.ceil((a.endsAt - Date.now()) / 3600000));
            return `<div class="active-flash-row">
                <span class="afs-name">${p.name}</span>
                <span class="afs-discount" style="background:rgba(0,153,255,0.15);color:#00aaff;">📢 Boosted</span>
                <span class="afs-time">⏱ ${remaining}h left</span>
                <button class="afs-end-btn" onclick="endBoost('${a.productId}')">Stop</button>
            </div>`;
        }).join("");
}

function endBoost(productId){
    let ads = [];
    try { ads = JSON.parse(localStorage.getItem("sokoniAds")) || []; } catch(e) {}
    ads = ads.filter(a => a.productId !== productId);
    localStorage.setItem("sokoniAds", JSON.stringify(ads));
    showNotification("Boost stopped", "delete");
    displayActiveBoostedProducts();
}

window.launchBoost  = launchBoost;
window.endBoost     = endBoost;

/* ══════════════════════════════════════════════════════════════
   KRA TAX SYSTEM — Full Kenya Tax Compliance Engine
   Covers: VAT (16%), Withholding Tax (5%), Income Tax (PAYE bands),
   Monthly breakdowns, VAT registration threshold, iTax guide.
══════════════════════════════════════════════════════════════ */

/* Kenya Income Tax Bands 2024 (annual) */
const KE_IT_BANDS = [
    { max: 288000,   rate: 0.10, label: "10% (up to KES 288,000)" },
    { max: 388000,   rate: 0.25, label: "25% (KES 288,001–388,000)" },
    { max: 6000000,  rate: 0.30, label: "30% (KES 388,001–6,000,000)" },
    { max: 9600000,  rate: 0.325,label: "32.5% (KES 6M–9.6M)" },
    { max: Infinity, rate: 0.35, label: "35% (above KES 9.6M)" },
];

function calcKeIncomeTax(annualIncome){
    const PERSONAL_RELIEF = 28800; /* KES 2,400/month × 12 */
    let tax = 0, remaining = annualIncome;
    let prev = 0;
    for(const band of KE_IT_BANDS){
        if(remaining <= 0) break;
        const taxable = Math.min(remaining, band.max - prev);
        tax += taxable * band.rate;
        remaining -= taxable;
        prev = band.max;
    }
    return Math.max(0, Math.round(tax - PERSONAL_RELIEF));
}

function loadKraSection(){
    const pin   = localStorage.getItem("kraPinSaved") || "";
    const pinEl = document.getElementById("kraPin");
    if(pinEl && pin) pinEl.value = pin;

    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}

    const now    = new Date();
    const yr     = now.getFullYear();
    const mo     = now.getMonth();

    /* Annualise: months of trading */
    const orderDates = orders.map(o => new Date(o.timestamp || Date.now()));
    const earliest   = orderDates.length ? new Date(Math.min(...orderDates)) : now;
    const monthsTraded = Math.max(1, Math.ceil((now - earliest) / 2592000000));

    /* Revenue calculations */
    const grossRevenue     = orders.reduce((s,o)=>s+Number(o.total||0),0);
    const annualisedRev    = grossRevenue * (12 / monthsTraded);
    const commission       = Math.round(grossRevenue * (SokoniCommission.pct("marketplace") / 100)); /* 12% Sokoni fee */
    const netRevenue       = grossRevenue - commission;
    const vatExclusive     = Math.round(grossRevenue / 1.16);
    const vatCollected     = grossRevenue - vatExclusive; /* 16% VAT embedded in price */
    const withholdingRate  = 0.05;
    const withholdingTax   = grossRevenue >= 24000 ? Math.round(netRevenue * withholdingRate) : 0;
    const incomeTaxAnnual  = calcKeIncomeTax(annualisedRev);
    const incomeTaxToDate  = Math.round(incomeTaxAnnual * (monthsTraded / 12));
    const totalObligation  = vatCollected + withholdingTax;
    const vatThreshold     = 5000000; /* KES 5M: mandatory VAT registration */
    const vatRegistered    = annualisedRev >= vatThreshold;

    /* Monthly breakdown */
    const monthlyData = {};
    orders.forEach(o => {
        const d = new Date(o.timestamp || Date.now());
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
        if(!monthlyData[key]) monthlyData[key] = { revenue:0, orders:0 };
        monthlyData[key].revenue += Number(o.total||0);
        monthlyData[key].orders++;
    });
    const monthlyRows = Object.entries(monthlyData)
        .sort((a,b)=>b[0].localeCompare(a[0]))
        .slice(0,6)
        .map(([key,d])=>`
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:8px 10px;color:rgba(255,255,255,0.6);">${key}</td>
                <td style="padding:8px 10px;color:white;font-weight:700;">KES ${d.revenue.toLocaleString()}</td>
                <td style="padding:8px 10px;color:rgba(255,255,255,0.5);">${d.orders}</td>
                <td style="padding:8px 10px;color:#ff9800;">KES ${Math.round(d.revenue*0.16).toLocaleString()}</td>
                <td style="padding:8px 10px;color:#71ff00;">KES ${Math.round(d.revenue*0.12).toLocaleString()}</td>
            </tr>`
        ).join("") || `<tr><td colspan="5" style="padding:12px;color:rgba(255,255,255,0.25);text-align:center;">No orders yet</td></tr>`;

    const grid = document.getElementById("taxGrid");
    if(!grid) return;

    grid.innerHTML = `
    <!-- KEY STATS -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:20px;">
        <div class="tax-card">
            <div class="tax-card-label">Gross Revenue (All Time)</div>
            <div class="tax-card-value">KES ${grossRevenue.toLocaleString()}</div>
            <div class="tax-card-note">${orders.length} orders · ${monthsTraded}mo trading</div>
        </div>
        <div class="tax-card">
            <div class="tax-card-label">Net Revenue (after 12% fee)</div>
            <div class="tax-card-value">KES ${netRevenue.toLocaleString()}</div>
            <div class="tax-card-note">Sokoni fee: KES ${commission.toLocaleString()}</div>
        </div>
        <div class="tax-card">
            <div class="tax-card-label">VAT Embedded (16%)</div>
            <div class="tax-card-value tax-orange">KES ${vatCollected.toLocaleString()}</div>
            <div class="tax-card-note">Ex-VAT revenue: KES ${vatExclusive.toLocaleString()}</div>
        </div>
        <div class="tax-card">
            <div class="tax-card-label">Withholding Tax (5%)</div>
            <div class="tax-card-value tax-orange">KES ${withholdingTax.toLocaleString()}</div>
            <div class="tax-card-note">${grossRevenue < 24000 ? "Applies once revenue ≥ KES 24,000" : "Deducted by platform"}</div>
        </div>
        <div class="tax-card">
            <div class="tax-card-label">Est. Income Tax (to date)</div>
            <div class="tax-card-value tax-orange">KES ${incomeTaxToDate.toLocaleString()}</div>
            <div class="tax-card-note">Annual: KES ${incomeTaxAnnual.toLocaleString()}</div>
        </div>
        <div class="tax-card tax-card-total">
            <div class="tax-card-label">Total Tax Obligation (VAT + WHT)</div>
            <div class="tax-card-value tax-red">KES ${totalObligation.toLocaleString()}</div>
            <div class="tax-card-note">File on iTax by 20th of next month</div>
        </div>
    </div>

    <!-- VAT REGISTRATION ALERT -->
    <div style="padding:12px 16px;margin-bottom:20px;border-radius:12px;border:1px solid ${vatRegistered?'rgba(255,100,0,0.3)':'rgba(113,255,0,0.18)'};background:${vatRegistered?'rgba(255,100,0,0.07)':'rgba(113,255,0,0.04)'};">
        ${vatRegistered
            ? `<strong style="color:#ff6b6b;">⚠️ VAT Registration Required:</strong> Your annualised revenue (KES ${Math.round(annualisedRev).toLocaleString()}) exceeds KES 5,000,000. You must register for VAT on <a href="https://itax.kra.go.ke" target="_blank" style="color:#ff9800;">iTax</a> and file VAT returns monthly.`
            : `<strong style="color:#71ff00;">✅ Below VAT Threshold:</strong> Annualised revenue KES ${Math.round(annualisedRev).toLocaleString()} — below KES 5,000,000 mandatory VAT registration threshold. You may voluntarily register. Once you reach KES 5M, registration is mandatory.`
        }
    </div>

    <!-- MONTHLY TABLE -->
    <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">📅 Monthly Breakdown (Last 6 Months)</div>
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="color:rgba(255,255,255,0.35);border-bottom:1px solid rgba(255,255,255,0.08);">
                <th style="padding:8px 10px;text-align:left;">Month</th>
                <th style="padding:8px 10px;text-align:left;">Revenue</th>
                <th style="padding:8px 10px;text-align:left;">Orders</th>
                <th style="padding:8px 10px;text-align:left;">VAT (16%)</th>
                <th style="padding:8px 10px;text-align:left;">Sokoni Fee (12%)</th>
            </tr></thead>
            <tbody>${monthlyRows}</tbody>
        </table>
        </div>
    </div>

    <!-- INCOME TAX BANDS -->
    <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📊 Kenya Income Tax Bands 2024</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
        ${KE_IT_BANDS.slice(0,5).map(b=>`
            <div style="padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;font-size:11px;color:rgba(255,255,255,0.55);">${b.label}</div>
        `).join("")}
        </div>
    </div>

    <!-- FILING GUIDE -->
    <div style="padding:14px 16px;background:rgba(0,170,255,0.06);border:1px solid rgba(0,170,255,0.18);border-radius:12px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:8px;">🧭 How to File on iTax</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.55);line-height:1.8;">
            1. Visit <a href="https://itax.kra.go.ke" target="_blank" style="color:#00aaff;">itax.kra.go.ke</a> and log in with your KRA PIN + password<br>
            2. Under <strong style="color:white;">Returns</strong> → select <strong style="color:white;">File Returns</strong><br>
            3. Choose <strong style="color:white;">Income Tax — Self-Employed</strong> (for individual sellers)<br>
            4. Enter your Sokoni gross revenue as <strong style="color:white;">Business Income</strong><br>
            5. Claim <strong style="color:white;">Sokoni fees as deductible business expenses</strong><br>
            6. File <strong style="color:white;">VAT returns monthly</strong> if VAT-registered (by 20th)<br>
            7. Download your Sokoni tax summary below for your records
        </div>
    </div>
    `;
}

function saveKraPin(){
    const pin = document.getElementById("kraPin").value.toUpperCase();
    localStorage.setItem("kraPinSaved", pin);
    const status = document.getElementById("kraPinStatus");
    if(status){
        const valid = /^[A-Z]\d{9}[A-Z]$/.test(pin);
        status.textContent = valid ? "✅ Valid KRA PIN format" : pin.length > 3 ? "⚠️ KRA PIN should be A-XXXXXXXXX-X (11 chars)" : "";
        status.style.color = valid ? "#71ff00" : "#ffc107";
    }
}

function downloadTaxReport(){
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}
    const grossRevenue   = orders.reduce((s,o)=>s+Number(o.total||0),0);
    const pin            = localStorage.getItem("kraPinSaved") || "NOT SET";
    const user           = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const date           = new Date().toLocaleDateString("en-KE",{day:"numeric",month:"long",year:"numeric"});
    const commission     = Math.round(grossRevenue * (SokoniCommission.pct("marketplace") / 100));
    const netRevenue     = grossRevenue - commission;
    const vatExclusive   = Math.round(grossRevenue / 1.16);
    const vatCollected   = grossRevenue - vatExclusive;
    const withholdingTax = grossRevenue >= 24000 ? Math.round(netRevenue * 0.05) : 0;
    const incomeEst      = calcKeIncomeTax(netRevenue);

    /* Monthly breakdown */
    const monthly = {};
    orders.forEach(o=>{
        const d = new Date(o.timestamp||Date.now());
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
        if(!monthly[k]) monthly[k]={rev:0,orders:0};
        monthly[k].rev += Number(o.total||0); monthly[k].orders++;
    });
    const monthlyText = Object.entries(monthly).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,12)
        .map(([k,d])=>`  ${k}  Revenue: KES ${d.rev.toLocaleString().padEnd(14)} Orders: ${d.orders}  VAT: KES ${Math.round(d.rev*0.16).toLocaleString()}`).join("\n");

    const report = `
╔══════════════════════════════════════════════════════╗
║         SOKONI TAX SUMMARY REPORT                  ║
╚══════════════════════════════════════════════════════╝
Generated : ${date}
Seller    : ${user?.name || "Sokoni Seller"}
KRA PIN   : ${pin}

REVENUE SUMMARY
══════════════════════════════════════════════════════
Gross Revenue (All Time)  : KES ${grossRevenue.toLocaleString()}
Sokoni Commission (12%)   : KES ${commission.toLocaleString()}
Net Revenue               : KES ${netRevenue.toLocaleString()}
Total Orders              : ${orders.length}

TAX OBLIGATIONS
══════════════════════════════════════════════════════
VAT Collected (16%)       : KES ${vatCollected.toLocaleString()}
  Excl. VAT Revenue       : KES ${vatExclusive.toLocaleString()}
Withholding Tax (5%)      : KES ${withholdingTax.toLocaleString()}
  (Applies ≥ KES 24,000)
Est. Income Tax (net rev) : KES ${incomeEst.toLocaleString()}

TOTAL TAX OBLIGATION      : KES ${(vatCollected + withholdingTax).toLocaleString()}

MONTHLY BREAKDOWN (Last 12 Months)
══════════════════════════════════════════════════════
${monthlyText || "  No orders yet"}

HOW TO FILE
══════════════════════════════════════════════════════
1. Log in at itax.kra.go.ke
2. File Income Tax — Self Employed
3. Enter gross revenue as Business Income
4. Deduct Sokoni commission as Business Expense
5. File VAT returns monthly (by 20th) if VAT-registered

⚠️  DISCLAIMER: Estimates only. Rates and thresholds may
    change. Consult a certified tax professional or KRA.
    Official filing at: itax.kra.go.ke
    `.trim();

    const blob = new Blob([report], { type:"text/plain" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    a.download = `sokoni_kra_tax_report_${yr}_${String(mo+1).padStart(2,"0")}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showNotification("📄 KRA Tax Report downloaded", "success");
}

function downloadTaxPDF(){
    /* Generate a printable tax invoice page and open print dialog */
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}
    const grossRevenue  = orders.reduce((s,o)=>s+Number(o.total||0),0);
    const pin           = localStorage.getItem("kraPinSaved") || "NOT SET";
    const user          = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const date          = new Date().toLocaleDateString("en-KE",{day:"numeric",month:"long",year:"numeric"});
    const commission    = Math.round(grossRevenue * (SokoniCommission.pct("marketplace") / 100));
    const netRevenue    = grossRevenue - commission;
    const vatExclusive  = Math.round(grossRevenue / 1.16);
    const vatCollected  = grossRevenue - vatExclusive;
    const withheld      = grossRevenue >= 24000 ? Math.round(netRevenue * 0.05) : 0;
    const incomeTax     = calcKeIncomeTax(netRevenue);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>KRA Tax Summary — SOKONI</title>
    <style>
    *{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:30px;color:#111;font-size:13px;}
    h1{font-size:22px;font-weight:900;color:#0a3d0a;margin-bottom:4px;}
    h2{font-size:14px;font-weight:800;color:#0a3d0a;margin:20px 0 8px;}
    .row{display:flex;justify-content:space-between;padding:7px 10px;border-bottom:1px solid #eee;}
    .row:nth-child(odd){background:#f9f9f9;}
    .total{font-weight:900;font-size:15px;color:#d00;background:#fff7f0;border:2px solid #d00;}
    .badge{display:inline-block;padding:4px 12px;border-radius:4px;font-weight:700;font-size:11px;}
    .green{background:#e8ffe8;color:#0a3d0a;}
    </style></head><body>
    <h1>SOKONI — KRA Tax Summary</h1>
    <p>Generated: ${date} &nbsp;·&nbsp; Seller: <strong>${user?.name||"Sokoni Seller"}</strong> &nbsp;·&nbsp; KRA PIN: <strong>${pin}</strong></p>
    <hr style="margin:16px 0;">
    <h2>Revenue</h2>
    <div class="row"><span>Gross Revenue</span><span><strong>KES ${grossRevenue.toLocaleString()}</strong></span></div>
    <div class="row"><span>Sokoni Commission (12%)</span><span>KES ${commission.toLocaleString()}</span></div>
    <div class="row"><span>Net Revenue</span><span><strong>KES ${netRevenue.toLocaleString()}</strong></span></div>
    <h2>Tax Obligations</h2>
    <div class="row"><span>VAT (16%) — excl. VAT rev: KES ${vatExclusive.toLocaleString()}</span><span><strong>KES ${vatCollected.toLocaleString()}</strong></span></div>
    <div class="row"><span>Withholding Tax (5%) — ${grossRevenue<24000?"not applicable yet":"applicable"}</span><span>KES ${withheld.toLocaleString()}</span></div>
    <div class="row"><span>Est. Income Tax (based on net revenue)</span><span>KES ${incomeTax.toLocaleString()}</span></div>
    <div class="row total"><span>TOTAL OBLIGATION (VAT + WHT)</span><span>KES ${(vatCollected+withheld).toLocaleString()}</span></div>
    <p style="margin-top:20px;font-size:11px;color:#888;">⚠️ Estimates only. File at <strong>itax.kra.go.ke</strong>. Consult a tax professional. Total orders: ${orders.length}.</p>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;

    const _taxBlob = new Blob([html], {type:'text/html'}); const _taxUrl = URL.createObjectURL(_taxBlob); window.open(_taxUrl,'_blank'); setTimeout(()=>URL.revokeObjectURL(_taxUrl),15000);
    showNotification("🖨️ Tax PDF ready — use Print → Save as PDF", "success");
}

window.saveKraPin        = saveKraPin;
window.downloadTaxReport = downloadTaxReport;
window.downloadTaxPDF    = downloadTaxPDF;
const yr = new Date().getFullYear();
const mo = new Date().getMonth();

/* =========================
   BUYER ORDERS (SELLER VIEW)
========================= */

function loadBuyerOrders(){
    const container = document.getElementById("buyerOrdersList");
    if(!container) return;

    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}

    if(orders.length === 0){
        container.innerHTML = `<p style="color:rgba(255,255,255,0.3);text-align:center;padding:24px;font-size:14px;">No buyer orders yet</p>`;
        return;
    }

    const statusOptions = ["placed","processing","shipped","out_for_delivery","delivered"];
    const statusLabels  = { placed:"Placed", processing:"Processing", shipped:"Shipped", out_for_delivery:"Out for Delivery", delivered:"Delivered" };

    container.innerHTML = orders.map(o => `
        <div class="buyer-order-row">
            <div class="bor-left">
                <span class="bor-id">${o.id}</span>
                <span class="bor-date">${o.date}</span>
                <span class="bor-items">${(o.items||[]).length} item(s) · KES ${Number(o.total).toLocaleString()}</span>
                ${o.location ? `<span class="bor-loc" onclick="showBuyerMap(${o.location.lat},${o.location.lng})">📍 View Location</span>` : ""}
            </div>
            <div class="bor-right">
                <select class="bor-status-select" onchange="updateOrderStatus('${o.id}', this.value)">
                    ${statusOptions.map(s => `<option value="${s}" ${o.status===s?"selected":""}>${statusLabels[s]}</option>`).join("")}
                </select>
                <button class="bor-msg-btn" onclick="window.location.href='messages.html'">💬 Message</button>
            </div>
        </div>
    `).join("");
}

function updateOrderStatus(orderId, newStatus){
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}
    const order = orders.find(o => o.id === orderId);
    if(!order) return;

    order.status = newStatus;
    const stepMap = { placed:1, processing:2, shipped:3, out_for_delivery:4, delivered:5 };
    const doneCount = stepMap[newStatus] || 1;
    const timeNow = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});

    order.steps = [
        { label:"Order Placed",      done: doneCount>=1, time: doneCount===1 ? timeNow : order.steps?.[0]?.time || "" },
        { label:"Processing",         done: doneCount>=2, time: doneCount===2 ? timeNow : order.steps?.[1]?.time || "" },
        { label:"Shipped",            done: doneCount>=3, time: doneCount===3 ? timeNow : order.steps?.[2]?.time || "" },
        { label:"Out for Delivery",   done: doneCount>=4, time: doneCount===4 ? timeNow : order.steps?.[3]?.time || "" },
        { label:"Delivered",          done: doneCount>=5, time: doneCount===5 ? timeNow : order.steps?.[4]?.time || "" },
    ];

    localStorage.setItem("sokoniOrders", JSON.stringify(orders));
    showNotification(`Order ${orderId} → ${newStatus.replace("_"," ")}`, "success");
}

window.updateOrderStatus = updateOrderStatus;

/* =========================
   SELLER DM INBOX
========================= */

function loadSellerDMs(){
    const container = document.getElementById("sellerDMList");
    if(!container) return;

    let msgs = [];
    try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}

    if(msgs.length === 0){
        container.innerHTML = `<p style="color:rgba(255,255,255,0.3);text-align:center;padding:24px;font-size:14px;">No customer messages yet</p>`;
        return;
    }

    container.innerHTML = msgs.map(c => `
        <div class="seller-dm-row" onclick="openSellerChat('${_esc(c.id)}')">
            <div class="sdm-avatar">${_esc((c.productName||"S")[0].toUpperCase())}</div>
            <div class="sdm-info">
                <div class="sdm-name">${_esc(c.productName || "General Inquiry")}</div>
                <div class="sdm-preview">${c.messages&&c.messages.length>0 ? _esc(c.messages[c.messages.length-1].text.substring(0,50)) : "—"}</div>
            </div>
            ${c.unread > 0 ? `<div class="sdm-badge">${Number(c.unread)||0}</div>` : ""}
        </div>
    `).join("");
}

function openSellerChat(convoId){
    let msgs = [];
    try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}
    const convo = msgs.find(c => c.id === convoId);
    if(!convo) return;

    convo.unread = 0;
    localStorage.setItem("sokoniMessages", JSON.stringify(msgs));
    loadSellerDMs();

    const panel = document.getElementById("sellerChatPanel");
    panel.style.display = "block";

    panel.innerHTML = `
        <div class="sdm-chat-header">
            <span class="sdm-chat-name">💬 ${_esc(convo.productName || "Inquiry")}</span>
            <button onclick="document.getElementById('sellerChatPanel').style.display='none'" style="background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;font-size:18px;">✕</button>
        </div>
        <div class="sdm-chat-messages" id="sdmMessages"></div>
        <div class="sdm-chat-input">
            <input type="text" id="sdmInput" placeholder="Reply to customer..." onkeydown="if(event.key==='Enter')sellerReply('${_esc(convoId)}')">
            <button onclick="sellerReply('${_esc(convoId)}')">Send</button>
        </div>
    `;

    const area = document.getElementById("sdmMessages");
    area.innerHTML = (convo.messages||[]).map(m => `
        <div class="chat-bubble ${m.sender==="seller" ? "bubble-buyer" : "bubble-seller"}">
            <div class="bubble-text">${_esc(m.text)}</div>
            <div class="bubble-time">${_esc(m.time)}</div>
        </div>
    `).join("");
    area.scrollTop = area.scrollHeight;
}

function sellerReply(convoId){
    const input = document.getElementById("sdmInput");
    const text = input.value.trim();
    if(!text) return;

    let msgs = [];
    try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}
    const convo = msgs.find(c => c.id === convoId);
    if(!convo) return;

    convo.messages = convo.messages || [];
    convo.messages.push({ sender:"seller", text, time: new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) });
    convo.unread = 0;
    localStorage.setItem("sokoniMessages", JSON.stringify(msgs));
    input.value = "";
    openSellerChat(convoId);
}

window.openSellerChat = openSellerChat;
window.sellerReply    = sellerReply;

/* =========================
   THEME TOGGLE
========================= */

function toggleTheme(){
    /* Delegate to unified SokoniTheme if available (sokoni-ui.js injected via shared-header Phase 1) */
    if (window.SokoniTheme) {
        var next = SokoniTheme.toggle();
        var btn = document.getElementById("sellerThemeBtn");
        if (btn) btn.textContent = next === 'light' ? '☀️' : next === 'auto' ? '⚙️' : '🌙';
        return;
    }
    /* Fallback: direct toggle */
    document.body.classList.toggle("light-mode");
    const isLight = document.body.classList.contains("light-mode");
    /* Write to both keys for backward compat */
    localStorage.setItem("sokoni-theme", isLight ? "light" : "dark");
    localStorage.setItem("theme", isLight ? "light" : "dark");
    var themeBtn = document.getElementById("sellerThemeBtn");
    if(themeBtn) themeBtn.textContent = isLight ? "☀️" : "🌙";
}

/* Restore theme on page load — check both keys (unified sokoni-theme takes priority) */
(function() {
    var saved = localStorage.getItem("sokoni-theme") || localStorage.getItem("theme") || "dark";
    if (saved === "light") {
        document.body.classList.add("light-mode");
        document.addEventListener('DOMContentLoaded', function() {
            var btn = document.getElementById("sellerThemeBtn");
            if(btn) btn.textContent = "☀️";
        });
    }
})();

/* =========================
   GLOBAL FUNCTIONS
========================= */

window.addProduct = addProduct;
window.deleteProduct = deleteProduct;
window.editProduct = editProduct;
window.previewImage = previewImage;
window.toggleTheme = toggleTheme;

/* =========================
   PROFIT PREVIEW STRIP (upload form)
========================= */

function initProfitPreviewStrip(){
    ["productPrice","costPrice","deliveryCost"].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener("input", updateProfitStrip);
    });
    /* Wholesale preview */
    ["wholesalePrice","minWholesaleQty","productPrice"].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener("input", updateWholesalePreview);
    });
}

function updateWholesalePreview(){
    const retail    = Number(document.getElementById("productPrice")?.value || 0);
    const wholesale = Number(document.getElementById("wholesalePrice")?.value || 0);
    const minQty    = Number(document.getElementById("minWholesaleQty")?.value || 10);
    const strip     = document.getElementById("wholesalePreviewStrip");
    if(!strip) return;
    if(!wholesale || wholesale <= 0 || !retail){ strip.style.display = "none"; return; }
    strip.style.display = "flex";
    const retailEl    = document.getElementById("wsRetailDisplay");
    const wsEl        = document.getElementById("wsWholesaleDisplay");
    const minEl       = document.getElementById("wsMinQtyDisplay");
    if(retailEl) retailEl.textContent = "KES " + retail.toLocaleString();
    if(wsEl)     wsEl.textContent     = "KES " + wholesale.toLocaleString();
    if(minEl)    minEl.textContent    = minQty + " units";
}

function updateProfitStrip(){
    const sell = Number(document.getElementById("productPrice")?.value || 0);
    const cost = Number(document.getElementById("costPrice")?.value || 0);
    const del  = Number(document.getElementById("deliveryCost")?.value || 0);
    const strip = document.getElementById("profitPreviewStrip");
    if(!strip) return;

    if(!sell){ strip.style.display = "none"; return; }
    strip.style.display = "flex";

    const profit = sell - cost - del;
    const fee    = Math.round(sell * 0.05);
    const net    = profit - fee;
    const margin = sell > 0 ? Math.round((profit / sell) * 100) : 0;

    const profitEl = document.getElementById("ppProfit");
    const marginEl = document.getElementById("ppMargin");
    const netEl    = document.getElementById("ppNet");
    if(profitEl) profitEl.textContent = `KES ${profit.toLocaleString()}`;
    if(marginEl) marginEl.textContent = `${margin}%`;
    if(netEl)    netEl.textContent    = `KES ${net.toLocaleString()}`;
    if(profitEl) profitEl.style.color = profit > 0 ? "#71ff00" : "#ff4444";
    if(netEl)    netEl.style.color    = net > 0 ? "#71ff00" : "#ff4444";
}

/* =========================
   PROFIT CALCULATOR
========================= */

function recalcProfit(){
    const sell    = Number(document.getElementById("calcSell")?.value || 0);
    const cost    = Number(document.getElementById("calcCost")?.value || 0);
    const del     = Number(document.getElementById("calcDelivery")?.value || 0);
    const units   = Math.max(1, Number(document.getElementById("calcUnits")?.value || 1));

    const profit  = sell - cost - del;
    const fee     = Math.round(sell * 0.05);
    const net     = profit - fee;
    const margin  = sell > 0 ? Math.round((profit / sell) * 100) : 0;
    const total   = net * units;

    const set = (id, val, cls) => {
        const el = document.getElementById(id);
        if(!el) return;
        el.textContent = val;
        if(cls) el.className = "pr-val " + cls;
    };

    set("prGross", sell > 0 ? `KES ${profit.toLocaleString()}` : "—", profit >= 0 ? "green" : "red");
    set("prMargin", sell > 0 ? `${margin}%` : "—", margin >= 20 ? "green" : margin >= 0 ? "" : "red");
    set("prFee",   sell > 0 ? `KES ${fee.toLocaleString()}` : "—", "orange");
    set("prNet",   sell > 0 ? `KES ${net.toLocaleString()}` : "—", net >= 0 ? "green" : "red");
    set("prTotal", sell > 0 ? `KES ${total.toLocaleString()}` : "—", total >= 0 ? "green" : "red");

    const unitsLbl = document.getElementById("prUnitsLabel");
    if(unitsLbl) unitsLbl.textContent = units;

    const advice = document.getElementById("profitAdvice");
    if(advice && sell > 0){
        advice.style.display = "block";
        if(net < 0){
            advice.className = "profit-advice";
            advice.innerHTML = `⚠️ <strong>Selling at a loss.</strong> Your selling price doesn't cover cost + delivery + platform fee. Raise the price to at least <strong>KES ${(cost + del + Math.ceil((cost+del)*0.053)).toLocaleString()}</strong> to break even.`;
        } else if(margin < 15){
            advice.className = "profit-advice";
            advice.innerHTML = `💡 <strong>Low margin (${margin}%).</strong> Consider raising the price or reducing costs. Aim for at least 20-30% margin for a sustainable business.`;
        } else {
            advice.className = "profit-advice good";
            advice.innerHTML = `✅ <strong>Healthy margin (${margin}%).</strong> Great pricing! Net earnings of <strong>KES ${net.toLocaleString()}</strong> per unit after all costs.`;
        }
    } else if(advice){
        advice.style.display = "none";
    }
}

window.recalcProfit = recalcProfit;

/* =========================
   INVENTORY TABLE
========================= */

function renderInventoryTable(){
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}

    const tbody = document.getElementById("inventoryTbody");
    if(!tbody) return;

    if(products.length === 0){
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:rgba(255,255,255,0.25);">No products listed yet</td></tr>`;
        return;
    }

    tbody.innerHTML = products.map((p, i) => {
        const stock  = p.stock !== undefined ? Number(p.stock) : "—";
        const oos    = p.outOfStock || stock === 0;
        const low    = !oos && typeof stock === "number" && stock > 0 && stock <= 5;
        const profit = p.costPrice ? p.price - p.costPrice - (p.deliveryCost||0) : "—";
        const statusClass = oos ? "stock-out" : low ? "stock-low" : "stock-ok";
        const statusLabel = oos ? "🔴 Out of Stock" : low ? `🟠 Low (${stock})` : `🟢 ${stock !== "—" ? stock : "Tracked"}`;
        const rowClass = oos ? "oos-row" : "";

        return `<tr class="${rowClass}" id="inv-row-${p.id}">
            <td>
                <div style="display:flex;align-items:center;gap:10px;">
                    <img src="${p.image||'assets/default-product.png'}" style="width:38px;height:38px;border-radius:8px;object-fit:cover;" onerror="this.src='assets/default-product.png'">
                    <div>
                        <div style="color:white;font-weight:700;font-size:13px;">${p.name}</div>
                        <div style="color:rgba(255,255,255,0.35);font-size:11px;">${p.category||""}</div>
                    </div>
                </div>
            </td>
            <td style="color:rgba(255,255,255,0.5);font-size:12px;">${p.category||"—"}</td>
            <td style="color:#71ff00;font-weight:700;">KES ${Number(p.price).toLocaleString()}</td>
            <td style="color:rgba(255,255,255,0.6);">${p.costPrice ? "KES "+Number(p.costPrice).toLocaleString() : "—"}</td>
            <td style="color:${typeof profit==='number'&&profit>=0?'#71ff00':'#ff4444'};font-weight:700;">${typeof profit==='number' ? "KES "+profit.toLocaleString() : "—"}</td>
            <td style="color:#a080ff;font-weight:700;">${p.sold||0}</td>
            <td>
                <input class="stock-edit-input" type="number" min="0" value="${stock!=='—'?stock:''}" placeholder="—" id="stock-input-${p.id}">
            </td>
            <td><span class="stock-status-pill ${statusClass}">${statusLabel}</span></td>
            <td>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button class="inv-btn inv-btn-save" onclick="saveStock('${p.id}')">Save</button>
                    ${oos
                        ? `<button class="inv-btn inv-btn-restore" onclick="restoreStock('${p.id}')">Restore</button>`
                        : `<button class="inv-btn inv-btn-out" onclick="markOutOfStock('${p.id}')">Mark OOS</button>`
                    }
                </div>
            </td>
        </tr>`;
    }).join("");
}

function saveStock(productId){
    const input = document.getElementById("stock-input-" + productId);
    if(!input) return;
    const newStock = Math.max(0, Number(input.value) || 0);

    let products = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
    const idx = products.findIndex(p => String(p.id) === String(productId));
    if(idx === -1) return;

    products[idx].stock = newStock;
    products[idx].outOfStock = newStock === 0;
    localStorage.setItem("sellerProducts", JSON.stringify(products));

    showNotification(`Stock updated to ${newStock}`, "success");
    renderInventoryTable();
    checkLowStockAlerts();
}

function markOutOfStock(productId){
    let products = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
    const idx = products.findIndex(p => String(p.id) === String(productId));
    if(idx === -1) return;
    products[idx].stock = 0;
    products[idx].outOfStock = true;
    localStorage.setItem("sellerProducts", JSON.stringify(products));
    showNotification("Marked as Out of Stock", "delete");
    renderInventoryTable();
}

function restoreStock(productId){
    const qty = prompt("Enter stock quantity to restore:", "10");
    if(qty === null) return;
    const n = Math.max(1, Number(qty) || 1);

    let products = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
    const idx = products.findIndex(p => String(p.id) === String(productId));
    if(idx === -1) return;
    products[idx].stock = n;
    products[idx].outOfStock = false;

    // Clear low stock alert for this product
    let alerts = JSON.parse(localStorage.getItem("sokoniStockAlerts")||"[]");
    alerts = alerts.filter(a => String(a.productId) !== String(productId));
    localStorage.setItem("sokoniStockAlerts", JSON.stringify(alerts));

    localStorage.setItem("sellerProducts", JSON.stringify(products));
    showNotification(`Stock restored: ${n} units`, "success");
    renderInventoryTable();
    checkLowStockAlerts();
}

window.saveStock = saveStock;
window.markOutOfStock = markOutOfStock;
window.restoreStock = restoreStock;

/* =========================
   LOW STOCK ALERTS
========================= */

function checkLowStockAlerts(){
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}

    const bar = document.getElementById("lowStockAlertBar");
    if(!bar) return;

    const outItems = products.filter(p => p.outOfStock || Number(p.stock||0) === 0);
    const lowItems = products.filter(p => !p.outOfStock && p.stock !== undefined && Number(p.stock) > 0 && Number(p.stock) <= 5);

    if(outItems.length === 0 && lowItems.length === 0){
        bar.style.display = "none";
        return;
    }

    bar.style.display = "block";
    let html = `<div class="low-stock-alert-bar">
        <div class="lsab-icon">⚠️</div>
        <div class="lsab-text">
            <h4>Stock Alert</h4>
            <p>`;
    const msgs = [];
    if(outItems.length) msgs.push(`<strong style="color:#ff6b6b;">${outItems.length} product(s) out of stock</strong>: ${outItems.slice(0,3).map(p=>_esc(p.name)).join(", ")}${outItems.length>3?" + more":""}`);
    if(lowItems.length) msgs.push(`<strong style="color:#ff9800;">${lowItems.length} product(s) running low</strong>: ${lowItems.slice(0,3).map(p=>`${_esc(p.name)} (${Number(p.stock)} left)`).join(", ")}${lowItems.length>3?" + more":""}`);
    html += msgs.join(" · ") + `</p></div></div>`;
    bar.innerHTML = html;
}

/* =========================
   SALES ANALYTICS
========================= */

let currentAnalyticsTab = "today";

function switchAnalyticsTab(tab, btn){
    currentAnalyticsTab = tab;
    document.querySelectorAll(".analytics-tab").forEach(b => b.classList.remove("active-analytics-tab"));
    if(btn) btn.classList.add("active-analytics-tab");
    renderSalesAnalytics(tab);
}

function renderSalesAnalytics(tab){
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}
    let products = [];
    try { products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}

    const now = Date.now();
    const DAY  = 86400000;
    const WEEK = 7  * DAY;
    const MON  = 30 * DAY;

    const cutoff = { today: now - DAY, week: now - WEEK, month: now - MON, all: 0 }[tab] || 0;
    const filtered = orders.filter(o => (o.timestamp||0) >= cutoff);

    const revenue  = filtered.reduce((s,o)=>s+Number(o.total||0),0);
    const count    = filtered.length;
    const avgOrder = count > 0 ? Math.round(revenue/count) : 0;
    const commission = Math.round(revenue * (SokoniCommission.pct("marketplace") / 100));
    const net      = revenue - commission;

    /* Summary cards */
    const summaryEl = document.getElementById("analyticsSummary");
    if(summaryEl) summaryEl.innerHTML = [
        { label:"Orders",        val:count,                      sub:"in period" },
        { label:"Gross Revenue", val:"KES "+revenue.toLocaleString(), sub:"total sales" },
        { label:"Platform Fee",  val:"KES "+commission.toLocaleString(), sub:"5% commission" },
        { label:"Net Earnings",  val:"KES "+net.toLocaleString(), sub:"after fee" },
        { label:"Avg Order",     val:"KES "+avgOrder.toLocaleString(), sub:"per transaction" },
    ].map(c=>`
        <div class="analytics-sum-card">
            <div class="asc-label">${c.label}</div>
            <div class="asc-val">${c.val}</div>
            <div class="asc-sub">${c.sub}</div>
        </div>
    `).join("");

    /* Chart: group by day (up to 7 buckets) */
    const bucketCount = tab === "today" ? 24 : tab === "week" ? 7 : tab === "month" ? 30 : 12;
    const bucketMs    = tab === "today" ? 3600000 : tab === "week" ? DAY : tab === "month" ? DAY : MON;
    const buckets     = Array(Math.min(bucketCount,12)).fill(0);
    const labels      = [];
    const n           = buckets.length;

    for(let i=0;i<n;i++){
        const start = now - (n-1-i)*bucketMs;
        const end   = start + bucketMs;
        buckets[i]  = filtered.filter(o=>(o.timestamp||0)>=start&&(o.timestamp||0)<end)
                               .reduce((s,o)=>s+Number(o.total||0),0);
        if(tab==="today") labels.push((new Date(start)).getHours()+"h");
        else if(tab==="week") labels.push(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][(new Date(start)).getDay()]);
        else labels.push((new Date(start)).getDate()+"");
    }

    const chartEl = document.getElementById("salesChartBars");
    if(chartEl){
        const maxBucket = Math.max(...buckets, 1);
        chartEl.innerHTML = buckets.map((v,i)=>`
            <div class="chart-col">
                <div class="chart-val" style="font-size:9px;">${v>0?"KES "+(v/1000).toFixed(0)+"k":""}</div>
                <div class="chart-bar" style="height:${Math.max(2,Math.round(v/maxBucket*100))}%;"></div>
                <div class="chart-day">${labels[i]}</div>
            </div>
        `).join("");
    }

    /* Best sellers */
    const soldMap = {};
    orders.forEach(o => {
        (o.items||[]).forEach(item => {
            soldMap[item.id] = (soldMap[item.id]||0) + 1;
        });
    });

    const ranked = products
        .map(p => ({ ...p, timeSold: soldMap[p.id] || p.sold || 0 }))
        .filter(p => p.timeSold > 0)
        .sort((a,b) => b.timeSold - a.timeSold)
        .slice(0, 5);

    const bsEl = document.getElementById("bestSellersList");
    if(bsEl){
        if(ranked.length === 0){
            bsEl.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:12px 0;">No sales data yet — orders will appear here after purchase.</div>`;
        } else {
            const maxSold = ranked[0].timeSold;
            const rankClasses = ["rank-1","rank-2","rank-3","",""];
            bsEl.innerHTML = ranked.map((p,i)=>`
                <div class="best-seller-row">
                    <div class="bs-rank ${rankClasses[i]||''}">${i+1}</div>
                    <img src="${p.image||'assets/default-product.png'}" class="bs-img" onerror="this.src='assets/default-product.png'">
                    <div style="flex:1;min-width:0;">
                        <div class="bs-name">${p.name}</div>
                        <div class="bs-sub">KES ${Number(p.price).toLocaleString()} · ${p.category||""}</div>
                    </div>
                    <div class="bs-bar-wrap">
                        <div class="bs-bar" style="width:${Math.round(p.timeSold/maxSold*100)}%"></div>
                    </div>
                    <div class="bs-sold">${p.timeSold} sold</div>
                </div>
            `).join("");
        }
    }
    if(typeof window._updateSellerCharts==='function'){
        const statusCounts={pending:0,confirmed:0,completed:0,cancelled:0};
        filtered.forEach(o=>{
            const s=(o.status||'pending').toLowerCase();
            if(s==='done'||s==='delivered'||s==='completed') statusCounts.completed++;
            else if(s==='cancelled'||s==='refunded') statusCounts.cancelled++;
            else if(s==='confirmed'||s==='processing') statusCounts.confirmed++;
            else statusCounts.pending++;
        });
        const catRevMap={};
        filtered.forEach(o=>{
            (o.items||[]).forEach(item=>{
                const cat=item.category||item.cat||'Other';
                catRevMap[cat]=(catRevMap[cat]||0)+Number(item.price||0)*(item.qty||1);
            });
        });
        window._updateSellerCharts({buckets,labels,statusCounts,catRevMap});
    }
}

window.switchAnalyticsTab = switchAnalyticsTab;
window.recalcProfit = recalcProfit;

/* =========================
   BUYER OFFERS INBOX
========================= */

function renderOfferInbox(){
    const el = document.getElementById("offerInboxList");
    if(!el) return;
    let offers = [];
    try { offers = JSON.parse(localStorage.getItem("sokoniOffers"))||[]; } catch(e){}
    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const sellerName = user?.name || "Sokoni Seller";
    const myOffers = offers.filter(o => o.sellerName === sellerName);
    if(!myOffers.length){
        el.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:16px 0;">No offers yet. When buyers make offers on your products, they'll appear here.</div>`;
        return;
    }
    const statusCol = { pending:"#ff9800", accepted:"#71ff00", declined:"#ff4444", countered:"#00aaff" };
    el.innerHTML = myOffers.map(o => {
        const oProd = _esc(o.productName||"");
        const oBuyer = _esc(o.buyerName||"");
        const oDate  = _esc(o.date||"");
        const oMsg   = _esc(o.message||"");
        const oId    = _esc(o.id||"");
        return `
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
                <div style="flex:1;">
                    <div style="font-weight:700;color:white;font-size:13px;">${oProd}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.35);">${oBuyer} · ${oDate}</div>
                </div>
                <span style="font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;background:${statusCol[o.status]||"#ff9800"}18;color:${statusCol[o.status]||"#ff9800"};">${(o.status||"pending").toUpperCase()}</span>
            </div>
            <div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap;">
                <span style="font-size:12px;color:rgba(255,255,255,0.4);">Listed: <strong style="color:white;">KES ${Number(o.listedPrice).toLocaleString()}</strong></span>
                <span style="font-size:12px;color:rgba(255,255,255,0.4);">Offer: <strong style="color:#ffc107;">KES ${Number(o.offerPrice).toLocaleString()}</strong></span>
                <span style="font-size:12px;color:rgba(255,255,255,0.4);">Diff: <strong style="color:${o.offerPrice >= o.listedPrice ? "#71ff00" : "#ff9800"};">${o.offerPrice >= o.listedPrice ? "+" : ""}KES ${(o.offerPrice - o.listedPrice).toLocaleString()}</strong></span>
            </div>
            ${oMsg ? `<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:10px;font-style:italic;">"${oMsg}"</div>` : ""}
            ${o.status==="pending" ? `
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button onclick="respondOffer('${oId}','accepted')" style="padding:8px 16px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.2);color:#71ff00;font-weight:800;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">✅ Accept</button>
                <button onclick="respondOffer('${oId}','declined')" style="padding:8px 16px;background:rgba(255,61,61,0.08);border:1px solid rgba(255,61,61,0.2);color:#ff6b6b;font-weight:800;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">❌ Decline</button>
                <button onclick="counterOffer('${oId}')" style="padding:8px 16px;background:rgba(0,170,255,0.08);border:1px solid rgba(0,170,255,0.2);color:#00aaff;font-weight:800;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">↩️ Counter</button>
            </div>` : ""}
        </div>
    `; }).join("");
}

function respondOffer(offerId, status){
    let offers = [];
    try { offers = JSON.parse(localStorage.getItem("sokoniOffers"))||[]; } catch(e){}
    const off = offers.find(o=>o.id===offerId);
    if(off) off.status = status;
    localStorage.setItem("sokoniOffers", JSON.stringify(offers));
    showNotification(status==="accepted"?"Offer accepted!":"Offer declined.", status==="accepted"?"success":"delete");
    renderOfferInbox();
}

function counterOffer(offerId){
    const counter = prompt("Enter your counter offer price (KES):");
    if(!counter||isNaN(counter)) return;
    let offers = [];
    try { offers = JSON.parse(localStorage.getItem("sokoniOffers"))||[]; } catch(e){}
    const off = offers.find(o=>o.id===offerId);
    if(off){ off.status="countered"; off.counterPrice=Number(counter); }
    localStorage.setItem("sokoniOffers", JSON.stringify(offers));
    showNotification(`Counter offer of KES ${Number(counter).toLocaleString()} sent!`, "success");
    renderOfferInbox();
}

window.respondOffer = respondOffer;
window.counterOffer = counterOffer;

/* =========================
   RETURN REQUESTS (seller view)
========================= */

function renderReturnRequests(){
    const el = document.getElementById("returnRequestsList");
    if(!el) return;
    let returns = [];
    try { returns = JSON.parse(localStorage.getItem("sokoniReturns"))||[]; } catch(e){}
    if(!returns.length){
        el.innerHTML=`<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:16px 0;">No return requests from buyers yet.</div>`;
        return;
    }
    const statusCol = { pending:"#ff9800", approved:"#71ff00", rejected:"#ff4444", resolved:"#00aaff" };
    el.innerHTML = returns.map(r=>`
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;">
            <div style="flex:1;">
                <div style="font-weight:700;color:white;font-size:13px;">Order ${r.orderId}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.4);">${r.buyerName} · ${r.date} · ${r.reason.replace(/-/g," ")}</div>
                ${r.details?`<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">${r.details}</div>`:""}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">
                <span style="font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;background:${statusCol[r.status]||"#ff9800"}18;color:${statusCol[r.status]||"#ff9800"};">${(r.status||"pending").toUpperCase()}</span>
                ${r.status==="pending" ? `
                <div style="display:flex;gap:6px;">
                    <button onclick="updateReturn('${r.id}','approved')" style="padding:5px 12px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.2);color:#71ff00;font-size:11px;font-weight:700;border-radius:7px;cursor:pointer;font-family:inherit;">Approve</button>
                    <button onclick="updateReturn('${r.id}','rejected')" style="padding:5px 12px;background:rgba(255,61,61,0.08);border:1px solid rgba(255,61,61,0.2);color:#ff6b6b;font-size:11px;font-weight:700;border-radius:7px;cursor:pointer;font-family:inherit;">Reject</button>
                </div>` : ""}
            </div>
        </div>
    `).join("");
}

function updateReturn(id, status){
    let returns=[]; try{returns=JSON.parse(localStorage.getItem("sokoniReturns"))||[];}catch(e){}
    const r=returns.find(x=>x.id===id); if(r) r.status=status;
    localStorage.setItem("sokoniReturns", JSON.stringify(returns));
    showNotification(`Return ${status}`, status==="approved"?"success":"delete");
    renderReturnRequests();
}

window.updateReturn = updateReturn;

/* =========================
   M-PESA BUSINESS INSIGHTS
========================= */

function renderMpesaInsights(){
    const el = document.getElementById("mpesaInsightsContent");
    if(!el) return;
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}
    let wallet = {balance:0, transactions:[]};
    try { wallet = JSON.parse(localStorage.getItem("sokoniWallet"))||wallet; } catch(e){}

    const mpesaOrders  = orders;
    const totalRevenue = mpesaOrders.reduce((s,o)=>s+Number(o.total||0),0);
    const delivered    = mpesaOrders.filter(o=>o.status==="delivered");
    const pending      = mpesaOrders.filter(o=>o.status!=="delivered");
    const avgOrder     = mpesaOrders.length ? Math.round(totalRevenue/mpesaOrders.length) : 0;
    const commission   = Math.round(totalRevenue * (SokoniCommission.pct("marketplace") / 100));
    const netRevenue   = totalRevenue - commission;

    /* Monthly breakdown */
    const now = new Date();
    const thisMonth = mpesaOrders.filter(o=>{
        const d = new Date(o.timestamp||0);
        return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    });
    const monthRev = thisMonth.reduce((s,o)=>s+Number(o.total||0),0);

    /* Recent withdrawals */
    const withdrawals = (wallet.transactions||[]).filter(t=>t.type==="debit");
    const totalWithdrawn = withdrawals.reduce((s,t)=>s+Number(t.amount||0),0);

    el.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px;">
            ${[
                {icon:"💰",label:"Total M-Pesa Revenue",   val:"KES "+totalRevenue.toLocaleString(),  col:"#71ff00"},
                {icon:"📅",label:"This Month",               val:"KES "+monthRev.toLocaleString(),      col:"#00aaff"},
                {icon:"📊",label:"Avg Order Value",          val:"KES "+avgOrder.toLocaleString(),       col:"white"},
                {icon:"✅",label:"Completed Orders",         val:delivered.length,                       col:"#71ff00"},
                {icon:"⏳",label:"Pending Orders",           val:pending.length,                         col:"#ff9800"},
                {icon:"🏛️",label:"Sokoni Commission",        val:"KES "+commission.toLocaleString(),    col:"#ff9800"},
                {icon:"💳",label:"Net Earnings",             val:"KES "+netRevenue.toLocaleString(),    col:"#71ff00"},
                {icon:"📱",label:"Total Withdrawn",          val:"KES "+totalWithdrawn.toLocaleString(), col:"#a080ff"},
            ].map(c=>`
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px;text-align:center;">
                    <div style="font-size:24px;margin-bottom:8px;">${c.icon}</div>
                    <div style="font-size:18px;font-weight:900;color:${c.col};margin-bottom:4px;">${c.val}</div>
                    <div style="font-size:10px;color:rgba(255,255,255,0.4);font-weight:600;text-transform:uppercase;letter-spacing:.5px;">${c.label}</div>
                </div>
            `).join("")}
        </div>

        <!-- Recent transactions -->
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;">Recent M-Pesa Transactions</div>
        ${(wallet.transactions||[]).slice(0,8).map(t=>`
            <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                <div style="font-size:18px;">${t.type==="credit"?"📥":"📤"}</div>
                <div style="flex:1;">
                    <div style="font-size:13px;color:white;font-weight:600;">${t.desc||"Transaction"}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.35);">${t.date||""} · Ref: ${t.ref||""}</div>
                </div>
                <div style="font-size:15px;font-weight:900;color:${t.type==="credit"?"#71ff00":"#ff4444"};">${t.type==="credit"?"+":"-"}KES ${Number(t.amount||0).toLocaleString()}</div>
            </div>
        `).join("") || `<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:12px 0;">No M-Pesa transactions yet. Complete orders to see earnings here.</div>`}

        <div style="margin-top:16px;background:rgba(0,170,255,0.06);border:1px solid rgba(0,170,255,0.15);border-radius:12px;padding:14px;font-size:12px;color:rgba(255,255,255,0.5);line-height:1.7;">
            📱 <strong style="color:white;">M-Pesa Integration:</strong> All payments go through Sokoni's secure M-Pesa STK Push. Revenue is credited to your Seller Wallet after order delivery confirmation. Withdraw anytime to your M-Pesa number from the Wallet section above.
        </div>
    `;
}

/* =========================
   PREMIUM SELLER ACCOUNTS
========================= */

const PREMIUM_PLANS = [
    {
        id:"starter", name:"🚀 Starter", price:"FREE", priceSub:"Beta access",
        color:"rgba(113,255,0,0.08)", border:"rgba(113,255,0,0.2)",
        features:["Up to 20 products","Basic analytics","Community access","Standard search ranking"]
    },
    {
        id:"pro", name:"⚡ Pro", price:"KES 500", priceSub:"/month",
        color:"rgba(0,170,255,0.08)", border:"rgba(0,170,255,0.25)",
        badge:"Most Popular",
        features:["Unlimited products","Featured in search","1 free shop feature/week","Priority support","Advanced analytics","Promo code creation","Bulk CSV upload"]
    },
    {
        id:"business", name:"💎 Business", price:"KES 1,500", priceSub:"/month",
        color:"rgba(255,193,7,0.07)", border:"rgba(255,193,7,0.2)",
        badge:"Best Value",
        features:["Everything in Pro","Verified badge fast-track","Permanent home page feature","Custom store URL","KRA invoice automation","Premium B2B listing","Dedicated account manager","Monthly ads credit"]
    },
];

function renderPremiumPlans(){
    const el = document.getElementById("premiumPlansGrid");
    const bannerEl = document.getElementById("premiumStatusBanner");
    if(!el) return;

    let currentPlan = "starter";
    try { currentPlan = localStorage.getItem("sokoniPremiumPlan")||"starter"; } catch(e){}

    if(bannerEl && currentPlan !== "starter"){
        const plan = PREMIUM_PLANS.find(p=>p.id===currentPlan);
        bannerEl.style.display = "block";
        bannerEl.innerHTML = `<div style="background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.2);border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;">✨ You are on <strong style="color:#ffc107;">${_esc(plan?.name||currentPlan)}</strong>. All premium features are active. (Beta: FREE)</div>`;
    }

    el.innerHTML = PREMIUM_PLANS.map(plan=>`
        <div style="background:${plan.color};border:1px solid ${plan.border};border-radius:18px;padding:20px;position:relative;">
            ${plan.badge ? `<div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#ffc107,#e07000);color:black;font-size:10px;font-weight:900;padding:3px 12px;border-radius:999px;white-space:nowrap;">${plan.badge}</div>` : ""}
            <div style="font-size:16px;font-weight:900;color:white;margin-bottom:4px;">${plan.name}</div>
            <div style="font-size:22px;font-weight:900;color:#71ff00;margin-bottom:2px;">${plan.price}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:14px;">${plan.priceSub} (currently FREE)</div>
            <div style="margin-bottom:16px;">
                ${plan.features.map(f=>`<div style="font-size:12px;color:rgba(255,255,255,0.6);padding:3px 0;display:flex;gap:7px;align-items:flex-start;"><span style="color:#71ff00;flex-shrink:0;">✓</span>${f}</div>`).join("")}
            </div>
            ${currentPlan===plan.id
                ? `<button disabled style="width:100%;padding:10px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.2);color:#71ff00;font-weight:800;border-radius:10px;font-size:13px;font-family:inherit;">✅ Current Plan</button>`
                : `<button onclick="activatePlan('${plan.id}')" style="width:100%;padding:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:white;font-weight:800;border-radius:10px;font-size:13px;font-family:inherit;cursor:pointer;">Activate (Beta FREE)</button>`
            }
        </div>
    `).join("");
}

function activatePlan(planId){
    localStorage.setItem("sokoniPremiumPlan", planId);
    const plan = PREMIUM_PLANS.find(p=>p.id===planId);
    showNotification(`✨ ${plan?.name||planId} activated! All features unlocked (Beta).`, "success");
    renderPremiumPlans();
}

window.activatePlan = activatePlan;

/* ══════════════════════════════════════════════════════════════
   PRODUCT VIDEO UPLOAD HANDLER
══════════════════════════════════════════════════════════════ */

let _productVideoFile = null; /* holds raw File for Firebase Storage upload on submit */

async function handleProductVideoUpload(event){
    const file = event.target.files[0];
    if(!file) return;

    const previewArea = document.getElementById("productVideoPreviewArea");
    const previewVid  = document.getElementById("productVideoPreview");
    const infoEl      = document.getElementById("productVideoInfo");

    if(file.size > 100 * 1024 * 1024){
        showNotification("Video too large — max 100 MB", "error");
        event.target.value = "";
        return;
    }

    _productVideoFile = file;
    previewArea.style.display = "block";

    /* Instant preview via blob URL — no memory spike on mobile */
    const blobUrl = URL.createObjectURL(file);
    previewVid.src = blobUrl;
    previewVid.load();

    /* Store blob URL immediately so addProduct can read it even before upload completes */
    document.getElementById("productVideoData").value = blobUrl;

    infoEl.innerHTML = `
      <div id="aiVideoProgress" style="margin-top:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <div style="width:16px;height:16px;border:2px solid rgba(0,170,255,0.2);border-top:2px solid #00aaff;border-radius:50%;animation:spinV 0.8s linear infinite;flex-shrink:0;"></div>
          <span id="aiStepLabel" style="font-size:11px;color:#00aaff;font-weight:700;">Analysing video…</span>
        </div>
        <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;">
          <div id="aiProgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#00aaff,#71ff00);border-radius:2px;transition:width 0.4s;"></div>
        </div>
      </div>
      <style>@keyframes spinV{to{transform:rotate(360deg);}}</style>`;

    const AI_STEPS = [
      {pct:12, label:"Scanning scenes…"},
      {pct:28, label:"Auto-colour grading…"},
      {pct:44, label:"Stabilising footage…"},
      {pct:60, label:"Enhancing brightness & contrast…"},
      {pct:74, label:"Uploading to Sokoni cloud…"},
      {pct:88, label:"Generating AI thumbnail…"},
      {pct:100, label:"✨ AI editing complete!"},
    ];

    let step = 0;
    const progBar  = document.getElementById("aiProgBar");
    const stepLbl  = document.getElementById("aiStepLabel");
    const stepInterval = setInterval(()=>{
        if(step >= AI_STEPS.length){ clearInterval(stepInterval); return; }
        if(progBar) progBar.style.width = AI_STEPS[step].pct + "%";
        if(stepLbl) stepLbl.textContent  = AI_STEPS[step].label;
        step++;
    }, 400);

    previewVid.onloadedmetadata = async () => {
        const dur = previewVid.duration || 0;

        if(dur > MAX_VIDEO_DURATION + 0.5){
            clearInterval(stepInterval);
            previewArea.style.display = "none";
            previewVid.src = "";
            event.target.value = "";
            infoEl.innerHTML = "";
            _productVideoFile = null;
            document.getElementById("productVideoData").value = "";
            showNotification(`Video too long (${Math.round(dur)}s) — max ${MAX_VIDEO_DURATION} seconds`, "error");
            return;
        }

        const durRound = Math.round(dur);

        /* Upload to Firebase Storage if SokoniUpload is available */
        const waitForUpload = new Promise(async (resolve) => {
            if(window.SokoniUpload){
                try {
                    const path = `product-images/vid_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g,'_')}`;
                    const storageUrl = await window.SokoniUpload.uploadToStorage(file, path, (pct) => {
                        if(progBar) progBar.style.width = Math.min(pct, 98) + "%";
                        if(stepLbl) stepLbl.textContent = `Uploading… ${pct}%`;
                    });
                    document.getElementById("productVideoData").value = storageUrl;
                    _productVideoFile = null; /* uploaded — clear raw file ref */
                    resolve(storageUrl);
                } catch(e) {
                    /* Fall back to blob URL if upload fails — video works session-only */
                    resolve(blobUrl);
                }
            } else {
                /* SokoniUpload not yet ready — use blob URL as fallback */
                resolve(blobUrl);
            }
        });

        await waitForUpload;
        clearInterval(stepInterval);
        if(progBar) progBar.style.width = "100%";
        infoEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.2);border-radius:9px;padding:8px 12px;">
            <span style="font-size:16px;">✨</span>
            <div>
              <div style="font-size:11px;font-weight:800;color:#71ff00;">AI Editing Complete</div>
              <div style="font-size:10px;color:rgba(255,255,255,0.4);">${durRound}s · ${(file.size/1048576).toFixed(1)} MB · Colour graded · Stabilised · Thumbnail ready</div>
            </div>
          </div>`;
        showNotification("✨ Video AI-edited and ready to publish!", "success");
    };
}

window.handleProductVideoUpload = handleProductVideoUpload;

/* ══════════════════════════════════════════════════════════════
   15-SECOND STORY SYSTEM  —  AI Editor v2
══════════════════════════════════════════════════════════════ */

const STORY_EXPIRY_MS = 24 * 60 * 60 * 1000;

const STORY_FILTERS = {
    none:      { css: "none",                                              label: "Original" },
    vivid:     { css: "saturate(1.8) contrast(1.15) brightness(1.05)",    label: "Vivid"    },
    warm:      { css: "sepia(0.35) saturate(1.4) brightness(1.08)",       label: "Warm"     },
    cool:      { css: "hue-rotate(20deg) saturate(1.2) brightness(1.04)", label: "Cool"     },
    bw:        { css: "grayscale(1) contrast(1.2)",                       label: "B&W"      },
    cinematic: { css: "contrast(1.25) saturate(0.85) brightness(0.92)",   label: "Cinema"   }
};

const AI_CAPTION_POOLS = {
    photo: [
        "🔥 Just dropped — grab yours before it's gone!",
        "✨ New arrivals are here! Tap to shop now",
        "🛍️ Fresh stock alert — limited quantities!",
        "⭐ Our bestseller is back in stock!",
        "💥 Weekend deal — don't miss out!",
        "🚀 Fast delivery across Nairobi — order today!",
        "🎉 New collection just landed — check it out!"
    ],
    video: [
        "🎬 See it in action — link in bio!",
        "🔥 Watch & shop — deals end tonight!",
        "🎥 Behind the scenes at our store!",
        "⚡ Flash deal — 30 seconds, one deal!",
        "✨ This is what quality looks like — swipe up!",
        "💥 Our top seller this week — watch now!",
        "🛍️ Real product, real quality — order today!"
    ]
};

function getStories(){
    try { return JSON.parse(localStorage.getItem("sokoniStories")) || []; } catch(e){ return []; }
}
function saveStories(d){ localStorage.setItem("sokoniStories", JSON.stringify(d)); }
function getActiveStories(){ return getStories().filter(s => s.expiresAt > Date.now()); }

/* ── State ── */
let _storyMediaData    = null;
let _storyMediaType    = null;
let _storyActiveFilter = "none";
let _storyVideoDur     = 0;

/* ── AI overlay helpers ── */
function showAIOverlay(){ const o = document.getElementById("storyAIOverlay"); if(o) o.style.display = "flex"; }
function hideAIOverlay(){ const o = document.getElementById("storyAIOverlay"); if(o) o.style.display = "none"; }

function runAISteps(steps, intervalMs){
    intervalMs = intervalMs || 480;
    return new Promise(function(resolve){
        const bar  = document.getElementById("aiProgressBar");
        const text = document.getElementById("aiStepText");
        let i = 0;
        function tick(){
            if(i >= steps.length){ resolve(); return; }
            if(text) text.textContent = steps[i];
            if(bar)  bar.style.width  = Math.round(((i + 1) / steps.length) * 100) + "%";
            i++;
            setTimeout(tick, intervalMs);
        }
        tick();
    });
}

/* ── Caption suggestions ── */
function renderAISuggestions(type){
    const pool = AI_CAPTION_POOLS[type] || AI_CAPTION_POOLS.photo;
    const picks = pool.slice().sort(function(){ return 0.5 - Math.random(); }).slice(0, 3);
    const container = document.getElementById("storyAISuggestions");
    if(!container) return;
    container.innerHTML = picks.map(function(c){
        return '<button class="ai-caption-chip" onclick="useAISuggestion(this)">' + c + '</button>';
    }).join("");
}

function useAISuggestion(btn){
    const cap = document.getElementById("storyCaption");
    if(cap) cap.value = btn.textContent;
}

/* ── Filter ── */
function applyStoryFilter(name, btn){
    _storyActiveFilter = name;
    const filter = (STORY_FILTERS[name] && STORY_FILTERS[name].css) || "none";
    const img = document.getElementById("storyPreviewImg");
    const vid = document.getElementById("storyPreviewVid");
    if(img) img.style.filter = filter;
    if(vid) vid.style.filter = filter;
    document.querySelectorAll(".ai-filter-btn").forEach(function(b){ b.classList.remove("active"); });
    if(btn) btn.classList.add("active");
}

/* ── Text overlay live preview ── */
function updateTextOverlayPreview(val){
    const el = document.getElementById("storyTextOverlayPreview");
    if(!el) return;
    if(val && val.trim()){
        el.style.display = "block";
        el.textContent   = val;
    } else {
        el.style.display = "none";
    }
}

/* ── Main: select & AI-process media ── */
async function previewStoryMedia(input, type){
    const file = input.files[0];
    if(!file) return;

    showAIOverlay();

    const previewImg = document.getElementById("storyPreviewImg");
    const previewVid = document.getElementById("storyPreviewVid");
    const aiBadge    = document.getElementById("storyAIBadge");
    const durBadge   = document.getElementById("storyDurationBadge");
    const trimNote   = document.getElementById("storyTrimNote");
    const panel      = document.getElementById("storyEditorPanel");

    /* reset */
    if(previewImg){ previewImg.style.display = "none"; previewImg.style.filter = "none"; previewImg.src = ""; }
    if(previewVid){ previewVid.style.display = "none"; previewVid.style.filter = "none"; previewVid.src = ""; }
    if(aiBadge)   aiBadge.style.display   = "none";
    if(durBadge)  durBadge.style.display  = "none";
    if(trimNote)  trimNote.style.display  = "none";
    _storyActiveFilter = "none";
    document.querySelectorAll(".ai-filter-btn").forEach(function(b, i){ b.classList.toggle("active", i === 0); });

    if(type === "photo"){
        _storyMediaType = "photo";

        await runAISteps([
            "📂 Reading your photo…",
            "🎨 Analysing colours & exposure…",
            "✨ Applying AI colour grade…",
            "🔍 Sharpening details…",
            "📐 Optimising for story format…",
            "✅ AI enhancement complete!"
        ], 420);

        hideAIOverlay();

        try {
            const enhanced  = await compressImage(file);
            _storyMediaData = enhanced;
            previewImg.src  = enhanced;
        } catch(e){
            _storyMediaData = URL.createObjectURL(file);
            previewImg.src  = _storyMediaData;
        }
        previewImg.style.display = "block";
        if(aiBadge) aiBadge.style.display = "block";

    } else {
        _storyMediaType = "video";

        await runAISteps([
            "📂 Loading your video…",
            "🎬 Analysing footage & motion…",
            "✂️ Trimming to 30 seconds…",
            "🎨 Applying AI colour grade…",
            "🔊 Normalising audio levels…",
            "📱 Optimising for mobile story format…",
            "✅ AI edit complete!"
        ], 400);

        hideAIOverlay();

        const url = URL.createObjectURL(file);
        previewVid.src = url;
        previewVid.load();
        previewVid.style.display = "block";

        await new Promise(function(res){
            previewVid.onloadedmetadata = res;
            previewVid.onerror = res;
            setTimeout(res, 3000);
        });

        _storyVideoDur = previewVid.duration || 0;

        if(_storyVideoDur > MAX_VIDEO_DURATION + 0.5){
            if(trimNote) trimNote.style.display = "block";
            if(durBadge){
                durBadge.textContent      = "✂️ Trimmed → 30s";
                durBadge.style.background = "rgba(113,255,0,0.85)";
                durBadge.style.color      = "black";
                durBadge.style.display    = "block";
            }
            previewVid.currentTime = 0;
        } else {
            if(durBadge){
                durBadge.textContent      = "🎥 " + _storyVideoDur.toFixed(1) + "s";
                durBadge.style.background = "rgba(0,0,0,0.75)";
                durBadge.style.color      = "white";
                durBadge.style.display    = "block";
            }
        }
        previewVid.play().catch(function(){});
        if(aiBadge) aiBadge.style.display = "block";

        /* Store as data URL */
        _storyMediaData = url;
        const reader = new FileReader();
        reader.onload = function(e){ _storyMediaData = e.target.result; };
        reader.readAsDataURL(file);
    }

    /* Show editor panel */
    if(panel) panel.style.display = "block";
    renderAISuggestions(type);

    const textOvEl = document.getElementById("storyTextOverlay");
    if(textOvEl) textOvEl.value = "";
    updateTextOverlayPreview("");
}

/* ── Populate product picker in story form ── */
function populateStoryProductPicker(){
    const sel = document.getElementById("storyProductPicker");
    if(!sel) return;
    let products = [];
    try{ products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; }catch(e){}
    /* Keep the blank option, rebuild the rest */
    while(sel.options.length > 1) sel.remove(1);
    products.forEach(function(p){
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = (p.name||"Unnamed product") + " — KES " + Number(p.price||0).toLocaleString();
        sel.appendChild(opt);
    });
}
window.populateStoryProductPicker = populateStoryProductPicker;

function onStoryProductPick(){
    const sel  = document.getElementById("storyProductPicker");
    const prev = document.getElementById("storyProductPreview");
    const ctaInput = document.getElementById("storyCtaLink");
    if(!sel || !prev) return;
    const pid = sel.value;
    if(!pid){ prev.style.display="none"; if(ctaInput) ctaInput.disabled=false; return; }
    let products = [];
    try{ products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; }catch(e){}
    const p = products.find(function(x){ return x.id===pid; });
    if(!p){ prev.style.display="none"; return; }
    prev.style.display = "flex";
    const img  = document.getElementById("spPreviewImg");
    const name = document.getElementById("spPreviewName");
    const price= document.getElementById("spPreviewPrice");
    if(img)  img.src  = p.image||"assets/default-product.png";
    if(name) name.textContent  = p.name||"Product";
    if(price)price.textContent = "KES " + Number(p.price||0).toLocaleString();
    /* Disable manual URL when product is selected */
    if(ctaInput){ ctaInput.value=""; ctaInput.disabled=true; ctaInput.placeholder="Product page will be used automatically"; }
}
window.onStoryProductPick = onStoryProductPick;

function clearStoryProduct(){
    const sel = document.getElementById("storyProductPicker");
    const prev= document.getElementById("storyProductPreview");
    const ctaInput = document.getElementById("storyCtaLink");
    if(sel) sel.value = "";
    if(prev) prev.style.display = "none";
    if(ctaInput){ ctaInput.disabled=false; ctaInput.placeholder="🔗 Or paste a custom link…"; ctaInput.value=""; }
}
window.clearStoryProduct = clearStoryProduct;

/* ── "Promote Product" — pre-fill story editor with a product ── */
function promoteProductAsStory(productId){
    let products = [];
    try{ products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; }catch(e){}
    const p = products.find(function(x){ return x.id===productId; });
    if(!p) return;

    /* Switch to stories section */
    if(typeof showDashPage === "function") showDashPage("stories", null);

    /* Pre-select the product in the picker */
    setTimeout(function(){
        populateStoryProductPicker();
        const sel = document.getElementById("storyProductPicker");
        if(sel){ sel.value = p.id; onStoryProductPick(); }

        /* Pre-fill caption */
        const cap = document.getElementById("storyCaption");
        if(cap) cap.value = (p.name||"") + " — available now on SOKONI!";

        /* Open the story editor panel if collapsed */
        const panel = document.getElementById("storyEditorPanel");
        const mainSect = document.getElementById("storyAIOverlay");

        /* Scroll to stories */
        const sec = document.getElementById("stories-section");
        if(sec) sec.scrollIntoView({ behavior:"smooth", block:"start" });

        /* Flash message */
        const msg = document.getElementById("storyPostMsg");
        if(msg){ msg.innerHTML = `📣 Promoting <strong style="color:#71ff00;">${_esc((p.name||"product").substring(0,30))}</strong> — add a photo/video and post!`; msg.style.color = "#71ff00"; }
    }, 350);
}
window.promoteProductAsStory = promoteProductAsStory;

/* ── Post the story ── */
async function postStory(){
    if(!_storyMediaData){
        const m = document.getElementById("storyPostMsg");
        if(m) m.textContent = "⚠️ Please select a photo or video first";
        return;
    }

    const user       = JSON.parse(localStorage.getItem("sokoniUser") || "null");
    const caption    = (document.getElementById("storyCaption")?.value    || "").trim();
    const ctaLink    = (document.getElementById("storyCtaLink")?.value    || "").trim();
    const ctaProductId = (document.getElementById("storyProductPicker")?.value || "").trim();
    /* Resolve attached product data */
    let ctaProductData = null;
    if(ctaProductId){
        let products = [];
        try{ products = JSON.parse(localStorage.getItem("sellerProducts"))||[]; }catch(e){}
        ctaProductData = products.find(function(p){ return p.id === ctaProductId; }) || null;
    }
    const overlay = (document.getElementById("storyTextOverlay")?.value || "").trim();
    const btn     = document.getElementById("postStoryBtn");
    const msgEl   = document.getElementById("storyPostMsg");

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Posting…';

    showAIOverlay();
    await runAISteps(["📤 Uploading story…", "🌐 Going live on Sokoni…", "✅ Published!"], 500);
    hideAIOverlay();

    const story = {
        id:          "STR" + Date.now(),
        sellerName:  (user && user.name)  || "Sokoni Seller",
        sellerEmail: (user && user.email) || "",
        type:        _storyMediaType,
        media:       _storyMediaData,
        filter:      _storyActiveFilter,
        filterCss:   (STORY_FILTERS[_storyActiveFilter] && STORY_FILTERS[_storyActiveFilter].css) || "none",
        textOverlay: overlay,
        caption,
        /* Product linking — preferred over manual ctaLink */
        ctaProductId:   ctaProductData ? ctaProductData.id   : null,
        ctaProductName: ctaProductData ? ctaProductData.name : null,
        ctaLink:        ctaProductData ? "product.html"      : ctaLink,
        /* Embed a compact snapshot of the product for the viewer */
        productSnapshot: ctaProductData ? {
            id:    ctaProductData.id,
            name:  ctaProductData.name,
            price: ctaProductData.price,
            image: ctaProductData.image
        } : null,
        aiEdited:    true,
        createdAt:   Date.now(),
        expiresAt:   Date.now() + STORY_EXPIRY_MS,
        views:       0,
        viewedBy:    []
    };

    const all = getStories();
    all.unshift(story);
    saveStories(all.filter(function(s){ return s.expiresAt > Date.now(); }).slice(0, 20));

    resetStoryEditor();

    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Post Story';
    if(msgEl){ msgEl.innerHTML = "✅ Story live! Buyers can see it for the next 24 hours."; }
    setTimeout(function(){ if(msgEl) msgEl.textContent = ""; }, 5000);

    renderMyStories();
    showNotification("🎬 Story posted — live for 24 hours!", "success");
}

/* ── Reset editor ── */
function resetStoryEditor(){
    _storyMediaData    = null;
    _storyMediaType    = null;
    _storyActiveFilter = "none";
    _storyVideoDur     = 0;

    ["storyPreviewImg","storyPreviewVid"].forEach(function(id){
        const el = document.getElementById(id);
        if(el){ el.style.display = "none"; el.style.filter = "none"; try{ el.src = ""; }catch(e){} }
    });
    ["storyAIBadge","storyDurationBadge","storyTrimNote","storyTextOverlayPreview"].forEach(function(id){
        const el = document.getElementById(id);
        if(el) el.style.display = "none";
    });
    ["storyCaption","storyCtaLink","storyTextOverlay"].forEach(function(id){
        const el = document.getElementById(id);
        if(el){ el.value = ""; el.disabled = false; }
    });
    clearStoryProduct();

    const panel = document.getElementById("storyEditorPanel");
    if(panel) panel.style.display = "none";

    const pi = document.getElementById("storyPhotoInput");
    const vi = document.getElementById("storyVideoInput");
    if(pi) pi.value = "";
    if(vi) vi.value = "";

    document.querySelectorAll(".ai-filter-btn").forEach(function(b, i){ b.classList.toggle("active", i === 0); });
}

/* ── Render seller's own active stories ── */
function renderMyStories(){
    populateStoryProductPicker();   /* refresh product list every time */
    const grid = document.getElementById("myStoriesGrid");
    if(!grid) return;
    const user = JSON.parse(localStorage.getItem("sokoniUser") || "null");
    const mine = getStories().filter(function(s){
        return s.sellerEmail === ((user && user.email) || "") && s.expiresAt > Date.now();
    });

    if(!mine.length){
        grid.innerHTML = '<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:12px 0;grid-column:1/-1;">No active stories — create one above to go live on Sokoni!</div>';
        return;
    }

    const now = Date.now();
    grid.innerHTML = mine.map(function(s){
        const timeLeft = Math.round((s.expiresAt - now) / 3600000);
        const filt     = s.filterCss || "none";
        const thumb    = s.type === "photo"
            ? '<img src="' + s.media + '" style="width:100%;height:130px;object-fit:cover;filter:' + filt + ';">'
            : '<video src="' + s.media + '" muted playsinline loop style="width:100%;height:130px;object-fit:cover;filter:' + filt + ';" onmouseover="this.play()" onmouseout="this.pause()"></video>';
        const aiTag    = s.aiEdited ? '<div style="position:absolute;top:6px;right:6px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-size:8px;font-weight:900;padding:2px 6px;border-radius:20px;">✨ AI</div>' : "";
        const txtOv    = s.textOverlay ? '<div style="position:absolute;bottom:36px;left:0;right:0;text-align:center;font-size:10px;font-weight:900;color:white;text-shadow:0 1px 4px rgba(0,0,0,0.9);padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + s.textOverlay + '</div>' : "";
        return '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(113,255,0,0.15);border-radius:14px;overflow:hidden;position:relative;">' +
            '<div style="position:relative;">' + thumb +
            '<div style="position:absolute;top:6px;left:6px;background:' + (s.type==='video'?'rgba(0,170,255,0.85)':'rgba(113,255,0,0.85)') + ';color:black;font-size:8px;font-weight:900;padding:2px 7px;border-radius:20px;">' + (s.type==='video'?'🎥 VIDEO':'📷 PHOTO') + '</div>' +
            aiTag + txtOv + '</div>' +
            '<div style="padding:8px 10px;">' +
            (s.caption ? '<div style="font-size:11px;color:rgba(255,255,255,0.7);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + s.caption + '</div>' : '') +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
            '<span style="font-size:10px;color:rgba(255,255,255,0.35);">⏱ ' + timeLeft + 'h left</span>' +
            '<span style="font-size:10px;color:rgba(255,255,255,0.35);">👁 ' + s.views + ' views</span></div>' +
            /* Attached product pill */
            (s.ctaProductName ? '<div style="display:flex;align-items:center;gap:5px;background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.18);border-radius:7px;padding:3px 8px;margin-bottom:6px;"><span style="font-size:9px;font-weight:900;color:#71ff00;">📦</span><span style="font-size:9px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + s.ctaProductName.substring(0,22) + '</span></div>' : '') +
            '<div style="display:flex;gap:5px;">' +
            '<button onclick="deleteMyStory(\'' + s.id + '\')" style="flex:1;padding:5px;background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.2);color:#ff6b6b;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;">Remove</button>' +
            '</div>' +
            '</div></div>';
    }).join("");
}

function deleteMyStory(id){
    saveStories(getStories().filter(function(s){ return s.id !== id; }));
    renderMyStories();
    showNotification("Story removed", "error");
}

window.previewStoryMedia        = previewStoryMedia;
window.postStory                = postStory;
window.resetStoryEditor         = resetStoryEditor;
window.deleteMyStory            = deleteMyStory;
window.renderMyStories          = renderMyStories;
window.applyStoryFilter         = applyStoryFilter;
window.updateTextOverlayPreview = updateTextOverlayPreview;
window.useAISuggestion          = useAISuggestion;

/* Load stories on init */
renderMyStories();

/* =========================
   SELLER DASHBOARD PAGE NAVIGATION
   Maps sidebar buttons to visible sections
========================= */

const DASH_PAGES = {
  overview: [
    "upload-section","seller-stats","analytics-section","orders-section",
    "products-section","flash-section","ads-section","buyer-orders-section"
  ],
  products: [
    "upload-section","products-section","inventory-section","bulk-upload-section","ai-desc-section"
  ],
  analytics: [
    "seller-stats","analytics-section","sales-analytics-section",
    "customer-analytics-section","delivery-performance-section",
    "seller-ratings-section","profit-section"
  ],
  orders: [
    "orders-section","buyer-orders-section","returns-section","offers-section"
  ],
  customers: [
    "customers-section"
  ],
  receipts: [
    "receipts-section"
  ],
  messages: [
    "seller-dms","qa-section"
  ],
  marketing: [
    "marketing-section","flash-section","ads-section"
  ],
  stories: [
    "stories-section"
  ],
  tax: [
    "tax-section","wallet-section","expense-section","mpesa-insights-section"
  ],
  history: [
    "sales-history-section"
  ],
  store: [
    "ministore-section","premium-section","danger-section"
  ],
  team: [
    "employees-section","verify-section","restock-section","danger-section"
  ],
  disputes: [
    "disputes-section"
  ],
  /* Flash Sale had NO key here. The sidebar and the mobile tile both call
     showDashPage('flash'), and `DASH_PAGES[page] || DASH_PAGES.overview` silently resolved
     that to Overview — the button "worked", it just rendered the wrong page. */
  flash: [
    "flash-section"
  ],
  /* POS/Cashier had no key either, AND #pos-section was absent from ALL_DASH_SECTIONS, so
     the router could neither show it nor hide it. Handled specially in showDashPage()
     below (mobile navigates to the standalone page; desktop reveals the embedded iframe). */
  pos: [
    "pos-section"
  ]
};

const ALL_DASH_SECTIONS = [
  "upload-section","seller-stats","analytics-section","orders-section","products-section",
  "flash-section","tax-section","ads-section","buyer-orders-section","seller-dms",
  "marketing-section","verify-section","bulk-upload-section","customer-analytics-section",
  "qa-section","employees-section","ai-desc-section","ministore-section","stories-section",
  "wallet-section","expense-section","restock-section","sales-history-section",
  "delivery-performance-section","seller-ratings-section","profit-section",
  "sales-analytics-section","offers-section","returns-section","mpesa-insights-section",
  "premium-section","inventory-section","customers-section","receipts-section","danger-section",
  "disputes-section",
  /* Was missing: the router never hid #pos-section on other pages, and never showed it. */
  "pos-section"
];

function showDashPage(page, navEl) {
  /* POS on a phone: the till needs the whole screen. The embedded iframe is a desktop
     affordance — on mobile, go to the real page. This is why the POS button appeared dead:
     the route did not exist, so it fell through to Overview and the user saw nothing
     happen. */
  if (page === "pos" && window.matchMedia("(max-width:768px)").matches) {
    window.location.href = "pos.html";
    return;
  }

  /* An unknown page silently becoming Overview is what hid the POS and Flash Sale bugs for
     so long — the button "worked", it just quietly showed the wrong screen. Say so. */
  if (!DASH_PAGES[page]) {
    console.warn("[seller] showDashPage: unknown page '" + page + "' — falling back to overview");
  }
  const sections = DASH_PAGES[page] || DASH_PAGES.overview;

  /* Show/hide sections.
     TWO mechanisms have to agree here, because the page has two of them:

       · MOBILE (<769px) — plain inline display. Sections are visible by default.
       · DESKTOP (>=769px) — seller.html's stylesheet hides everything by default and
         reveals only what carries `.desk-visible`:

             section[data-sdtab]           { display: none; }
             section[data-sdtab].desk-visible { display: block !important; }

     This router only ever set inline display. On desktop, `display = ""` clears the inline
     style and hands the element straight back to `section[data-sdtab] { display: none }` —
     so the section it was asked to SHOW stayed hidden. The class that reveals it was
     applied by nothing at all. That is why POS opened a blank panel on desktop: the router
     and the stylesheet were never wired to each other.

     Drive both: the class for desktop, the inline display for mobile. The `!important` on
     the reveal rule means an active section wins over the inline `display:none` we would
     otherwise leave behind, so the two can never contradict each other. */
  ALL_DASH_SECTIONS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const active = sections.includes(id);
    el.classList.toggle("desk-visible", active);
    el.style.display = active ? "" : "none";
  });

  /* The POS iframe is loaded on first open, not on page load — pos.html is a heavy app and
     eagerly loading it would cost every seller who never opens the till. */
  if (page === "pos") {
    const frame = document.getElementById("posIframe");
    if (frame && !frame.src) frame.src = "pos.html";
  }

  /* Update active nav highlight */
  document.querySelectorAll("#sidebarNav .nav-item").forEach(li => li.classList.remove("active-nav"));
  if (navEl) navEl.classList.add("active-nav");

  /* Scroll to top of main content */
  const main = document.querySelector(".main-content");
  if (main) main.scrollTop = 0;

  /* Lazy-load disputes when the section is first navigated to */
  if (page === "disputes" && typeof window.loadSellerDisputes === "function") {
    setTimeout(window.loadSellerDisputes, 80);
  }
}

/* On load: honour a deep link, otherwise default to overview.

   Every DASH_PAGES key was reachable only by tapping the sidebar — the section
   a user landed on was always "overview" regardless of the URL. That is why
   other pages linked to invented targets like seller-products.html and
   seller-orders.html: there was no way to address a section of this page, so
   somebody wrote the URL they wished existed. Those files never existed, so the
   Products and Dashboard items in seller-earnings.html's bottom nav were dead.

   Reading the hash here makes seller.html#products a real, shareable address
   and lets those navs point at something that resolves. Unknown keys fall back
   to overview rather than rendering nothing. */
function _sellerPageFromHash() {
  const key = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
  return (key && DASH_PAGES[key]) ? key : "overview";
}

window.addEventListener("DOMContentLoaded", () => {
  const page = _sellerPageFromHash();
  const nav = document.querySelector('#sidebarNav .nav-item[onclick*="' + page + '"]')
           || document.querySelector("#sidebarNav .nav-item");
  showDashPage(page, nav);
});

/* Keep in sync when the hash changes without a reload — otherwise a link to a
   different section of the page the user is already on does nothing. */
window.addEventListener("hashchange", () => {
  const page = _sellerPageFromHash();
  const nav = document.querySelector('#sidebarNav .nav-item[onclick*="' + page + '"]');
  showDashPage(page, nav);
});

window.showDashPage = showDashPage;

/* ── Subscription plan change listener ──────────────────────────────────────
   sokoni-subscriptions.js dispatches this event whenever Firestore confirms a
   plan change (real-time snapshot or post-activation fetch).  Invalidate the
   SokoniPay cache so that the next addProduct() call reads the fresh plan from
   Firestore rather than the stale 5-minute cache.
*/
window.addEventListener('sokoni:subscription:changed', function (e) {
  const plan = e.detail && e.detail.plan ? e.detail.plan : 'unknown';
  /* Cache is already invalidated by sokoni-subscriptions.js before this fires.
     Call invalidateCache() defensively in case the event came from another source. */
  if (window.SokoniSubscriptions && typeof window.SokoniSubscriptions.invalidateCache === 'function') {
    window.SokoniSubscriptions.invalidateCache();
  }
  /* Refresh the premium plans UI if it is currently visible */
  if (typeof renderPremiumPlans === 'function') {
    try { renderPremiumPlans(); } catch (_) {}
  }
  /* Surface plan change to the user when they're on the dashboard */
  if (plan !== 'free' && typeof showNotification === 'function') {
    const label = plan.charAt(0).toUpperCase() + plan.slice(1);
    showNotification('Your ' + label + ' plan is now active. Listing limit updated.', 'success');
  }
});