# SOKONI Administrator Guide

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Classification:** Internal — Confidential  
**Version:** 1.0 — 2026-07-13

---

## Administrator Roles

### Super Administrator — Alex Ogutu Ochieng

| Access Point | Role | Notes |
|---|---|---|
| Google Workspace | Super Admin | Full tenant control |
| Firebase Console | Owner | Project ownership |
| Google Cloud | Owner + Billing Admin | Full resource + cost control |
| IntaSend | Account Owner | Settlement, API keys |
| Africa's Talking | Account Owner | SMS, Sender ID |
| SendGrid | Account Owner | Email delivery |
| GCP Secret Manager | Full Access | All production secrets |
| DNS / Domain | Administrator | mysokoni.co.ke |
| GitHub | Owner | Source repository |

**Primary email:** admin@mysokoni.co.ke  
**Recovery email:** ogutualex824@gmail.com

### Platform Administrator — Ochi Isaac

| Access Point | Role | Restrictions |
|---|---|---|
| Google Workspace | Admin (non-super) | No billing, no ownership transfer |
| Firebase Console | Editor | Cannot transfer ownership |
| User Management | Full | Create / suspend / delete users |
| Support | Full | All tickets and communications |
| Monitoring dashboards | Read-only | Cannot modify alert configs |
| Secret Manager | **None** | No access to production secrets |
| Billing | **None** | No financial account access |
| IntaSend | **None** | No payment account access |

**Platform email:** isaac@mysokoni.co.ke

---

## Daily Operations

### Reviewing Platform Health

**Daily Ops Report** — delivered automatically at 06:00 EAT to `devops@mysokoni.co.ke`.
Contains: active users (24h), orders, payments, errors, CF invocations.

**Manual dashboard access:**
- Firebase Console → Firestore → Usage tab
- Firebase Console → Functions → Dashboard (invocations, errors, latency)
- GCP Console → Cloud Monitoring → Dashboards → SOKONI
- `https://mysokoni.co.ke/reliability-center.html` (admin-only)
- `https://mysokoni.co.ke/admin-os.html` (Admin Operating System)
- `https://mysokoni.co.ke/ops-center.html` (Operations Center)

### Reviewing Alerts

Cloud Monitoring alerts go to:
- `ogutualex824@gmail.com`
- `admin@mysokoni.co.ke` (add manually in GCP console — see Go-Live Checklist GCP-4)
- `security@mysokoni.co.ke` (add manually — GCP-3)

### Weekly Security Digest

Delivered Monday 07:00 EAT to `devops@mysokoni.co.ke` + `security@mysokoni.co.ke`.
Review and action any flagged items before the next business week.

---

## User Management

### Suspending a User

Via Firebase Console:
`Authentication → Users → Find user → Edit → Disable account`

Via Admin OS:
`admin-os.html → User Management → Search → Suspend`

This sets `suspended: true` in Firestore `users/{uid}` — protected by `noAdminFields()`, only writable via Admin SDK.

### Banning a User

Similar to suspension; sets `banned: true`. Banned users cannot create a new account with the same phone number (rate-limited in Cloud Functions).

### Verifying a Seller

Set `verified: true` and `adminApproved: true` via Admin OS. These are admin-only Firestore fields protected by `noAdminFields()`.

---

## Email Administration

### Mailbox Directory

| Mailbox | Managed By | Purpose |
|---|---|---|
| admin@mysokoni.co.ke | Alex | Super Admin operations |
| info@mysokoni.co.ke | Shared | General enquiries + Gmail forward target |
| support@mysokoni.co.ke | Isaac | Customer support |
| security@mysokoni.co.ke | Alex | Security incidents, weekly digest |
| payments@mysokoni.co.ke | Shared | Payment disputes, IntaSend alerts |
| finance@mysokoni.co.ke | Shared | Finance team |
| devops@mysokoni.co.ke | Alex | Daily ops reports, CF error alerts |
| developers@mysokoni.co.ke | Alex | Webhook callbacks, API notifications |
| legal@mysokoni.co.ke | Alex | Legal correspondence |
| compliance@mysokoni.co.ke | Shared | Regulatory queries |
| privacy@mysokoni.co.ke | Shared | Privacy / GDPR requests |
| billing@mysokoni.co.ke | Shared | Billing, invoices |
| notifications@mysokoni.co.ke | System | Automated notifications (no inbox needed) |
| noreply@mysokoni.co.ke | System | System mail, no inbox |
| isaac@mysokoni.co.ke | Isaac | Platform Administrator personal |

### Creating New Workspace Users
`admin.google.com → Directory → Users → Add new user`

---

## Payment Operations

### Reviewing Settlements

`admin-os.html → Financial → Settlements`  
Or: Firebase Console → Firestore → `settlementLogs` collection

Settlement runs automatically every 6 hours via `scheduledAutoSettlement` Cloud Function.

### Processing a Manual Refund

1. Admin OS → Orders → Find order → Refund
2. Confirm order status is eligible (not already refunded, not disputed)
3. Refund processes via `autoRefundTrigger` CF → IntaSend refund API

### Reviewing Payment Anomalies

`admin-os.html → Security → Payment Anomalies`  
Anomalies are detected by `detectPaymentAnomalies` (4 patterns: velocity, amount outlier, device switch, time-of-day).

---

## SmartPOS Operations

### Merchant Onboarding

`https://mysokoni.co.ke/pos-setup.html`  
Auto-assigns `SOK-XXXXXX` Merchant ID.  
Setup Guide gates Production Ready status — merchant must complete all steps.

### Till Management

`https://mysokoni.co.ke/pos-till-manager.html`  
Multi-till support for multi-staff operations.

### End-of-Day Reports

`https://mysokoni.co.ke/pos-daily.html` — Morning, Trading, Closing views  
EOD reports auto-email to merchant registered email.

---

## Secret Management

### Rotating a Secret

```bash
# Set new value (prompts securely)
firebase functions:secrets:set SECRET_NAME

# Verify new version is active
firebase functions:secrets:list

# Redeploy affected functions to pick up new secret
firebase deploy --only functions:<FUNCTION_NAME>
```

**After rotating IntaSend keys:**
1. Update in IntaSend dashboard first
2. Rotate in Secret Manager
3. Redeploy payment functions
4. Test a payment end-to-end

### Emergency Secret Rotation

If a secret is compromised:
1. Immediately rotate in the provider's dashboard (IntaSend, SendGrid, AT)
2. Update in Secret Manager: `firebase functions:secrets:set SECRET_NAME`
3. Deploy: `firebase deploy --only functions` (full functions deploy)
4. Notify `security@mysokoni.co.ke`
5. Review Cloud Logging for any unauthorized usage

---

## Monitoring Dashboards

| Dashboard | URL | Access |
|---|---|---|
| Admin OS | /admin-os.html | Super Admin + Platform Admin |
| Operations Center | /ops-center.html | Super Admin |
| Reliability Center | /reliability-center.html | Super Admin |
| Redis Monitor | /redis-monitor.html | Super Admin |
| Trust & Safety | /trust-safety.html | Super Admin |
| Security Zero Trust | /security-zero-trust-dashboard.html | Super Admin |
| SmartPOS Observability | /pos-observability.html | POS Merchants |
| Intelligence Dashboard | /automation-center.html | Super Admin |

---

## Escalation Matrix

| Incident Type | First Responder | Escalation | SLA |
|---|---|---|---|
| Payment failure | Isaac (Platform Admin) | Alex (Super Admin) | 30 min |
| Security breach | Alex | External security firm | Immediate |
| Platform outage | Alex | GCP support | 15 min |
| Data privacy request | Isaac | Alex + legal@ | 24 hours |
| Merchant dispute | Isaac | Alex | 4 hours |
| CF quota limit | Alex | GCP quota request | 1 hour |

---

*Document: SOKONI Administrator Guide v1.0 — 2026-07-13*
