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

## Windows environment gotchas

Two issues that look like broken tooling but are both the same root cause: **Windows ships a
`python` alias that is a Microsoft Store installer stub, not an interpreter.** It sits on
`PATH` ahead of everything and fails with *"Python was not found; run without arguments to
install from the Microsoft Store"*.

### `gcloud` fails with "Python was not found"

The Cloud SDK is **not** broken and does **not** need a system Python — its launcher just
can't find a usable interpreter. The SDK ships its own. Point the launcher at it:

```bash
export CLOUDSDK_PYTHON="$LOCALAPPDATA/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe"
gcloud version   # now works
```

Set it in your shell profile — it is per-shell, so a new terminal loses it and gcloud
appears "broken" again. Every `gcloud` command in this guide assumes it is exported.

### `python -m http.server` serves nothing

Same stub. Use the npm dev server (`npm run dev`) or any Node static server instead.

---

## Google Cloud credentials: two separate stores

`gcloud auth login` and `gcloud auth application-default login` populate **different**
credential stores. Having one does **not** imply the other exists or is valid, and the
failure modes look nothing alike:

| Command | Store | Used by |
|---|---|---|
| `gcloud auth login` | user credentials | the `gcloud` CLI itself |
| `gcloud auth application-default login` | **ADC** | `firebase-admin`, client libraries, the RC harness |

If `firebase-admin` fails with `invalid_client` or *"Could not load the default
credentials"* while `gcloud` commands work fine, it is ADC that is missing or stale — run
the application-default login.

Do **not** try to bridge a `gcloud auth print-access-token` value into `firebase-admin` as a
custom credential. It does not work and has been verified twice: Identity Toolkit rejects
user credentials without a quota project, and Firestore refuses custom credential objects
outright (*"Must initialize the SDK with a certificate credential or application default
credentials"*). Use ADC, or a service-account key if a long-lived credential is genuinely
warranted.

---

## Cloud Run invoker bindings (a 403 that is not a code bug)

Firebase **onCall** functions are Cloud Run services underneath. They require
`roles/run.invoker` granted to `allUsers` so the request can *reach* the function — the
function then enforces auth itself and returns `401 UNAUTHENTICATED` to anonymous callers.
This is the normal configuration, not an open endpoint.

A **missing** binding presents as `403` on every call and is easily mistaken for an
application defect. Diagnose by comparing against a known-working callable:

```bash
gcloud run services get-iam-policy createcheckoutsession \
  --region=us-central1 --project=sokoni-aeb26 --format="value(bindings.members)"
# expect: ['allUsers']

gcloud run services add-iam-policy-binding <service> \
  --region=us-central1 --member=allUsers \
  --role=roles/run.invoker --project=sokoni-aeb26
```

Cloud Run **service names are lowercase** (`requestdataexport`) even though the exported
function is camelCase (`requestDataExport`).

A correctly-fixed endpoint moves **403 → 401**. Before granting `allUsers` on anything
privacy-sensitive, confirm the function enforces auth internally (`request.auth?.uid` /
`_assertAuth`) and ideally `enforceAppCheck: true`.

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
