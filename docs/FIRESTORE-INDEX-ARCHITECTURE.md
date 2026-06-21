# Firestore Index Architecture
*SOKONI Platform — Composite Index Dependency Map*
*Last updated: 2026-06-21 | Total indexes: 182 / 200 (18 slots reserved for growth)*

---

## Architecture Principles

| Principle | Implementation |
|---|---|
| **One index per access pattern** | No speculative indexes; each index maps to ≥1 real query |
| **Search engines own search** | Algolia/Typesense handle all text search, category browse, filtering. Firestore owns ownership and transactional queries only |
| **Zero regression policy** | Existing indexes are preserved; new indexes added only when confirmed by code scan |
| **200-index hard limit** | Current: 182. Reserve: 18 slots. Trigger review when count reaches 190 |

---

## Index Count by Collection Group

| Collection | Indexes | Purpose |
|---|---|---|
| `orders` | 7 | Buyer history, seller management, driver tracking, POS, admin |
| `inventory_movements` | 3 | Product, type, warehouse movement logs |
| `inventory_*` (all) | 18 | Full warehouse management: POs, batches, GRN, transfers, stock counts |
| `gipDispatch` | 4 | GIP command center: region, module, asset, status views |
| `gipAssets` | 3 | Regional asset management: online/offline, module filter |
| `gipLocations` | 2 | Region + online/status location queries |
| `mediaAssets` | 3 | User media library: by dest, by tier |
| `commissionLedger` | 3 | Seller commission: history, by period, by status |
| `emailLogs` | 3 | Email audit: by status, category, template |
| `posPayments` | 3 | POS payment history: seller, caller, status filter |
| `workflowInstances` | 4 | WAP: by definition, status, compound definition+status |
| `workflowApprovals` | 2 | WAP: pending approvals, deadline escalation |
| `workflowSchedule` | 2 | WAP: due items, stale processing detection |
| `workflowDLQ` | 1 | WAP: unresolved dead-letter queue |
| `algoliaQueue` | 2 | Algolia sync: due items, stuck detection |
| `typesenseQueue` | 3 | Typesense sync: priority queue, stuck processing, cleanup |
| `eccAuditLog` | 2 | ECC: audit by actor, by action |
| `platformEvents` | 3 | ECC: events by publisher, type, domain |
| `platformServices` | 2 | ECC: services by type, by status |
| `rideRequests` | 3 | Rides: user history, driver (driverId field), driver (assignedDriverId field) |
| `deliveries` | 4 | Delivery: sender history, rider active, rider history, admin |
| `gipAlerts` | 2 | GIP: unresolved alerts, alerts by asset |
| All others | ~106 | See full map below |

---

## Full Index Dependency Map

### Core Commerce

**`orders`** (7 indexes)
| Index | Query Served | Code Location |
|---|---|---|
| `(type, createdAt DESC)` | POS order list by type | `pos.js` |
| `(uid, createdAt DESC)` | Buyer "My Orders" | `profile.js`, `orders.html` |
| `(userId, status, createdAt DESC)` | Legacy buyer filter | `orders.js` (legacy field) |
| `(sellerId, status, createdAt DESC)` | Seller hub order filter | `seller.html` (legacy field) |
| `(sellerUid, createdAt DESC)` | Seller order list | `seller.html` |
| `(buyerUid, createdAt DESC)` | Buyer order history | `orders.html` |
| `(assignedDriverUid, status, createdAt DESC)` | Driver active orders | `driver.html` |

**`payments`** (1)
| Index | Query Served |
|---|---|
| `(uid, status, createdAt DESC)` | User payment history with status filter |

**`commissionLedger`** (3)
| Index | Query Served |
|---|---|
| `(sellerUid, createdAt DESC)` | All commissions for seller |
| `(sellerUid, period DESC, createdAt DESC)` | Commissions by billing period |
| `(sellerUid, status, createdAt DESC)` | Pending/settled commissions filter |

**`invoices`** (1) — `(sellerUid, createdAt DESC)` — seller invoice list

**`settlements`** (1) — `(sellerId, status, createdAt DESC)` — settlement admin filter

**`settlementQueue`** (1) — `(status, createdAt ASC)` — settlement processor queue

**`refunds`** (1) — `(buyerUid, createdAt DESC)` — buyer refund history

**`escrows`** (1) — `(status, createdAt ASC)` — escrow expiry processor

**`paymentLedger`** (1) — `(debitAccount, currency)` — ledger balance query

**`posPayments`** (3)
| Index | Query Served |
|---|---|
| `(sellerUid, createdAt DESC)` | Seller POS payment history |
| `(sellerUid, status, createdAt DESC)` | Seller POS filter by status |
| `(callerUid, createdAt DESC)` | Payment caller history (B2B) |

**`sellerPayments`** (2)
| Index | Query Served |
|---|---|
| `(sellerUid, createdAt DESC)` | Seller payment ledger |
| `(sellerUid, hub, createdAt DESC)` | Seller payments filtered by hub |

**`posTransactions`** (2)
| Index | Query Served |
|---|---|
| `(sellerId, timestamp DESC)` | SmartPOS transaction history |
| `(sellerId, paymentMethod, timestamp DESC)` | SmartPOS by payment method |

---

### Products & Marketplace

**`products`** (5) — *These serve both Firestore ownership queries AND search fallback*
| Index | Query Served | Can migrate to Algolia? |
|---|---|---|
| `(category, price ASC)` | Browse by category+price | YES — Phase 2 removal candidate |
| `(category, createdAt DESC)` | Browse by category+date | YES — Phase 2 removal candidate |
| `(sellerId, createdAt DESC)` | Seller product management | NO — ownership query |
| `(category, rating DESC)` | Browse by category+rating | YES — Phase 2 removal candidate |
| `(category, isFeatured, createdAt DESC)` | Featured product browse | YES — Phase 2 removal candidate |

**`reviews`** (1) — `(productId, rating DESC)` — product review list

**`services`** (1) — `(category, rating DESC)` — service browse (Algolia migration candidate)

**`listings`** (1) — `(hub, status, createdAt DESC)` — hub-specific listing admin view

**`offers`** (1) — `(productId, active)` — active offers for a product

**`featuredListings`** (2)
| Index | Query Served |
|---|---|
| `(sellerUid, createdAt DESC)` | Seller featured listing history |
| `(status, endDate ASC)` | Expiring featured listings (CF cleanup) |

**`sokoAds`** (2)
| Index | Query Served |
|---|---|
| `(sellerUid, createdAt DESC)` | Seller ad history |
| `(status, createdAt DESC)` | Admin: active/pending ads |

---

### Inventory (SmartPOS / Warehouse)

**`inventory_products`** (3) — active+name, active+category+name, active+barcode
**`inventory_levels`** (1) — productId+warehouseId
**`inventory_variants`** (2) — productId+active, productId+createdAt
**`inventory_movements`** (3) — productId+ts, type+ts, warehouseId+ts
**`inventory_purchaseOrders`** (2) — status+createdAt, supplierId+status+createdAt
**`inventory_batches`** (1) — productId+expiryDate (expiry alert CF)
**`inventory_fraud_events`** (2) — status+createdAt, fraudLevel+createdAt
**`inventory_work_orders`** (1) — status+createdAt
**`inventory_transfers`** (2) — status+requestedAt, fromWarehouseId+status+requestedAt
**`inventory_grn`** (2) — purchaseOrderId+createdAt, status+createdAt
**`inventory_stockcounts`** (2) — warehouseId+status, status+createdAt
**`inventory_requisitions`** (1) — status+createdAt
**`inventory_shelf_scans`** (1) — status+createdAt
**`lines`** (COLLECTION_GROUP) (1) — countId+productId (stockcount line items)

---

### Delivery & Logistics

**`packageRequests`** (3) — uid+createdAt, sellerUid+createdAt, assignedDriverId+createdAt

**`deliveries`** (4)
| Index | Query Served |
|---|---|
| `(senderUid, createdAt DESC)` | Sender delivery history |
| `(assignedRiderId, status, createdAt DESC)` | Rider active deliveries |
| `(assignedRiderId, createdAt DESC)` | Rider all deliveries |
| `(status, createdAt DESC)` | Admin delivery monitor |

**`deliveryRiders`** (1) — `(isOnline, isAvailable, updatedAt DESC)` — available rider lookup

**`deliveryLocations`** (1) — `(riderId, updatedAt DESC)` — rider location history

**`deliveryProofs`** (1) — `(deliveryId, createdAt DESC)` — delivery proof by delivery

---

### Rides

**`rideRequests`** (3)
| Index | Query Served |
|---|---|
| `(uid, createdAt DESC)` | User ride history |
| `(driverId, status, createdAt DESC)` | Driver rides (legacy field) |
| `(assignedDriverId, status, createdAt DESC)` | Driver rides (current field) |

**`rideDrivers`** (1) — `(isOnline, updatedAt DESC)` — online driver list

**`rides`** (1) — `(status, createdAt DESC)` — admin ride monitor

**`driverLocations`** (2)
| Index | Query Served |
|---|---|
| `(driverId, updatedAt DESC)` | Driver location history |
| `(online, available)` | WAP driver assignment query |

**`driverRatings`** (1) — `(driverId, createdAt DESC)` — driver rating list

---

### GIP (Geo Intelligence Platform)

**`gipLocations`** (2) — region+isOnline, region+status+isOnline
**`gipAssets`** (3) — uid+isOnline, region+module+status, region+module+isOnline
**`gipDispatch`** (4) — status+createdAt, region+status+createdAt, assignedAssetId+status+deliveredAt, module+status+createdAt
**`gipAlerts`** (2) — resolved+createdAt, assetId+resolved+createdAt
**`gipRoutes`** (1) — module+createdAt
**`drivers`** (COLLECTION_GROUP, 1) — assetId+computedAt

---

### WAP (Workflow Automation Platform)

**`workflowInstances`** (4)
| Index | Query Served | CF/Page |
|---|---|---|
| `(definitionId, metadata.startedAt DESC)` | WAP admin: instances by workflow | `wap.html` |
| `(status, metadata.startedAt DESC)` | WAP admin: filter by status | `wap.html` |
| `(status, metadata.completedAt DESC)` | ECC: completed workflow monitor | `ecc.html` |
| `(definitionId, status, metadata.startedAt DESC)` | WAP admin: compound filter | `wap.html` |

**`workflowApprovals`** (2)
| Index | Query Served | CF/Page |
|---|---|---|
| `(status, requestedAt DESC)` | Pending approval list | `wap.html` |
| `(status, deadline ASC)` | Overdue escalation | `functions/wap.js:wapEscalateApprovals` |

**`workflowSchedule`** (2)
| Index | Query Served | CF |
|---|---|---|
| `(status, executeAt ASC)` | Due schedule items | `functions/wap.js:wapAdvanceSchedule` |
| `(status, createdAt ASC)` | Stale processing items | `functions/wap.js:wapWatchdog` |

**`workflowDLQ`** (1)
| Index | Query Served | CF/Page |
|---|---|---|
| `(resolvedAt, failedAt DESC)` | Unresolved DLQ items | `functions/wap.js:wapGetDLQ` / `wap.html` |

---

### ECC (Enterprise Control Center)

**`eccAuditLog`** (2)
| Index | Query Served |
|---|---|
| `(actorUid, ts DESC)` | Audit log filtered by user |
| `(action, ts DESC)` | Audit log filtered by action type |

**`eccIncidents`** (1) — `(status, createdAt DESC)` — incident list by status

---

### Platform Registry & Events

**`platformEvents`** (3)
| Index | Query Served |
|---|---|
| `(publisherUid, publishedAt DESC)` | Events by publishing service |
| `(type, publishedAt DESC)` | Events by event type |
| `(domain, publishedAt DESC)` | Events by domain (auth, commerce, logistics…) |

**`platformServices`** (2)
| Index | Query Served |
|---|---|
| `(type, updatedAt DESC)` | Platform registry by service type |
| `(status, updatedAt DESC)` | Unhealthy/degraded service filter |

---

### AI & Subscriptions

**`aiSubscriptions`** (2) — status+activatedAt, uid+status+activatedAt
**`aiUsage`** (1) — uid+period
**`aiCreditLedger`** (1) — uid+ts
**`aiBoosts`** (1) — uid+expiresAt
**`aiPromotions`** (1) — active+expiresAt

**`subscriptions`** (1) — `(status, expiresAt ASC)` — expiry processor
**`sellerSubscriptions`** (1) — `(plan, updatedAt DESC)` — subscription plan management

**`entitlements`** (2) — riskScore+updatedAt, needsRefresh+updatedAt
**`subscriptionBrain`** (2) — retentionTier+churnRisk, upgradeProb+updatedAt

---

### Search Engine Queues

**`algoliaQueue`** (2)
| Index | Query Served |
|---|---|
| `(status, nextAttemptAt ASC)` | Ready items to sync |
| `(status, updatedAt ASC)` | Stuck processing detection |

**`typesenseQueue`** (3)
| Index | Query Served |
|---|---|
| `(status, nextAttemptAt ASC)` | Ready items to sync |
| `(status, updatedAt ASC)` | Stuck detection |
| `(collection, status, nextAttemptAt ASC)` | Per-collection sync progress |

---

### Email System

**`emailLogs`** (3) — status+sentAt, category+sentAt, template+sentAt
**`emailQueue`** (1) — `(status, nextAttempt ASC)` — email retry queue

---

### Finance & Wallet

**`walletTxns`** (1) — `(uid, type, ts DESC)` — wallet transaction filter
**`withdrawals`** (1) — `(uid, status, createdAt DESC)` — withdrawal history
**`voucherRedemptions`** (1) — `(uid, redeemedAt DESC)` — user voucher history
**`vouchers`** (1) — `(active, expiresAt ASC)` — expiring voucher cleanup
**`bookingFees`** (1) — `(uid, createdAt DESC)` — user booking fee history

---

### Users & Verification

**`users`** (1) — `(role, createdAt DESC)` — admin user list by role
**`verificationRequests`** (1) — `(status, createdAt DESC)` — admin verification queue
**`flags`** (1) — `(status, createdAt DESC)` — content moderation queue
**`applications`** (1) — `(status, createdAt DESC)` — job/driver application queue

---

### Community & Entertainment

**`conversations`** (1) — `(participants ARRAY, lastAt DESC)` — user inbox
**`communityPosts`** (2) — type+timestamp, status+timestamp
**`communityGroups`** (1) — `(status, memberCount DESC)` — popular group list
**`communityEvents`** (1) — `(status, eventDate ASC)` — upcoming events

**`entArtists`** (2) — type+city+createdAt, uid+createdAt
**`entEvents`** (2) — status+date, uid+date
**`entTickets`** (2) — uid+createdAt, eventId+status
**`entVenues`** (2) — status+city, type+status
**`entArtistBookings`** (1) — artistUid+createdAt
**`entReviews`** (1) — `(targetId, approved, createdAt DESC)` — approved reviews for target

---

### Hubs: Jobs, Legal, Services

**`jobs`** (3) — active+postedAt, active+featured+postedAt, active+category+postedAt
**`jobApplications`** (1) — jobId+appliedAt
**`education`** (1) — active+featured+createdAt
**`legalAppointments`** (1) — uid+status+date
**`legalServiceRequests`** (1) — uid+status+createdAt
**`legalReviews`** (1) — lawyerId+createdAt
**`homeServiceBookings`** (1) — uid+createdAt
**`homeServiceReviews`** (1) — providerId+createdAt
**`providers`** (1) — status+updatedAt
**`bookings`** (1) — providerId+createdAt

---

### Platform Monitoring

**`adminAlerts`** (1) — `(resolved, createdAt DESC)` — unresolved admin alerts
**`disputes`** (1) — `(status, createdAt DESC)` — dispute queue
**`auditLogs`** (3) — uid+ts, action+ts, sellerUid+createdAt
**`intelligenceLog`** (2) — module+ts, decisionType+ts
**`featureFlags`** (1) — enabled+updatedAt
**`notificationQueue`** (1) — `(channel, createdAt ASC)` — notification dispatch queue
**`notifications`** (1) — `(targetUid, createdAt DESC)` — user notification feed
**`referrals`** (1) — `(referrerUid, createdAt DESC)` — referral history
**`trending`** (1) — `(hub, updatedAt DESC)` — trending items by hub
**`monthly`** (COLLECTION_GROUP, 1) — status+lastUpdated
**`mediaAssets`** (3) — uid+createdAt, uid+dest+createdAt, uid+tier+createdAt

---

## Deployment Strategy

### Safe Deploy Protocol (Never Exceed 200)

```
Phase 1 (Current): 182 indexes
 └─ Deploy with --force flag
 └─ Firebase CLI deletes old indexes before creating new ones
 └─ Net change: +20 from baseline
 └─ Max in-flight during deploy: ~190 (safe)

Phase 2 (Future — when Algolia/Typesense confirmed live):
 └─ Remove 4 product search indexes: category+price, category+rating, 
    category+createdAt, category+isFeatured (all → Algolia)
 └─ Remove 1 services index: category+rating (→ Algolia)
 └─ Net: 182 → 177 indexes, freeing 23 slots
```

### Emergency Headroom Rule
If count reaches **190**: stop all non-critical deploys, remove phase 2 candidates before adding anything new.

---

## Search Engine Separation

| Query Type | Owner | Rationale |
|---|---|---|
| "Show products in Electronics under KES 2000" | **Algolia** | Text + multi-filter = search engine |
| "Show seller Jane's products" | **Firestore** | Ownership query (uid-scoped) |
| "Find nearby restaurants by rating" | **Typesense** | Geo + text + sort |
| "Show buyer John's last 10 orders" | **Firestore** | Transactional ownership |
| "Search jobs in Nairobi with 'React'" | **Algolia** | Full-text + filter |
| "Show seller Jane's commission ledger" | **Firestore** | Financial audit ownership |

**Phase 2 Algolia migration candidates** (currently on Firestore fallback):
- `products` (category+price), (category+rating), (category+createdAt), (category+isFeatured) — 4 indexes
- `services` (category+rating) — 1 index
- `jobs` (active+featured+postedAt), (active+category+postedAt) — 2 indexes (keep `active+postedAt` for admin)

---

## Query Optimization Recommendations

### 1. Orders field name normalization
**Problem**: Orders collection has two naming conventions in use (`sellerId` / `sellerUid`, `userId` / `buyerUid`).
**Recommendation**: Standardize all new order writes to `sellerUid` and `buyerUid`. Keep both index variants during migration.
**Impact**: Can remove 2 legacy indexes once backfill complete.

### 2. Products category indexes → Algolia
**Problem**: 4 Firestore indexes serve pure browse/filter queries better handled by Algolia.
**Recommendation**: Wire product category listing to `SokoniSearch.search()` in `sokoni-search-pro.js`. 
**Impact**: Frees 4 index slots immediately.

### 3. Trending query
**Current**: `gipDispatch` has status+createdAt (new) but `trending` has hub+updatedAt.
**Actual query in CF**: `where("type", "==", type).orderBy("rank", "asc")` — needs `(type, rank ASC)`.
**Recommendation**: Add `(type, rank ASC)` to trending collection; confirm hub+updatedAt usage.

### 4. GipDispatch in/array queries
**Pattern**: `where("status", "in", [...])` with `orderBy("createdAt")` uses the new `(status, createdAt DESC)` index.
Firestore correctly uses equality-index fields for `in` operators.

---

## Data Model Recommendations

### 1. Order summary denormalization
Current: Multiple indexes needed for `(uid, sellerUid, buyerUid, assignedDriverUid)` × `(status, createdAt)` combinations.
Recommendation: Add `orderSummary` collection with pre-aggregated counts per user per status. Reduces paginated list queries.

### 2. Wallet transaction aggregation
Current: `walletTxns` queried for balance calculation on every page load.
Recommendation: Maintain `wallets/{uid}.balance` as a denormalized field updated via Cloud Function on every transaction write.

### 3. Commission period summaries
Current: `commissionLedger` queried with period filter for reporting.
Recommendation: Pre-aggregate `commissionSummary/{sellerId}_{period}` document, updated via CF trigger. Eliminates the `(sellerUid, period, createdAt)` index.

---

## Future Capacity Estimate

| Category | Current | Projected (12 months) | Notes |
|---|---|---|---|
| Core commerce | 20 | 25 | New hubs (BnB, property vehicle) |
| Inventory | 18 | 20 | Stable |
| GIP + Logistics | 14 | 16 | Multi-city expansion |
| WAP + ECC | 12 | 18 | New workflow types |
| AI + Subscriptions | 10 | 14 | More tier indexes |
| New hubs (BnB, property) | 0 | 12 | ~6 indexes each |
| Search queues | 5 | 6 | Stable |
| **Total projected** | **182** | **~195** | ~5 slots remaining |

**Action required before 12-month mark**: Execute Phase 2 removals (Algolia migration) to recover 7 slots before new hub launches. Target: 188 max.

---

## Index Health Monitoring

Integrate with ECC dashboard (`ecc.html`) via `eccAuditLog` queries. 

**Manual health check procedure:**
```bash
# Count current indexes in production
firebase firestore:indexes --project sokoni-aeb26 | grep "READY\|CREATING\|DELETING" | wc -l

# Deploy updated index file
firebase deploy --only firestore:indexes --project sokoni-aeb26

# Verify count after deploy
firebase firestore:indexes --project sokoni-aeb26 | grep READY | wc -l
```

**Automated trigger**: If `eccAuditLog` records `action: "firestore_index_limit_warning"`, immediately run Phase 2 Algolia migration.

---

## Related Documents
- [[TYPESENSE-ARCHITECTURE]] — Typesense collection schema and sync strategy
- [[SECURITY]] — Firestore security rules
- [[API]] — Cloud Functions API reference for WAP/ECC
