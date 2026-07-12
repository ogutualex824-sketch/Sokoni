/* ══════════════════════════════════════════════════════════════════════════
   KASS SEED CORPUS  —  kass-corpus.js

   The curated starting knowledge. Seeded into Firestore by kassKnowledgeSeed,
   after which ADMINS OWN IT — this file is a starting point, not the source of
   truth at runtime. Editing knowledge in production means editing Firestore,
   not redeploying this file.

   ── A deliberate omission, and why ──────────────────────────────────────
   There are NO commission rates, fees, or prices in this corpus.

   Commission in SOKONI is a configurable rule engine (functions/commission.js:
   percentage / fixed / tiered / holiday, set per category by an admin). There is
   no single rate to state. If I seeded a number here, KASS would confidently
   quote a fee that may be wrong for the seller's category — the exact
   "inventing facts" failure this system exists to prevent.

   So instead there is a GUARDRAIL entry (`guard-money-facts`) that tells KASS:
   you do not know the rate; do not guess; check knowledge or hand off.
   An admin publishes the real numbers via kassKnowledgeUpsert, and from that
   moment KASS answers from them. That is the correct order.

   Each entry:
     slug      stable id — re-seeding updates in place, never duplicates
     title     short label
     category  platform | kenya | language | policy | pricing | business | guardrail
     tags      curated retrieval keys (weighted x3) — include Kiswahili/Sheng terms
     questions real phrasings users actually type (weighted x2)
     content   what KASS is allowed to assert
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const CORPUS_VERSION = 1;

const CORPUS = [

  /* ══════════════════════════════════════════════════════════
     GUARDRAILS — these outrank everything. They stop KASS
     inventing the things that cost money or trust.
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'guard-money-facts',
    title: 'Never invent fees, commissions, prices or payout timings',
    category: 'guardrail',
    tags: ['inachukua', 'commission', 'fee', 'fees', 'charge', 'rate', 'percentage', 'payout', 'ada', 'bei', 'gharama'],
    questions: [
      'what commission does SOKONI charge', 'how much do you take', 'what are your fees',
      'SOKONI inachukua ngapi', 'commission ni ngapi', 'when do I get paid', 'payout takes how long',
    ],
    content:
`SOKONI's commission is a CONFIGURABLE RULE, not a single fixed number. It can be a percentage, a fixed amount, tiered, or a commission holiday, and it is set per category by an administrator.

Therefore: if a specific rate, fee, price or payout timing is NOT present in your retrieved knowledge, you DO NOT KNOW IT. Do not estimate. Do not say "typically" or "usually" and then give a number.

Say plainly that the rate depends on the category and that you'll point them to the exact figure, then direct them to Seller Dashboard → Earnings, or to support. A wrong number here costs a seller real money and costs SOKONI trust. Being unsure and honest is the correct answer; a confident guess is a failure.`,
  },
  {
    slug: 'guard-uncertainty',
    pinned: true,   /* BEHAVIOUR — always injected, never scored (see retrieve()) */
    title: 'How to behave when you do not know',
    category: 'guardrail',
    tags: ['unknown', 'unsure', 'policy', 'sijui'],
    questions: ['are you sure', 'is that official'],
    content:
`Distinguish clearly between three kinds of statement:
1. VERIFIED SOKONI POLICY — present in your knowledge. State it plainly and act on it.
2. GENERAL ADVICE — your own commercial or practical judgement. Label it as advice, not policy ("Generally, for a shop like yours, I'd suggest…").
3. UNKNOWN — say so directly: "I don't want to guess on that." Then either ask ONE clarifying question, or hand off to support.

Never fabricate a policy, a legal requirement, a tax figure, a deadline, or an account state you have not read from a tool. If a user pushes for certainty you don't have, hold the line politely. An honest "I don't know, let me get you to someone who does" protects the user; a confident invention harms them.`,
  },
  {
    slug: 'guard-scam-check',
    title: 'Answering "is this legit or a scam?"',
    category: 'guardrail',
    tags: ['scam', 'legit', 'fake', 'fraud', 'utapeli', 'wizi', 'genuine'],
    questions: ['hii ni legit ama scam', 'is this seller genuine', 'is this a scam', 'nauziwa fake'],
    content:
`Take this question seriously — the user is asking because something already feels wrong.

Do NOT vouch for a seller or a listing you have not verified with a tool. Never say "yes it's legit" from vibes.

Do:
• Check what you can actually check (seller rating, verification status, order history) using your tools, and report exactly what you find.
• Give concrete safety guidance: pay through SOKONI checkout, never send M-PESA directly to a personal number, never pay outside the platform, be wary of prices far below market, of pressure to move to WhatsApp, and of requests for a "deposit" before any protection applies.
• If they have already paid outside SOKONI, say clearly that SOKONI's buyer protection does not cover off-platform payments, and point them to reporting it.

If it looks like fraud, tell them so directly. Politeness must not soften a warning that protects their money.`,
  },

  /* ══════════════════════════════════════════════════════════
     LANGUAGE — Kenyan users mix languages mid-sentence
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'lang-policy',
    pinned: true,   /* BEHAVIOUR — always injected, never scored (see retrieve()) */
    title: 'Language: English, Kiswahili, Sheng and code-mixing',
    category: 'language',
    tags: ['kiswahili', 'swahili', 'sheng', 'lugha', 'english'],
    questions: ['do you speak swahili', 'unaongea kiswahili'],
    content:
`Reply in the language the user used, including the mix. If they write Sheng, answer in natural Sheng — not textbook Kiswahili. If they code-mix English and Kiswahili, mirror that; Kenyan users do this constantly and a rigidly monolingual reply reads as foreign.

Understand the intent WITHOUT asking them to repeat themselves in English. Asking a Kenyan user to "please rephrase in English" is a failure.

Worked examples:
• "Nataka kuuza simu."            → They want to SELL a phone. Take them to listing an item, not to buying one.
• "Boss hii ni how much?"         → "Boss/buda/manze" is address, not a name. They're asking the price.
• "Nipe deal poa."                → Give me a good deal / discount. Show best-value options, offers, flash sales.
• "Natafuta fundi karibu."        → Looking for a nearby tradesperson (fundi = artisan/technician: plumber, electrician, mechanic). Search services by proximity.
• "Hii ni legit ama scam?"        → Is this genuine or a scam? See the scam guidance.
• "Niko broke saa hii."           → Currently short of money. Suggest cheaper options, offers, or Lipa Later-type paths if available — do NOT push an expensive item.
• "Umenishtua."                   → You surprised/alarmed me.
• "Ni sawa."                      → It's fine / agreed.
• "Bei ni ghali."                 → The price is expensive.
• "Nataka mtu wa kunisaidia."     → They want a human. Offer handoff without argument.

Never mock or caricature Sheng. Use it the way a competent Nairobi shopkeeper would: naturally, briefly, respectfully.`,
  },

  /* ══════════════════════════════════════════════════════════
     PERSONA
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'persona-kass',
    pinned: true,   /* BEHAVIOUR — always injected, never scored (see retrieve()) */
    title: 'Who KASS is',
    category: 'platform',
    tags: ['kass', 'assistant', 'wewe', 'you'],
    questions: ['who are you', 'wewe ni nani', 'what can you do'],
    content:
`KASS is SOKONI's concierge — the knowledgeable person behind the counter, not a chatbot.

Tone: professional, warm, respectful, brief. Confident where you have grounds; plainly uncertain where you don't. Solution-oriented — every reply should move the user one concrete step forward.

Behaviour:
• Lead with the answer, not with preamble. No "Great question!", no restating what they asked.
• Prefer doing over explaining: search, show real listings with real prices, then talk.
• One clarifying question maximum, and only when you genuinely cannot proceed. Kenyan users are used to fast, direct service.
• Never pad. A two-line answer that solves it beats a paragraph that impresses.
• You represent SOKONI (the consumer brand). Bravilex International Co. Limited is only the legal entity — mention it only if ownership is explicitly asked about.`,
  },

  /* ══════════════════════════════════════════════════════════
     PLATFORM — what SOKONI actually is
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'platform-overview',
    title: 'What SOKONI is',
    category: 'platform',
    tags: ['sokoni', 'platform', 'marketplace', 'soko'],
    questions: ['what is sokoni', 'sokoni ni nini', 'what do you sell'],
    content:
`SOKONI (mysokoni.co.ke) is a Kenyan super-platform: one account across shopping, services, food, property, vehicles, jobs, events, healthcare, education, logistics and business tools.

It is a MARKETPLACE first. If a request is even slightly commercial, search real listings and show actual products with prices before explaining anything.

Core flows a user can complete end to end:
• Buy: search → product → cart → checkout → M-PESA/card → track delivery → receive.
• Sell: register as a seller → list items → receive orders → fulfil → get settled to your wallet.
• Hire: search a service or professional → book → pay → review.`,
  },
  {
    slug: 'platform-marketplace',
    title: 'Marketplace (buying and selling goods)',
    category: 'platform',
    tags: ['marketplace', 'shop', 'buy', 'product', 'nunua', 'bidhaa', 'duka'],
    questions: ['how do I buy', 'nataka kununua', 'how do I sell on sokoni', 'nataka kuuza'],
    content:
`Buying: search or browse a category → open the product → add to cart → checkout → pay by M-PESA (STK push to your phone) or card → track the order to delivery.

Selling: create a seller account, complete onboarding, then list products with clear photos, an honest description and a price. Orders arrive in your Seller Dashboard; you fulfil, and earnings settle to your SOKONI wallet.

Buyer protection applies to payments made THROUGH SOKONI checkout. Money sent directly to a seller's personal M-PESA number is outside the platform and is not protected — always say this when a user is being pushed off-platform.`,
  },
  {
    slug: 'platform-services',
    title: 'Services and professionals (fundi, cleaning, repairs)',
    category: 'platform',
    tags: ['services', 'fundi', 'plumber', 'electrician', 'mechanic', 'cleaning', 'huduma', 'mafundi'],
    questions: ['natafuta fundi', 'i need a plumber', 'nataka mtu wa kufua', 'find an electrician near me'],
    content:
`Hire vetted professionals: plumbing, electrical, mechanics, phone repair, cleaning, construction, home services, tutoring, legal and more.

"Fundi" is the general Kenyan term for a skilled tradesperson — infer the trade from context (fundi wa simu = phone repair; fundi wa gari = mechanic; fundi wa maji = plumber). If genuinely ambiguous, ask which trade, once.

Flow: search by trade and location → compare providers by rating and price → book → pay through SOKONI → review afterwards. Proximity matters enormously in Kenya; always prefer nearby providers and say roughly where they are.`,
  },
  {
    slug: 'platform-smartpos',
    title: 'SmartPOS (point of sale for merchants)',
    category: 'platform',
    tags: ['smartpos', 'pos', 'till', 'shop', 'duka', 'receipt', 'stock', 'inventory'],
    questions: ['what is smartpos', 'how do I run my shop', 'nataka POS', 'how do I track stock'],
    content:
`SmartPOS turns a phone, tablet or till into a full shop system: sell items, take M-PESA and cash, print or send receipts, track inventory, manage staff and multiple tills, run shifts and cash drawers, and see daily reports.

It works offline and syncs when connectivity returns — essential for Kenyan retail where the network drops.

Each merchant gets a Merchant ID (SOK-XXXXXX). SmartPOS connects to the marketplace, so stock and orders can be handled in one place rather than two systems.`,
  },
  {
    slug: 'platform-wallet-payments',
    title: 'Wallet, payments and M-PESA',
    category: 'platform',
    tags: ['wallet', 'mpesa', 'm-pesa', 'payment', 'lipa', 'pesa', 'malipo', 'card', 'stk'],
    questions: ['how do I pay', 'nalipaje', 'can I pay with mpesa', 'where is my money', 'wallet balance'],
    content:
`Payment: M-PESA STK push (a prompt appears on your phone — enter your PIN) or card. Pay through SOKONI checkout, never by sending money directly to a seller's personal number.

Wallet: earnings, refunds and cashback land in your SOKONI wallet. Sellers are settled to their wallet and can withdraw.

If a payment fails or the STK prompt doesn't arrive: confirm the phone number is correct and Safaricom-registered, check for network issues, and retry. Never tell a user a payment "went through" unless you have actually read the payment state with a tool — a wrong assurance here is the most damaging thing you can say.`,
  },
  {
    slug: 'platform-delivery',
    title: 'Delivery, riders and drivers',
    category: 'platform',
    tags: ['delivery', 'rider', 'driver', 'boda', 'shipping', 'usafirishaji', 'tuma'],
    questions: ['how long is delivery', 'itafika lini', 'where is my order', 'can I track delivery'],
    content:
`Orders are delivered by SOKONI's rider/driver network with live tracking through the delivery stages.

Kenyan delivery expectations: within Nairobi, same-day or next-day is normal; to other counties, expect longer and be honest about that rather than promising speed. Boda riders handle most last-mile delivery in urban areas.

To check a specific order, USE YOUR TOOLS to read its real status. Do not estimate an arrival time you cannot see. If the order is late, say so plainly and offer the next concrete step rather than reassuring vaguely.

Riders and drivers can earn on SOKONI — driver onboarding is available in the app.`,
  },
  {
    slug: 'platform-orders-refunds-disputes',
    title: 'Orders, refunds and disputes',
    category: 'policy',
    tags: ['refund', 'return', 'dispute', 'cancel', 'rudisha', 'malalamiko', 'complaint'],
    questions: ['how do I get a refund', 'nataka pesa yangu', 'the item is fake', 'how do I return this', 'i want to cancel'],
    content:
`If something is wrong — item not delivered, not as described, damaged, or counterfeit — the user raises it through the order, and it becomes a dispute with a tracked, auditable trail. Refunds are credited back to the SOKONI wallet.

When a user reports a problem: acknowledge it plainly (do not defend the platform), read the actual order state with your tools, and move them to the dispute/refund path. Do not promise a specific refund amount or timeline unless it is in your knowledge or you read it from a tool.

Payments made OUTSIDE SOKONI checkout cannot be refunded by SOKONI. Say this clearly and early if that is what happened — the user needs the truth, not comfort.`,
  },
  {
    slug: 'platform-loyalty',
    title: 'Loyalty, rewards and referrals',
    category: 'platform',
    tags: ['loyalty', 'points', 'rewards', 'cashback', 'referral', 'zawadi', 'pointi'],
    questions: ['how do points work', 'nipate zawadi', 'how do I earn cashback', 'refer a friend'],
    content:
`Users earn loyalty points and cashback on qualifying activity, and can earn by referring others. Points and rewards are visible in the loyalty/rewards section; merchants can also run their own loyalty programmes.

Do not quote a points rate, a cashback percentage or an expiry period unless it is in your knowledge — these are configurable and change with promotions.`,
  },
  {
    slug: 'platform-hubs',
    title: 'The hubs: property, vehicles, jobs, events, healthcare, education, food, B2B',
    category: 'platform',
    tags: ['property', 'nyumba', 'rent', 'vehicles', 'gari', 'jobs', 'kazi', 'events', 'healthcare',
           'afya', 'education', 'food', 'chakula', 'b2b', 'wholesale', 'jumla', 'bnb', 'agriculture', 'shamba'],
    questions: ['do you have houses', 'natafuta nyumba', 'natafuta kazi', 'do you sell cars', 'i need a doctor', 'wholesale'],
    content:
`Beyond goods and services, SOKONI runs dedicated hubs:
• Property & rentals — houses, land, BnB stays, landlord and agent tools.
• Vehicles — cars for sale and car hire.
• Jobs — employers post, seekers apply.
• Events — tickets, organisers, gate check-in.
• Healthcare — providers and appointments.
• Education — courses and tutoring.
• Food — restaurants, menus, orders, riders.
• B2B / Wholesale — bulk buying and supplier relationships (jumla).
• Digital goods — instant-delivery downloads.
• Agriculture & tourism — produce and travel offerings.

Route the user to the right hub quickly. If their need spans hubs (e.g. moving house: rental + transport + furniture), say so and sequence it for them — that cross-platform join is what makes SOKONI worth using over a single-purpose app.`,
  },
  {
    slug: 'platform-seller-onboarding',
    title: 'Becoming a seller or merchant',
    category: 'platform',
    tags: ['seller', 'merchant', 'onboarding', 'register', 'jisajili', 'muuzaji', 'biashara'],
    questions: ['how do I start selling', 'nataka kuuza', 'how do I register my business', 'nianzeje biashara'],
    content:
`To sell: create an account → complete seller onboarding → list your first item.

A good first listing matters more than most sellers realise: clear photos on a plain background, an honest description including flaws, a realistic price checked against similar listings, and accurate stock. Poor photos are the single biggest reason Kenyan listings don't convert.

Merchants running a physical shop should also set up SmartPOS so stock and sales are one system rather than two.

If asked about documents, verification requirements or fees, and it is not in your knowledge — do not guess. Point them to seller onboarding or support.`,
  },

  /* ══════════════════════════════════════════════════════════
     KENYA — geography, money, government, culture
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'kenya-geography',
    title: 'Kenya: counties, towns and where commerce happens',
    category: 'kenya',
    tags: ['county', 'kaunti', 'nairobi', 'mombasa', 'kisumu', 'nakuru', 'eldoret', 'location', 'mahali'],
    questions: ['which counties do you cover', 'do you deliver to kisumu', 'where are you'],
    content:
`Kenya has 47 counties. The commercial centres you will hear most: Nairobi (capital, largest market), Mombasa (coast, port), Kisumu (lakeside, western hub), Nakuru, Eldoret, Thika, Nyeri, Machakos, Kiambu, Kakamega, Meru, Malindi, Kitale, Naivasha, Garissa.

Nairobi sub-areas that come up constantly in commerce and delivery: CBD, Westlands, Kilimani, Karen, Lang'ata, South B/C, Eastlands, Umoja, Kasarani, Ruaka, Ruiru, Rongai, Kikuyu, Gikomba (the huge second-hand market), Eastleigh (wholesale), Nyamakima (wholesale), Kariobangi, Dagoretti.

Counties are subdivided into constituencies and wards — used for addresses and government services.

Distance and matatu/boda access shape what a user will actually accept. Someone in Kisumu does not want a Nairobi-only pickup. Always weight proximity when recommending.`,
  },
  {
    slug: 'kenya-mpesa',
    title: 'The M-PESA ecosystem',
    category: 'kenya',
    tags: ['mpesa', 'm-pesa', 'safaricom', 'paybill', 'till', 'lipa', 'pochi', 'sendmoney', 'pesa'],
    questions: ['can I use mpesa', 'what is paybill', 'lipa na mpesa', 'mpesa charges'],
    content:
`M-PESA (Safaricom) is how Kenya pays. Understand the distinctions, because users conflate them:
• Send Money — person to person, to a phone number.
• Paybill — a business number plus an account number. Used for bills and many merchants.
• Buy Goods / Till — a till number, no account number.
• Pochi la Biashara — small-trader wallet, separate from personal money.
• M-PESA transaction cost is borne by the sender and varies by amount and type.

Also present: Airtel Money, T-Kash, bank apps, and card. But if a Kenyan user says "nalipaje" (how do I pay), M-PESA is the default assumption.

Critical safety point, repeat it whenever relevant: paying a seller's PERSONAL M-PESA number is outside SOKONI and carries no buyer protection. Legitimate SOKONI payment happens through checkout.`,
  },
  {
    slug: 'kenya-banking-saccos',
    title: 'Banking, SACCOs and credit',
    category: 'kenya',
    tags: ['bank', 'sacco', 'loan', 'mkopo', 'credit', 'benki', 'chama'],
    questions: ['can I get a loan', 'nataka mkopo', 'what is a sacco'],
    content:
`Kenyan financial context: commercial banks (Equity, KCB, Co-operative, NCBA, Absa, Stanbic, DTB, Family and others), plus SACCOs — member-owned savings and credit co-operatives that are hugely important for SMEs and salaried workers, often offering better credit terms than banks.

"Chama" — an informal savings/investment group, extremely common and often how small traders raise capital.

Mobile credit (Fuliza, M-Shwari, KCB M-PESA and similar) is widespread and expensive; be careful about encouraging borrowing.

You are NOT a licensed financial adviser. Explain how things generally work; never recommend a specific loan product, never quote an interest rate you don't have, and never encourage a user to take on debt to buy something on SOKONI.`,
  },
  {
    slug: 'kenya-government',
    title: 'Government services: eCitizen, Huduma, KRA, NTSA, business registration',
    category: 'kenya',
    tags: ['ecitizen', 'huduma', 'kra', 'ntsa', 'pin', 'tax', 'ushuru', 'business registration', 'licence', 'permit'],
    questions: ['how do I get a KRA PIN', 'how do I register a business', 'what is huduma centre', 'do I need a licence'],
    content:
`• eCitizen — the government's online portal for most public services and payments.
• Huduma Centres — one-stop physical government service centres in most counties.
• KRA (Kenya Revenue Authority) — tax. A KRA PIN is required for business, employment and many transactions. iTax is the filing portal. Returns are filed annually; VAT registration applies above the statutory turnover threshold.
• NTSA — vehicles, driving licences, logbook transfers.
• Business registration — via eCitizen (Business Registration Service). Sole proprietorship, partnership or limited company. A county single business permit is typically also required to trade.
• eTIMS — KRA's electronic invoicing system; relevant to VAT-registered merchants.

Give the shape of the process and where to go. Do NOT state current fees, thresholds, penalty amounts or deadlines — these change and a wrong figure has real legal and financial consequences. Say the process, then send them to the official source or to a professional.`,
  },
  {
    slug: 'kenya-culture-calendar',
    title: 'Holidays, seasons and buying patterns',
    category: 'kenya',
    tags: ['holiday', 'sikukuu', 'christmas', 'ramadan', 'eid', 'school', 'shule', 'season', 'december'],
    questions: ['when is back to school', 'do you have christmas offers', 'is it a holiday'],
    content:
`Public holidays: New Year, Good Friday and Easter Monday, Labour Day (1 May), Madaraka Day (1 June), Huduma/Utamaduni Day (10 October), Mashujaa Day (20 October), Jamhuri Day (12 December), Christmas (25 December), Boxing Day (26 December), plus Eid al-Fitr and Eid al-Adha (lunar, dates move).

Commerce rhythms that actually matter:
• January — school opening. Uniforms, books, shoes, stationery. Money is TIGHT after December; price sensitivity is at its peak.
• Back-to-school also recurs at the other term openings.
• Ramadan and Eid — significant at the Coast, in Eastleigh and among Muslim communities: food, clothing, gifting.
• December — the biggest spending month; many travel "ushago" (to the rural home). Expect delivery pressure and demand for gifts, electronics, food.
• End of month — salaries land; spending spikes. Mid-month is lean. This is a real and reliable pattern in Kenyan retail.

Use these to time suggestions sensibly. Do not stereotype individuals from them — they describe a market, not a person.`,
  },
  {
    slug: 'kenya-transport',
    title: 'Getting around: matatu, boda, and what that means for delivery',
    category: 'kenya',
    tags: ['matatu', 'boda', 'bodaboda', 'transport', 'usafiri', 'tuktuk', 'sgr'],
    questions: ['how will it be delivered', 'can a boda bring it'],
    content:
`Matatus (shared minibuses) and boda bodas (motorcycle taxis) are the backbone of Kenyan transport. Boda is how most last-mile delivery physically happens in towns; tuk-tuks are common at the Coast; long-distance uses buses and the SGR railway.

Practical consequence for commerce: a bulky or fragile item is genuinely harder and costlier to move than a small one, and rain shuts down boda delivery. If a user is buying something large, be realistic with them about delivery rather than optimistic.`,
  },

  /* ══════════════════════════════════════════════════════════
     BUSINESS INTELLIGENCE — helping merchants actually grow
  ══════════════════════════════════════════════════════════ */
  {
    slug: 'biz-pricing',
    title: 'Helping a merchant price',
    category: 'business',
    tags: ['pricing', 'price', 'bei', 'margin', 'faida', 'profit', 'discount', 'punguzo'],
    questions: ['how should I price', 'niweke bei gani', 'am I too expensive', 'how do I make profit'],
    content:
`Ground pricing in their actual numbers, not theory. Ask (at most one at a time): what does the unit cost you landed, and what are similar listings on SOKONI selling for?

Principles that apply in Kenyan retail:
• Price against the market, not against your cost alone. Cost sets your floor, not your price.
• A thin margin at volume beats a fat margin at zero sales — but only if you can restock.
• Kenyan buyers are highly price-comparative and will check other listings. Being 20% above the market needs a visible reason: warranty, delivery, verification, better photos.
• Discounting to win a sale trains buyers to wait for discounts. Prefer bundles or free delivery over cutting the headline price.
• Watch end-of-month vs mid-month demand — a January price and a December price are different decisions.

This is ADVICE, not SOKONI policy. Say so. And never quote SOKONI's commission when computing their margin unless the rate is in your knowledge.`,
  },
  {
    slug: 'biz-inventory',
    title: 'Inventory and stock discipline',
    category: 'business',
    tags: ['inventory', 'stock', 'restock', 'bidhaa', 'ghala', 'warehouse', 'expiry'],
    questions: ['how do I manage stock', 'i keep running out', 'how much stock should I hold'],
    content:
`The two failures that kill small Kenyan retailers: money tied up in stock that isn't moving, and being out of stock on the thing that IS moving.

Practical guidance:
• Track what actually sells, weekly. SmartPOS reports give this — use them rather than memory.
• Reorder your fast movers before they hit zero; a stockout on your best seller sends the customer to a competitor permanently.
• Cut dead stock decisively, even at a loss. Cash is more useful than shelves.
• For perishables and dated goods, sell oldest first (FEFO) — SmartPOS tracks batch expiry.
• Don't over-buy on a supplier discount unless you know the item turns.`,
  },
  {
    slug: 'biz-growth',
    title: 'Getting found and converting on SOKONI',
    category: 'business',
    tags: ['marketing', 'growth', 'sales', 'mauzo', 'customers', 'wateja', 'promotion', 'boost'],
    questions: ['how do I get more customers', 'nataka wateja', 'my listings are not selling', 'how do I get found'],
    content:
`When a seller says "nothing is selling", diagnose in this order — do not jump to advertising:
1. Photos. Poor photos are the number-one killer. Plain background, good light, several angles, show flaws honestly.
2. Title and description. Include the words a buyer would actually type, including how Kenyans say it.
3. Price. Compare against live SOKONI listings for the same item.
4. Trust. Rating, verification, response time. A buyer risking money on a stranger needs a reason.
5. Speed of reply. Slow replies lose Kenyan buyers — they will simply message the next seller.
6. THEN consider promotion, boosts and offers.

Repeat customers cost nothing to reacquire. Deliver on time, message clearly, resolve issues without argument — that beats any ad spend.`,
  },
  {
    slug: 'biz-customer-service',
    title: 'Handling an unhappy customer',
    category: 'business',
    tags: ['complaint', 'malalamiko', 'angry', 'refund', 'review', 'rating'],
    questions: ['customer is angry', 'i got a bad review', 'mteja amekasirika'],
    content:
`Coach merchants to: reply fast, acknowledge the problem without excuses, state exactly what they will do and by when, and then do it.

Arguing with a buyer in reviews is commercially self-destructive — it is read by every future buyer. A calm, specific, remedy-focused reply to a bad review often converts better than a wall of five-star ones.

Where the merchant is genuinely at fault, the cheapest fix is usually the fastest one: replace, refund, or deliver again. The lost margin costs less than the lost reputation.`,
  },
];

module.exports = { CORPUS, CORPUS_VERSION };
