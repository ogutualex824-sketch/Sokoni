# SOKONI Typesense Deployment Guide v2.0

**Audience:** DevOps / Backend Engineers  
**Last Updated:** 2026-06-20

---

## Prerequisites

- Firebase project with Blaze plan (Cloud Functions required)
- Node 18 runtime (set in `functions/package.json`)
- Firebase CLI ≥ 13.0 (`npm install -g firebase-tools`)
- Typesense cluster (Typesense Cloud or self-hosted)
- Google Cloud Storage bucket (same project as Firebase)

---

## Step 1 — Provision Typesense Cluster

### Option A: Typesense Cloud (recommended)

1. Create account at [cloud.typesense.org](https://cloud.typesense.org)
2. Create a cluster: **3 nodes**, RAM ≥ 4GB per node, SSD storage
3. Note your cluster **hostname**: `xyz.a1.typesense.net`
4. Generate two API keys in the Typesense dashboard:
   - **Admin key** — full permissions
   - **Search-only key** — `searches` permission only

### Option B: Self-hosted (3-node HA)

```bash
# On each node, install Typesense 0.25+
curl -O https://dl.typesense.org/releases/0.25.2/typesense-server-0.25.2-linux-amd64.tar.gz
tar -xzf typesense-server-*.tar.gz

# Node 1 (example config)
./typesense-server \
  --data-dir=/var/lib/typesense \
  --api-key=ADMIN_KEY_HERE \
  --listen-port=8108 \
  --nodes=n1.internal:8108:8107,n2.internal:8108:8107,n3.internal:8108:8107 \
  --node-address=n1.internal \
  --peering-port=8107

# Repeat for n2 and n3 with matching --nodes and their own --node-address
```

---

## Step 2 — Store Secrets in Firebase

```bash
# Admin key (never exposed to browser)
firebase functions:secrets:set TYPESENSE_ADMIN_KEY
# When prompted, paste your Typesense admin key

# Search-only key (used to generate scoped keys)
firebase functions:secrets:set TYPESENSE_SEARCH_KEY
# When prompted, paste your search-only key

# Verify secrets are stored
firebase functions:secrets:access TYPESENSE_ADMIN_KEY
```

---

## Step 3 — Set Environment Variables

Edit (or create) `functions/.env.YOUR_PROJECT_ID`:

```env
# Single node (Typesense Cloud)
TYPESENSE_NODES=xyz.a1.typesense.net:443:https

# OR multi-node HA (3 nodes, comma-separated)
# TYPESENSE_NODES=n1.example.com:443:https,n2.example.com:443:https,n3.example.com:443:https
```

---

## Step 4 — Update sokoni-config.js (Browser Config)

Open `sokoni-config.js` and fill in the Typesense section:

```javascript
typesenseHost:      "xyz.a1.typesense.net",   // single node
typesensePort:      443,
typesenseProtocol:  "https",
typesenseSearchKey: "",  // leave empty — getTypesenseSearchKey CF will issue scoped keys

// OR for multi-node:
typesenseNodes: [
  "n1.example.com:443:https",
  "n2.example.com:443:https",
  "n3.example.com:443:https",
],
```

---

## Step 5 — Deploy Cloud Functions

```bash
# Deploy all functions at once
firebase deploy --only functions

# Or deploy specific modules only
firebase deploy --only functions:typesenseCreateCollections,functions:typesenseBackfill
```

**Functions deployed (count: ~50):**

| Module | Functions |
|---|---|
| typesense-sync | 75 Firestore triggers (25 × 3) |
| typesense-queue | processTypesenseQueue, typesenseQueueMonitor, typesenseReprocessDLQ, typesenseForceRetry |
| typesense-admin | typesenseCreateCollections, typesenseBackfill, typesenseHealthCheck, typesenseDeleteOrphans, typesenseCollectionStats, typesenseCanaryDeploy |
| typesense-reconcile | typesenseReconcile, typesenseRepairDivergent, typesenseVerifyDoc |
| typesense-monitor | typesenseMonitorHealth, typesenseMonitorLatency, typesenseGetDashboard, typesenseResolveAlert, typesenseMonitorCleanup |
| typesense-backup | typesenseBackupDaily, typesenseBackupCleanup, typesenseListBackups, typesenseVerifyBackup, typesenseRestoreBackup |
| typesense-secured-keys | getTypesenseSearchKey, typesenseKeyStats, typesenseKeyCleanup |
| typesense-analytics | recordTypesenseSearchEvent, getTsAnalyticsDashboard, getTsAutocompleteSuggestions, generateTsTrending, cleanupTsAnalytics, typesenseExportAnalytics |

---

## Step 6 — Create Collections

Call the admin Cloud Function to create all 25 Typesense collections:

### Via Firebase Console

1. Go to **Firebase Console** → **Functions** → **typesenseCreateCollections**
2. Click **Test function** (or use the Functions shell)
3. Pass: `{}` (empty object — creates all collections)

### Via Firebase Functions Shell

```javascript
firebase functions:shell
> typesenseCreateCollections({})
```

### Via Admin SDK (Node.js)

```javascript
const admin = require('firebase-admin');
admin.initializeApp();

const fn = admin.functions().httpsCallable('typesenseCreateCollections');
const result = await fn({});
console.log(result.data);
// { created: [...], skipped: [...], aliasesWired: [...] }
```

**Expected output:**
```json
{
  "created": ["sokoni_products_v1", "sokoni_shops_v1", "...24 more"],
  "aliasesWired": ["sokoni_products", "sokoni_shops", "...24 more"],
  "synonymsApplied": 13,
  "presetsApplied": 1
}
```

---

## Step 7 — Backfill Existing Data

Backfill each Firestore collection into Typesense. Run these sequentially to avoid overloading:

```javascript
// In Firebase Functions shell or admin script
const backfill = admin.functions().httpsCallable('typesenseBackfill');

const collections = [
  'products', 'sellers', 'providers', 'services', 'events',
  'propertyListings', 'cars', 'jobs', 'bnbListings', 'foods',
  'fitness_clubs', 'fitness_classes', 'education', 'lawyers',
  'reviews', 'users', 'categories', 'brands', 'collections',
  'coupons', 'tourism', 'entertainment',
];

for (const col of collections) {
  console.log(`Backfilling ${col}...`);
  const result = await backfill({ firestoreCollection: col, pageSize: 200 });
  console.log(result.data);
  await new Promise(r => setTimeout(r, 2000)); // pause between collections
}
```

**Note:** Large collections (100k+ docs) may require multiple backfill calls if the Cloud Function times out at 540s. The function uses cursor-based pagination — safe to resume.

---

## Step 8 — Deploy Firestore Indexes

```bash
firebase deploy --only firestore:indexes
```

This deploys all indexes in `firestore.indexes.json`, including the new Typesense pipeline indexes.

---

## Step 9 — Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

---

## Step 10 — Verify Health

Call the health check from the Firebase Functions shell:

```javascript
> typesenseHealthCheck({})
// { healthy: true, nodes: [...], collectionsChecked: 25, allHealthy: true }
```

Or wait 5 minutes for the first scheduled `typesenseMonitorHealth` run, then check:

```javascript
const db = admin.firestore();
const status = await db.doc('tsMonitor/status').get();
console.log(status.data());
// { healthy: true, healthyNodes: 3, totalNodes: 3, queueDepth: 0, dlqDepth: 0 }
```

---

## Step 11 — Include Browser Scripts

Add to your HTML pages (after `sokoni-config.js`):

```html
<!-- Core search engine -->
<script src="/sokoni-typesense-engine.js"></script>

<!-- Recommendations (optional — add on product/listing pages) -->
<script src="/sokoni-search-recommendations.js"></script>
```

The engine auto-initialises when `window.SOKONI_CONFIG.typesenseHost` or `typesenseNodes` is set.

---

## Upgrade from v1 (12 collections → 25 collections)

1. Deploy all updated Cloud Functions (Step 5)
2. Call `typesenseCreateCollections({})` — it will detect existing collections and add missing fields only (non-destructive PATCH)
3. Run backfill for the 13 new collections:
   - `bnbListings`, `hotels`, `fitness_clubs`, `fitness_classes`, `education`, `lawyers`, `reviews`, `digitalReviews`, `legalReviews`, `tourism`, `entertainment`, `categories`, `brands`
4. Deploy updated browser scripts
5. Deploy updated `firestore.indexes.json`

No data is lost during upgrade. Existing collections are not dropped.

---

## Rollback Procedure

If a deployment causes issues:

```bash
# Roll back Cloud Functions to previous version
firebase functions:rollback

# OR deploy a specific older function version
firebase deploy --only functions:typesenseCreateCollections
```

For Typesense collection issues, use the restore function:

```javascript
// Restore sokoni_products from yesterday's backup
const restore = admin.functions().httpsCallable('typesenseRestoreBackup');
await restore({ backupId: 'daily_sokoni_products_2026-06-19', targetVersion: 'restored' });
```

---

## Cost Estimates (Firebase)

| Resource | Estimated Usage | Notes |
|---|---|---|
| Cloud Functions invocations | ~5M/month | 75 triggers + scheduled CFs |
| Firestore reads (queue) | ~2M/day | Queue monitor + processing |
| Firestore writes (queue) | ~500k/day | Index queue entries |
| Cloud Storage (backups) | ~10GB/month | JSONL gzip daily backups |
| Network egress | ~5GB/month | Typesense → Functions |

---

## Related Documents

- [[TYPESENSE-ARCHITECTURE]] — system design and data flow
- [[TYPESENSE-RUNBOOK]] — operations: incidents, scaling, DLQ handling
- [[SECURITY]] — secret management, key rotation
