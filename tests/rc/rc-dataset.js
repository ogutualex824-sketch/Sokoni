/* ============================================================================
   RC1 — CANONICAL BETA DATASET  (backend-agnostic)

   The single source of truth for every release-candidate run. Every backend
   (production-admin, emulator, …) seeds FROM this file, so two runs on two
   backends start from byte-identical state and their PASS/FAIL results are
   directly comparable over time.

   NOTHING here is environment-specific. No credentials, no hosts, no secrets.
   Passwords are for DEDICATED throwaway beta identities only and are meant to
   be well-known within the team; they must never be reused for a real account.
   ========================================================================== */

'use strict';

/* Stable ids — the same uid every run, so evidence diffs are meaningful.
   A backend that cannot choose uids (e.g. real Auth) maps email→uid and records
   the mapping in the run report instead. */
const IDENTITIES = {
  buyer: {
    email: 'buyer.beta@sokoni.test',
    password: 'RcBeta!buyer-2026',
    displayName: 'RC Buyer',
    claims: {},                              // ordinary user, no privilege
    profile: { role: 'buyer', county: 'Nairobi' },
  },
  seller: {
    email: 'seller.beta@sokoni.test',
    password: 'RcBeta!seller-2026',
    displayName: 'RC Seller',
    claims: { seller: true },
    profile: { role: 'seller', shopHandle: 'rc-beta-shop', tier: 'premium' },
  },
  manager: {
    email: 'manager.beta@sokoni.test',
    password: 'RcBeta!manager-2026',
    displayName: 'RC Manager',
    /* PRIVILEGED. On a production backend, minting this claim creates a real
       manager-capable account — the runner requires an explicit
       --allow-privileged flag before a backend may set it. */
    claims: { manager: true },
    profile: { role: 'manager' },
    privileged: true,
  },
  driver: {
    email: 'driver.beta@sokoni.test',
    password: 'RcBeta!driver-2026',
    displayName: 'RC Driver',
    claims: { driver: true },
    profile: { role: 'driver', vehicle: 'motorbike' },
  },
  admin: {
    email: 'admin.beta@sokoni.test',
    password: 'RcBeta!admin-2026',
    displayName: 'RC Admin',
    /* HIGHLY PRIVILEGED — an admin-capable account in whatever project it runs
       against. Same --allow-privileged gate; never seeded by default. */
    claims: { admin: true },
    profile: { role: 'admin' },
    privileged: true,
  },
};

/* Predictable catalog. Stock numbers are chosen so decrement assertions are
   unambiguous (RC-04 buys 2 of SKU rc-stock-10 → expect exactly 8). */
const PRODUCTS = [
  {
    id: 'rc-prod-basic',
    name: 'RC Test Product — Basic',
    price: 100000,                           // cents → KES 1,000.00
    stock: 25,
    category: 'electronics',
    status: 'active',
    isVisible: true,
    searchableTerms: ['rc', 'test', 'basic', 'electronics'],
    ownerRole: 'seller',
  },
  {
    id: 'rc-stock-10',
    name: 'RC Inventory Probe — Stock 10',
    price: 50000,                            // KES 500.00
    stock: 10,
    category: 'grocery',
    status: 'active',
    isVisible: true,
    searchableTerms: ['rc', 'inventory', 'probe', 'stock', 'grocery'],
    ownerRole: 'seller',
  },
  {
    id: 'rc-search-swahili',
    name: 'RC Search — Viatu (Shoes)',
    price: 350000,                           // KES 3,500.00
    stock: 12,
    category: 'fashion',
    status: 'active',
    isVisible: true,
    searchableTerms: ['rc', 'viatu', 'shoes', 'kiatu', 'fashion'],
    ownerRole: 'seller',
  },
];

/* A known order used by RC-03 (payment) and RC-04 (inventory) as the starting
   point, so those journeys don't depend on RC-02 having run first. */
const KNOWN_ORDER = {
  id: 'rc-order-seed',
  buyerRole: 'buyer',
  items: [{ productId: 'rc-stock-10', qty: 2, price: 50000 }],
  subtotal: 100000,
  status: 'pending',
};

/* Everything the harness writes is tagged so cleanup can find and remove ONLY
   RC data and never touch a real document. */
const RC_TAG = { _rcSeed: true, _rcRun: 'rc1' };

module.exports = { IDENTITIES, PRODUCTS, KNOWN_ORDER, RC_TAG };
