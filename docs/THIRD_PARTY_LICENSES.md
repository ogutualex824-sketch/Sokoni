# Third-party software, fonts and assets — licence inventory (2026-10-01)

**Scope:** what the SOKONI web app loads in the browser, taken from a scan of the hosting tree
(`*.html`, `*.js`). **Related:** [[SECURITY_PRIVACY_GAP_CENSUS_2026-10-01]] ·
[[RECORDS_OF_PROCESSING_ACTIVITIES]] · [[SECURITY]]

**Status labels:**
- **VERIFIED:** the licence is known and the file or banner is present.
- **UNPROVEN:** the licence or source has not been confirmed.
- **ACTION:** a follow-up is needed.

## Scripts and styles

| Library | Version(s) | Where from | Licence | Data sent to a third party | Status |
|---|---|---|---|---|---|
| Firebase JS SDK | 10.12.2 (544 refs), 10.12.0, 9.23.0, 9.22.2, 9.6.1, 11.0.2, 11.0.1, 11.1.0, 11.9.0 | gstatic.com | Apache-2.0 | Auth, Firestore, Functions and App Check traffic to Google (our processor) | VERIFIED licence. **ACTION:** converge on one version; nine are loaded and `checkout.html` loads two. |
| IntaSend inline SDK | 3.0.3 | unpkg.com | Vendor SDK under IntaSend's terms | Payment details go to IntaSend (processor) | **ACTION:** no Subresource Integrity (SRI) on the payment SDK. Self-host or add `integrity=`. |
| Chart.js | 4.4.1 (cdnjs), 4.x (jsdelivr) | cdnjs, jsdelivr | MIT | none | VERIFIED. **ACTION:** one CDN, pinned. |
| qrcodejs | 1.0.0 | cdnjs | MIT | none | VERIFIED |
| qrcode (node-qrcode) | unpinned | jsdelivr | MIT | none | **ACTION:** pin the version |
| jsQR | unpinned | jsdelivr | Apache-2.0 | none | **ACTION:** pin the version |
| @zxing/library | 0.20.0 | unpkg | Apache-2.0 | none (decodes on the device) | VERIFIED |
| Leaflet.markercluster | 1.4.1 | unpkg and jsdelivr | MIT | none | VERIFIED. **ACTION:** one CDN |
| Leaflet.heat | 0.2.0 | unpkg and jsdelivr | UNPROVEN (confirm in the package) | none | UNPROVEN |
| pdf.js | 3.11.174 | cdnjs | Apache-2.0 | none | VERIFIED |
| tesseract.js | 5.x | jsdelivr | Apache-2.0 | none (OCR on the device; model files fetched from the CDN) | VERIFIED licence |
| Google Analytics 4 | gtag, G-QT32H65TJS | googletagmanager.com | Google terms | Page and event data. Loads **only after consent** (`analytics.js` via `SokoniConsent`); ad signals denied | VERIFIED gating |

16 CDN `<script>` tags carry no `integrity=` attribute (census 2026-10-01). **ACTION:** add SRI or self-host, payment SDK first.

## Fonts and icons

| Asset | Where from | Licence | Status |
|---|---|---|---|
| Font Awesome Free 6.5.1 | self-hosted `/assets/vendor/fontawesome/6.5.1` | Icons CC BY 4.0 · Fonts SIL OFL 1.1 · Code MIT | VERIFIED. `LICENSE.txt` was added to the vendor folder, and the CSS banner is intact. |
| Inter | Google Fonts (21 pages) | SIL OFL 1.1 | VERIFIED licence. Loading from Google sends the visitor's IP address to Google; self-hosting would avoid that. |

## Images and marks

| Asset | Source | Status |
|---|---|---|
| Stock photos hot-linked from `images.unsplash.com` (`category.js`, `sokoni-carhub-pro.js`, `car-hub.html`; `script.js` only behind a localhost gate) | Unsplash | Allowed under the Unsplash License, but **the source of each photo is not recorded**. **ACTION:** record the source or replace with real listing photos. |
| Payment marks (Visa, Mastercard, M-Pesa, PayPal) and "intasend trust badge" in `/assets` | Brand owners | Trademarks, to be used only to represent that payment method. **ACTION:** the PayPal mark is shown although no PayPal rail exists (census P1). |
| SOKONI and Bravilex logos | Own | Owned |

## Third-party request endpoints

| Endpoint | Purpose | Note |
|---|---|---|
| `api.qrserver.com`, `chart.googleapis.com` | QR images | The encoded text (for example a profile URL) goes to a third party. **ACTION:** generate QR codes on the device (qrcodejs is already loaded). |
| `intasend-prod-static.s3` | IntaSend assets | Processor |

This inventory is a snapshot. Rerun the scan in `docs/SECURITY_PRIVACY_GAP_CENSUS_2026-10-01.md` §3 before each release that adds a library.
