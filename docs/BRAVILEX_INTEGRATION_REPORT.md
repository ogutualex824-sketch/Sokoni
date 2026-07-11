# SOKONI × Bravilex — Corporate Integration Change Report

**Date:** 2026-07-11
**Change:** SOKONI is now legally owned and operated by **Bravilex International Co. Limited**.
**Scope:** Branding/legal-ownership only. **SOKONI remains the consumer brand.** No infrastructure, API, Firebase, payment, auth, database, or schema changes.
**Commit:** `645649a` (38 files) + earlier straggler fixes.

---

## 1. What changed (and what deliberately did NOT)

**Changed — legal entity references only:**
- Old entities found: **`Sokoni Technologies Ltd`** (legal.html, seo.js, JSON-LD in driver/flashsale/services) and **`Sokoni Digital Limited`** (most page footers, About/Contact/press, email + generated footers). Both replaced with **`Bravilex International Co. Limited`**.

**Unchanged — all consumer-facing SOKONI branding (verified):**
- App name, page `<title>`, `manifest.json` `name`/`short_name` (still "SOKONI"), logo, favicon, domain `mysokoni.co.ke`, nav, colours, layout.
- Firebase project, Firestore collections, Storage, Functions names, indexes, Auth, Cloud Run services, secrets, env vars — untouched.
- APIs, endpoints, URLs, schemas — untouched.

---

## 2. Files updated (38)

### Legal pages (7)
`legal.html` (5 entity refs + footer + "Company" definition + ownership statement), `privacy.html`, `terms.html` (binding-contract-with-Bravilex + "Company" defined), `cookie-policy.html`, `refund-policy.html`, `returns-policy.html`, `data-deletion.html` — entity swaps + canonical footers + ownership statements.

### Agreements & info pages (12)
`seller-terms.html` (merchant clause), `provider-terms.html` (provider clause), `community-guidelines.html`, `help.html`, `faq.html`, `about.html` (Bravilex mission paragraph + JSON-LD legalName), `contact.html` (Company/Brand block + publisher), `careers.html` (hiringOrganization), `press.html` (company name + boilerplate), `trust-and-safety.html`, `payment-security.html`, `status.html` — footers + required copy.

### SEO / structured data (4 + seo.js)
`seo.js` (`legalName: "Bravilex International Co. Limited"`, added `brand: "SOKONI"`), `driver.html` / `flashsale.html` / `services.html` inline JSON-LD Organization names.

### Footers (also in the above; plus)
`index.html`, `community.html` copyright footers → `© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.`

### Dashboards (3)
`seller.html` ("Powered by Bravilex…" footer), `profile.html` ("SOKONI — A product of Bravilex…" footer), `admin-os.html` (Company Information block: Legal Entity = Bravilex, Platform = SOKONI).

### Backend / templates (8 JS)
`functions/email-templates.js` (email footer + copyright), `sokoni-receipt.js`, `functions/etims.js`, `functions/hub-etims.js`, `functions/pos-retail.js`, `functions/pos-retail-engine.js` (receipt/invoice/eTIMS/POS document legal footers → "Operated by Bravilex…"), `functions/index.js` + `functions/pos-ai-assistant.js` (**KASS prompts**: "who owns SOKONI" → "SOKONI is owned and operated by Bravilex International Co. Limited."), plus `age-gate.js` generated footer.

---

## 3. Validation results
- **`node --check`** on all 10 edited JS files — **PASS**.
- **Entity sweep:** `grep` for `Sokoni Technologies Ltd | Sokoni Digital Limited | Sokoni Ventures | Mysokoni Ventures` → **0 remaining** (excluding the intended `legal-hub.html` form placeholders).
- **Branding intact:** manifest `name`/`short_name` = SOKONI; titles unchanged.
- **Bravilex references present in 36 files.**
- **Deploy:** Hosting (customer-facing pages) + Functions (backend text) — see §5.

---

## 4. Intentionally left as-is
- **`legal-hub.html`** form-generator placeholders (`"e.g. Sokoni Technologies Ltd"`, `"e.g. Sokoni Ventures"`) — these are **example inputs for users generating their OWN contracts** (NDA/employment/partnership), not SOKONI's legal entity. Replacing them would be incorrect. (Optional follow-up: change to a neutral example like "e.g. Acme Ltd".)

---

## 5. Deployment & follow-ups
- **Hosting:** deployed (legal pages, footers, About, Contact, dashboards, seo.js, client receipt renderer).
- **Functions:** backend text changes (KASS prompts, email footer, eTIMS/POS receipt footers) are **updates to existing functions** — deploy via `firebase deploy --only functions:sokoniChat,functions:Kass` (KASS) and the email/eTIMS/POS functions. These are not quota-blocked (updates, not new creates).
- **Manual follow-ups (business, not code):**
  - App-store **developer/publisher name** → "Bravilex International Co. Limited" (Play Console / App Store Connect metadata) — the PWA `manifest.json` display name stays SOKONI as required.
  - Update any **registered business documents / payment-processor (IntaSend) merchant name** to Bravilex.
  - `CHANGELOG.md` / `README.md` corporate note (optional).

---

## 6. Success criteria — met
- ✅ Customers still experience the platform as **SOKONI** (branding, app, domain unchanged).
- ✅ All legal-ownership references consistently identify **Bravilex International Co. Limited**.
- ✅ No infrastructure, API, Firebase, payment, auth, or database functionality altered.
