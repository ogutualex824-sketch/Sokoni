# SOKONI Android Release Guide

**Package:** `ke.co.mysokoni.app`  
**Technology:** Trusted Web Activity (TWA) via Bubblewrap  
**Platform:** Google Play Store  
**Domain:** `https://mysokoni.co.ke`

---

## Overview

SOKONI is packaged as a Trusted Web Activity (TWA), which wraps the production PWA inside a native Android shell. The app opens Chrome Custom Tab without any browser UI — it looks and behaves like a native app. The TWA is verified using Digital Asset Links, which confirms the Android package owns the web domain.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| Java JDK | 11+ | https://adoptium.net |
| Android SDK | API 29+ | Via Android Studio |
| Bubblewrap CLI | latest | `npm i -g @bubblewrap/cli` |
| `keytool` | (bundled with Java) | — |

Set environment variables:
```bash
export ANDROID_HOME=$HOME/Android/Sdk          # macOS/Linux
# Windows: set ANDROID_HOME=C:\Users\USER\AppData\Local\Android\Sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools/bin:$PATH
```

---

## Step 1 — Generate the Release Keystore

Run once. Store the keystore file securely — losing it means you can never update the Play Store listing.

```bash
keytool -genkeypair \
  -alias sokoni-key \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -keystore sokoni-release.keystore
```

You will be prompted for:
- Keystore password (choose a strong password, save it)
- Key password (can be the same)
- Your name / organisation details

**Store `sokoni-release.keystore` outside the git repository. Never commit it.**

---

## Step 2 — Extract the SHA-256 Fingerprint

```bash
keytool -list -v \
  -keystore sokoni-release.keystore \
  -alias sokoni-key \
  | grep "SHA256:"
```

Example output:
```
SHA256: AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78
```

---

## Step 3 — Update assetlinks.json

Open `assetlinks.json` in the project root and replace the placeholder with the fingerprint from Step 2.

The fingerprint should be the colon-delimited uppercase hex string, exactly as `keytool` outputs it.

Deploy hosting to publish the updated `assetlinks.json`:

```bash
npx firebase-tools@latest deploy --only hosting
```

Verify the file is accessible:
```bash
curl https://mysokoni.co.ke/.well-known/assetlinks.json
```

---

## Step 4 — Update twa-manifest.json

Open `twa-manifest.json` and replace `REPLACE_WITH_RELEASE_SHA256_FINGERPRINT` with the actual fingerprint from Step 2.

Also fill in the signing credentials (these are used by Bubblewrap at build time):
```json
"signing": {
  "store": "/absolute/path/to/sokoni-release.keystore",
  "alias": "sokoni-key",
  "keyPassword": "YOUR_KEY_PASSWORD",
  "storePassword": "YOUR_STORE_PASSWORD"
}
```

---

## Step 5 — Initialise the Bubblewrap Project

Run from the project root:

```bash
bubblewrap init --manifest=https://mysokoni.co.ke/manifest.json
```

Bubblewrap will read the web app manifest and ask you to confirm settings. When prompted for the TWA manifest path, point it to `twa-manifest.json`.

Alternatively, initialise from the local file:

```bash
bubblewrap init --manifest=./manifest.json
```

This generates an `android/` directory with the Android project.

---

## Step 6 — Build the APK (for testing)

```bash
bubblewrap build
```

Output: `app-release-signed.apk`

Install on a connected device for testing:
```bash
adb install -r app-release-signed.apk
```

---

## Step 7 — Build the AAB (for Play Store)

The Play Store requires an Android App Bundle (`.aab`), not an APK.

```bash
bubblewrap build --skipPwaValidation
```

Or, from the generated `android/` directory:
```bash
cd android
./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

Sign the AAB:
```bash
jarsigner -verbose \
  -sigalg SHA256withRSA \
  -digestalg SHA-256 \
  -keystore sokoni-release.keystore \
  android/app/build/outputs/bundle/release/app-release.aab \
  sokoni-key
```

---

## Step 8 — Validate Digital Asset Links

Before submitting to Play Store, verify DAL verification passes:

1. Install the app on a test device
2. Open `https://mysokoni.co.ke` on the device — the browser chrome (URL bar) should be hidden, confirming TWA verification passed
3. If the URL bar appears, the assetlinks.json fingerprint doesn't match — re-check Step 2 and Step 3

Online validator: https://developers.google.com/digital-asset-links/tools/generator

---

## Step 9 — Play Store Submission Checklist

### App information
- [ ] Title: `SOKONI — Kenya's Marketplace`
- [ ] Short description (80 chars): `Buy, sell, book & hire — Kenya's all-in-one digital marketplace`
- [ ] Full description (4000 chars): covering all hubs (marketplace, food, events, logistics, POS…)
- [ ] Category: `Shopping`
- [ ] Content rating: complete the questionnaire (select appropriate age rating)
- [ ] Contact email: `support@mysokoni.co.ke`
- [ ] Privacy policy URL: `https://mysokoni.co.ke/privacy.html`

### Graphics
- [ ] App icon: 512×512 PNG, no alpha, exported from `assets/icons/icon-512.png`
- [ ] Feature graphic: 1024×500 PNG
- [ ] Phone screenshots: at least 2, max 8 (1080×1920 portrait recommended)
  - Use `assets/screenshots/screen-*.png` — generate these with Playwright or a physical device

### Release
- [ ] Upload `app-release.aab` to Internal Testing track first
- [ ] Test on 3+ devices across Android 9/10/12/14
- [ ] Verify: splash screen, offline mode, notifications, deep links, M-Pesa checkout
- [ ] Promote to Production when satisfied

### App signing
- [ ] Enrol in Play App Signing (recommended) — Google manages the signing key for distribution
- [ ] Upload the `sokoni-release.keystore` upload key to Play Console

---

## Step 10 — Versioning

Each Play Store update requires a higher `versionCode` (integer). Update in `twa-manifest.json`:

```json
"appVersion": "1.0.1",
"appVersionCode": 2
```

Also update in `android/app/build.gradle` if building manually.

Suggested versioning scheme:
- `appVersionCode`: increment by 1 per release
- `appVersion`: `MAJOR.MINOR.PATCH` — bump MINOR per sprint, PATCH per hotfix

---

## Ongoing Maintenance

| When | Action |
|---|---|
| New pages added | No action needed — TWA renders the live PWA |
| New shortcuts added | Update `shortcuts` in `twa-manifest.json`, bump `appVersionCode`, rebuild |
| Domain change | Update `host` in `twa-manifest.json`, regenerate assetlinks.json |
| Icon change | Update `iconUrl` in `twa-manifest.json`, rebuild |
| Service worker update | No action — PWA SW handles itself; users get updates via browser cache |

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| URL bar visible in TWA | Wrong SHA-256 in assetlinks.json | Re-extract fingerprint with `keytool`, update assetlinks.json, redeploy hosting |
| App crashes on launch | Missing `start_url` in manifest | Ensure `https://mysokoni.co.ke/?source=twa` returns 200 |
| Black screen on launch | Slow first-load, no offline cache | Confirm SW is registered and caches shell on install |
| Notifications not working | TWA needs `enableNotifications: true` in twa-manifest.json | Already set; ensure FCM token is registered |
| DAL verification fails | assetlinks.json not publicly accessible | Run `curl https://mysokoni.co.ke/.well-known/assetlinks.json`, check hosting deploy |

---

## Related Documents

- [[PWA]] — service worker strategy and offline support
- [[ARCHITECTURE]] — platform architecture overview
- [[SCALABILITY]] — scaling targets and growth model
- [[DEPLOY_QUEUE]] — pending CF deployments
