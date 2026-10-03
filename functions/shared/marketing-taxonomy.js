'use strict';
/**
 * THE Marketing Hub taxonomy — ONE source of truth (owner brief 2026-10-03, Marketing Hub MK1).
 * Every Marketing surface reads THIS list: the application wizard, the directory filters, the marketer's service editor,
 * AdminOS / Super Admin, the capability answer. The browser copy sokoni-marketing-taxonomy.js is GENERATED
 * (node scripts/build-marketing-taxonomy.js --check); never hand-edit it. Ids are stable; labels may change.
 *
 * Each service carries `model`: how a customer buys it on SOKONI — 'booking' (fixed-price session through the canonical
 * booking engine), 'quote' (request → provider quote → accept → booking) or 'project' (quote → held payment → delivery →
 * release). Every model settles through providerBookings → IntaSend → hold → completion PIN → one commission → business
 * wallet; nothing here prices or settles.
 *
 * LEGACY: HubRegister's six marketing rows (graphic-design, social-media, printing, advertising, pr-firm, content-creator)
 * map one-to-one where a match exists (printing has none — it is a marketplace product category, not a marketing service).
 */
const G = (id, label, icon, services) => ({ id, label, icon, services });
const S = (id, label, model) => ({ id, label, model: model || 'quote' });

const GROUPS = Object.freeze([
  G('strategy', 'Strategy & Consulting', '🧭', [S('marketing-strategy', 'Marketing Strategy'), S('digital-marketing-strategy', 'Digital Marketing Strategy'), S('brand-strategy', 'Brand Strategy'), S('market-research', 'Market Research', 'project'), S('marketing-consulting', 'Marketing Consulting', 'booking')]),
  G('digital', 'Digital Marketing', '📱', [S('digital-marketing', 'Digital Marketing'), S('social-media-marketing', 'Social Media Marketing'), S('social-media-management', 'Social Media Management', 'project'), S('seo', 'Search Engine Optimization (SEO)', 'project'), S('sem', 'Search Engine Marketing (SEM)'), S('performance-marketing', 'Performance Marketing'), S('affiliate-marketing', 'Affiliate Marketing'), S('email-marketing', 'Email Marketing'), S('sms-marketing', 'SMS Marketing'), S('whatsapp-marketing', 'WhatsApp Marketing')]),
  G('content', 'Content', '✍️', [S('content-marketing', 'Content Marketing'), S('copywriting', 'Copywriting'), S('blog-writing', 'Blog / Article Writing'), S('website-content', 'Website Content'), S('product-descriptions', 'Product Descriptions'), S('social-media-content', 'Social Media Content'), S('content-strategy', 'Content Strategy')]),
  G('creative', 'Creative & Brand', '🎨', [S('branding', 'Branding', 'project'), S('brand-identity', 'Brand Identity', 'project'), S('logo-design', 'Logo Design'), S('graphic-design', 'Graphic Design'), S('marketing-design', 'Marketing Design'), S('creative-direction', 'Creative Direction'), S('packaging-design', 'Packaging / Promotional Design')]),
  G('media', 'Media', '🎬', [S('photography', 'Photography', 'booking'), S('commercial-photography', 'Commercial Photography', 'booking'), S('product-photography', 'Product Photography', 'booking'), S('videography', 'Videography', 'booking'), S('commercial-video', 'Commercial Video', 'project'), S('social-media-video', 'Social Media Video'), S('motion-graphics', 'Motion Graphics'), S('animation', 'Animation', 'project'), S('video-editing', 'Video Editing'), S('audio-advertising', 'Audio / Voice Advertising')]),
  G('advertising', 'Advertising', '📣', [S('campaign-management', 'Advertising Campaign Management', 'project'), S('social-advertising', 'Social Advertising'), S('search-advertising', 'Google / Search Advertising'), S('display-advertising', 'Display Advertising'), S('outdoor-advertising', 'Outdoor Advertising'), S('print-advertising', 'Print Advertising'), S('radio-advertising', 'Radio Advertising'), S('tv-advertising', 'Television Advertising'), S('influencer-campaigns', 'Influencer Campaigns', 'project')]),
  G('pr', 'Public Relations & Communications', '🗞️', [S('public-relations', 'Public Relations', 'project'), S('corporate-communications', 'Corporate Communications'), S('media-relations', 'Media Relations'), S('press-releases', 'Press Releases'), S('reputation-management', 'Reputation Management', 'project'), S('event-promotion', 'Event Promotion')]),
  G('creator', 'Influencer & Creator Marketing', '🌟', [S('influencer-marketing', 'Influencer Marketing', 'project'), S('creator-campaigns', 'Creator Campaigns', 'project'), S('brand-partnerships', 'Brand Partnerships'), S('ugc-campaigns', 'UGC Campaigns'), S('ambassador-campaigns', 'Ambassador Campaigns', 'project')]),
  G('events', 'Events & Activation', '🎪', [S('event-marketing', 'Event Marketing', 'project'), S('product-launches', 'Product Launches', 'project'), S('brand-activations', 'Brand Activations', 'project'), S('experiential-marketing', 'Experiential Marketing', 'project'), S('roadshows', 'Roadshows', 'project'), S('promotional-campaigns', 'Promotional Campaigns', 'project')]),
  G('growth', 'Sales & Growth', '📈', [S('lead-generation', 'Lead Generation'), S('customer-acquisition', 'Customer Acquisition'), S('conversion-optimization', 'Conversion Optimization'), S('sales-promotion', 'Sales Promotion'), S('growth-marketing', 'Growth Marketing'), S('marketing-automation', 'Marketing Automation')]),
].map((g) => Object.freeze(Object.assign({}, g, { services: Object.freeze(g.services.map((s) => Object.freeze(s))) }))));

const AREA = Object.freeze(GROUPS.reduce((m, g) => { g.services.forEach((s) => { if (m[s.id]) throw new Error('duplicate marketing id ' + s.id); m[s.id] = Object.freeze({ id: s.id, label: s.label, group: g.id, model: s.model }); }); return m; }, {}));
const AREA_IDS = Object.freeze(Object.keys(AREA));
const MODELS = Object.freeze(['booking', 'quote', 'project']);

/* The three application types the owner requires — NEVER the generic business application. */
const APPLICATION_TYPES = Object.freeze({
  individual: { label: 'Individual Marketer', minCategories: 1, maxCategories: 12 },
  agency:     { label: 'Marketing Agency',    minCategories: 1, maxCategories: 30 },
  specialist: { label: 'Specialist (one service)', minCategories: 1, maxCategories: 1 },
});

const LEGACY_TO_AREA = Object.freeze({ 'graphic-design': 'graphic-design', 'social-media': 'social-media-management', advertising: 'campaign-management', 'pr-firm': 'public-relations', 'content-creator': 'social-media-content', printing: null });

function normalizeCategories(input, max) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) { const id = typeof v === 'string' ? v.trim().toLowerCase() : ''; if (AREA[id] && out.indexOf(id) < 0) out.push(id); if (out.length >= (max || 30)) break; }
  return out;
}
const isArea = (id) => !!AREA[id];
const groupOf = (id) => (AREA[id] ? AREA[id].group : null);
const groupsOf = (ids) => { const g = []; (ids || []).forEach((a) => { const x = groupOf(a); if (x && g.indexOf(x) < 0) g.push(x); }); return g; };

module.exports = { GROUPS, AREA, AREA_IDS, MODELS, APPLICATION_TYPES, LEGACY_TO_AREA, normalizeCategories, isArea, groupOf, groupsOf };
