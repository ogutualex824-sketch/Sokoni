# SOKONI Typesense Operations Runbook v2.0

**Audience:** On-call Engineers  
**Last Updated:** 2026-06-20  
**SLA:** p99 < 150ms · Availability > 99.9% · Queue depth < 10,000 · DLQ < 50

---

## Monitoring Dashboard

Check current health at any time:

```javascript
// Firebase Functions shell
> typesenseGetDashboard({})
// Returns: currentStatus, currentLatency, queueStats, activeAlerts, latencyHistory, healthHistory
```

Or check directly in Firestore:
- `tsMonitor/status` — latest health snapshot (updated every 5min)
- `tsMonitor/latency` — latest p50/p95/p99 (updated every 15min)
- `adminAlerts` (where `resolved == false`) — active alerts

---

## Incident Response

### INCIDENT: Cluster Down (majority nodes unhealthy)

**Severity:** CRITICAL  
**Alert type:** `typesense_cluster_down`

**Diagnosis:**
```javascript
> typesenseHealthCheck({})
// Check: { nodes: [{status, host}] }
```

**Steps:**
1. SSH to Typesense nodes, check service status: `systemctl status typesense-server`
2. Check disk space: `df -h /var/lib/typesense`
3. Check memory: `free -m`
4. Check logs: `journalctl -u typesense-server -n 100`

**Recovery:**
```bash
# Restart single node
systemctl restart typesense-server

# Check cluster membership after restart
curl -H "X-TYPESENSE-API-KEY: $ADMIN_KEY" http://localhost:8108/operations/raft_info
```

**Browser client resilience:** The browser engine has per-node circuit breakers (threshold 3 failures, 15s cooldown) and will automatically route to healthy nodes. Clients do not need to be restarted.

---

### INCIDENT: Node Degraded (1 of 3 down)

**Severity:** WARNING  
**Alert type:** `typesense_node_down`

**Impact:** Reduced write throughput, read capacity at 66%. Search continues normally.

**Steps:**
1. Verify via health check which node is down
2. Attempt restart on the degraded node (see above)
3. Monitor `tsMonitor/status` for recovery — circuit breakers will re-enable the node automatically

---

### INCIDENT: Latency SLA Breach (p99 ≥ 150ms)

**Severity:** WARNING  
**Alert type:** `typesense_latency_sla_breach`

**Diagnosis:**
```javascript
> typesenseGetDashboard({})
// Check: currentLatency.p50, p95, p99, latencyHistory
```

**Common causes and fixes:**

| Cause | Fix |
|---|---|
| Queue backup causing lock contention | Pause queue: set `typesenseQueue` to status != pending temporarily |
| Collection too large for RAM | Add more RAM to Typesense node or split collection |
| Cold cache after restart | Warm up with: run probes via `typesenseMonitorLatency({})` callable |
| Missing index on filter field | Add `facet: true` to the field in the schema |
| Overly complex `filter_by` | Simplify — remove OR conditions where possible |

**Queue pause (emergency):**
```javascript
// Stop processing for 10 minutes to reduce cluster load
const fn = admin.functions().httpsCallable('typesenseForceRetry');
// Don't call — just let the queue idle, it retries automatically
```

---

### INCIDENT: Queue Depth Exceeds 10,000

**Severity:** WARNING → CRITICAL (> 20,000)  
**Alert type:** `typesense_queue_deep`

**Diagnosis:**
```javascript
// Check queue stats
const snap = await db.doc('tsQueueStats/latest').get();
console.log(snap.data());
// { pendingTotal, pendingByPriority, dlqDepth, stuckReset, donesPurged }
```

**Steps:**
1. Check if `processTypesenseQueue` is running — look in Cloud Function logs
2. Check for stuck items (processingStartedAt > 10min ago) — `typesenseQueueMonitor` resets these automatically
3. If queue is growing due to mass update (e.g. bulk price change), this is expected — BATCH priority will drain overnight
4. If queue is growing due to errors, check DLQ depth

**Speed up queue processing:**
The queue processes up to 10,000 items per `processTypesenseQueue` invocation. It runs on a schedule — if you need to drain faster, trigger it manually:
```javascript
> processTypesenseQueue({})
```

---

### INCIDENT: DLQ Depth Exceeds 50

**Severity:** WARNING  
**Alert type:** `typesense_dlq_high`

**Diagnosis:**
```javascript
const dlqSnap = await db.collection('typesenseQueueDLQ')
  .orderBy('failedAt', 'desc').limit(10).get();
dlqSnap.docs.forEach(d => console.log(d.data()));
// Check: error field, collection, docId, operation
```

**Steps:**
1. Identify the error pattern (auth error vs schema mismatch vs node timeout)
2. Fix the root cause (e.g. update schema if field type changed)
3. Reprocess DLQ:

```javascript
> typesenseReprocessDLQ({})
// Moves all DLQ items back to typesenseQueue at NORMAL priority
```

4. If items keep failing, verify the document transformer in `typesense-client.js`

---

### INCIDENT: Reconciliation Detected Divergence > 100 repairs

**Severity:** WARNING → CRITICAL (> 1000)  
**Alert type:** `typesense_reconcile_divergence`

**Diagnosis:**
```javascript
const log = await db.collection('tsReconcileLog')
  .orderBy('runAt', 'desc').limit(1).get();
console.log(log.docs[0].data());
// Check: totalMissing, totalOrphans, collections[]
```

**Steps:**
1. Repairs are already enqueued automatically — check queue depth
2. If a specific collection is badly diverged, run a full repair:

```javascript
const fn = admin.functions().httpsCallable('typesenseRepairDivergent');
await fn({ firestoreCollection: 'products', pageSize: 200 });
// Enqueues all docs at BATCH priority
```

3. For catastrophic divergence, run a full backfill:

```javascript
const backfill = admin.functions().httpsCallable('typesenseBackfill');
await backfill({ firestoreCollection: 'products', overwrite: true });
```

---

## Scaling Playbook

### Scaling for Black Friday / Viral Traffic

**1 week before:**
- Upgrade Typesense cluster to higher memory tier
- Pre-warm caches by triggering `typesenseMonitorLatency` every minute instead of every 15
- Increase `typesenseQueue` processing frequency if needed
- Review DLQ — ensure it is empty

**Day before:**
- Trigger a full backup: `typesenseBackupDaily({})`  
- Verify backup: call `typesenseVerifyBackup` for top 5 collections
- Review `tsMonitor/status` — ensure all nodes healthy
- Reduce L1/L2 cache TTL on browser clients if you need fresher data (edit `TS.cacheTTL` in `sokoni-typesense-engine.js`)

**During event:**
- Monitor `tsMonitor/latency` every 5 minutes
- Watch `adminAlerts` collection for new alerts
- Have DLQ reprocess command ready: `typesenseReprocessDLQ({})`

**After event:**
- Run `typesenseDeleteOrphans({})` to clean up any stale indexed data
- Review `tsReconcileLog` from next morning's 04:00 run

---

## Backup and Restore

### List Available Backups

```javascript
const fn = admin.functions().httpsCallable('typesenseListBackups');
const result = await fn({ collection: 'sokoni_products', limit: 10 });
console.log(result.data);
// [{ backupId, collection, docCount, storeLoc, createdAt, verified }]
```

### Verify a Backup

```javascript
const fn = admin.functions().httpsCallable('typesenseVerifyBackup');
const result = await fn({ backupId: 'daily_sokoni_products_2026-06-19' });
console.log(result.data);
// { valid: true, expectedCount: 50000, backedUpCount: 49998, driftPct: 0 }
```

### Restore from Backup

```javascript
const fn = admin.functions().httpsCallable('typesenseRestoreBackup');
const result = await fn({
  backupId: 'daily_sokoni_products_2026-06-19',
  targetVersion: 'restored',  // creates sokoni_products_restored, then swaps alias
});
console.log(result.data);
// { imported: 49998, aliasSwapped: 'sokoni_products', targetCollection: 'sokoni_products_restored' }
```

**Note:** Restore swaps the alias automatically. The old collection `sokoni_products_v1` remains intact as a safety net until manually deleted.

---

## Key Rotation

### Rotate Typesense Admin Key

```bash
# 1. Generate new key in Typesense dashboard
# 2. Update Firebase secret
firebase functions:secrets:set TYPESENSE_ADMIN_KEY
# 3. Redeploy functions that use the admin key
firebase deploy --only functions:typesenseCreateCollections,typesenseBackfill,typesenseHealthCheck
# 4. Update TYPESENSE_NODES env var if host changed
```

### Rotate Search-Only Key

```bash
# 1. Generate new search-only key in Typesense dashboard
# 2. Update Firebase secret
firebase functions:secrets:set TYPESENSE_SEARCH_KEY
# 3. Redeploy secured-keys function
firebase deploy --only functions:getTypesenseSearchKey
# 4. Existing browser-issued scoped keys will expire within their TTL (max 4hr)
#    No active sessions need to be invalidated manually
```

---

## Schema Migration (Adding a New Field)

1. Add the field to the collection schema in `functions/typesense-client.js` `COLLECTION_SCHEMAS`
2. Call `typesenseCreateCollections({})` — it will PATCH the field onto existing collections
3. Update the transformer for that collection to populate the new field
4. Backfill existing docs: `typesenseBackfill({ firestoreCollection: '...', overwrite: true })`

---

## Adding a New Collection

1. Define the schema in `COLLECTION_SCHEMAS` in `functions/typesense-client.js`
2. Add to `COLLECTION_MAP`
3. Add the transformer to `TRANSFORMERS`
4. Add `_makeTriggers('newCollection', {...})` in `functions/typesense-sync.js`
5. Add to `ALL_COLLECTIONS` in `functions/typesense-secured-keys.js`
6. Export all new triggers in `functions/index.js`
7. Add to `typesenseCollections` in `sokoni-config.js`
8. Add `_queryByFields` entry in `sokoni-typesense-engine.js`
9. Deploy: `firebase deploy --only functions`
10. Create collection: `typesenseCreateCollections({})`
11. Backfill: `typesenseBackfill({ firestoreCollection: 'newCollection' })`

---

## Resolving Alerts

```javascript
const fn = admin.functions().httpsCallable('typesenseResolveAlert');
await fn({ alertId: 'ALERT_DOC_ID' });
```

Or in Firestore directly:
```javascript
await db.collection('adminAlerts').doc('ALERT_DOC_ID').update({
  resolved: true,
  resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  resolvedBy: 'manual',
});
```

---

## Verifying a Single Document

```javascript
const fn = admin.functions().httpsCallable('typesenseVerifyDoc');
const result = await fn({
  firestoreCollection: 'products',
  docId: 'PRODUCT_ID',
});
console.log(result.data);
// { inFirestore: true, inTypesense: true, diverged: false, fsStatus: 'active', tsDoc: {...} }
```

---

## Related Documents

- [[TYPESENSE-ARCHITECTURE]] — system design
- [[TYPESENSE-DEPLOYMENT]] — initial setup
- [[SECURITY]] — secret management
- [[CHANGELOG]] — version history
