'use strict';
/**
 * EPRA maximum pump prices — parser for https://www.epra.go.ke/pump-prices (2026-10-03)
 * ======================================================================================
 * EPRA retired the /category/petroleum/maximum-pump-prices/ pages (404 since 2026-07-12). Prices now live on ONE
 * public page (allowed by robots.txt) holding a single table with a row per town per pricing period:
 *
 *     From | To | Town | Super (PMS) | Diesel (AGO) | Kerosene (IK)       e.g. 15-08-2026 | 14-09-2026 | Nairobi | 214.03 | 217.86 | 191.38
 *
 * PURE (no network, no Firestore, no clock unless passed) so the suite exercises THIS code against real page shapes.
 *
 * HONEST BY CONSTRUCTION — the old parser filled any missing fuel or city from fixed ratios and regional offsets,
 * i.e. it invented prices. This one never does:
 *   - columns are located by their HEADER TEXT, not by position, so a reordered table still parses or fails;
 *   - a price outside 80–600 KES/litre is refused (the row is skipped, never "corrected");
 *   - the result must contain Nairobi with all three fuels, otherwise it THROWS and the caller keeps the last
 *     real prices (and reports the failure) — no partial or estimated record is ever written;
 *   - the period actually published by EPRA is returned with the prices, so a reader can say how old they are.
 */
const PRICE_MIN = 80, PRICE_MAX = 600;
const FUELS = { super_petrol: /super|pms|petrol/i, diesel: /diesel|ago/i, kerosene: /kerosene|\bik\b/i };

const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function dmy (s) { const m = String(s || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); if (!m) return null; const t = Date.UTC(+m[3], +m[2] - 1, +m[1]); return isNaN(t) ? null : t; }
const iso = (t) => new Date(t).toISOString().slice(0, 10);
function price (s) { const n = Number(String(s || '').replace(/,/g, '')); return Number.isFinite(n) && n >= PRICE_MIN && n <= PRICE_MAX ? Math.round(n * 100) / 100 : null; }
const townKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** parsePumpPrices(html, { now }) → { period:{from,to}, prices:{super_petrol:{town:n},diesel:{},kerosene:{}}, towns } — throws on anything not provably right. */
function parsePumpPrices (html, opts) {
  const now = (opts && opts.now) ? Number(opts.now) : Date.now();
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  let col = null, body = null;
  for (const tb of tables) {
    const heads = [...tb.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]).toLowerCase());
    const idx = (re) => heads.findIndex((h) => re.test(h));
    const c = { from: idx(/^from\b/), to: idx(/^to\b/), town: idx(/town/), super_petrol: idx(FUELS.super_petrol), diesel: idx(FUELS.diesel), kerosene: idx(FUELS.kerosene) };
    if (Object.values(c).every((i) => i >= 0)) { col = c; body = tb; break; }
  }
  if (!col) throw new Error('EPRA pump-price table not found (header From/To/Town/Super/Diesel/Kerosene missing)');

  const rows = [];
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => text(c[1]));
    if (cells.length <= Math.max(...Object.values(col))) continue;
    const from = dmy(cells[col.from]), to = dmy(cells[col.to]);
    if (from === null || to === null || to < from) continue;
    rows.push({ from, to, town: cells[col.town], super_petrol: price(cells[col.super_petrol]), diesel: price(cells[col.diesel]), kerosene: price(cells[col.kerosene]) });
  }
  if (!rows.length) throw new Error('EPRA pump-price table has no parseable rows');

  /* The period in force: the newest one that has STARTED (EPRA can publish the next month a day early). */
  const started = [...new Set(rows.map((r) => r.from))].filter((f) => f <= now + 86400000).sort((a, b) => b - a);
  if (!started.length) throw new Error('EPRA pump-price table has no period that has started');
  const from = started[0];
  const cur = rows.filter((r) => r.from === from);
  const to = cur[0].to;

  const prices = { super_petrol: {}, diesel: {}, kerosene: {} };
  let towns = 0;
  for (const r of cur) {
    const k = townKey(r.town); if (!k) continue;
    let any = false;
    for (const f of Object.keys(prices)) if (r[f] !== null) { prices[f][k] = r[f]; any = true; }
    if (any) towns++;
  }
  if (!(prices.super_petrol.nairobi && prices.diesel.nairobi && prices.kerosene.nairobi)) {
    throw new Error('EPRA pump-price table: Nairobi Super/Diesel/Kerosene not all present for ' + iso(from) + '..' + iso(to));
  }
  return { period: { from: iso(from), to: iso(to) }, prices, towns };
}

module.exports = { parsePumpPrices, PRICE_MIN, PRICE_MAX, _internals: { dmy, price, townKey } };
