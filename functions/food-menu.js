/**
 * food-menu.js — FOOD HUB GATE 2: the Menu / Drinks authority (owner brief 2026-10-03).
 *
 * ONE callable, `foodMenu`, that a food business's merchant-v2 Menu and Drinks modules call. It is NOT a second
 * product system: every menu item IS a canonical `products/{id}` document (the record checkout, POS, stock, offers
 * and search already read). A drink is the same product filed under a `drinks` section — one record, projected into
 * the Menu and the Drinks views, never cloned.
 *
 * WHY A SERVER AUTHORITY. Products are written straight from the browser today (sokoni-merchant-data.js), and the
 * served rules protect none of price / status / stock on products/{id} (Gate 2 census). A food menu is built here
 * instead, so that every menu write is:
 *
 *   actor      merchant-identity.resolveActor — the SAME owner/employee authority merchant-v2 and posCompleteCheckout
 *              use (no new staff system). Menu edits: owner + manager. Availability: + cashier (the person at the
 *              counter marks an item sold out). Reads: any active staff role.
 *   module     business-workspace.workspaceFor(owner) — approval first, category → capability → merchantModules.
 *              `menu` (food sections) / `drinks` (drinks sections) must be AVAILABLE. A browser-chosen category
 *              activates nothing; a pending or unapproved business gets no menu.
 *   plan       the product limit (product-limit, the same counter the served `withinProductLimit` rule and
 *              canPublishProduct read) is checked BEFORE a new item is created — a refusal writes nothing.
 *   ownership  an item may only be edited through the shop it belongs to (products.shopId), owned by that shop's
 *              owner (products.sellerUid). Another shop's product id is refused, never adopted.
 *
 * WHAT THIS NEVER WRITES. `stock`, `inventoryVersion`, `sold`, `reservedStock` (merchantAdjustStock and the sale
 * transactions own them), `salePrice` (flash sales), `wholesalePrice` (b2b-wholesale), commission, approval or
 * verification fields. Price here is the merchant's BASE price; the final order price is resolved by the checkout
 * authority at transaction time (Gate 3), which reads this document — never a browser total.
 *
 * AVAILABILITY uses the canonical sellability vocabulary: `outOfStock: true` is the explicit merchant flag
 * shared/sellability.availabilityOf already honours (state out_of_stock / reason flagged), so every checkout that
 * consults sellability refuses an unavailable dish without new logic. `menu.availability` records which kind
 * (unavailable / temporarily_unavailable + availableAgainAt) for the dashboard.
 *
 * ARCHIVE is the canonical tombstone (sellability.tombstonePatch: status 'archived', isVisible false) — never a
 * delete (owner invariant: a product is never deleted).
 *
 * PUBLIC MENU (op 'public') returns only a shop that passes the ONE shop discovery gate
 * (business-category.shopEligibility) AND whose owner holds a valid food approval, and within it only published,
 * listed items with their server-computed availability. No demo data, no fallback menu.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const REGION = 'us-central1';
const CFG = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

const MENU_WRITERS = Object.freeze(['owner', 'manager']);
const AVAILABILITY_WRITERS = Object.freeze(['owner', 'manager', 'cashier']);
const SECTION_KINDS = Object.freeze({ food: 'menu', drinks: 'drinks' });     /* section kind → merchant module */
const AVAILABILITY = Object.freeze(['available', 'unavailable', 'temporarily_unavailable']);
const MAX_SECTIONS = 40;
const MAX_VARIANTS = 10;
const MAX_PRICE = 1000000;
const MAX_TEMP_HOURS = 7 * 24;

/* ── small helpers ───────────────────────────────────────────────────────────────────────────────────────────── */
const _s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const _fail = (code, msg, reason) => new HttpsError(code, msg, { reason });
function _price(v, what) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n > MAX_PRICE || Math.round(n * 100) !== n * 100) {
    throw _fail('invalid-argument', (what || 'Price') + ' must be a positive amount in KES (at most 2 decimals, up to 1,000,000).', 'BAD_PRICE');
  }
  return n;
}
/* The SAME id derivation as the merchant-v2 product writer (sokoni-merchant-data.productDraftId), so a menu item
   and a product created by any other merchant surface share one id space: prd_<shopId>_<djb2(shopId::token)>. */
function itemIdFor(shopId, token) {
  const basis = shopId + '::' + token;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return 'prd_' + shopId + '_' + h.toString(36);
}
const _slug = (s) => _s(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

/* ── dependencies (injectable for the certification suite; production defaults below) ─────────────────────── */
function defaultDeps() {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  return {
    db: getFirestore(),
    FieldValue,
    resolveActor: (uid, shopId) => require('./merchant-identity')._internal.resolveActor(uid, shopId),
    workspaceFor: (db, uid) => require('./business-workspace').workspaceFor(db, uid),
    productLimit: async (db, ownerUid) => {
      const PL = require('./product-limit');
      const snap = await db.collection('productCounters').doc(String(ownerUid)).get();
      const d = snap.exists ? (snap.data() || {}) : {};
      const max = typeof d.maxProducts === 'number' ? d.maxProducts : (await PL._internal.resolveMaxProducts(ownerUid)).max;
      const count = Number(d.count || 0);
      return { allowed: max === -1 || count < max, count, limit: max };
    },
    now: () => new Date(),
  };
}

/* ── the gates ────────────────────────────────────────────────────────────────────────────────────────────────── */
async function _actor(deps, uid, shopId, allowed) {
  if (!uid) throw _fail('unauthenticated', 'Sign in to manage your menu.', 'UNAUTHENTICATED');
  const sid = _s(shopId, 128);
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) throw _fail('invalid-argument', 'shopId is required.', 'NO_SHOP');
  const a = await deps.resolveActor(uid, sid);
  if (!a || !a.ok) throw _fail('permission-denied', 'You do not have access to this business.', (a && a.reason) || 'NOT_AUTHORISED');
  const role = a.servedBy && a.servedBy.role;
  if (allowed && allowed.indexOf(role) < 0) throw _fail('permission-denied', 'Your role cannot make this change.', 'ROLE_NOT_PERMITTED');
  const shop = a.shop || {};
  const ownerUid = String(shop.sellerUid || shop.ownerId || sid);
  return { shopId: sid, shop, ownerUid, role, uid };
}

/* The workspace must be AVAILABLE on merchant-v2 with the module switched on — the capability engine's answer, from
   server facts only. Returns the workspace (for the module map). */
async function _module(deps, ctx, moduleKey) {
  let w;
  try { w = await deps.workspaceFor(deps.db, ctx.ownerUid); }
  catch (e) { throw _fail('unavailable', 'Your business record could not be read just now. Nothing was changed.', 'WORKSPACE_UNREADABLE'); }
  if (!w || w.state !== 'AVAILABLE' || w.route !== 'merchant-v2.html') {
    throw _fail('failed-precondition', 'Your food business is not approved for a menu yet.', (w && (w.reason || w.state)) || 'NOT_APPROVED');
  }
  const m = (w.merchantModules || {})[moduleKey];
  if (!m || m.state !== 'AVAILABLE') {
    throw _fail('failed-precondition', 'This is not available for your business.', 'MODULE_' + (m ? m.state : 'NOT_APPLICABLE'));
  }
  return w;
}

function _sections(shop) {
  const m = shop && shop.menu;
  return Array.isArray(m && m.sections) ? m.sections.filter((x) => x && x.id && SECTION_KINDS[x.kind]) : [];
}

/* An item is editable through this shop only if it IS this shop's product. */
async function _ownedItem(deps, ctx, itemId) {
  const id = _s(itemId, 200);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw _fail('invalid-argument', 'itemId is required.', 'NO_ITEM');
  const ref = deps.db.collection('products').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw _fail('not-found', 'That menu item does not exist.', 'ITEM_NOT_FOUND');
  const p = snap.data() || {};
  if (String(p.shopId || '') !== ctx.shopId || String(p.sellerUid || '') !== ctx.ownerUid) {
    throw _fail('permission-denied', 'That item belongs to another business.', 'ITEM_NOT_OWNED');
  }
  return { ref, p, id };
}
const _archived = (p) => String(p.status || '').toLowerCase() === 'archived';

/* ── operations ──────────────────────────────────────────────────────────────────────────────────────────────── */
function _projectItem(id, p, extra) {
  const m = p.menu || {};
  return Object.assign({
    id, name: p.name || '', description: p.description || '', price: p.price,
    image: p.image || (Array.isArray(p.images) && p.images[0]) || null,
    sectionId: m.sectionId || null, kind: m.kind || null, sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : 0,
    variants: Array.isArray(p.variants) ? p.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })) : [],
    prepMinutes: typeof m.prepMinutes === 'number' ? m.prepMinutes : null,
  }, extra || {});
}

async function opLoad(deps, ctx) {
  const snap = await deps.db.collection('products').where('shopId', '==', ctx.shopId).limit(500).get();
  const items = snap.docs.map((d) => ({ id: d.id, p: d.data() || {} }))
    .filter((x) => x.p.menu && String(x.p.sellerUid || '') === ctx.ownerUid)
    .map((x) => _projectItem(x.id, x.p, {
      status: _archived(x.p) ? 'archived' : (String(x.p.status || '') === 'active' ? 'published' : 'draft'),
      availability: (x.p.menu && x.p.menu.availability) || (x.p.outOfStock === true ? 'unavailable' : 'available'),
      availableAgainAt: (x.p.menu && x.p.menu.availableAgainAt) || null,
      metered: typeof x.p.stock === 'number', stock: typeof x.p.stock === 'number' ? x.p.stock : null,
    }));
  return { ok: true, role: ctx.role, sections: _sections(ctx.shop), items };
}

async function opSaveSections(deps, ctx, data) {
  const input = Array.isArray(data.sections) ? data.sections : null;
  if (!input) throw _fail('invalid-argument', 'sections must be a list.', 'BAD_SECTIONS');
  if (input.length > MAX_SECTIONS) throw _fail('invalid-argument', 'At most ' + MAX_SECTIONS + ' sections.', 'TOO_MANY_SECTIONS');
  const seen = new Set();
  const out = input.map((x, i) => {
    const name = _s(x && x.name, 40);
    const kind = String((x && x.kind) || 'food');
    if (!name) throw _fail('invalid-argument', 'Every section needs a name.', 'BAD_SECTION_NAME');
    if (!SECTION_KINDS[kind]) throw _fail('invalid-argument', 'A section is food or drinks.', 'BAD_SECTION_KIND');
    let id = _s(x && x.id, 32);
    if (id && !/^[a-z0-9_-]{1,32}$/.test(id)) throw _fail('invalid-argument', 'Bad section id.', 'BAD_SECTION_ID');
    if (!id) { id = _slug(name) || ('section-' + (i + 1)); let k = 2; while (seen.has(id)) id = _slug(name).slice(0, 28) + '-' + (k++); }
    if (seen.has(id)) throw _fail('invalid-argument', 'Two sections share an id.', 'DUP_SECTION_ID');
    seen.add(id);
    return { id, name, kind, sortOrder: i };
  });
  /* Each module gates its own kind: a business without the Drinks capability cannot create drinks sections. */
  for (const k of new Set(out.map((x) => x.kind))) await _module(deps, ctx, SECTION_KINDS[k]);
  /* A section still holding live items cannot be removed or change kind — its items would lose their place. */
  const before = _sections(ctx.shop);
  const gone = before.filter((b) => !out.some((n) => n.id === b.id && n.kind === b.kind)).map((b) => b.id);
  if (gone.length) {
    const live = await deps.db.collection('products').where('shopId', '==', ctx.shopId).limit(500).get();
    const used = live.docs.map((d) => d.data() || {}).filter((p) => p.menu && gone.indexOf(p.menu.sectionId) > -1 && !_archived(p));
    if (used.length) throw _fail('failed-precondition', 'Move or archive the items in a section before removing it.', 'SECTION_IN_USE');
  }
  await deps.db.collection('shops').doc(ctx.shopId).set({
    menu: { sections: out, updatedAt: deps.FieldValue.serverTimestamp(), updatedBy: ctx.uid },
  }, { merge: true });
  return { ok: true, sections: out };
}

async function opSaveItem(deps, ctx, data) {
  const sections = _sections(ctx.shop);
  const sec = sections.find((x) => x.id === _s(data.sectionId, 32));
  if (!sec) throw _fail('invalid-argument', 'Choose a menu section for this item.', 'NO_SECTION');
  await _module(deps, ctx, SECTION_KINDS[sec.kind]);

  const name = _s(data.name, 120);
  if (!name) throw _fail('invalid-argument', 'The item needs a name.', 'NO_NAME');
  const description = _s(data.description, 1000);
  const price = _price(data.price);
  const vin = Array.isArray(data.variants) ? data.variants : [];
  if (vin.length > MAX_VARIANTS) throw _fail('invalid-argument', 'At most ' + MAX_VARIANTS + ' sizes/options.', 'TOO_MANY_VARIANTS');
  const variants = vin.map((v, i) => {
    const vn = _s(v && v.name, 40);
    if (!vn) throw _fail('invalid-argument', 'Every size/option needs a name.', 'BAD_VARIANT');
    return { id: _slug(vn) || ('opt-' + (i + 1)), name: vn, price: _price(v && v.price, 'Option price') };
  });
  let prepMinutes = null;
  if (data.prepMinutes != null && data.prepMinutes !== '') {
    const pm = Number(data.prepMinutes);
    if (!Number.isInteger(pm) || pm < 0 || pm > 600) throw _fail('invalid-argument', 'Preparation time is whole minutes (0–600).', 'BAD_PREP');
    prepMinutes = pm;
  }
  const ts = deps.FieldValue.serverTimestamp();
  const fields = {
    name, nameLower: name.toLowerCase(), description, price, variants,
    /* `category` is what every existing storefront groups by; the section name is the menu's category. */
    category: sec.name,
  };

  if (data.itemId) {
    const { ref, p } = await _ownedItem(deps, ctx, data.itemId);
    if (_archived(p)) throw _fail('failed-precondition', 'Restore is not available; create the item again.', 'ITEM_ARCHIVED');
    const prevMenu = p.menu || {};
    await ref.set(Object.assign({}, fields, {
      menu: Object.assign({}, prevMenu, { sectionId: sec.id, kind: sec.kind, prepMinutes }),
      updatedAt: ts, updatedBy: ctx.uid, revision: deps.FieldValue.increment(1),
    }), { merge: true });
    return { ok: true, itemId: ref.id, created: false };
  }

  const token = _s(data.draftToken, 80);
  if (!token) throw _fail('invalid-argument', 'draftToken is required (one per new item).', 'NO_DRAFT_TOKEN');
  const id = itemIdFor(ctx.shopId, token);
  const ref = deps.db.collection('products').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    /* The same draftToken replayed: the item it created, never a second one. Another shop's id cannot collide
       (the id embeds this shopId), but ownership is still checked. */
    const p = existing.data() || {};
    if (String(p.shopId) !== ctx.shopId || String(p.sellerUid) !== ctx.ownerUid) throw _fail('permission-denied', 'That item belongs to another business.', 'ITEM_NOT_OWNED');
    return { ok: true, itemId: id, created: false, replay: true };
  }
  const lim = await deps.productLimit(deps.db, ctx.ownerUid);
  if (!lim || lim.allowed !== true) {
    throw new HttpsError('resource-exhausted', 'Your plan does not allow another item. Upgrade to add more.', {
      reason: 'PRODUCT_LIMIT_REACHED', limit: lim ? lim.limit : null, count: lim ? lim.count : null, action: { label: 'View plans', href: '/subscription.html' } });
  }
  const sortOrder = Date.now() % 1e9;
  await ref.create(Object.assign({}, fields, {
    id, shopId: ctx.shopId, sellerUid: ctx.ownerUid,
    status: 'draft',                     /* never published by creation — publish is its own decision */
    menu: { sectionId: sec.id, kind: sec.kind, sortOrder, availability: 'available', prepMinutes },
    source: 'food_menu', createdAt: ts, createdBy: ctx.uid, updatedAt: ts, updatedBy: ctx.uid, revision: 1,
  }));
  return { ok: true, itemId: id, created: true };
}

async function opSetStatus(deps, ctx, data) {
  const { ref, p } = await _ownedItem(deps, ctx, data.itemId);
  if (_archived(p)) throw _fail('failed-precondition', 'This item is archived.', 'ITEM_ARCHIVED');
  if (!p.menu) throw _fail('failed-precondition', 'This product is not on your menu.', 'NOT_A_MENU_ITEM');
  const want = String(data.status || '');
  if (want !== 'published' && want !== 'draft') throw _fail('invalid-argument', 'status is published or draft.', 'BAD_STATUS');
  await _module(deps, ctx, SECTION_KINDS[p.menu.kind] || 'menu');
  await ref.set({ status: want === 'published' ? 'active' : 'draft', isVisible: want === 'published',
    updatedAt: deps.FieldValue.serverTimestamp(), updatedBy: ctx.uid, revision: deps.FieldValue.increment(1) }, { merge: true });
  return { ok: true, itemId: ref.id, status: want };
}

async function opSetAvailability(deps, ctx, data) {
  const { ref, p } = await _ownedItem(deps, ctx, data.itemId);
  if (_archived(p)) throw _fail('failed-precondition', 'This item is archived.', 'ITEM_ARCHIVED');
  if (!p.menu) throw _fail('failed-precondition', 'This product is not on your menu.', 'NOT_A_MENU_ITEM');
  const av = String(data.availability || '');
  if (AVAILABILITY.indexOf(av) < 0) throw _fail('invalid-argument', 'availability is available, unavailable or temporarily_unavailable.', 'BAD_AVAILABILITY');
  await _module(deps, ctx, SECTION_KINDS[p.menu.kind] || 'menu');
  let again = null;
  if (av === 'temporarily_unavailable') {
    const hours = Number(data.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_TEMP_HOURS) throw _fail('invalid-argument', 'Temporarily unavailable is 1 to 168 hours.', 'BAD_HOURS');
    again = new Date(deps.now().getTime() + hours * 3600e3).toISOString();
  }
  await ref.set({
    outOfStock: av !== 'available',                       /* the canonical flag sellability.availabilityOf honours */
    menu: Object.assign({}, p.menu, { availability: av, availableAgainAt: again }),
    updatedAt: deps.FieldValue.serverTimestamp(), updatedBy: ctx.uid,
  }, { merge: true });
  return { ok: true, itemId: ref.id, availability: av, availableAgainAt: again };
}

async function opArchive(deps, ctx, data) {
  const { ref, p } = await _ownedItem(deps, ctx, data.itemId);
  if (!p.menu) throw _fail('failed-precondition', 'This product is not on your menu.', 'NOT_A_MENU_ITEM');
  if (_archived(p)) return { ok: true, itemId: ref.id, archived: true, already: true };
  const SELL = require('./shared/sellability');
  await ref.set(Object.assign(SELL.tombstonePatch(), {
    archivedAt: deps.FieldValue.serverTimestamp(), archivedBy: ctx.uid, updatedAt: deps.FieldValue.serverTimestamp(),
  }), { merge: true });
  return { ok: true, itemId: ref.id, archived: true };
}

async function opReorder(deps, ctx, data) {
  const ids = Array.isArray(data.itemIds) ? data.itemIds.slice(0, 200) : null;
  if (!ids || !ids.length) throw _fail('invalid-argument', 'itemIds is required.', 'NO_ITEMS');
  const owned = [];
  for (const id of ids) owned.push(await _ownedItem(deps, ctx, id));      /* all checked BEFORE any write */
  const batch = deps.db.batch();
  owned.forEach((o, i) => batch.set(o.ref, { menu: Object.assign({}, o.p.menu || {}, { sortOrder: i }), updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true }));
  await batch.commit();
  return { ok: true, count: owned.length };
}

/* The SHOP's food workspace, for anyone who works there: the owner's workspace answer (approval → category →
   capability → merchantModules), projected to what merchant-v2 needs to show or hide the Menu / Drinks / Kitchen views.
   providerDispatch businessWorkspace answers for the CALLER's account, which for a manager or cashier is not the
   business — so the shop-scoped answer lives here, behind the same staff authority as every menu read. */
async function opModules(deps, ctx) {
  let w;
  try { w = await deps.workspaceFor(deps.db, ctx.ownerUid); }
  catch (e) { throw _fail('unavailable', 'Your business record could not be read just now.', 'WORKSPACE_UNREADABLE'); }
  const routed = !!(w && w.state === 'AVAILABLE' && w.route === 'merchant-v2.html');
  const mm = routed ? (w.merchantModules || {}) : {};
  const pick = (k) => (mm[k] ? { state: mm[k].state, reason: mm[k].reason || null } : null);
  return { ok: true, role: ctx.role, state: w ? w.state : null, route: w ? w.route : null, reason: (w && w.reason) || null,
    message: (w && w.message) || null, merchantModules: { menu: pick('menu'), drinks: pick('drinks'), kitchen: pick('kitchen'), catering: pick('catering') } };
}

/* Public: what a buyer may see. No auth required; nothing private returned. */
async function opPublic(deps, data) {
  const sid = _s(data.shopId, 128);
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) throw _fail('invalid-argument', 'shopId is required.', 'NO_SHOP');
  const shopSnap = await deps.db.collection('shops').doc(sid).get();
  const none = { ok: true, available: false, sections: [], items: [] };
  if (!shopSnap.exists) return Object.assign(none, { reason: 'SHOP_NOT_FOUND' });
  const shop = shopSnap.data() || {};
  const elig = require('./business-category').shopEligibility(shop);
  if (!elig.eligible) return Object.assign(none, { reason: 'SHOP_NOT_PUBLIC' });
  const ownerUid = String(shop.sellerUid || shop.ownerId || sid);
  let w = null; try { w = await deps.workspaceFor(deps.db, ownerUid); } catch (_) { w = null; }
  const mm = (w && w.state === 'AVAILABLE' && w.route === 'merchant-v2.html' && w.merchantModules) || {};
  const on = (k) => mm[k] && mm[k].state === 'AVAILABLE';
  if (!on('menu') && !on('drinks')) return Object.assign(none, { reason: 'NO_FOOD_MENU' });
  const SELL = require('./shared/sellability');
  const snap = await deps.db.collection('products').where('shopId', '==', sid).limit(500).get();
  const sections = _sections(shop).filter((s) => on(SECTION_KINDS[s.kind]));
  const items = snap.docs.map((d) => ({ id: d.id, p: d.data() || {} }))
    .filter((x) => x.p.menu && String(x.p.sellerUid || '') === ownerUid && String(x.p.status || '') === 'active' && x.p.isVisible !== false && !_archived(x.p)
      && sections.some((s) => s.id === x.p.menu.sectionId))
    .map((x) => { const a = SELL.availabilityOf(x.p, shop); return _projectItem(x.id, x.p, { availability: a.state, orderable: false, sellable: a.sellable }); });
  /* `orderable:false` — Food ordering is Gate 3. The menu is real; ordering is not open, and nothing here says it is. */
  return { ok: true, available: true, shop: { id: sid, name: _s(shop.name, 160) }, sections, items, ordering: 'NOT_OPEN' };
}

/* ── dispatcher ──────────────────────────────────────────────────────────────────────────────────────────────── */
async function handle(deps, uid, data) {
  const d = data || {};
  const op = String(d.op || '');
  switch (op) {
    case 'public': return opPublic(deps, d);
    case 'load': return opLoad(deps, await _actor(deps, uid, d.shopId, null));
    case 'modules': return opModules(deps, await _actor(deps, uid, d.shopId, null));
    case 'saveSections': return opSaveSections(deps, await _actor(deps, uid, d.shopId, MENU_WRITERS), d);
    case 'saveItem': return opSaveItem(deps, await _actor(deps, uid, d.shopId, MENU_WRITERS), d);
    case 'setStatus': return opSetStatus(deps, await _actor(deps, uid, d.shopId, MENU_WRITERS), d);
    case 'setAvailability': return opSetAvailability(deps, await _actor(deps, uid, d.shopId, AVAILABILITY_WRITERS), d);
    case 'archive': return opArchive(deps, await _actor(deps, uid, d.shopId, MENU_WRITERS), d);
    case 'reorder': return opReorder(deps, await _actor(deps, uid, d.shopId, MENU_WRITERS), d);
    default: throw _fail('invalid-argument', 'Unknown menu operation.', 'UNKNOWN_OP');
  }
}

let _deps = null;
exports.foodMenu = onCall(CFG, async (req) => {
  _deps = _deps || defaultDeps();
  try {
    return await handle(_deps, req.auth && req.auth.uid, req.data);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('[foodMenu] failed', { op: req.data && req.data.op, error: String(e && e.message || e) });
    throw new HttpsError('internal', 'The menu could not be updated. Nothing was changed.');
  }
});

exports._internal = { handle, itemIdFor, MENU_WRITERS, AVAILABILITY_WRITERS, SECTION_KINDS, AVAILABILITY, defaultDeps };
