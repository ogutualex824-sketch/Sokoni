# DMARC.md

# SOKONI Email Authentication — DMARC Implementation Guide

**Domain:** mysokoni.co.ke  
**Date:** 2026-06-20  
**Status:** Implementation Ready — DNS Action Required  
**Audited by:** SOKONI Engineering

Related: [[docs/DNS-RECORDS]] [[docs/SECURITY]] [[CHANGELOG]]

---

## Executive Summary

| Check | Current State | Target State |
|---|---|---|
| SPF | ⚠️ Weak (`~all`, includes Firebase CDN) | ✅ Hardened (`-all`, SendGrid added) |
| DKIM | ⚠️ HostPinnacle only (selector: `default`) | ✅ + SendGrid (selectors: `s1`, `s2`) |
| DMARC | ❌ `p=none` (monitor only, no enforcement) | ✅ `p=quarantine`, strict alignment |
| Alignment (SPF) | N/A | `aspf=s` — strict |
| Alignment (DKIM) | N/A | `adkim=s` — strict |
| Report aggregates | ❌ Not configured | ✅ `dmarc@mysokoni.co.ke` |
| Report forensics | ❌ Not configured | ✅ `security@mysokoni.co.ke` |

---

## DNS Audit Findings (2026-06-20)

### Current SPF Record

```
v=spf1 +a +mx +ip4:46.165.235.143 include:relay.mailbaby.net ~all
```

**Problems:**
- `+a` authorises Firebase Hosting CDN (`199.36.158.100`) to send email — incorrect
- `+mx` authorises whatever the MX record points to — potentially Firebase CDN  
- `~all` is softfail — tells receivers to accept but mark, not reject
- `include:sendgrid.net` **missing** — all SendGrid-sent emails fail SPF
- Should use `-all` (hardfail) to maximise DMARC enforcement

### Current DKIM Record

```
Selector: default
Record:   default._domainkey.mysokoni.co.ke
Value:    v=DKIM1; k=rsa; p=MIIBIjAN...
```

**Status:** Present — HostPinnacle/MailBaby signing key exists.  
**Problem:** SendGrid has NO DKIM selectors (`s1`, `s2` — not found). All SendGrid emails are sent **without DKIM signatures** for `mysokoni.co.ke`. This is a critical gap.

### Current DMARC Record

```
v=DMARC1; p=none;
```

**Status:** Monitoring only — no enforcement. No reporting configured.

### Firebase Hosting A Record

```
mysokoni.co.ke → 199.36.158.100 (Firebase CDN — do not use for mail)
```

**No Firebase records will be modified** — DMARC implementation only adds email auth records.

---

## Alignment Analysis

DMARC requires the sending domain in the `From:` header to **align** with either:
- The domain that passes SPF (the SMTP `MAIL FROM` / Return-Path domain), **OR**
- The domain in the DKIM `d=` tag

**Only ONE of these needs to pass for DMARC to succeed.**

With `adkim=s; aspf=s` (strict alignment):

| Email Path | SPF MAIL FROM | SPF Strict | DKIM d= | DKIM Strict | DMARC Result |
|---|---|---|---|---|---|
| HostPinnacle/MailBaby | `@mysokoni.co.ke` | ✅ PASS | `default` (`d=mysokoni.co.ke`) | ✅ PASS | ✅ PASS |
| SendGrid (after domain auth) | `@em.mysokoni.co.ke` | ❌ FAIL (subdomain) | `s1`/`s2` (`d=mysokoni.co.ke`) | ✅ PASS | ✅ PASS |
| SendGrid (before domain auth) | `@sendgrid.net` | ❌ FAIL | none | ❌ FAIL | ❌ FAIL → Quarantined |

**Conclusion:** SendGrid domain authentication is **mandatory** before enabling `p=quarantine`. Without it, all SOKONI platform emails (order confirmations, payment alerts, etc.) will be quarantined by receiving mail servers.

---

## Implementation — 4 Steps

### Step 1 — Set Up SendGrid Domain Authentication (Critical Path)

> **Do this before changing the DMARC policy from `p=none` to `p=quarantine`.**

1. Log in to [sendgrid.com](https://sendgrid.com)
2. Navigate to **Settings → Sender Authentication → Domain Authentication**
3. Click **Authenticate Your Domain**
4. Choose DNS host: **HostPinnacle** (or choose "Other")
5. Enter domain: `mysokoni.co.ke`
6. **Do NOT tick** "Use automated security" (this avoids additional CNAME complexity)
7. Click **Next** — SendGrid generates 3 DNS records
8. Copy the three records (they will look like):

```
Type    Host                              Value
CNAME   s1._domainkey.mysokoni.co.ke     s1.domainkey.uXXXXXX.wlXXX.sendgrid.net
CNAME   s2._domainkey.mysokoni.co.ke     s2.domainkey.uXXXXXX.wlXXX.sendgrid.net
CNAME   em.mysokoni.co.ke                uXXXXXX.wlXXX.sendgrid.net
```

9. Add these to HostPinnacle DNS (see Step 3)
10. Return to SendGrid and click **Verify** (allow 30–60 min for propagation)
11. Once verified, SendGrid will sign all outgoing emails with `d=mysokoni.co.ke`

> **Why `em.mysokoni.co.ke`?** This becomes the Return-Path (MAIL FROM) subdomain for SendGrid. With `aspf=s` strict alignment, this subdomain fails SPF alignment — **but DMARC still passes because DKIM alignment succeeds**. DMARC is an OR condition.

---

### Step 2 — Update SPF Record

**In HostPinnacle DNS panel → Manage DNS for mysokoni.co.ke → Edit TXT @ record:**

**Remove:**
```
v=spf1 +a +mx +ip4:46.165.235.143 include:relay.mailbaby.net ~all
```

**Replace with:**
```
v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all
```

**Changes explained:**
- Removed `+a` — Firebase CDN should never send email
- Removed `+mx` — MX record points to domain itself; not an authorised sender
- Added `include:sendgrid.net` — authorises all SendGrid IP ranges
- Changed `~all` to `-all` — hardfail: reject all unauthorised senders

---

### Step 3 — Update DMARC Record

**In HostPinnacle DNS panel → Manage DNS for mysokoni.co.ke → Edit TXT `_dmarc` record:**

**Remove (or replace) current value:**
```
v=DMARC1; p=none;
```

**Replace with:**
```
v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:security@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100
```

**DNS record to add:**

| Field | Value |
|---|---|
| Type | TXT |
| Host / Name | `_dmarc` |
| Value | `v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:security@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100` |
| TTL | 3600 |

**Tag reference:**

| Tag | Value | Meaning |
|---|---|---|
| `v` | `DMARC1` | Protocol version |
| `p` | `quarantine` | Send failing emails to spam |
| `rua` | `mailto:dmarc@mysokoni.co.ke` | Aggregate reports (daily XML from Google, Microsoft, Yahoo) |
| `ruf` | `mailto:security@mysokoni.co.ke` | Forensic/failure reports (per-email failure samples) |
| `fo` | `1` | Generate forensic report when ANY auth check fails |
| `adkim` | `s` | DKIM strict alignment (`d=` must exactly match From domain) |
| `aspf` | `s` | SPF strict alignment (MAIL FROM must exactly match From domain) |
| `pct` | `100` | Apply policy to 100% of failing emails |

> **Rollout strategy:** Start with `p=none` to collect aggregate reports for 7–14 days first. Confirm all legitimate sending sources pass DMARC before switching to `p=quarantine`. The Cloud Function DMARC report processor will parse incoming reports automatically.

---

### Step 4 — Add SendGrid DKIM CNAME Records

After completing Step 1, add the three CNAMEs from SendGrid to HostPinnacle DNS:

| Type | Host | Value |
|---|---|---|
| CNAME | `s1._domainkey` | *(from SendGrid dashboard)* |
| CNAME | `s2._domainkey` | *(from SendGrid dashboard)* |
| CNAME | `em` | *(from SendGrid dashboard)* |

---

## DNS Records After Implementation

### Records to ADD or MODIFY

| Action | Type | Host | Value |
|---|---|---|---|
| **MODIFY** | TXT | `@` (root) | `v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all` |
| **MODIFY** | TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:security@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100` |
| **ADD** | CNAME | `s1._domainkey` | *(from SendGrid)* |
| **ADD** | CNAME | `s2._domainkey` | *(from SendGrid)* |
| **ADD** | CNAME | `em` | *(from SendGrid)* |

### Records to PRESERVE (Do Not Touch)

| Type | Host | Value | Purpose |
|---|---|---|---|
| A | `@` | `199.36.158.100` | Firebase Hosting CDN |
| TXT | `@` | `hosting-site=sokoni-aeb26` | Firebase Hosting verification |
| TXT | `default._domainkey` | `v=DKIM1; k=rsa; p=MIIBIj...` | HostPinnacle DKIM |

---

## Propagation Timeline

| Record | Change | Propagation |
|---|---|---|
| SPF | ~all → -all + sendgrid.net | 30–60 minutes |
| SendGrid CNAME | New records | 30–60 minutes |
| DMARC | p=none → p=quarantine | 30–60 minutes (do last) |

> DNS changes propagate within 30 minutes on HostPinnacle. For safety, make SPF and DKIM changes first, wait 24 hours to monitor reports, then update DMARC to `p=quarantine`.

---

## Verification

Run the SOKONI DNS verification script after propagation:

```bash
node monitoring/dmarc-verify.js
```

Or use these public tools:
- [MXToolbox SPF Checker](https://mxtoolbox.com/spf.aspx)
- [MXToolbox DMARC Checker](https://mxtoolbox.com/dmarc.aspx)
- [SendGrid Email Tester](https://app.sendgrid.com/email_activity)
- [mail-tester.com](https://www.mail-tester.com) — send a test email, get a score

---

## DMARC Aggregate Reports

When `rua=mailto:dmarc@mysokoni.co.ke` is active, major email providers send daily XML reports:

- **Google Workspace** sends within 24 hours of the first email
- **Microsoft/Outlook** sends daily at 00:00 UTC
- **Yahoo** sends daily

Reports arrive as ZIP-compressed XML files attached to an email from `noreply-dmarc-support@google.com`, `mailfrom@microsoft.com`, etc.

**Automated processing:** Upload report XML to the **Email Center → DMARC Reports** tab. The SOKONI DMARC processor (`processDmarcReport` Cloud Function) will parse the XML and store results in Firestore.

---

## SPF Record Deep Dive

### Final SPF Structure

```
v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all
```

**Mechanism breakdown:**

| Mechanism | Authorised Sender | Why |
|---|---|---|
| `ip4:46.165.235.143` | HostPinnacle mail server | Direct IP for outbound SMTP |
| `include:relay.mailbaby.net` | MailBaby relay IPs | Current SMTP relay service |
| `include:sendgrid.net` | All SendGrid IP ranges | SOKONI Cloud Functions email |
| `-all` | Everything else | Hard reject |

**DNS lookup count:** 3 lookups (relay.mailbaby.net + sendgrid.net + root). Well within the 10-lookup limit.

---

## DKIM Record Deep Dive

### HostPinnacle (Existing — Preserve)

```
Selector: default
Host:     default._domainkey.mysokoni.co.ke
Value:    v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApBwm...
Key size: 2048-bit RSA (verified)
```

### SendGrid (To Be Added)

```
Selector:  s1, s2
Hosts:     s1._domainkey.mysokoni.co.ke
           s2._domainkey.mysokoni.co.ke
Type:      CNAME (pointing to SendGrid infrastructure)
d= tag:    mysokoni.co.ke (strict DKIM alignment — ✅ passes DMARC)
```

---

## Email Flows and DMARC Compliance

| Email Type | Sent From | Via | SPF Align | DKIM Align | DMARC |
|---|---|---|---|---|---|
| Order confirmations | orders@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Payment notifications | payments@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Password resets | security@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Seller onboarding | sellers@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Delivery notifications | delivery@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Marketing emails | marketing@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Security alerts | security@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| Event tickets | events@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |
| HostPinnacle (SMTP) | any@mysokoni.co.ke | MailBaby | ✅ (ip4 match) | ✅ default | ✅ PASS |
| Invoice CF | orders@mysokoni.co.ke | SendGrid | ❌ (em subdomain) | ✅ s1/s2 | ✅ PASS |

All email flows pass DMARC after SendGrid domain authentication is completed.

---

## Security Posture

### DMARC Quarantine Mode

`p=quarantine` means:
- Emails that fail DMARC alignment are delivered to the **spam/junk folder**
- Not rejected outright (that would be `p=reject`)
- Allows recovery if a legitimate sender was missed

### When to Upgrade to `p=reject`

After 30 days of `p=quarantine` with zero legitimate failures in DMARC aggregate reports:
1. Change `p=quarantine` → `p=reject`
2. Update the `_dmarc` TXT record

### Spoofing Protection

With `p=quarantine` and strict alignment:
- Phishing emails spoofing `@mysokoni.co.ke` are quarantined at major providers
- BIMI (Brand Indicators for Message Identification) is compatible once `p=reject` is reached — adds SOKONI logo to emails in Gmail, Yahoo
- DMARC reports will show if anyone is attempting to spoof your domain

---

## Recommended Improvements (Post-Launch)

| Priority | Improvement | Action |
|---|---|---|
| High | Upgrade to `p=reject` after 30 days of clean reports | Edit `_dmarc` TXT record |
| High | Implement BIMI — show SOKONI logo in Gmail/Yahoo | Add `default._bimi` TXT record + upload logo |
| Medium | MTA-STS — enforce TLS for email delivery | Add `_mta-sts` TXT + serve policy at `mta-sts.mysokoni.co.ke` |
| Medium | TLS-RPT — report TLS connection failures | Add `_smtp._tls` TXT record |
| Low | Remove MailBaby dependency | Consolidate all email through SendGrid |
| Low | Review MX records | Confirm MX points to MailBaby/HostPinnacle, not Firebase CDN |
