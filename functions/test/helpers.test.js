/**
 * Unit tests — HMAC, reference generator, and tax constants
 * These test pure helper functions that require no Firebase connection.
 */

"use strict";

const crypto = require("crypto");

/* ── Inline the helpers under test (avoids importing the full index.js
   which would try to initialise Firebase Admin SDK) ── */

function _verifyHmac(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature).slice(0, expected.length).padEnd(expected.length));
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

function _genRef(prefix) {
  return (prefix || "REF") + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

const _TAX = { VAT: 0.16, WHT: 0.05, DST: 0.015, WHT_THRESHOLD: 24000 };
const _PLATFORM_FEE = 0.10;

/* ─────────────────────────────────────────────────────────────
   HMAC Verification
───────────────────────────────────────────────────────────── */
describe("_verifyHmac", () => {
  const SECRET = "test-secret-key";
  const BODY   = JSON.stringify({ invoice_id: "INV-001", state: "COMPLETE" });

  function makeSignature(body, secret) {
    return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("accepts a valid HMAC signature", () => {
    const sig = makeSignature(BODY, SECRET);
    expect(_verifyHmac(BODY, sig, SECRET)).toBe(true);
  });

  test("rejects a tampered signature", () => {
    const sig = makeSignature(BODY, SECRET).slice(0, -4) + "aaaa";
    expect(_verifyHmac(BODY, sig, SECRET)).toBe(false);
  });

  test("rejects a wrong secret", () => {
    const sig = makeSignature(BODY, "wrong-secret");
    expect(_verifyHmac(BODY, sig, SECRET)).toBe(false);
  });

  test("rejects empty signature", () => {
    expect(_verifyHmac(BODY, "", SECRET)).toBe(false);
    expect(_verifyHmac(BODY, null, SECRET)).toBe(false);
  });

  test("rejects empty secret", () => {
    const sig = makeSignature(BODY, SECRET);
    expect(_verifyHmac(BODY, sig, "")).toBe(false);
    expect(_verifyHmac(BODY, sig, null)).toBe(false);
  });

  test("is constant-time (does not throw on length-mismatched inputs)", () => {
    expect(() => _verifyHmac(BODY, "short", SECRET)).not.toThrow();
    expect(() => _verifyHmac(BODY, "x".repeat(500), SECRET)).not.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   Reference Generator
───────────────────────────────────────────────────────────── */
describe("_genRef", () => {
  test("uses the provided prefix", () => {
    const ref = _genRef("ESC");
    expect(ref.startsWith("ESC-")).toBe(true);
  });

  test("falls back to REF when no prefix given", () => {
    const ref = _genRef();
    expect(ref.startsWith("REF-")).toBe(true);
  });

  test("produces unique references", () => {
    const refs = new Set(Array.from({ length: 100 }, () => _genRef("TST")));
    expect(refs.size).toBe(100);
  });

  test("contains a timestamp component (numeric segment after prefix)", () => {
    const ref = _genRef("PAY");
    const parts = ref.split("-");
    expect(parts.length).toBe(3);
    expect(Number(parts[1])).toBeGreaterThan(1700000000000); // > Nov 2023
  });

  test("hex suffix is uppercase and 8 chars", () => {
    const ref = _genRef("X");
    const hex = ref.split("-")[2];
    expect(hex).toMatch(/^[A-F0-9]{8}$/);
  });
});

/* ─────────────────────────────────────────────────────────────
   Tax Constants
───────────────────────────────────────────────────────────── */
describe("Kenyan Tax Constants", () => {
  test("VAT is 16%", () => {
    expect(_TAX.VAT).toBe(0.16);
  });

  test("WHT is 5%", () => {
    expect(_TAX.WHT).toBe(0.05);
  });

  test("DST is 1.5%", () => {
    expect(_TAX.DST).toBe(0.015);
  });

  test("WHT_THRESHOLD is KES 24,000", () => {
    expect(_TAX.WHT_THRESHOLD).toBe(24000);
  });

  test("Platform fee is 10%", () => {
    expect(_PLATFORM_FEE).toBe(0.10);
  });
});

/* ─────────────────────────────────────────────────────────────
   Commission & WHT Calculation Logic
───────────────────────────────────────────────────────────── */
describe("Commission and WHT calculation", () => {
  function calculateRelease(gross) {
    const commission = Math.round(gross * _PLATFORM_FEE * 100) / 100;
    const preWht     = gross - commission;
    const wht        = preWht > _TAX.WHT_THRESHOLD
      ? Math.round(preWht * _TAX.WHT * 100) / 100
      : 0;
    const sellerNet  = Math.round((preWht - wht) * 100) / 100;
    return { commission, wht, sellerNet };
  }

  test("KES 5,000 order: 10% commission, no WHT", () => {
    const { commission, wht, sellerNet } = calculateRelease(5000);
    expect(commission).toBe(500);
    expect(wht).toBe(0);          // 4,500 < 24,000 threshold
    expect(sellerNet).toBe(4500);
  });

  test("KES 30,000 order: 10% commission, 5% WHT on net", () => {
    const { commission, wht, sellerNet } = calculateRelease(30000);
    expect(commission).toBe(3000);
    expect(wht).toBe(1350);       // 27,000 * 5%
    expect(sellerNet).toBe(25650);
  });

  test("Gross always equals commission + wht + sellerNet", () => {
    [1000, 5000, 25000, 50000, 200000].forEach(gross => {
      const { commission, wht, sellerNet } = calculateRelease(gross);
      expect(commission + wht + sellerNet).toBeCloseTo(gross, 1);
    });
  });

  test("Seller always receives positive amount", () => {
    [100, 500, 5000].forEach(gross => {
      const { sellerNet } = calculateRelease(gross);
      expect(sellerNet).toBeGreaterThan(0);
    });
  });
});
