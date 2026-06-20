# DNS-RECORDS.md

# SOKONI DNS Records — Complete Reference

**Domain:** mysokoni.co.ke  
**DNS Provider:** HostPinnacle  
**Last Audited:** 2026-06-20  
**Firebase Project:** sokoni-aeb26

Related: [[docs/DMARC]] [[docs/SECURITY]]

---

## Summary

| Category | Status | Notes |
|---|---|---|
| Firebase Hosting | ✅ Live | Do not modify |
| SPF | ⚠️ Needs update | Remove +a +mx, add SendGrid, change ~all → -all |
| DKIM (HostPinnacle) | ✅ Present | selector: `default` |
| DKIM (SendGrid) | ❌ Missing | Must add after SendGrid domain authentication |
| DMARC | ❌ p=none only | Must update to p=quarantine |
| MX | ⚠️ Verify | Confirm points to HostPinnacle, not Firebase CDN |

---

## Firebase Hosting Records — DO NOT MODIFY

These records power the live website. Never delete or edit them.

| Type | Host | Value | Purpose |
|---|---|---|---|
| A | `@` | `199.36.158.100` | Firebase Hosting CDN (primary) |
| TXT | `@` | `hosting-site=sokoni-aeb26` | Firebase Hosting verification |

> Firebase may use additional A records or a www CNAME. Confirm in Firebase Console → Hosting → Custom Domains.

---

## Email Authentication Records — Current State

### SPF (Current — Needs Update)

| Type | Host | Current Value |
|---|---|---|
| TXT | `@` | `v=spf1 +a +mx +ip4:46.165.235.143 include:relay.mailbaby.net ~all` |

**Issues:** Authorises Firebase CDN via `+a`, softfail `~all`, missing SendGrid.

### DKIM (Current — Keep)

| Type | Host | Value |
|---|---|---|
| TXT | `default._domainkey` | `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApBwmplCj0gql4btWtoku6RD5h+5evuOraDfRl6jqcf7F1fSCSDAoQp8x58o/JRkJGWYHrXpvRv7dvU+X9QoBcPo6VG335lsTFwgbiNgNXSMvPXU1e1hqtPm10roDHFvPa6qMmPDa3NI7dZT2ePzBgpV3e86iNRkz3MOZRfZD1G5PwUEkP9Wuq1O/6WgJ+DO+NLc7ewYauavifrfm84p6uOIQXDwD/EQ4za5OfUiA/e1/NFaeZ5lhsFtZr93vYJkYZa420MfeyNzz6x9bfIDzQO/FhTBxHheYy2tA6obPG9JWiwz2Qc9/mudaun+u6rDbHyvvf3Plqvlm4vZvuT17KwIDAQAB` |

### DMARC (Current — Needs Update)

| Type | Host | Current Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

---

## Email Authentication Records — Target State

### SPF Record (MODIFY)

| Type | Host | Value | TTL |
|---|---|---|---|
| TXT | `@` | `v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all` | 3600 |

### DMARC Record (MODIFY)

| Type | Host | Value | TTL |
|---|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:security@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100` | 3600 |

### SendGrid DKIM Records (ADD — values from SendGrid dashboard)

| Type | Host | Value | TTL |
|---|---|---|---|
| CNAME | `s1._domainkey` | *(from SendGrid → Domain Authentication)* | 3600 |
| CNAME | `s2._domainkey` | *(from SendGrid → Domain Authentication)* | 3600 |
| CNAME | `em` | *(from SendGrid → Domain Authentication)* | 3600 |

---

## SendGrid Authorised IPs (via include:sendgrid.net)

SendGrid publishes their IP ranges via SPF includes. The `include:sendgrid.net` mechanism resolves to all current SendGrid sending IPs automatically.

---

## MailBaby Authorised IPs (via include:relay.mailbaby.net)

Resolved ranges (2026-06-20):

```
199.231.189.152/29
64.20.38.24/29
174.138.190.32/29
64.20.36.192/29
199.231.189.96/29
206.72.200.40/29
66.45.229.224/28
174.138.180.168/29
174.138.180.160/29
174.138.180.152/29
67.217.53.0/24
(+ spf2.flat.mailbaby.net range)
```

---

## DKIM Key Details

| Field | Value |
|---|---|
| Selector | `default` |
| Algorithm | RSA |
| Key size | 2048-bit (inferred from key length) |
| Provider | HostPinnacle |
| Full record host | `default._domainkey.mysokoni.co.ke` |

---

## MX Records — Verify

> The audit showed `mysokoni.co.ke` as the MX host with preference 0. This may mean email is directed back to the domain itself (which resolves to Firebase CDN `199.36.158.100`), which cannot receive email.

**Recommended MX configuration for HostPinnacle/MailBaby:**

| Type | Host | Value | Priority |
|---|---|---|---|
| MX | `@` | *(HostPinnacle mail server hostname)* | 10 |

**Action:** Log in to HostPinnacle DNS panel and verify the MX record points to a real mail server hostname (e.g., `mail.mysokoni.co.ke` or HostPinnacle's mailserver), not to the domain's own A record (Firebase CDN).

---

## DMARC Reporting — Inbound Address Configuration

The DMARC record sends aggregate reports to `dmarc@mysokoni.co.ke` and forensic reports to `security@mysokoni.co.ke`. Both must be deliverable mailboxes.

| Mailbox | Purpose | Receiving Server |
|---|---|---|
| `dmarc@mysokoni.co.ke` | Aggregate XML reports (daily from Google, Microsoft, Yahoo) | HostPinnacle IMAP |
| `security@mysokoni.co.ke` | Forensic reports (per-failure samples) | HostPinnacle IMAP |

Both addresses are part of the 40 `@mysokoni.co.ke` accounts provisioned in the email system. Verify they exist as mailboxes in HostPinnacle control panel.

---

## Future Email Security Records

### BIMI (Brand Indicators for Message Identification)

Add after upgrading DMARC to `p=reject`:

```
Type:  TXT
Host:  default._bimi
Value: v=BIMI1; l=https://mysokoni.co.ke/brand/logo-bimi.svg; a=
```

Requires:
- DMARC policy: `p=reject`  
- SVG logo meeting BIMI specifications (square, under 32KB, Tiny PS subset)
- Optional VMC (Verified Mark Certificate) from DigiCert/Entrust for checkmark in Gmail

### MTA-STS (Enforce TLS for Inbound Email)

```
Type:  TXT
Host:  _mta-sts
Value: v=STSv1; id=20260620
```

Plus serve a policy file at: `https://mta-sts.mysokoni.co.ke/.well-known/mta-sts.txt`

### TLS-RPT (TLS Reporting)

```
Type:  TXT
Host:  _smtp._tls
Value: v=TLSRPTv1; rua=mailto:security@mysokoni.co.ke
```

---

## Quick Implementation Checklist

```
[ ] 1. Complete SendGrid domain authentication for mysokoni.co.ke
[ ]    → Get s1._domainkey, s2._domainkey, em CNAME values from SendGrid dashboard
[ ] 2. Log in to HostPinnacle DNS panel
[ ] 3. MODIFY SPF TXT record at @ (root):
[ ]    Old: v=spf1 +a +mx +ip4:46.165.235.143 include:relay.mailbaby.net ~all
[ ]    New: v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all
[ ] 4. ADD CNAME s1._domainkey → (from SendGrid)
[ ] 5. ADD CNAME s2._domainkey → (from SendGrid)
[ ] 6. ADD CNAME em → (from SendGrid)
[ ] 7. Verify SendGrid domain authentication shows "Verified"
[ ] 8. Wait 24 hours — run: node monitoring/dmarc-verify.js
[ ] 9. Send test email via mail-tester.com — confirm 10/10 score
[ ] 10. MODIFY DMARC TXT record at _dmarc:
[ ]     Old: v=DMARC1; p=none;
[ ]     New: v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:security@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100
[ ] 11. Run: node monitoring/dmarc-verify.js
[ ] 12. Monitor dmarc@mysokoni.co.ke inbox for aggregate reports (arrive within 24h)
[ ] 13. Upload reports to Email Center → DMARC Reports tab
[ ] 14. After 30 days clean → upgrade to p=reject
```
