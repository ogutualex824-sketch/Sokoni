# SOKONI — BIMI, SPF, DKIM & DMARC Checklist

**Domain:** `mysokoni.co.ke`
**Legal Entity:** Bravilex International Co. Limited
**Email Provider:** SendGrid (primary) + SMTP fallback

> This document lists every DNS and configuration step required to:
> 1. Harden email authentication (SPF + DKIM + DMARC)
> 2. Enable a branded sender logo in supported email clients (BIMI)
>
> **Do not make DNS changes automatically.** Review each step, test in a staging environment, and roll out DMARC gradually (p=none → p=quarantine → p=reject) to avoid dropping legitimate mail.

---

## 1. SPF (Sender Policy Framework)

SPF lets receiving servers verify that mail from `mysokoni.co.ke` came from an authorised server.

### What SPF does
- Receiving server looks up the `TXT` record for `mysokoni.co.ke`
- Checks if the sending IP is listed
- Passes or fails the check

### Required DNS record

```
Type:  TXT
Name:  @  (or mysokoni.co.ke)
Value: v=spf1 include:sendgrid.net include:_spf.google.com ~all
TTL:   3600
```

> Change `~all` (softfail) to `-all` (hardfail) only **after** you have confirmed all legitimate sending sources are covered and DMARC is at `p=reject`.

### Sending sources to include

| Source | SPF Include |
|---|---|
| SendGrid (primary) | `include:sendgrid.net` |
| Google Workspace (if used for staff email) | `include:_spf.google.com` |
| Firebase / Google Cloud | Already covered by `sendgrid.net` |
| SMTP fallback (your server) | Add its IP: `ip4:x.x.x.x` |

### Verification

```bash
nslookup -type=TXT mysokoni.co.ke
# or
dig TXT mysokoni.co.ke +short
```

Expected output includes `v=spf1 include:sendgrid.net`.

---

## 2. DKIM (DomainKeys Identified Mail)

DKIM adds a cryptographic signature to outgoing email headers so receivers can verify the message was not tampered with.

### SendGrid DKIM setup (manual steps)

1. Log in to SendGrid → **Settings → Sender Authentication → Authenticate Your Domain**
2. Choose DNS host (e.g. Cloudflare, GoDaddy, or your registrar for `.co.ke`)
3. SendGrid generates 3 DNS records — two CNAME records for DKIM and one for domain validation

**Example records SendGrid will give you (keys will differ):**

```
Type:  CNAME
Name:  s1._domainkey.mysokoni.co.ke
Value: s1.domainkey.u12345678.wl.sendgrid.net

Type:  CNAME
Name:  s2._domainkey.mysokoni.co.ke
Value: s2.domainkey.u12345678.wl.sendgrid.net

Type:  CNAME
Name:  em1234.mysokoni.co.ke
Value: u12345678.wl.sendgrid.net
```

4. Add all three records in your DNS panel
5. Back in SendGrid, click **Verify** — it may take 15–60 minutes for DNS to propagate

### Verification

```bash
dig CNAME s1._domainkey.mysokoni.co.ke +short
# Expected: s1.domainkey.u12345678.wl.sendgrid.net.
```

Use [MXToolbox DKIM Lookup](https://mxtoolbox.com/dkim.aspx) with selector `s1` and domain `mysokoni.co.ke`.

---

## 3. DMARC (Domain-based Message Authentication, Reporting & Conformance)

DMARC ties SPF and DKIM together and tells receivers what to do when authentication fails. It also sends reports back so you can monitor who is sending mail on your behalf.

### Rollout strategy (critical — do not skip)

| Phase | Policy | When to move |
|---|---|---|
| Phase 1 | `p=none` | Immediately. Collects reports without blocking mail. |
| Phase 2 | `p=quarantine` | After 2–4 weeks with clean reports (>95% pass rate). |
| Phase 3 | `p=reject` | After another 2–4 weeks. Blocks all unauthenticated mail. |

### DNS record

```
Type:  TXT
Name:  _dmarc.mysokoni.co.ke
Value: v=DMARC1; p=none; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:dmarc@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100
TTL:   3600
```

| Tag | Value | Meaning |
|---|---|---|
| `p` | `none` | Start here — monitor only |
| `rua` | `dmarc@mysokoni.co.ke` | Aggregate report destination (daily XML) |
| `ruf` | `dmarc@mysokoni.co.ke` | Forensic report destination |
| `fo` | `1` | Send forensic report on any failure |
| `adkim` | `s` | Strict DKIM alignment |
| `aspf` | `s` | Strict SPF alignment |
| `pct` | `100` | Apply to 100% of mail |

> **Note:** The `email-dmarc.js` Cloud Function is already deployed at  
> `https://us-central1-sokoni-aeb26.cloudfunctions.net/dmarcWebhook`  
> It receives SendGrid inbound-parse webhooks and writes aggregate data to Firestore (`dmarcReports` collection). The DMARC admin UI lives at `/admin-os.html` → Security tab.

### Update the policy over time

```
# Phase 2 (after clean reports):
v=DMARC1; p=quarantine; rua=mailto:dmarc@mysokoni.co.ke; pct=10

# Phase 3 (production enforcement):
v=DMARC1; p=reject; rua=mailto:dmarc@mysokoni.co.ke; pct=100
```

### Verification

```bash
dig TXT _dmarc.mysokoni.co.ke +short
```

Use [MXToolbox DMARC Lookup](https://mxtoolbox.com/dmarc.aspx).

---

## 4. BIMI (Brand Indicators for Message Identification)

BIMI displays your logo in the inbox next to the sender name in supported clients. It requires DMARC to be at `p=quarantine` or `p=reject`.

### Supported clients

| Client | BIMI support |
|---|---|
| Gmail | ✅ Full support (requires VMC for verified checkmark) |
| Apple Mail (iOS 16+, macOS Ventura+) | ✅ Full support |
| Yahoo Mail | ✅ Full support |
| Outlook | ❌ Not yet supported |
| Samsung Email | ✅ |
| Fastmail | ✅ |
| AOL Mail | ✅ |

### Logo requirements

| Requirement | Value |
|---|---|
| Format | SVG 1.2 Tiny Profile (not SVG 1.1) |
| Aspect ratio | 1:1 (square) |
| Background | Square, not transparent (white or brand colour fills the frame) |
| Max file size | 32 KB (recommend < 16 KB) |
| Hosting | HTTPS, publicly accessible, no redirects |
| URL | `https://mysokoni.co.ke/assets/bimi-logo.svg` (suggested) |

> **Action required:** Create a square SVG 1.2 Tiny logo. The `logosokoni.png` shield icon is the right visual — convert it to compliant SVG.

### Prepare the BIMI SVG

1. Export `assets/logosokoni.png` to SVG using Adobe Illustrator, Inkscape, or a professional designer
2. Validate it at [BIMI Group Validator](https://bimigroup.org/bimi-generator/)
3. Ensure it uses `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny">` (not `version="1.1"`)
4. Upload to `https://mysokoni.co.ke/assets/bimi-logo.svg` (Firebase Hosting)

### BIMI DNS record (without VMC — logo only, no verified checkmark)

```
Type:  TXT
Name:  default._bimi.mysokoni.co.ke
Value: v=BIMI1; l=https://mysokoni.co.ke/assets/bimi-logo.svg;
TTL:   3600
```

> Gmail requires a VMC (Verified Mark Certificate) to show the logo and blue checkmark. Without VMC, Gmail ignores the BIMI record entirely. Apple Mail, Yahoo, and Samsung display the logo without VMC.

### VMC (Verified Mark Certificate) — for Gmail verified checkmark

A VMC is a paid TLS certificate that cryptographically binds your logo to your domain. It proves you own both the domain and the trademark on the logo.

| Step | Detail |
|---|---|
| Certificate Authority | DigiCert or Entrust (the two BIMI-authorised CAs as of 2026) |
| Cost | ~USD 1,300–1,500 / year |
| Pre-requisites | Registered trademark for the SOKONI logo in at least one jurisdiction (e.g. KIPI — Kenya Industrial Property Institute) |
| File format | PEM (.pem) hosted at HTTPS URL |

**BIMI record with VMC:**
```
v=BIMI1; l=https://mysokoni.co.ke/assets/bimi-logo.svg; a=https://mysokoni.co.ke/assets/bimi-vmc.pem;
```

---

## 5. Manual Verification Checklist

Work through these in order. Do not proceed to BIMI until DMARC is at `p=reject`.

```
── PHASE 1: Foundation ──
[ ] SPF record added and verified (nslookup / MXToolbox)
[ ] SendGrid domain authentication completed (3 CNAME records)
[ ] DKIM selector s1 verified in MXToolbox
[ ] DMARC record added at p=none
[ ] Send a test email and run through mail-tester.com (target score: 10/10)
[ ] Confirm dmarc@mysokoni.co.ke inbox is receiving aggregate reports

── PHASE 2: Tighten ──
[ ] Review 2 weeks of DMARC aggregate reports in /admin-os.html → Security
[ ] Confirm pass rate ≥ 95% for all sending sources
[ ] Update DMARC to p=quarantine pct=10, then pct=100
[ ] Wait 2 more weeks, confirm no legitimate mail in quarantine

── PHASE 3: Enforce ──
[ ] Update DMARC to p=reject
[ ] Run mail-tester.com again — should still be 10/10
[ ] Confirm email deliverability with SendGrid Activity Feed

── PHASE 4: BIMI ──
[ ] Create BIMI-compliant SVG logo (Tiny 1.2, square, no transparency, < 16 KB)
[ ] Validate SVG at bimigroup.org/bimi-generator
[ ] Upload SVG to https://mysokoni.co.ke/assets/bimi-logo.svg
[ ] Confirm URL is publicly accessible with curl -I
[ ] Add BIMI TXT record at default._bimi.mysokoni.co.ke
[ ] Test in Yahoo Mail (shows logo without VMC)
[ ] (Optional) Obtain VMC from DigiCert or Entrust for Gmail checkmark
[ ] If VMC obtained: upload .pem, add a= tag to BIMI record
[ ] Test in Gmail — logo with blue verified checkmark appears
```

---

## 6. Useful Tools

| Tool | URL |
|---|---|
| Mail Tester (full score) | https://www.mail-tester.com |
| MXToolbox | https://mxtoolbox.com |
| DMARC Analyser | https://www.dmarcanalyzer.com |
| BIMI Group Validator | https://bimigroup.org/bimi-generator/ |
| Google Postmaster Tools | https://postmaster.google.com |
| SendGrid Email Testing | SendGrid Dashboard → Activity → Filter by domain |

---

## 7. Timeline Estimate

| Phase | Duration |
|---|---|
| SPF + DKIM | 1–2 hours |
| DMARC p=none monitoring | 2–4 weeks |
| DMARC p=quarantine hardening | 2–4 weeks |
| DMARC p=reject enforcement | Immediate flip |
| BIMI SVG creation | 1–3 days (design work) |
| BIMI DNS record | 1 hour |
| VMC (optional, for Gmail) | 1–3 weeks (trademark + CA verification) |

---

*Document maintained by SOKONI Engineering. Last updated: 2026-07-12.*
*Reference: [[Email System]] · [[Security Standards]] · [[DNS Architecture]]*
