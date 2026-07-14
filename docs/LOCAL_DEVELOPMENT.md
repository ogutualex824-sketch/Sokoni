# SOKONI — Local Development Guide

**Project:** SOKONI  
**Classification:** Internal — Engineering

---

## Starting the Local Server

```bash
npm run dev
# http-server . -p 3000 --cors -c-1
# Opens http://localhost:3000
```

The app is served directly from the repository root. There is no build step — all HTML, JS, and CSS files are served as-is.

---

## Secure Context and Web Bluetooth on localhost

### The Rule

Web Bluetooth (`navigator.bluetooth`) requires a **secure context** — either HTTPS or localhost.

### Chrome treats localhost as a secure context

Google Chrome (and all Chromium-based browsers) grant `localhost` and `127.0.0.1` the status of a [potentially trustworthy origin](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy). This means:

| URL | Secure Context? | Web Bluetooth available? |
|---|---|---|
| `http://localhost:3000` | **Yes** (Chrome exception) | **Yes** |
| `http://127.0.0.1:3000` | **Yes** (Chrome exception) | **Yes** |
| `http://192.168.1.x:3000` | No | No |
| `http://any-other-hostname` | No | No |
| `https://mysokoni.co.ke` | Yes | Yes |

**Conclusion:** P58E Bluetooth printer pairing and printing work on `http://localhost:3000` in Chrome. No HTTPS deployment is required for local BLE development.

### Verifying your environment

Open `pos-printer-hardware-test.html` — the Environment Diagnostics panel at the top of the page shows `isSecureContext`, browser, OS, and confirms whether Web Bluetooth is available and why.

### When Bluetooth is still unavailable on localhost

If you are on `http://localhost` but Web Bluetooth is still blocked, the reason will be one of:

1. **Wrong browser** — Firefox and Safari do not implement Web Bluetooth. Use Chrome 85+.
2. **Chromium feature flag disabled** — visit `chrome://flags/#enable-web-bluetooth` and enable it.
3. **OS Bluetooth disabled** — ensure system Bluetooth is on (Windows: Action Center → Bluetooth toggle).
4. **Chrome experimental features** — on some Linux distros, Web Bluetooth is behind `--enable-experimental-web-platform-features`.

---

## Cloud Functions

Cloud Functions always hit the live production project (`sokoni-aeb26`). There is no local Functions emulator configured.

Any checkout, payment, or print action on `localhost` is a real operation against the production Firestore database and live IntaSend/M-Pesa integration.

To test without affecting production data, create a separate test seller account and use the test products collection.

---

## HTTPS is still required for

- **Share Sheet** (`navigator.share`) — Web Share API requires HTTPS. It will not work on `http://localhost`.
- **App Check** enforcement — ReCaptcha v3 tokens require a registered domain.
- **Service Worker** — service workers are restricted to HTTPS (localhost is the only exception, and it is already handled).

---

## Deploying to Firebase Hosting

```bash
# Hosting only (fast, no function deploy)
npm run deploy:hosting

# Full deploy (functions + hosting + rules)
npm run deploy:all
```

Production URL: **https://mysokoni.co.ke**

---

## Key Local Test Pages

| Page | Purpose |
|---|---|
| `/pos-checkout.html` | Full POS checkout flow |
| `/pos-printer-hardware-test.html` | P58E BLE hardware certification (TEST-13a) |
| `/pos-ios-print-test` | iOS / Safari print certification (TEST-13c) |
| `/pos-daily.html` | Daily operations, X/Z reports |
| `/admin-os.html` | Admin operating system |

---

*SOKONI Local Development Guide — 2026-07-14*
