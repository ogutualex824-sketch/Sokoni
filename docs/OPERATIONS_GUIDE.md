# SOKONI Operations Guide — v1.0.0

**Audience:** Platform operators, on-call engineers, and administrators.  
**Last Updated:** 2026-07-12  
**Emergency:** ogutualex824@gmail.com

---

## Daily Operations

### Morning Checklist (06:30 EAT daily)
- [ ] Review `scheduledDailyOpsReport` email (auto-sent at 06:00 EAT)
- [ ] Check Google Cloud Monitoring for overnight alerts
- [ ] Review `healthSnapshots` collection in Firestore for any red statuses
- [ ] Check AsyncJobs queue depth — Firestore → `asyncJobs` → filter `status == 'pending'`
- [ ] Verify payment settlement ran — Firestore → `settlements` → filter `date == today`
- [ ] Check failed delivery count — Admin OS → Logistics panel

### Accessing the Admin OS
URL: https://mysokoni.co.ke/admin-os.html  
Required role: `admin` or `superAdmin`

Admin OS panels:
1. Platform Overview (KPI cards)
2. Users & Roles
3. Sellers & Merchants
4. Orders & Fulfillment
5. Payments & Settlements
6. Disputes & Moderation
7. Delivery & Drivers
8. SmartPOS Operations
9. Communications (broadcast email, push)
10. Analytics & Reports
11. Security Center (Zero Trust)
12. FinOS (General Ledger)
13. Platform Configuration
14. Subscription & Billing
15. Loyalty & Rewards
16. AI & KASS Config
17. Developer Tools
18. Monitoring
19. Legal & Compliance

---

## Monitoring

### Google Cloud Monitoring
URL: https://console.cloud.google.com/monitoring?project=sokoni-aeb26

Key dashboards:
- **Cloud Functions** — invocation rates, error rates, latencies
- **Firestore** — read/write counts, latencies
- **App Engine / Hosting** — request rates

Alert channels:
- Email: ogutualex824@gmail.com
- Setup: `bash scripts/setup-monitoring-alerts.sh ogutualex824@gmail.com`

### Redis Health
```bash
# Check Redis connectivity (from VPC)
redis-cli -h 10.127.36.43 -p 6379 PING
# Expected: PONG

# Monitor live traffic
redis-cli -h 10.127.36.43 monitor
```

### Firebase Performance
URL: Firebase Console → Performance → Web

### Error Tracking
- Firebase Console → Crashlytics (if enabled)
- Google Cloud Logging → search for `severity=ERROR AND resource.type=cloud_function`

---

## User Management

### Grant Admin Access
```javascript
// In Firebase Console → Firestore → users/{uid}
// Add to the `roles` array:
roles: ["admin"]

// Or via Admin OS → Users & Roles → Find user → Edit Roles
```

### Suspend a User
1. Admin OS → Users & Roles → Find user → Suspend
2. Or: Firebase Console → Authentication → Find user → Disable

### Reset a Seller's Account
1. Admin OS → Sellers → Find seller → View Details
2. Flag review can be cleared from the moderation panel

---

## Payment Operations

### Manual Settlement Trigger
1. Admin OS → FinOS → Settlements
2. Click "Trigger Manual Settlement"
3. Or call: `firebase functions:call triggerManualSettlement`

### Refund Processing
1. Admin OS → Orders → Find order → Issue Refund
2. Refunds go back to the customer's wallet
3. Wallet-to-M-Pesa withdrawals processed via B2C within 24h

### STK Push Test
```bash
# Test M-Pesa STK push (KES 1 to your number)
firebase functions:call testSTKPush --data '{"amount": 1, "phone": "254712345678"}'
```

### Checking Wallet Balances
Firestore → `wallets` → `{userId}` → `balance` field

---

## Email Operations

### Test Email Delivery
```bash
# Trigger test email (requires Firebase auth token)
firebase functions:call testEmailDelivery --data '{"to":"ogutualex824@gmail.com"}'
```

### Reprocess Failed Emails
```bash
# Trigger email queue processor
firebase functions:call processEmailQueue --data '{}'
```

### Send Broadcast Email
1. Admin OS → Communications → Broadcast Email
2. Select: All users / Sellers only / Buyers only
3. Write subject + body + CTA
4. Preview → Confirm → Send

---

## SmartPOS Operations

### Onboarding a New Merchant
1. Direct merchant to: https://mysokoni.co.ke/onboarding.html
2. Merchant completes profile → selects SmartPOS plan
3. Merchant ID auto-generated (format: SOK-XXXXXX)
4. Merchant redirected to pos.html after onboarding

### Opening a POS Shift
1. Merchant logs in at https://mysokoni.co.ke/pos.html
2. Click "Open Shift" → enter opening float
3. Shift ID generated and stored in Firestore `posShifts`

### End-of-Day Closing
1. POS → pos-daily.html → Closing section
2. Count physical cash → enter in "Closing Float" field
3. System calculates cash variance
4. Confirm close → EOD report auto-emailed

### Till Management
URL: https://mysokoni.co.ke/pos-till-manager.html

### Cash Manager
URL: https://mysokoni.co.ke/pos-cash-manager.html (POS Admin only)

---

## Delivery & Logistics

### Assigning a Driver
1. Admin OS → Delivery panel → Unassigned deliveries
2. Select delivery → Assign Driver → Select from available pool

### Tracking a Delivery
URL: https://mysokoni.co.ke/delivery-tracking.html?id={deliveryId}

### Driver Suspension
Admin OS → Drivers → Find driver → Suspend  
Auto-suspension triggers after ≥10 cancellations (configurable)

---

## Platform Configuration

### Feature Flags
Firestore → `platform/config` → `featureFlags` map

Key flags:
- `platformMaintenance` — set `true` to show maintenance page
- `paymentsEnabled` — set `false` to disable all payment flows
- `newUserRegistration` — set `false` to freeze new signups
- `sellerOnboarding` — set `false` to pause new seller applications

### Commission Rates
Firestore → `platform/commissionConfig`

Default rates:
| Category | Rate |
|---|---|
| Marketplace products | 8% |
| Food orders | 10% |
| Event tickets | 5% |
| Property leads | 3% |
| Services | 12% |

### Loyalty Tier Thresholds
Firestore → `loyaltyConfig/tiers`

---

## Security Operations

### Review Security Alerts
URL: https://mysokoni.co.ke/security-center.html

### Zero Trust Dashboard
URL: https://mysokoni.co.ke/security-zero-trust-dashboard.html

### Viewing Security Events
Firestore → `securityEvents` → filter by `type`, `severity`, `timestamp`

### IP Blocking
1. Cloudflare Dashboard → Security → WAF → IP Block rules
2. Or: Admin OS → Security → Blocked IPs → Add

### Revoking Compromised Sessions
```bash
# Revoke all sessions for a user
firebase auth:revoke-tokens --uid <userId>
```

---

## AsyncJobs Queue

### Monitoring Queue Depth
```bash
# Check pending jobs
gcloud firestore documents list sokoni-aeb26 --collection asyncJobs --filter 'status=pending'
```

### Reprocessing Stuck Jobs
```bash
# Trigger the sweeper manually
firebase functions:call asyncSweeper
```

### Job Types
- `email` — email delivery jobs
- `sms` — SMS notifications
- `settlement` — payout calculations
- `report` — scheduled report generation
- `export` — data export jobs

---

## Subscription Management

### Viewing Active Subscriptions
Firestore → `subscriptions` → filter `status == 'active'`

### Manual Subscription Cancellation
```bash
firebase functions:call cancelSubscription --data '{"subscriptionId":"sub_xxx"}'
```

### Grace Period Configuration
Firestore → `platform/subscriptionConfig` → `gracePeriodDays` (default: 3)

---

## Escalation Path

| Severity | Response Time | Escalation |
|---|---|---|
| P0 — Platform down | 15 minutes | ogutualex824@gmail.com immediately |
| P1 — Payment failure | 30 minutes | ogutualex824@gmail.com |
| P2 — Feature degraded | 2 hours | Normal support queue |
| P3 — Non-critical bug | Next business day | GitHub issue |

---

## Useful Commands

```bash
# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only hosting
firebase deploy --only hosting

# Deploy only Firestore rules
firebase deploy --only firestore:rules

# Deploy only Firestore indexes (default DB)
firebase deploy --only firestore:indexes

# Deploy indexes for sokoni-ops
firebase deploy --only firestore:indexes --project sokoni-aeb26

# View CF logs
gcloud logging read "resource.type=cloud_function" --project=sokoni-aeb26 --limit=50

# List all CFs
firebase functions:list

# Call a callable CF (requires auth)
firebase functions:call <functionName> --data '<json>'

# Check secret
gcloud secrets versions access latest --secret=SENDGRID_API_KEY --project=sokoni-aeb26

# Run setup scripts
bash scripts/setup-secrets.sh
bash scripts/setup-sendgrid.sh
bash scripts/setup-monitoring-alerts.sh ogutualex824@gmail.com
bash scripts/batch_deploy.sh
```
