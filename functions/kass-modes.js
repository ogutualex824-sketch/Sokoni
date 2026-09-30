/* ══════════════════════════════════════════════════════════════════════════
   KASS EXPERT MODES  —  kass-modes.js

   KASS switches expertise automatically. The user never picks a mode — being
   asked "which department do you want?" is exactly the bureaucratic experience
   a good concierge removes.

   A mode does NOT change the facts (those come from retrieved knowledge). It
   changes the LENS: what to ask first, what to lead with, what a good answer
   looks like. A payments question and a pricing question deserve different
   instincts even when they touch the same order.

   Detection is lexical and multilingual — the same tokeniser the knowledge
   engine uses, so "nataka kuuza" routes to Merchant just as "I want to sell"
   does. It is intentionally cheap: this runs before every model call, so an
   LLM classifier here would add a round-trip and blow the latency budget.

   Ambiguity is expected and fine. When no mode wins clearly we fall back to
   CONCIERGE, which is the correct behaviour for "hi" or "help me".
═════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Each mode: cues (weighted terms, English + Kiswahili/Sheng) and a lens.
   Cues are matched against normalised tokens, so include the ROOT users type. */
const MODES = {
  shopping: {
    label: '🛒 Shopping Expert',
    cues: ['buy','nunua','kununua','price','bei','cheap','rahisi','compare','product','bidhaa',
           'phone','simu','laptop','tv','fridge','shoes','viatu','warranty','dhamana','spec',
           'brand','size','colour','color','deal','offer','discount','punguzo','available'],
    lens:
`LENS — Shopping Expert.
Search the marketplace FIRST and show real listings with real prices before you explain anything.
Compare on the things that actually decide a Kenyan purchase: price, warranty, seller rating, delivery
time and proximity. If their budget is tight, say so plainly and show the cheaper option — do not upsell
someone who told you they are broke. Offer an alternative when the exact item isn't there rather than
returning nothing.`,
  },
  merchant: {
    label: '🏪 Merchant Expert',
    cues: ['sell','uza','kuuza','muuzaji','seller','merchant','shop','duka','biashara','listing',
           'orders','customers','wateja','margin','faida','profit','revenue','mauzo','supplier',
           'wholesale','jumla','onboarding','verify','verification'],
    lens:
`LENS — Merchant Expert.
Talk to them as an operator, not a shopper. Ground every answer in their real numbers — ask what the unit
cost them and what similar listings sell for before advising on price. Diagnose before prescribing: when
"nothing is selling", check photos, title, price and trust BEFORE suggesting paid promotion.
Be concrete and commercial. Label your commercial judgement as advice, never as SOKONI policy.`,
  },
  payments: {
    label: '💳 Payments Expert',
    cues: ['pay','lipa','malipo','mpesa','m-pesa','stk','paybill','till','card','wallet','pesa',
           'refund','rudisha','failed','imekwama','pending','escrow','settlement','payout','withdraw','toa'],
    lens:
`LENS — Payments Expert.
Money is where a wrong answer does the most damage. NEVER state that a payment succeeded, failed or is
pending unless you have READ it with a tool. Never guess a payout timing.
If a payment is stuck: confirm the phone number, check the real state, and give the next concrete step.
Always warn against paying a seller's personal M-PESA number — that is outside SOKONI and unprotected.`,
  },
  logistics: {
    label: '🚚 Logistics Expert',
    cues: ['delivery','deliver','itafika','tuma','shipping','rider','boda','driver','courier',
           'track','tracking','late','imechelewa','address','pickup','dispatch','zone'],
    lens:
`LENS — Logistics Expert.
Read the ACTUAL order status with a tool before you say anything about where it is. Never invent an
arrival time.
Be realistic about Kenyan delivery: same/next-day is normal within Nairobi; other counties take longer;
rain stops boda delivery; bulky items are genuinely harder. If it is late, say so plainly and give the
next step — do not reassure vaguely.`,
  },
  kenya: {
    label: '🏛 Kenya Guide',
    cues: ['kra','pin','ntsa','ecitizen','huduma','county','kaunti','tax','ushuru','licence','license',
           'permit','register','sajili','sacco','bank','benki','holiday','sikukuu','constituency','ward'],
    lens:
`LENS — Kenya Guide.
Explain the SHAPE of the process and where to go. Do NOT state current fees, thresholds, penalties or
deadlines — these change and a wrong figure has real legal and financial consequences. Point to the
official source (eCitizen, iTax, Huduma Centre) or to a professional.
You are not a lawyer, tax adviser or financial adviser. Be useful, be accurate, know the edge.`,
  },
  business: {
    label: '📈 Business Consultant',
    cues: ['grow','growth','marketing','strategy','advice','ushauri','pricing','promotion','brand',
           'accounting','hesabu','cashflow','loan','mkopo','expand','competitor','plan'],
    lens:
`LENS — Business Consultant.
Practical, numerate, Kenyan-market-aware. Work from their actual figures. Prefer one decisive
recommendation over five options.
Be honest when the answer is uncomfortable — cut the dead stock, drop the price, fire the bad supplier.
Flag clearly that this is advice, not SOKONI policy. Never encourage borrowing to fund inventory.`,
  },
  inventory: {
    label: '📦 Inventory Expert',
    cues: ['stock','inventory','restock','ghala','warehouse','expiry','batch','fefo','reorder',
           'stockout','count','shrinkage','supplier'],
    lens:
`LENS — Inventory Expert.
The two killers are cash tied up in dead stock, and stockouts on the fast movers. Push them to decide
from SmartPOS reports, not memory. Sell perishables oldest-first (FEFO). Cut dead stock decisively even
at a loss — cash beats shelves.`,
  },
  pos: {
    label: '🛠 SmartPOS / Technical Support',
    cues: ['smartpos','pos','till','receipt','printer','scanner','barcode','shift','drawer','offline',
           'sync','device','login','error','bug','stuck','haifanyi'],
    lens:
`LENS — SmartPOS / Technical Support.
Diagnose, don't lecture. Ask for the ONE fact that discriminates between causes, then give the fix as
numbered steps.
SmartPOS works offline and syncs on reconnect — say so, because Kenyan merchants lose the network
constantly and often assume they've lost the sale. If it is a real defect, say so and escalate rather
than talking them in circles.`,
  },
  property: {
    label: '🏠 Property Expert',
    cues: ['house','nyumba','rent','kodi','apartment','plot','land','shamba','bnb','airbnb','hotel',
           'stay','landlord','tenant','deposit','agent'],
    lens:
`LENS — Property Expert.
Location, price, and what's actually included decide it. Be specific about the estate/area — "Nairobi"
is useless to someone choosing between Kasarani and Karen.
Warn plainly about deposit scams: never pay a deposit for a house you have not seen, and never off-platform.`,
  },
  jobs: {
    label: '💼 Jobs Expert',
    cues: ['job','kazi','hire','ajira','cv','resume','apply','employer','vacancy','salary','mshahara','intern'],
    lens:
`LENS — Jobs Expert.
Be practical and encouraging without inflating hopes. Match on real skills and location.
Never charge or endorse charging a jobseeker to apply — that is the classic Kenyan job scam. Say so if
you see it.`,
  },
  events: {
    label: '🎉 Events Expert',
    cues: ['event','tukio','ticket','tiketi','concert','gate','organiser','organizer','venue','booking','book'],
    lens:
`LENS — Events Expert.
Tickets, dates, venue, entry. Be exact about time and gate details — a vague answer here means someone
misses the event. Warn against buying tickets outside SOKONI.`,
  },
  analytics: {
    label: '📊 Analytics Advisor',
    cues: ['report','ripoti','analytics','dashboard','sales','trend','forecast','kpi','metric','data','insight'],
    lens:
`LENS — Analytics Advisor.
Lead with the number that changes a decision, not a wall of metrics. Say what it means and what to DO.
If you don't have the data, say so — do not estimate a figure and present it as measured.`,
  },
  support: {
    label: '🤖 Platform Expert',
    cues: ['account','akaunti','password','sign','login','profile','settings','how','feature','app','kass','help','saidia'],
    lens:
`LENS — Platform Expert.
Explain how SOKONI actually works, briefly, then take them to the exact page. Prefer doing over
describing.`,
  },
};

const FALLBACK = {
  label: '🤝 Concierge',
  lens:
`LENS — Concierge.
Intent is not yet clear. Do NOT interrogate them. Make one good assumption from context and act on it, or
ask a single short question. Kenyan users expect fast, direct service — a wall of clarifying questions
loses them.`,
};

/* Reuse the knowledge engine's tokeniser so mode detection and retrieval see the
   same normalised text — otherwise a query could retrieve payments knowledge while
   routing to the shopping lens. */
const { tokens } = require('./kass-knowledge');

/* STRONG cues decide the mode on their own. They are the words that state INTENT
   rather than subject matter, and intent is what a lens should follow.
   "Nataka kuuza simu" contains both a selling verb and a product noun — without
   this, the product noun tied with the verb and routed a SELLER to the shopping
   lens. The verb is what matters: they are selling, not buying. */
const STRONG = {
  merchant:  ['sell','uza','kuuza','selling','listing','listings','seller','muuzaji','merchant'],
  inventory: ['stock','inventory','restock','stockout','reorder','expiry','ghala'],
  payments:  ['refund','rudisha','payout','escrow','settlement','mpesa','m-pesa','stk'],
  logistics: ['delivery','deliver','itafika','tracking','rider','boda'],
  property:  ['nyumba','house','rent','kodi','plot','shamba','bnb'],
  jobs:      ['job','kazi','ajira','cv','vacancy'],
};

/* Light stemming: Kenyan users type plurals and -ing forms freely ("listings",
   "selling"). Matching cues literally missed all of them — "My listings are not
   selling" routed to Concierge, which is a failure on the single most common
   merchant complaint. */
function _variants(tok) {
  const v = new Set([tok]);
  if (tok.endsWith('s')   && tok.length > 3) v.add(tok.slice(0, -1));
  if (tok.endsWith('ing') && tok.length > 5) v.add(tok.slice(0, -3));
  return v;
}

function detect(query) {
  const t = tokens(query);
  if (!t.length) return { key: 'concierge', ...FALLBACK, score: 0 };

  /* Expand the query once, so both cue lists match against the same variants. */
  const expanded = new Set();
  t.forEach(tok => _variants(tok).forEach(v => expanded.add(v)));
  const lead = new Set(t.slice(0, 3));

  let best = null;
  for (const [key, m] of Object.entries(MODES)) {
    let score = 0;
    for (const cue of m.cues) {
      if (expanded.has(cue)) score += 2;
      if (lead.has(cue))     score += 1;                 /* intent word up front */
    }
    for (const cue of (STRONG[key] || [])) {
      if (expanded.has(cue)) score += 5;                 /* intent beats subject matter */
    }
    if (score > 0 && (!best || score > best.score)) best = { key, ...m, score };
  }

  /* Require a real signal. One incidental word is not an expertise switch —
     routing on noise is worse than staying a generalist. */
  if (!best || best.score < 2) return { key: 'concierge', ...FALLBACK, score: 0 };
  return best;
}

module.exports = { detect, MODES, FALLBACK };
