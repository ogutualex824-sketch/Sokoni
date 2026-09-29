/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PRODUCT TAXONOMY
   ══════════════════════════════════════════════════════════════════════════════
   Every vocabulary a merchant picks from when listing something for sale, and the
   rules that decide which parts of the form apply to what they are selling.

   ── GENERATED, NOT RETYPED ──────────────────────────────────────────────────
   Lifted from seller.html — the legacy upload form — by
   scripts/build-product-taxonomy.js. 99 categories in 20 groups,
   23 locations, the ownership matrix and the five category sets that drive
   the conditional sections.

   Retyping them would have created a second table that drifts. This repo has
   been there: "The platform once had NINE commission tables that disagreed"
   (commission-config.js). scripts/test-product-taxonomy-parity.js asserts this
   module and seller.html still agree, so the day someone edits one and not the
   other is the day a test fails rather than the day a merchant picks a category
   that no longer exists.

   ── WHY A MERCHANT CANNOT BE SHOWN EVERY FIELD ──────────────────────────────
   A phone needs an IMEI. A goat needs a slaughter record. An e-book needs a
   download URL and none of the above. Showing all of it at once is how an
   upload form becomes something merchants abandon, so the SHAPE of the form is
   derived from the category rather than fixed:

       kindOf(cat)            physical | service | digital
       needsOwnership(cat)    high-theft goods: serial/IMEI + proof of purchase
       needsFoodLicence(cat)  county permit, KEBS, KMC, halal, cold chain
       showsKebs(cat)         standards mark applies to this class of goods
       isAdult(cat)           18+ — the buyer is age-gated at checkout

   These are the LEGACY form's own rules, carried over unchanged. They are
   commercial and regulatory decisions, not UI preferences, and this module is
   not the place to revise them.

   ── EMOJI ARE PART OF THE DATA ──────────────────────────────────────────────
   Every option carries its own emoji, so a <select> built from this module is
   legible at a glance on a phone. They are stored beside the label rather than
   baked into it, so a caller can render "📱 Phones" or just "Phones" without
   string surgery.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniProductTaxonomy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── Categories, grouped exactly as a merchant sees them ─────────────────── */
  var GROUPS = [
    {
      "emoji": "🛍️",
      "label": "Fashion & Style",
      "options": [
        {
          "value": "fashion",
          "emoji": "👕",
          "label": "Clothing & Fashion"
        },
        {
          "value": "accessories",
          "emoji": "⌚",
          "label": "Accessories & Jewelry"
        },
        {
          "value": "shoes",
          "emoji": "👟",
          "label": "Shoes & Footwear"
        },
        {
          "value": "bags",
          "emoji": "👜",
          "label": "Bags & Luggage"
        },
        {
          "value": "luxury",
          "emoji": "💎",
          "label": "Luxury & Designer"
        }
      ]
    },
    {
      "emoji": "📱",
      "label": "Technology",
      "options": [
        {
          "value": "electronics",
          "emoji": "📱",
          "label": "Phones & Electronics"
        },
        {
          "value": "computers",
          "emoji": "💻",
          "label": "Computers & Laptops"
        },
        {
          "value": "gaming",
          "emoji": "🎮",
          "label": "Gaming & Consoles"
        },
        {
          "value": "cameras",
          "emoji": "📸",
          "label": "Cameras & Photography"
        },
        {
          "value": "appliances",
          "emoji": "🏠",
          "label": "Home Appliances"
        }
      ]
    },
    {
      "emoji": "🏠",
      "label": "Home & Living",
      "options": [
        {
          "value": "furniture",
          "emoji": "🛋️",
          "label": "Furniture & Decor"
        },
        {
          "value": "kitchen",
          "emoji": "🍳",
          "label": "Kitchen & Dining"
        },
        {
          "value": "garden",
          "emoji": "🌿",
          "label": "Garden & Outdoor"
        },
        {
          "value": "tools",
          "emoji": "🔧",
          "label": "Tools & Hardware"
        },
        {
          "value": "cleaning",
          "emoji": "🧹",
          "label": "Cleaning Supplies"
        }
      ]
    },
    {
      "emoji": "💄",
      "label": "Health & Beauty",
      "options": [
        {
          "value": "beauty",
          "emoji": "💄",
          "label": "Beauty & Makeup"
        },
        {
          "value": "skincare",
          "emoji": "🧴",
          "label": "Skincare & Wellness"
        },
        {
          "value": "haircare",
          "emoji": "💇",
          "label": "Hair & Hair Products"
        },
        {
          "value": "fragrances",
          "emoji": "🌸",
          "label": "Perfumes & Fragrances"
        },
        {
          "value": "health",
          "emoji": "💊",
          "label": "Health & Supplements"
        }
      ]
    },
    {
      "emoji": "🚗",
      "label": "Automotive",
      "options": [
        {
          "value": "cars",
          "emoji": "🚗",
          "label": "Cars & Vehicles"
        },
        {
          "value": "motorcycles",
          "emoji": "🏍️",
          "label": "Motorcycles & Bikes"
        },
        {
          "value": "auto-parts",
          "emoji": "🔩",
          "label": "Auto Parts & Accessories"
        },
        {
          "value": "tyres",
          "emoji": "🛞",
          "label": "Tyres & Rims"
        }
      ]
    },
    {
      "emoji": "🍎",
      "label": "Food & Agriculture",
      "options": [
        {
          "value": "food",
          "emoji": "🍎",
          "label": "Food & Groceries"
        },
        {
          "value": "meat",
          "emoji": "🥩",
          "label": "Meat & Butchery"
        },
        {
          "value": "poultry",
          "emoji": "🐔",
          "label": "Poultry & Eggs"
        },
        {
          "value": "fish",
          "emoji": "🐟",
          "label": "Fish & Seafood"
        },
        {
          "value": "dairy",
          "emoji": "🥛",
          "label": "Dairy & Milking"
        },
        {
          "value": "bakery",
          "emoji": "🍞",
          "label": "Bakery & Bread"
        },
        {
          "value": "agriculture",
          "emoji": "🌱",
          "label": "Agriculture & Farming"
        },
        {
          "value": "livestock",
          "emoji": "🐄",
          "label": "Livestock & Poultry"
        }
      ]
    },
    {
      "emoji": "📚",
      "label": "Education & Media",
      "options": [
        {
          "value": "books",
          "emoji": "📚",
          "label": "Books & Stationery"
        },
        {
          "value": "music",
          "emoji": "🎵",
          "label": "Music & Instruments"
        },
        {
          "value": "art",
          "emoji": "🎨",
          "label": "Art & Crafts"
        },
        {
          "value": "movies",
          "emoji": "🎬",
          "label": "Movies & Media"
        }
      ]
    },
    {
      "emoji": "⚽",
      "label": "Sports & Recreation",
      "options": [
        {
          "value": "sports",
          "emoji": "⚽",
          "label": "Sports & Fitness"
        },
        {
          "value": "outdoor",
          "emoji": "🏕️",
          "label": "Outdoor & Adventure"
        },
        {
          "value": "toys",
          "emoji": "🧸",
          "label": "Toys & Games"
        },
        {
          "value": "kids",
          "emoji": "👶",
          "label": "Baby & Kids"
        }
      ]
    },
    {
      "emoji": "🛠️",
      "label": "Tech & Repair Services",
      "options": [
        {
          "value": "phone-repair",
          "emoji": "📱",
          "label": "Phone Repair"
        },
        {
          "value": "computer-repair",
          "emoji": "💻",
          "label": "Computer & IT Repair"
        },
        {
          "value": "electronics-repair",
          "emoji": "🔌",
          "label": "Electronics Repair"
        }
      ]
    },
    {
      "emoji": "🎨",
      "label": "Creative Services",
      "options": [
        {
          "value": "graphic-design",
          "emoji": "🎨",
          "label": "Graphic Design"
        },
        {
          "value": "photography",
          "emoji": "📸",
          "label": "Photography"
        },
        {
          "value": "videography",
          "emoji": "🎬",
          "label": "Videography & Film"
        },
        {
          "value": "music-audio",
          "emoji": "🎵",
          "label": "Music & Audio"
        }
      ]
    },
    {
      "emoji": "🏠",
      "label": "Home Services",
      "options": [
        {
          "value": "cleaning",
          "emoji": "🧹",
          "label": "Cleaning Services"
        },
        {
          "value": "laundry",
          "emoji": "🧺",
          "label": "Laundry (Mamafua)"
        },
        {
          "value": "gardening",
          "emoji": "🌱",
          "label": "Gardening & Landscaping"
        },
        {
          "value": "plumbing",
          "emoji": "🔧",
          "label": "Plumbing & Repairs"
        },
        {
          "value": "electrical",
          "emoji": "⚡",
          "label": "Electrical Work"
        },
        {
          "value": "interior-design",
          "emoji": "🏠",
          "label": "Interior Design"
        }
      ]
    },
    {
      "emoji": "🚚",
      "label": "Delivery & Logistics",
      "options": [
        {
          "value": "delivery-service",
          "emoji": "🚚",
          "label": "Delivery Service"
        },
        {
          "value": "courier",
          "emoji": "📦",
          "label": "Courier & Shipping"
        },
        {
          "value": "boda-delivery",
          "emoji": "🏍️",
          "label": "Boda Boda Delivery"
        }
      ]
    },
    {
      "emoji": "📢",
      "label": "Business Services",
      "options": [
        {
          "value": "marketing",
          "emoji": "📢",
          "label": "Marketing & Social Media"
        },
        {
          "value": "accounting",
          "emoji": "📋",
          "label": "Accounting & Finance"
        },
        {
          "value": "legal",
          "emoji": "⚖️",
          "label": "Legal & Advisory"
        },
        {
          "value": "printing",
          "emoji": "🖨️",
          "label": "Printing & Branding"
        },
        {
          "value": "virtual-assistant",
          "emoji": "💼",
          "label": "Virtual Assistant"
        }
      ]
    },
    {
      "emoji": "🎓",
      "label": "Education & Training",
      "options": [
        {
          "value": "tutoring",
          "emoji": "📚",
          "label": "Tutoring & Teaching"
        },
        {
          "value": "coaching",
          "emoji": "🎯",
          "label": "Coaching & Mentoring"
        }
      ]
    },
    {
      "emoji": "🎉",
      "label": "Events & Lifestyle",
      "options": [
        {
          "value": "events",
          "emoji": "🎉",
          "label": "Event Planning"
        },
        {
          "value": "catering",
          "emoji": "🍽️",
          "label": "Catering"
        },
        {
          "value": "hair-beauty",
          "emoji": "💇",
          "label": "Hair & Beauty"
        },
        {
          "value": "fitness",
          "emoji": "🏋️",
          "label": "Fitness & Training"
        }
      ]
    },
    {
      "emoji": "💻",
      "label": "Digital Products",
      "options": [
        {
          "value": "ebook",
          "emoji": "📖",
          "label": "eBook"
        },
        {
          "value": "template",
          "emoji": "🗂️",
          "label": "Templates & Designs"
        },
        {
          "value": "course",
          "emoji": "🎓",
          "label": "Online Course"
        },
        {
          "value": "software",
          "emoji": "💾",
          "label": "Software & Apps"
        },
        {
          "value": "license",
          "emoji": "🔑",
          "label": "Software License"
        }
      ]
    },
    {
      "emoji": "🧱",
      "label": "Construction & Building",
      "options": [
        {
          "value": "cement",
          "emoji": "🏗️",
          "label": "Cement & Concrete"
        },
        {
          "value": "steel",
          "emoji": "⚙️",
          "label": "Steel, Iron & Reinforcement"
        },
        {
          "value": "timber",
          "emoji": "🪵",
          "label": "Timber & Wood Products"
        },
        {
          "value": "roofing",
          "emoji": "🏠",
          "label": "Roofing & Ceilings"
        },
        {
          "value": "bricks",
          "emoji": "🧱",
          "label": "Bricks, Blocks & Stones"
        },
        {
          "value": "tiles",
          "emoji": "🔲",
          "label": "Tiles & Flooring"
        },
        {
          "value": "paint",
          "emoji": "🎨",
          "label": "Paint & Coatings"
        },
        {
          "value": "plumbing-materials",
          "emoji": "🔧",
          "label": "Plumbing Materials"
        },
        {
          "value": "electrical-materials",
          "emoji": "⚡",
          "label": "Electrical Materials"
        },
        {
          "value": "windows-doors",
          "emoji": "🚪",
          "label": "Windows & Doors"
        },
        {
          "value": "construction-tools",
          "emoji": "🔨",
          "label": "Construction Tools & Equipment"
        },
        {
          "value": "safety-ppe",
          "emoji": "🦺",
          "label": "Safety Gear & PPE"
        },
        {
          "value": "sand-gravel",
          "emoji": "⛏️",
          "label": "Sand, Gravel & Aggregates"
        },
        {
          "value": "prefab",
          "emoji": "🏗️",
          "label": "Prefab & Modular Structures"
        }
      ]
    },
    {
      "emoji": "🔥",
      "label": "Energy & Fuel",
      "options": [
        {
          "value": "gas",
          "emoji": "🔥",
          "label": "Cooking Gas (LPG Cylinders)"
        },
        {
          "value": "gas-accessories",
          "emoji": "🪣",
          "label": "Gas Accessories & Regulators"
        },
        {
          "value": "charcoal",
          "emoji": "🪵",
          "label": "Charcoal & Firewood"
        },
        {
          "value": "solar",
          "emoji": "☀️",
          "label": "Solar Products & Batteries"
        },
        {
          "value": "kerosene",
          "emoji": "🛢️",
          "label": "Kerosene & Fuel"
        }
      ]
    },
    {
      "emoji": "💼",
      "label": "Other Business",
      "options": [
        {
          "value": "office",
          "emoji": "📦",
          "label": "Office & Stationery"
        },
        {
          "value": "pets",
          "emoji": "🐾",
          "label": "Pets & Animals"
        },
        {
          "value": "travel",
          "emoji": "✈️",
          "label": "Travel & Tourism"
        },
        {
          "value": "services",
          "emoji": "🛠️",
          "label": "Other Services"
        }
      ]
    },
    {
      "emoji": "🔞",
      "label": "18+ (Age-Restricted)",
      "options": [
        {
          "value": "alcohol",
          "emoji": "🍺",
          "label": "Alcohol & Beverages"
        },
        {
          "value": "vape",
          "emoji": "💨",
          "label": "Vape & E-Cigarettes"
        },
        {
          "value": "tobacco",
          "emoji": "🚬",
          "label": "Tobacco & Cigarettes"
        },
        {
          "value": "adult",
          "emoji": "🔞",
          "label": "Adult Products & Novelties"
        }
      ]
    }
  ];

  /* ── Where the item is ───────────────────────────────────────────────────── */
  var LOCATIONS = [
    {
      "value": "nairobi",
      "emoji": "📍",
      "label": "Nairobi"
    },
    {
      "value": "mombasa",
      "emoji": "📍",
      "label": "Mombasa"
    },
    {
      "value": "kisumu",
      "emoji": "📍",
      "label": "Kisumu"
    },
    {
      "value": "nakuru",
      "emoji": "📍",
      "label": "Nakuru"
    },
    {
      "value": "eldoret",
      "emoji": "📍",
      "label": "Eldoret"
    },
    {
      "value": "thika",
      "emoji": "📍",
      "label": "Thika"
    },
    {
      "value": "nyeri",
      "emoji": "📍",
      "label": "Nyeri"
    },
    {
      "value": "meru",
      "emoji": "📍",
      "label": "Meru"
    },
    {
      "value": "embu",
      "emoji": "📍",
      "label": "Embu"
    },
    {
      "value": "machakos",
      "emoji": "📍",
      "label": "Machakos"
    },
    {
      "value": "naivasha",
      "emoji": "📍",
      "label": "Naivasha"
    },
    {
      "value": "nanyuki",
      "emoji": "📍",
      "label": "Nanyuki"
    },
    {
      "value": "kisii",
      "emoji": "📍",
      "label": "Kisii"
    },
    {
      "value": "kericho",
      "emoji": "📍",
      "label": "Kericho"
    },
    {
      "value": "kakamega",
      "emoji": "📍",
      "label": "Kakamega"
    },
    {
      "value": "kitale",
      "emoji": "📍",
      "label": "Kitale"
    },
    {
      "value": "bungoma",
      "emoji": "📍",
      "label": "Bungoma"
    },
    {
      "value": "malindi",
      "emoji": "📍",
      "label": "Malindi"
    },
    {
      "value": "isiolo",
      "emoji": "📍",
      "label": "Isiolo"
    },
    {
      "value": "garissa",
      "emoji": "📍",
      "label": "Garissa"
    },
    {
      "value": "kenya",
      "emoji": "🌍",
      "label": "All Kenya"
    },
    {
      "value": "remote",
      "emoji": "💻",
      "label": "Online / Remote"
    },
    {
      "value": "worldwide",
      "emoji": "🌐",
      "label": "Worldwide"
    }
  ];

  /* ── How the seller came by a high-value item ────────────────────────────── */
  var OWNER_SOURCES = [
    {
      "value": "bought-new",
      "emoji": "🛒",
      "label": "Bought new (shop/dealer)"
    },
    {
      "value": "bought-second",
      "emoji": "🤝",
      "label": "Bought second-hand (private seller)"
    },
    {
      "value": "gift",
      "emoji": "🎁",
      "label": "Gift from family/friend"
    },
    {
      "value": "imported",
      "emoji": "✈️",
      "label": "Imported personally"
    },
    {
      "value": "company",
      "emoji": "🏢",
      "label": "Company asset / work device"
    },
    {
      "value": "own-business",
      "emoji": "🏪",
      "label": "Own business stock"
    }
  ];

  /* ── Food handling ───────────────────────────────────────────────────────── */
  var FOOD_STORAGE = [
    {
      "value": "refrigerated",
      "emoji": "❄️",
      "label": "Refrigerated (2–8°C)"
    },
    {
      "value": "frozen",
      "emoji": "🧊",
      "label": "Frozen (-18°C and below)"
    },
    {
      "value": "chilled",
      "emoji": "🌡️",
      "label": "Chilled (0–4°C)"
    },
    {
      "value": "dry-store",
      "emoji": "📦",
      "label": "Dry Store / Ambient"
    },
    {
      "value": "live",
      "emoji": "🐄",
      "label": "Live animal"
    }
  ];
  var FOOD_SLAUGHTER = [
    {
      "value": "kmc-certified",
      "emoji": "",
      "label": "KMC Certified Abattoir"
    },
    {
      "value": "county-approved",
      "emoji": "",
      "label": "County-Approved Slaughterhouse"
    },
    {
      "value": "home-slaughter",
      "emoji": "",
      "label": "Home / Farm Slaughter"
    },
    {
      "value": "halal-certified",
      "emoji": "✅",
      "label": "Halal Certified Slaughter"
    }
  ];

  /* ── Condition. NOT in the legacy form — added here because a marketplace
        that cannot say "used" makes every listing look new, and a buyer who
        finds out later disputes the order. ─────────────────────────────────── */
  var CONDITIONS = [
    { value: 'new',        emoji: '\u2728', label: 'Brand new' },
    { value: 'like-new',   emoji: '\uD83D\uDC8E', label: 'Like new — barely used' },
    { value: 'used-good',  emoji: '\uD83D\uDC4D', label: 'Used — good condition' },
    { value: 'used-fair',  emoji: '\uD83D\uDD27', label: 'Used — fair, works fine' },
    { value: 'refurbished',emoji: '\u267B\uFE0F', label: 'Refurbished' },
    { value: 'for-parts',  emoji: '\uD83E\uDDE9', label: 'For parts / not working' }
  ];

  /* ── UNITS AND STATES ────────────────────────────────────────────────────
     Every dropdown in the upload form carries emoji, and these are the ones the
     product-specs model supplies as bare words ("kg", "pieces", "mm"). They are
     decorated HERE rather than in the model, because the model is arithmetic —
     it converts and compares measurements — and an emoji in a unit key would
     end up in a stored value.

     A whole DIMENSION shares one glyph (📏 for every length, ⚖️ for every
     weight): the emoji says what KIND of thing is being measured, and reading
     "📏 mm / 📏 cm / 📏 m" is faster than three unrelated pictures. */
  var UNIT_EMOJI = {
    length: '\uD83D\uDCCF', weight: '\u2696\uFE0F', volume: '\uD83E\uDDF4',
    area: '\uD83D\uDCD0', power: '\u26A1', storage: '\uD83D\uDCBE',
    time: '\u23F1\uFE0F', screen: '\uD83D\uDCF1'
  };
  var STOCK_UNIT_EMOJI = {
    pieces: '\uD83D\uDD22', kg: '\u2696\uFE0F', g: '\u2696\uFE0F',
    litres: '\uD83E\uDDF4', ml: '\uD83E\uDDF4', metres: '\uD83D\uDCCF',
    boxes: '\uD83D\uDCE6', packs: '\uD83C\uDF81', cartons: '\uD83D\uDCE6',
    crates: '\uD83E\uDDFA', bags: '\uD83D\uDECD\uFE0F', bundles: '\uD83E\uDeA2',
    pairs: '\uD83D\uDC5F', sets: '\uD83C\uDF9B\uFE0F', dozens: '\uD83E\uDD5A',
    hours: '\u23F1\uFE0F'
  };
  /* Whether a listing is on sale or put away. Two states, both said plainly. */
  var VISIBILITY = [
    { value: 'active', emoji: '\u2705', label: 'Active \u2014 on sale' },
    { value: 'draft',  emoji: '\uD83D\uDCDD', label: 'Draft \u2014 hidden' }
  ];

  /** The glyph for a stock unit, or a neutral one so a select is never bare. */
  function stockUnitEmoji (u) { return STOCK_UNIT_EMOJI[String(u || '').toLowerCase()] || '\uD83D\uDCE6'; }
  /** The glyph for a measurement dimension (length, weight, volume\u2026). */
  function dimensionEmoji (d) { return UNIT_EMOJI[String(d || '').toLowerCase()] || '\uD83D\uDCCF'; }

  /* ── The high-theft goods that need proof of ownership, and what to ask for ── */
  var OWNERSHIP = {
    "electronics": {
      "serial": "IMEI Number",
      "hint": "Dial *#06# on your phone to find it",
      "doc": "Purchase Receipt / Box Label",
      "sub": "Phones are frequently stolen. IMEI helps track if this device is blacklisted."
    },
    "computers": {
      "serial": "Serial Number",
      "hint": "Check label on bottom of laptop/PC",
      "doc": "Purchase Receipt or Warranty Card",
      "sub": "Laptops require a serial number and proof of purchase to list."
    },
    "gaming": {
      "serial": "Serial Number",
      "hint": "Found on back/bottom of the console",
      "doc": "Purchase Receipt",
      "sub": "Gaming consoles are high-theft items. Serial number is required."
    },
    "cameras": {
      "serial": "Serial Number",
      "hint": "Inside the battery compartment",
      "doc": "Purchase Receipt or Warranty Card",
      "sub": "Camera serial numbers are tracked by manufacturers."
    },
    "cars": {
      "serial": "Chassis / VIN Number",
      "hint": "17-character code on dashboard/door",
      "doc": "Vehicle Logbook (Blue Book)",
      "sub": "All vehicles must be listed with a valid logbook and chassis number to prevent selling stolen cars."
    },
    "motorcycles": {
      "serial": "Chassis Number",
      "hint": "Found on the frame near the engine",
      "doc": "Vehicle Logbook",
      "sub": "Motorcycles require chassis number and logbook."
    },
    "auto-parts": {
      "serial": "Part Number (optional)",
      "hint": "Found on the part label",
      "doc": "Purchase Receipt",
      "sub": "Auto parts from stolen vehicles cannot be listed."
    },
    "luxury": {
      "serial": "Serial / Auth. Code",
      "hint": "Found on certificate of authenticity",
      "doc": "Certificate of Authenticity or Receipt",
      "sub": "Luxury items require proof of authenticity."
    },
    "tyres": {
      "serial": "DOT Code",
      "hint": "On the sidewall of the tyre",
      "doc": "Purchase Receipt",
      "sub": "Tyres require a DOT code to verify they are road-legal."
    }
  };

  /* ── Category sets, carried over from the legacy form unchanged ──────────── */
  var KEBS = [
    "food",
    "meat",
    "poultry",
    "fish",
    "dairy",
    "bakery",
    "agriculture",
    "livestock",
    "electronics",
    "computers",
    "cameras",
    "appliances",
    "gaming",
    "health",
    "beauty",
    "skincare",
    "haircare",
    "fragrances",
    "toys",
    "kids",
    "tyres",
    "auto-parts"
  ];
  var FOOD_LICENCE = [
    "food",
    "meat",
    "poultry",
    "fish",
    "dairy",
    "bakery",
    "agriculture",
    "livestock"
  ];
  var SERVICE = [
    "phone-repair",
    "computer-repair",
    "electronics-repair",
    "graphic-design",
    "photography",
    "videography",
    "music-audio",
    "cleaning",
    "laundry",
    "gardening",
    "plumbing",
    "electrical",
    "interior-design",
    "delivery-service",
    "courier",
    "boda-delivery",
    "marketing",
    "accounting",
    "legal",
    "virtual-assistant",
    "printing",
    "tutoring",
    "coaching",
    "events",
    "catering",
    "hair-beauty",
    "fitness",
    "services"
  ];
  var DIGITAL = [
    "ebook",
    "template",
    "course",
    "software",
    "license"
  ];
  var ADULT = [
    "vape",
    "alcohol",
    "tobacco",
    "adult"
  ];

  var _set = function (a) { var s = {}; a.forEach(function (k) { s[k] = true; }); return s; };
  var KEBS_S = _set(KEBS), FOOD_S = _set(FOOD_LICENCE),
      SVC_S = _set(SERVICE), DIG_S = _set(DIGITAL), ADULT_S = _set(ADULT);

  var BY_VALUE = {};
  GROUPS.forEach(function (grp) {
    grp.options.forEach(function (o) {
      BY_VALUE[o.value] = { value: o.value, emoji: o.emoji, label: o.label,
                            group: grp.label, groupEmoji: grp.emoji };
    });
  });

  var c = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };

  /* physical | service | digital — the three shapes an upload form takes. */
  function kindOf (cat) {
    var k = c(cat);
    if (DIG_S[k]) return 'digital';
    if (SVC_S[k]) return 'service';
    return 'physical';
  }
  function needsOwnership (cat) { return !!OWNERSHIP[c(cat)]; }
  function ownershipFor (cat)   { return OWNERSHIP[c(cat)] || null; }
  function needsFoodLicence (cat) { return !!FOOD_S[c(cat)]; }
  function showsKebs (cat)      { return kindOf(cat) === 'physical' && !!KEBS_S[c(cat)]; }
  function isAdult (cat)        { return !!ADULT_S[c(cat)]; }
  function isKnown (cat)        { return !!BY_VALUE[c(cat)]; }
  function infoFor (cat)        { return BY_VALUE[c(cat)] || null; }

  /* A vehicle or motorcycle needs a logbook; everything else needs a receipt. */
  function needsOwnerDoc (cat) { var k = c(cat); return k === 'cars' || k === 'motorcycles'; }

  function labelFor (cat) {
    var i = BY_VALUE[c(cat)];
    return i ? (i.emoji ? i.emoji + ' ' + i.label : i.label) : '';
  }

  /* ── HTML helpers ────────────────────────────────────────────────────────
     The caller supplies its own escaper so this module does not become a second
     opinion on escaping. Values here are generated and known-safe, but a label
     still goes through it: a taxonomy that escapes nothing teaches the next
     caller the wrong habit. */
  function optionRow (o, selected, esc) {
    var e = esc || function (s) { return String(s); };
    var text = (o.emoji ? o.emoji + ' ' : '') + o.label;
    return '<option value="' + e(o.value) + '"' +
      (c(selected) === c(o.value) ? ' selected' : '') + '>' + e(text) + '</option>';
  }

  /** The full grouped category list, ready to drop inside a <select>. */
  function categoryOptionsHtml (selected, esc, placeholder) {
    var e = esc || function (s) { return String(s); };
    var head = placeholder === false ? ''
      : '<option value="">' + e(placeholder || '\uD83C\uDFF7\uFE0F Choose a category') + '</option>';
    return head + GROUPS.map(function (grp) {
      return '<optgroup label="' + e((grp.emoji ? grp.emoji + ' ' : '') + grp.label) + '">' +
        grp.options.map(function (o) { return optionRow(o, selected, e); }).join('') +
        '</optgroup>';
    }).join('');
  }

  /** Any flat vocabulary (locations, conditions, storage…) as <option> rows. */
  function optionsHtml (list, selected, esc, placeholder) {
    var e = esc || function (s) { return String(s); };
    var head = placeholder === false ? ''
      : '<option value="">' + e(placeholder || 'Select\u2026') + '</option>';
    return head + (list || []).map(function (o) { return optionRow(o, selected, e); }).join('');
  }

  return {
    GROUPS: GROUPS, LOCATIONS: LOCATIONS, OWNER_SOURCES: OWNER_SOURCES,
    VISIBILITY: VISIBILITY, UNIT_EMOJI: UNIT_EMOJI, STOCK_UNIT_EMOJI: STOCK_UNIT_EMOJI,
    stockUnitEmoji: stockUnitEmoji, dimensionEmoji: dimensionEmoji,
    FOOD_STORAGE: FOOD_STORAGE, FOOD_SLAUGHTER: FOOD_SLAUGHTER, CONDITIONS: CONDITIONS,
    OWNERSHIP: OWNERSHIP,
    KEBS: KEBS, FOOD_LICENCE: FOOD_LICENCE, SERVICE: SERVICE, DIGITAL: DIGITAL, ADULT: ADULT,
    kindOf: kindOf, needsOwnership: needsOwnership, ownershipFor: ownershipFor,
    needsOwnerDoc: needsOwnerDoc, needsFoodLicence: needsFoodLicence,
    showsKebs: showsKebs, isAdult: isAdult, isKnown: isKnown, infoFor: infoFor,
    labelFor: labelFor,
    categoryOptionsHtml: categoryOptionsHtml, optionsHtml: optionsHtml
  };
}));
