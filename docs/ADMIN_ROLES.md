# SOKONI Platform — Administrative Roles & Access Policy

**Platform:** SOKONI  
**Legal Owner:** Bravilex International Co. Limited  
**Effective:** 2026-07-13  
**Classification:** Internal — Confidential

---

## Role Hierarchy

```
Bravilex International Co. Limited (Legal Entity)
└── SOKONI (Consumer Brand / Platform)
    ├── Super Administrator — Alex Ogutu Ochieng
    └── Platform Administrator — Ochi Isaac
```

---

## 1. Super Administrator

| Field | Value |
|---|---|
| **Full Name** | Alex Ogutu Ochieng |
| **Primary Email** | admin@mysokoni.co.ke |
| **Personal Email** | ogutualex824@gmail.com |
| **Role** | Super Administrator / Founder / CTO |

### Permissions

| System | Access Level |
|---|---|
| Firebase Project | Owner |
| Google Cloud | Owner / Billing Administrator |
| Google Workspace | Super Admin |
| DNS / Domain | Administrator |
| IntaSend | Account Owner |
| Africa's Talking | Account Owner |
| SendGrid | Account Owner |
| Secret Manager | Full Access |
| Cloud Monitoring | Full Access — primary alert recipient |
| GitHub Repository | Owner |
| Security Center | Full Access |

### Restrictions
None — full platform ownership.

---

## 2. Platform Administrator

| Field | Value |
|---|---|
| **Full Name** | Ochi Isaac |
| **Platform Email** | isaac@mysokoni.co.ke |
| **Role** | Platform Administrator |

### Permissions

| System | Access Level |
|---|---|
| Google Workspace | Admin (non-super) |
| Firebase Project | Editor (no Owner transfer) |
| User Management | Full — create / suspend / delete users |
| Support Administration | Full — access all support tickets |
| Email Administration | Full — manage mailboxes within Workspace |
| Monitoring | Read — view dashboards and alerts |
| Reports | Read — view ops and security reports |
| Billing | **None** — no billing access |
| Ownership Transfer | **Prohibited** — cannot transfer ownership |
| Secret Manager | **None** — no access to production secrets |
| DNS | **None** — no DNS changes |
| IntaSend | **None** — no payment account access |

### Notes
- Account `isaac@mysokoni.co.ke` must be created in Google Workspace before granting Firebase Editor role.
- Firebase role granted via: `firebase projects:roles set isaac@mysokoni.co.ke --role roles/editor`
- Google Workspace admin delegated by Super Admin in admin.google.com → Account → Admin roles.

---

## 3. Email Account Architecture

### Executive
| Mailbox | Purpose |
|---|---|
| admin@mysokoni.co.ke | Platform administration, Super Admin primary |
| info@mysokoni.co.ke | General enquiries, public-facing contact |
| legal@mysokoni.co.ke | Legal correspondence, contracts |
| privacy@mysokoni.co.ke | Privacy requests, GDPR/DPA compliance |
| compliance@mysokoni.co.ke | Regulatory compliance queries |

### Operations
| Mailbox | Purpose |
|---|---|
| support@mysokoni.co.ke | Customer support |
| finance@mysokoni.co.ke | Finance team |
| billing@mysokoni.co.ke | Billing, invoices |
| payments@mysokoni.co.ke | Payment operations, disputes |
| notifications@mysokoni.co.ke | Automated platform notifications |

### Technology
| Mailbox | Purpose |
|---|---|
| security@mysokoni.co.ke | Security incidents, weekly security digest |
| developers@mysokoni.co.ke | Webhook callbacks, API notifications |
| devops@mysokoni.co.ke | Daily ops reports, infrastructure alerts |
| noreply@mysokoni.co.ke | Automated system mail (no reply expected) |

### Platform Administrator
| Mailbox | Purpose |
|---|---|
| isaac@mysokoni.co.ke | Isaac's personal Workspace mailbox |

---

## 4. Gmail Backup Account

| Field | Value |
|---|---|
| Account | bravilexinternational@gmail.com |
| Role | Backup company email, historical correspondence |
| Forwarding | All incoming mail → info@mysokoni.co.ke |
| Retention | **Permanent — do NOT remove or delete** |
| Recovery Email | Set as recovery address for Workspace |

---

## 5. Automated Reports — Distribution

| Report | Schedule | Recipients |
|---|---|---|
| Daily Ops Report | 06:00 EAT daily | devops@mysokoni.co.ke |
| Weekly Security Digest | Monday 07:00 EAT | devops@mysokoni.co.ke + security@mysokoni.co.ke |

---

## 6. Emergency Contacts

| Contact | Role | Email |
|---|---|---|
| Alex Ogutu Ochieng | Founder / CTO | admin@mysokoni.co.ke |
| Alex (personal) | Primary on-call | ogutualex824@gmail.com |

---

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-07-13 | Initial ratification — admin roles defined, Isaac onboarded | Alex Ogutu |
