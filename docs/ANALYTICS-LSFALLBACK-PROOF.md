# `_lsFallback` Escalation — before-proof

> **Base: `54fed88`.** Read-only. **No product code changed.**
> Scope: `business-analytics.html`, `seller-analytics.html`
> Verdict: **client authority hygiene, not a data-exposure vulnerability.**

Related: [[Role Contract Triage]] · [[Access Control Matrix]] · [[Users Document Integrity]]

---

## The reachability path, read in full

```js
function _verifySellerAccess(onGranted){
  if (localStorage.getItem('loggedIn') !== 'true') { location.replace('login.html'); return; }
  ...
  window.firebaseAuth.onAuthStateChanged(function(user){
    if (!user) { _deny(); return; }          // ← a REAL session is required
    _checkRole(user);
  });

  function _checkRole(user){
    if (!window.firebaseDB) { _lsFallback(); return; }
    getDoc(doc(db,'users',user.uid))
      .then(snap => { … _isSellerDoc(d) ? onGranted(user) : (claims.admin ? onGranted : _deny) })
      .catch(_lsFallback);                    // ← the fallback
  }
}
```

So the fallback is **not** anonymously reachable. It needs:

1. a genuine signed-in Firebase user, **and**
2. the `users/{uid}` read to fail — network, App Check, or a deliberately blocked request —
   or `window.firebaseDB` to be absent, **and**
3. a forged `localStorage.userRole` / `sokoniUser`.

A signed-in buyer can satisfy all three: they own the client, so they can block their own
Firestore request and set their own localStorage. **The grant is forgeable.** The only
question left is what it grants.

---

## What `onGranted` actually exposes

### `business-analytics.html` — nothing

```
onGranted(user) → initCharts(user)
  renderHealthMetrics    0 reads
  drawRevenueChart       0 reads
  renderCACKPIs          0 reads
  renderTopProducts      0 reads
  renderStaffTable       0 reads
  loadSubStatusFromFirestore(uid) → getDoc(planSubscriptions/{uid})   the caller's OWN doc
```

Measured: **zero** `getDocs`, `onSnapshot` or `httpsCallable` in the entire file. The only two
reads are `users/{uid}` (the gate itself) and `planSubscriptions/{uid}` — both the caller's own
documents, which they may read anyway.

**Forging the fallback yields a chart shell containing no privileged data.**

### `seller-analytics.html` — scoped by query construction

```js
var q = query(collection(db,'orders'),
              where('sellerUid','==',uid),      // ← the CALLER's own uid
              orderBy('createdAt','desc'), limit(500));
```

The query asks only for orders where **the caller is the seller**. A buyer who forges the
fallback runs that same query with their own uid and matches nothing, because they are not
the `sellerUid` on any order.

This holds **independently of Firestore rules** — it is a property of the query, not of the
gate. Rules are a second boundary on top: the served ruleset permits an orders read only when
`buyerId` or `sellerUid` equals the caller, or the caller is an admin.

---

## Verdict

**Client authority hygiene defect, not a security vulnerability.**

A signed-in non-seller can force the analytics *view* open. They obtain:

- rendered chart furniture with no backing data (`business-analytics`)
- an empty result set (`seller-analytics`)

No cross-tenant data is reachable through this path. The severity claim the escalation was
opened to test does not survive measurement.

### The defect that IS real here

`business-analytics.html` renders health metrics, revenue, CAC KPIs, top products and a staff
table from **no canonical source at all** — zero reads. Under the standing no-fabricated-metrics
rule that is a defect in its own right, and a more consequential one than the fallback: a
legitimate seller is shown figures that came from nowhere. **Logged separately; not fixed here.**

---

## An artifact discrepancy, flagged not explained away

`firestore.rules.served-current` in this worktree is **257,162 bytes**. The CHANGELOG records
the Release 2 publish and post-publish re-fetch as **252,074 bytes, byte-identical to the
candidate**. Checked: the difference is **not** line endings — the file contains zero `0x0D`
bytes.

So this local snapshot is **not** a reliable record of what is served, and any rule claim resting
on it should be re-verified against a live fetch. The Release 2 `activeRole` scoping *is* present
in the snapshot, which is reassuring but not authoritative.

This does not affect the verdict above, which rests on query construction and read counts in the
page source rather than on the ruleset.

**Open item:** re-fetch the live ruleset and reconcile the artifact.

---

## Disposition

| item | disposition |
|---|---|
| `_lsFallback` forgeable grant | **FIX** — canonicalise the source; low severity, no exposure |
| exposure via the forged grant | **NOT A VULNERABILITY** — proven by read count and query scope |
| `business-analytics` metrics from no source | **ESCALATE separately** — no-fabricated-metrics |
| `firestore.rules.served-current` mismatch | **OPEN** — re-fetch and reconcile |

The fallback fix is now safe to make small: replace the localStorage branch with the authority,
and on failure `_deny()` rather than guess. It is not urgent, because it grants nothing.
