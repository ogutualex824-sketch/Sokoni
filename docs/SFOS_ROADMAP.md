# SFOS Roadmap — SOKONI Financial Operating System

**Version:** 1.0  
**Date:** 2026-07-14  
**Status:** Living Document — update after each milestone  
**Owner:** SOKONI Engineering / Product  

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete |
| 🔄 | In Progress |
| 🔵 | Planned |
| ⚠️ | Blocked / At Risk |
| 🔴 | Regulatory Gate |

---

## Now — Phase 0 Pilot (July 2026)

### Already Built (RC1)

✅ **Wallet 2.0 Engine** (`wallet-engine.js`)
- 18 Gen2 Cloud Functions
- P2P send by phone
- Savings vaults with lock / auto-save / target
- QR code generation and payment
- PIN with rate-limiting and auto-freeze
- Daily / monthly spend limits
- AI spending insights (Claude Haiku)
- Escrow with two-party release

✅ **SFOS Core SDK** (`sfos-core.js`)
- Auth-gated, XSS-protected
- All SFOS CF bindings
- Canvas health gauge and vault progress rings
- Animated balance counters
- Panel / overlay navigation

✅ **SFOS Architecture Documentation**
- Architecture spec (this suite of documents)
- Migration guide (phases 0-4)
- API contracts for all 17 SFOS CFs
- Firestore schema for all SFOS collections

### Phase 0 Definition of Done

- [ ] sfos-engine.js deployed to production
- [ ] sfosIdentity created for all existing users
- [ ] sfos-wallet.html live at `/sfos-wallet.html`
- [ ] Reconciliation script passes with 0 drift
- [ ] 10% pilot rollout active and monitoring healthy

---

## Q3 2026 — SFOS Foundation

### July 2026

🔵 **Deploy SFOS CFs to Production**
- Deploy `sfos-engine.js` alongside existing CFs
- Deploy SFOS Firestore rules
- Deploy SFOS indexes
- Run batch identity migration

🔵 **Financial Identity Live**
- Every user has an `sfosIdentity` document
- Tier calculated from `lifetimeSpend` (Bronze → Platinum)
- KYC level visible in SFOS dashboard

🔵 **Immutable Ledger Active**
- All new transactions create `sfosLedger` entries
- Ledger immutability enforced by Firestore rules
- Daily reconciliation CF scheduled

### August 2026

🔵 **SFOS Dashboard: Full Feature Set**
- Financial health score with factor breakdown
- Net worth calculator
- AI spending forecast (Claude Haiku)
- Detailed analytics (week / month / year)
- Escrow with milestone tracking

🔵 **Loyalty Rewards Integration**
- sfosRewards seeded for all users
- Points earned on every transaction
- Tier upgrade / downgrade logic live
- Redemption (points → wallet credit) active

### September 2026

🔵 **Group Wallets (Chama)**
- Create / join a group wallet
- Contribution scheduling (weekly / monthly)
- Group transaction history
- Fund rotation (simple ROSCA logic)

🔵 **Merchant Financial Dashboard**
- Revenue summary (day / week / month)
- Pending settlement view
- Commission breakdown
- One-click settlement request

**Regulatory consideration:** Group wallets that collect and distribute funds may attract CBK attention as a "micro-deposit-taking institution." Legal review required before launch. Target conservative launch: group size cap 20 members, max balance KES 500,000.

---

## Q4 2026 — Merchant Finance

### October 2026

🔵 **Auto-Settlement Engine**
- Scheduled settlement every Tuesday and Friday
- Automatic commission deduction before settlement
- Settlement receipt PDF
- eTIMS integration for VAT-registered sellers

🔵 **Business Wallet Multi-User Access**
- Merchant can add up to 5 authorised users (cashiers, managers)
- Role-based permissions (view-only, initiate, approve)
- All actions logged in `walletAuditLog` with initiator UID
- PIN required for actions above KES 10,000

### November 2026

🔵 **Advanced KYC Tier Upgrades**
- Tier 1 (Basic): phone verification, KES 50k/day limit
- Tier 2 (Verified): national ID + selfie, KES 200k/day limit
- Tier 3 (Enhanced): business registration, KES 1M/day limit
- KYC documents stored in Firebase Storage with restricted rules

**Regulatory consideration:** Identity verification at Tier 2+ constitutes CDD (Customer Due Diligence) under Kenya's Proceeds of Crime and Anti-Money Laundering Act (POCAMLA). SOKONI must appoint an AML Compliance Officer before enabling Tier 2 KYC. Engage legal counsel in September 2026.

### December 2026

🔵 **Revenue Reporting Suite**
- Monthly P&L for merchants
- Tax summary (VAT, WHT where applicable)
- Downloadable CSV export for accountants
- eTIMS automated invoice submission for qualifying merchants

---

## Q1 2027 — Advanced Features

### January 2027

🔵 **Biometric Authentication**
- WebAuthn / FIDO2 passkey registration
- Fingerprint / Face ID for transaction confirmation
- Falls back to PIN if biometric unavailable
- Passkey stored device-side (no biometric data on servers)

🔵 **Real-Time Fraud Alerts**
- Push notification on unusual transactions
- In-app alert with one-tap freeze button
- Fraud reporting flow (contested transactions)
- 24-hour SLA on fraud investigations

### February 2027

🔵 **Family Wallet**
- Primary account links up to 4 family members (children, dependants)
- Parent controls: spend categories allowed, daily limit per member
- Allowance scheduling (weekly pocket money)
- Family spending summary view

**Regulatory consideration:** Family wallets where a parent controls a minor's account may require specific consent mechanisms under Kenya's Data Protection Act 2019. Children's data requires parental consent and enhanced protections. Legal review in December 2026.

### March 2027

🔵 **SFOS API (Third-Party Integrations)**
- REST API wrapper around SFOS CFs
- OAuth 2.0 authentication for third-party apps
- Rate-limited: 1,000 req/hour per app
- Sandbox environment for developer testing
- API key management dashboard
- Webhook notifications for transaction events

---

## Q2 2027 — Card Programme

### April 2027

🔵 **Virtual Debit Card**
- Partnership with a licensed card issuer (target: PesaLink or Equity Bank)
- Instant virtual Mastercard / Visa attached to SOKONI wallet
- Card number, CVV, and expiry in-app
- Freeze / unfreeze card independently from wallet
- Online purchases draw from wallet balance in real time

**Regulatory consideration:** SOKONI is not itself a card issuer. We are an agent of the licensed issuer. The issuer must be CBK-licensed as a payment card network participant. Negotiate agent issuing agreement with target issuer by January 2027.

### May 2027

🔵 **Card Top-Up and Withdrawal**
- Wallet → Card: instant transfer
- Card → Wallet: T+1 settlement
- Card spending reflected in SFOS ledger
- Card transaction history merged with wallet history

### June 2027

🔵 **Card Rewards**
- 0.5% cashback on card purchases (to wallet balance)
- Boosted rates for SOKONI Marketplace purchases (1.5%)
- Monthly cashback summary

---

## Q3 2027 — Licensed Services

🔴 **CBK Regulatory Sandbox Application**

SOKONI targets the CBK Regulatory Sandbox to test:
- P2P transfers above M-Pesa limits
- Group wallet (chama) features
- SFOS API for third-party integrations

**Application requirements:**
- Registered Kenyan company (Bravilex Digital Solutions Ltd ✅)
- Audited financial statements
- AML/CFT policy document
- IT security assessment by accredited firm
- Detailed product scope for sandbox

Target: sandbox application submitted Q2 2027, approval Q3 2027.

🔴 **Payment Service Provider (PSP) Licence**

Pursuing a Payment Service Provider licence under the National Payment System Act 2011 to:
- Operate P2P transfers independently of M-Pesa
- Issue electronic money (e-money)
- Operate as an acquiring institution

**Licence requirements:**
- Minimum paid-up capital: KES 20M
- Fit and proper assessment of directors
- Technical audit of payment systems
- Anti-money laundering programme

Target: PSP licence application Q3 2027, licence grant Q2 2028.

---

## Q4 2027 — Cross-Border

### November 2027

🔵 **M-Pesa Tanzania Integration**
- Send from SOKONI wallet to Tanzanian M-Pesa number
- Forex rate displayed at confirmation (live rate from CBK/XE)
- Compliance: both Kenya AML and Tanzania AML requirements
- Partner: Vodacom Tanzania (via Safaricom cross-border API)

**Regulatory consideration:** Cross-border transactions require SWIFT/BIS reporting above USD 10,000. SOKONI must register with both CBK (Kenya) and BRELA (Tanzania) for remittance service. Target corridor: Kenya ↔ Tanzania.

### December 2027

🔵 **Uganda Mobile Money**
- MTN Uganda Money (UGX) corridor
- Airtel Money Uganda corridor
- Target: Kenya → Uganda corridor (diaspora to family remittance)

🔵 **Kenya ↔ Uganda ↔ Tanzania Corridor**
- Unified cross-border transfer UI
- FX rates and fees shown upfront
- Compliance engine handles per-country limits
- Real-time compliance reporting to CBK

---

## 2028 — SOKONI Banking

### Q1 2028

🔴 **Digital Banking Licence (CBK)**

SOKONI targets a Digital Credit Provider (DCP) licence first (lower bar than full banking licence) to offer:
- Short-term credit (BNPL, personal loans)
- Savings products with interest

Full Banking Licence would follow, targeting 2029-2030.

**Licence requirements:**
- DCP: KES 3M minimum capital; fit and proper directors; credit risk policy
- Tier 3 Bank: KES 1B minimum capital; detailed supervision framework

### Q2 2028

🔵 **Savings with Interest**
- SFOS Savings Account: interest-bearing wallet balance
- Rates benchmarked to Kenya Government T-Bill rate
- Interest calculated daily, paid monthly
- Tax: 15% WHT on interest (withheld at source, remitted to KRA)
- CDSC protection up to KES 100k (if KDIC arrangement made)

**Regulatory consideration:** Accepting deposits and paying interest requires either a Banking Licence or a specific exemption. Partner option: white-label savings product with a licensed bank (e.g. NCBA, Equity). SOKONI is the front-end; the bank holds the deposits.

### Q3 2028

🔵 **Credit Product (BNPL and Personal Loans)**
- BNPL: split purchases into 3-6 equal instalments, 0% interest (merchant subsidy)
- Personal loan: up to KES 50,000 for Platinum-tier users, 30-day term
- Credit score calculated from SFOS transaction history (proprietary model)
- CRB reporting for loans above KES 1,000 (required by law)

**Regulatory consideration:** All credit must comply with Kenya's Consumer Protection Act and the Banking Act's credit disclosure requirements. Penalties and collection procedures must be documented and disclosed at point of application. CRB reporting required within 90 days of default.

### Q4 2028

🔵 **Insurance Product (Micro-Insurance)**
- Partner with a licensed insurer (e.g. Jubilee, Britam, CIC)
- Products: phone insurance, personal accident cover, hospital cash
- Distribution licence: SOKONI applies for an Insurance Agent licence (IRA)
- Premiums deducted from wallet balance monthly
- Claims reported in-app, settled to wallet within 72 hours

**Regulatory consideration:** SOKONI must hold an Insurance Agent licence issued by the Insurance Regulatory Authority (IRA). The agent licence does not require capital but does require E&O (errors and omissions) insurance and staff training certification.

🔵 **Investment Product (Money Market Fund)**
- Partner with a licensed fund manager (e.g. Sanlam, Old Mutual, GenAfrica)
- SOKONI is the distribution front-end; fund manager holds AUM
- Minimum investment: KES 100
- Returns paid into SFOS wallet monthly
- CMA distribution licence required

**Regulatory consideration:** SOKONI cannot manage funds directly without a CMA Fund Manager licence. The safest path is an appointed representative / tied agent arrangement with a licensed manager. Target fund: a compliant MMF with daily liquidity.

---

## 2029+ — Advanced Platform

### 2029

🔵 **ISO 20022 Integration**
- Connect to Kenya's KEPSS (Kenyan Electronic Payment and Settlement System) via RTGS
- Enables real-time large-value settlement between banks and SOKONI
- Required for business-to-business payments above M-Pesa limits

🔵 **Open Banking API (PSD2-style)**
- Third-party apps can read SOKONI account data with user consent
- Enables fintech ecosystem to build on SFOS
- Scope: balance inquiry, transaction history, payment initiation

### 2030

🔵 **SOKONI Digital Bank**
- Full CBK Tier 3 banking licence
- SOKONI is itself a deposit-taking institution
- Offers current accounts, savings accounts, loans, cards
- Regulated by CBK; deposits protected by KDIC
- Integration with Kenya's SWIFT participant network for international wires

---

## Regulatory Milestones Timeline

| Quarter | Milestone | Regulator |
|---------|-----------|-----------|
| Q2 2027 | AML Compliance Officer appointed | Internal |
| Q3 2027 | CBK Regulatory Sandbox application | CBK |
| Q3 2027 | PSP Licence application submitted | CBK |
| Q4 2027 | IRA Insurance Agent licence | IRA |
| Q2 2028 | DCP Licence (credit) | CBK |
| Q2 2028 | PSP Licence granted | CBK |
| Q3 2028 | CMA distribution arrangement | CMA |
| Q2 2029 | Full banking licence application | CBK |
| 2030 | Banking licence granted | CBK |

---

## Technical Debt Register

| Item | Priority | Target Quarter |
|------|----------|---------------|
| Migrate from Firestore aggregations to BigQuery for analytics at 100k+ users | High | Q4 2026 |
| Add Redis layer for risk engine velocity tracking | Medium | Q1 2027 |
| Move AI forecast from Claude Haiku to fine-tuned model | Low | Q2 2027 |
| Implement proper CQRS pattern for ledger reads | High | Q1 2027 |
| Add gRPC/WebSocket for real-time balance updates | Medium | Q2 2027 |
| Dedicated reconciliation microservice (replace scheduled CF) | Low | Q3 2027 |

---

## Success Metrics

| Metric | Q3 2026 Target | Q4 2026 Target | 2027 Target |
|--------|---------------|---------------|------------|
| SFOS-enabled users | 5,000 | 20,000 | 100,000 |
| Daily active SFOS users | 500 | 2,000 | 10,000 |
| P2P transaction volume/month | KES 5M | KES 25M | KES 200M |
| Merchant settlement volume/month | KES 2M | KES 10M | KES 100M |
| Savings vault deposits | KES 500k | KES 3M | KES 30M |
| Group wallets | 50 | 200 | 2,000 |
| Ledger reconciliation drift | 0.00 | 0.00 | 0.00 |
| CF error rate (P2P) | < 0.5% | < 0.2% | < 0.1% |
| P95 send latency | < 800ms | < 500ms | < 300ms |

---

*This roadmap is reviewed quarterly. Strategic priorities may shift based on regulatory developments, user feedback, and business conditions. The immutability of the ledger and the security of user funds are never traded against speed of delivery.*

*Related: [[SFOS_ARCHITECTURE]] | [[SFOS_MIGRATION]] | [[PLATFORM_CONSTITUTION]] | [[Commission_System]]*
