/* ══════════════════════════════════════════════════════════════════════════
   KASS VAPES — merchant catalogue

   The product data for the KASS Vapes brand, held as data rather than embedded
   in a seeding script, so the same catalogue can be loaded into:

     • PosInventory (IndexedDB) for SmartPOS testing — works offline, no auth
     • Firestore, by an authenticated merchant or admin, via the canonical
       onboarding path

   WHY THIS IS DATA AND NOT A SEEDER
   Creating the merchant itself requires inviteUser (admin-invitations.js:293),
   which needs an admin claim. Writing merchant documents by hand would bypass
   the canonical onboarding flow. So the catalogue is prepared here and applied
   through whichever path the caller is authorised to use.

   COMPLIANCE
   Every category maps to a restricted category in functions/brands.js, so the
   KASS storefront age gate applies to the whole catalogue. Categories are named
   to match brands.js exactly — a mismatch would leave products outside the gate.

   Prices are Kenyan retail in KES, cost/sell spreads are realistic (roughly
   30-45% margin), and barcodes are EAN-13-shaped so barcode lookup can be
   exercised properly rather than with placeholder strings.
   ══════════════════════════════════════════════════════════════════════════ */
window.KassCatalog = (() => {
  'use strict';

  const MERCHANT = Object.freeze({
    businessName: 'KASS VAPES',
    businessType: 'Vape & Lifestyle Store',
    brand:        'kass',              /* matches functions/brands.js */
    tier:         'Premium',
    status:       'active',
    visibility:   'public',
    country:      'Kenya',
    countryCode:  'KE',
    currency:     'KES',
    description:
      'Premium vape devices, pods and e-liquids. Authentic brands, verified stock, ' +
      'and expert guidance for adult vapers across Kenya.',
    policies: {
      ageRestriction: 'Strictly 18+. Age verification is required before purchase.',
      returns:        'Unopened devices may be returned within 7 days with receipt. ' +
                      'E-liquids and pods cannot be returned once opened, for hygiene reasons.',
      warranty:       'Devices carry a 6-month manufacturer warranty against defects. ' +
                      'Coils and consumables are excluded.',
      delivery:       'Same-day within Nairobi CBD. 1-3 days countrywide.',
    },
    hours: {
      mon: '09:00-20:00', tue: '09:00-20:00', wed: '09:00-20:00', thu: '09:00-20:00',
      fri: '09:00-21:00', sat: '10:00-21:00', sun: '11:00-18:00',
    },
    contact: { phone: '', email: '', /* filled at onboarding — never invented here */ },
  });

  /* Category ids match brands.js restrictedCategories so the age gate covers all. */
  const CATEGORIES = Object.freeze([
    { id: 'vape-devices',     name: 'Vape Kits',        icon: '🔋', color: '#b06cff' },
    { id: 'pods',             name: 'Pod Systems',      icon: '📦', color: '#8b5cf6' },
    { id: 'e-liquids',        name: 'Vape Juice',       icon: '💧', color: '#a78bfa' },
    { id: 'coils',            name: 'Coils',            icon: '🌀', color: '#7c3aed' },
    { id: 'vape-accessories', name: 'Accessories',      icon: '🔌', color: '#6d28d9' },
  ]);

  /* Realistic Kenyan vape retail. cost/price in KES.
     `category` uses the category NAME, matching how PosInventory stores it
     (pos-inventory.js:148); categoryId carries the id for filtering by either. */
  const PRODUCTS = Object.freeze([
    /* ── Disposables ─────────────────────────────────────────────── */
    { name: 'Elf Bar BC5000 — Blue Razz Ice', sku: 'ELF-BC5-BRI', barcode: '6009880011247',
      category: 'Vape Kits', categoryId: 'vape-devices', brand: 'Elf Bar',
      cost: 950,  price: 1800, stock: 40, minStockLevel: 8, weight: 0.06,
      description: '5000-puff disposable. Blue raspberry with a cool finish. Mesh coil, 650mAh rechargeable.' },
    { name: 'Elf Bar BC5000 — Watermelon Ice', sku: 'ELF-BC5-WMI', barcode: '6009880011254',
      category: 'Vape Kits', categoryId: 'vape-devices', brand: 'Elf Bar',
      cost: 950,  price: 1800, stock: 35, minStockLevel: 8, weight: 0.06,
      description: '5000-puff disposable. Sweet watermelon, chilled. Mesh coil, 650mAh rechargeable.' },
    { name: 'Lost Mary OS5000 — Strawberry Kiwi', sku: 'LM-OS5-SKW', barcode: '6009880011261',
      category: 'Vape Kits', categoryId: 'vape-devices', brand: 'Lost Mary',
      cost: 1100, price: 2000, stock: 28, minStockLevel: 6, weight: 0.06,
      description: '5000-puff disposable with a soft strawberry-kiwi blend. Type-C rechargeable.' },

    /* ── Pod systems ─────────────────────────────────────────────── */
    { name: 'Vaporesso XROS 3 Pod Kit — Black', sku: 'VAP-XR3-BLK', barcode: '6009880021147',
      category: 'Pod Systems', categoryId: 'pods', brand: 'Vaporesso',
      cost: 2400, price: 3900, stock: 18, minStockLevel: 4, weight: 0.11,
      description: '1000mAh pod kit with adjustable airflow and COREX mesh. Refillable 2ml pod included.' },
    { name: 'Vaporesso XROS 3 Pod Kit — Silver', sku: 'VAP-XR3-SLV', barcode: '6009880021154',
      category: 'Pod Systems', categoryId: 'pods', brand: 'Vaporesso',
      cost: 2400, price: 3900, stock: 12, minStockLevel: 4, weight: 0.11,
      description: '1000mAh pod kit with adjustable airflow and COREX mesh. Refillable 2ml pod included.' },
    { name: 'Uwell Caliburn G3 Kit', sku: 'UWL-CG3-KIT', barcode: '6009880021161',
      category: 'Pod Systems', categoryId: 'pods', brand: 'Uwell',
      cost: 2800, price: 4500, stock: 14, minStockLevel: 4, weight: 0.12,
      description: '900mAh pod system, dual adjustable airflow, 2.5ml refillable pod. Pro-FOCS flavour tech.' },
    { name: 'SMOK Novo 5 Kit', sku: 'SMK-NV5-KIT', barcode: '6009880021178',
      category: 'Pod Systems', categoryId: 'pods', brand: 'SMOK',
      cost: 2100, price: 3400, stock: 9,  minStockLevel: 4, weight: 0.10,
      description: 'Compact 900mAh pod kit with a 2ml refillable pod and side fill. Beginner friendly.' },

    /* ── Vape kits (larger devices) ───────────────────────────────── */
    { name: 'Vaporesso Luxe X Pro Kit', sku: 'VAP-LXP-KIT', barcode: '6009880031047',
      category: 'Vape Kits', categoryId: 'vape-devices', brand: 'Vaporesso',
      cost: 4200, price: 6800, stock: 7,  minStockLevel: 3, weight: 0.16,
      description: '40W pod-mod, 1500mAh, 5ml pod, 0.4Ω/0.6Ω mesh coils. Full-colour display.' },
    { name: 'GeekVape Aegis Hero 3', sku: 'GKV-AH3-KIT', barcode: '6009880031054',
      category: 'Vape Kits', categoryId: 'vape-devices', brand: 'GeekVape',
      cost: 4800, price: 7500, stock: 5,  minStockLevel: 2, weight: 0.19,
      description: 'IP68 shock, dust and water resistant. 1500mAh, 30W, 3.5ml pod. Built for rough use.' },

    /* ── E-liquids ───────────────────────────────────────────────── */
    { name: 'Nasty Juice — Cush Man Mango 60ml (3mg)', sku: 'NST-CSH-M03', barcode: '6009880041047',
      category: 'Vape Juice', categoryId: 'e-liquids', brand: 'Nasty Juice',
      cost: 850,  price: 1500, stock: 30, minStockLevel: 6, weight: 0.09,
      description: 'Ripe mango, 60ml shortfill, 3mg freebase. 70/30 VG/PG.' },
    { name: 'Nasty Juice — Cush Man Mango 60ml (6mg)', sku: 'NST-CSH-M06', barcode: '6009880041054',
      category: 'Vape Juice', categoryId: 'e-liquids', brand: 'Nasty Juice',
      cost: 850,  price: 1500, stock: 22, minStockLevel: 6, weight: 0.09,
      description: 'Ripe mango, 60ml shortfill, 6mg freebase. 70/30 VG/PG.' },
    { name: 'Pacha Mama — Mint Leaf 60ml (3mg)', sku: 'PCH-MNT-03', barcode: '6009880041061',
      category: 'Vape Juice', categoryId: 'e-liquids', brand: 'Pacha Mama',
      cost: 900,  price: 1600, stock: 19, minStockLevel: 6, weight: 0.09,
      description: 'Cool mint with a honeydew finish. 60ml, 3mg freebase.' },
    { name: 'Elf Bar Salt — Blue Razz 30ml (20mg)', sku: 'ELF-SLT-BR20', barcode: '6009880041078',
      category: 'Vape Juice', categoryId: 'e-liquids', brand: 'Elf Bar',
      cost: 700,  price: 1300, stock: 26, minStockLevel: 6, weight: 0.05,
      description: 'Nicotine salt, 30ml, 20mg. Smooth throat hit — for pod systems.' },
    { name: 'Riot Squad Salt — Pink Grenade 30ml (10mg)', sku: 'RIO-SLT-PG10', barcode: '6009880041085',
      category: 'Vape Juice', categoryId: 'e-liquids', brand: 'Riot Squad',
      cost: 780,  price: 1400, stock: 3,  minStockLevel: 6, weight: 0.05,
      description: 'Pink lemonade and berries. Nicotine salt, 30ml, 10mg. LOW STOCK — reorder.' },

    /* ── Coils ───────────────────────────────────────────────────── */
    { name: 'Vaporesso GTX Coil 0.6Ω (5-pack)', sku: 'VAP-GTX-06', barcode: '6009880051047',
      category: 'Coils', categoryId: 'coils', brand: 'Vaporesso',
      cost: 380, price: 750, stock: 24, minStockLevel: 8, weight: 0.03,
      description: 'Mesh replacement coils for GTX tanks and Luxe pods. 0.6Ω, 5 per pack.' },
    { name: 'Uwell Caliburn G3 Coil 0.8Ω (4-pack)', sku: 'UWL-CG3-08', barcode: '6009880051054',
      category: 'Coils', categoryId: 'coils', brand: 'Uwell',
      cost: 420, price: 800, stock: 20, minStockLevel: 8, weight: 0.03,
      description: 'Replacement coils for Caliburn G3. 0.8Ω mesh, 4 per pack.' },
    { name: 'SMOK Novo 5 Coil 0.7Ω (3-pack)', sku: 'SMK-NV5-07', barcode: '6009880051061',
      category: 'Coils', categoryId: 'coils', brand: 'SMOK',
      cost: 330, price: 650, stock: 16, minStockLevel: 8, weight: 0.02,
      description: 'Meshed replacement coils for Novo 5. 0.7Ω, 3 per pack.' },

    /* ── Accessories ─────────────────────────────────────────────── */
    { name: 'USB-C Fast Charging Cable (1m)', sku: 'ACC-USBC-1M', barcode: '6009880061047',
      category: 'Accessories', categoryId: 'vape-accessories', brand: 'KASS',
      cost: 180, price: 400, stock: 45, minStockLevel: 10, weight: 0.04,
      description: 'Braided USB-C cable for vape device charging. 1 metre.' },
    { name: '18650 Battery — Sony VTC6 3000mAh', sku: 'ACC-BAT-VTC6', barcode: '6009880061054',
      category: 'Accessories', categoryId: 'vape-accessories', brand: 'Sony',
      cost: 900, price: 1600, stock: 11, minStockLevel: 4, weight: 0.05,
      description: 'Genuine Sony VTC6 18650, 3000mAh, 30A continuous. For mods only.' },
    { name: 'Dual 18650 Battery Charger', sku: 'ACC-CHG-DUAL', barcode: '6009880061061',
      category: 'Accessories', categoryId: 'vape-accessories', brand: 'Nitecore',
      cost: 1400, price: 2400, stock: 6,  minStockLevel: 3, weight: 0.18,
      description: 'Two-bay smart charger with LCD. Auto cut-off and reverse-polarity protection.' },
    { name: 'Vape Carry Case — Compact', sku: 'ACC-CASE-CMP', barcode: '6009880061078',
      category: 'Accessories', categoryId: 'vape-accessories', brand: 'KASS',
      cost: 350, price: 750, stock: 22, minStockLevel: 6, weight: 0.08,
      description: 'Padded zip case for a pod device, spare pods and a bottle of juice.' },
  ]);

  /* Load into PosInventory (IndexedDB). Client-side, offline-capable, no auth —
     which is why SmartPOS can be exercised before the merchant exists in
     Firestore. Idempotent by SKU so it can be re-run safely. */
  async function seedPos(opts = {}) {
    const I = window.PosInventory;
    if (!I) throw new Error('PosInventory not loaded');

    const existing = await I.getAllProducts();
    const bySku = new Set(existing.map(p => p.sku).filter(Boolean));

    /* Categories first, so products can resolve their category. */
    const existingCats = await I.getCategories();
    const catNames = new Set((existingCats || []).map(c => c.name));
    for (const c of CATEGORIES) {
      if (!catNames.has(c.name)) await I.addCategory(c);
    }

    let added = 0, skipped = 0;
    for (const p of PRODUCTS) {
      if (bySku.has(p.sku)) { skipped++; continue; }
      const product = await I.addProduct({
        name: p.name, sku: p.sku, barcode: p.barcode,
        category: p.category, brand: p.brand, description: p.description,
        price: p.price, cost: p.cost, taxRate: 16, unit: 'PCS',
        minStockLevel: p.minStockLevel, weight: p.weight, status: 'active',
      });
      /* Opening stock, recorded as a movement rather than written directly.
         Signature is adjustStock(productId, branchId, delta, reason, ...) —
         pos-inventory.js:315. Passing stock in the branchId position would
         silently seed nothing, which is the same shape of defect that left the
         till's product grid empty. */
      if (typeof I.adjustStock === 'function' && p.stock > 0) {
        await I.adjustStock(product.id, opts.branchId || 'default', p.stock, 'opening_stock')
          .catch((e) => { console.warn('[kass] opening stock failed for ' + p.sku, e && e.message); });
      }
      added++;
    }
    return { added, skipped, categories: CATEGORIES.length, total: PRODUCTS.length };
  }

  return { MERCHANT, CATEGORIES, PRODUCTS, seedPos,
           stats: () => ({
             products: PRODUCTS.length,
             categories: CATEGORIES.length,
             lowStock: PRODUCTS.filter(p => p.stock <= p.minStockLevel).length,
             stockValue: PRODUCTS.reduce((s, p) => s + p.cost * p.stock, 0),
             retailValue: PRODUCTS.reduce((s, p) => s + p.price * p.stock, 0),
           }) };
})();
