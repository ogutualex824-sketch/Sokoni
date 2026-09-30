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
/* _PLATFORM_FEE is gone. Escrow release does not charge commission: finos-router already
   charged it, through the Commission Engine, at payment time. */

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

  test("no hardcoded platform fee survives in the tax constants", () => {
    expect(typeof _TAX.VAT).toBe("number");
    expect(_TAX).not.toHaveProperty("PLATFORM_FEE");
  });
});

/* ─────────────────────────────────────────────────────────────
   Commission & WHT Calculation Logic
───────────────────────────────────────────────────────────── */
describe("Escrow release does not charge commission twice", () => {
  /* The old test asserted a 10% commission ON RELEASE. That was the defect, written down as a
     requirement. Escrows are created by finos-router routePayment, which runs the Commission
     Engine and credits the platform its commission AT PAYMENT TIME; the escrow then holds only
     sellerNetCents. Charging again on release bills the seller twice for one sale. */

  /* The migrated logic, in the shape index.js releaseEscrow now uses. */
  function release(escrow) {
    const isEngineEscrow = Number.isFinite(escrow.grossCents);
    if (isEngineEscrow) {
      return {
        gross: escrow.grossCents / 100,
        commissionAlreadyCharged: (escrow.commissionCents || 0) / 100,
        commission: 0,                                   /* nothing more is owed */
        sellerNet: escrow.sellerNetCents / 100,
      };
    }
    if (!Number.isFinite(Number(escrow.amount))) {
      throw new Error("no usable amount — refusing to release");
    }
    return null; /* legacy path is priced by the engine; covered in the engine's own suite */
  }

  test("an engine escrow is released without charging commission again", () => {
    const r = release({ grossCents: 1000000, commissionCents: 30000, sellerNetCents: 970000 });
    expect(r.commission).toBe(0);
    expect(r.commissionAlreadyCharged).toBe(300);
    expect(r.sellerNet).toBe(9700);
  });

  test("the seller receives exactly what the engine computed", () => {
    [[500000, 15000, 485000], [1000000, 30000, 970000], [2500000, 75000, 2425000]]
      .forEach(([gross, comm, net]) => {
        const r = release({ grossCents: gross, commissionCents: comm, sellerNetCents: net });
        expect(r.sellerNet).toBeCloseTo(net / 100, 2);
        expect(r.commissionAlreadyCharged + r.sellerNet).toBeCloseTo(gross / 100, 2);
      });
  });

  test("an unpriceable escrow FAILS CLOSED rather than writing NaN", () => {
    /* The old code read escrow.amount, which finos-router never writes. On a real escrow that is
       undefined, and Math.round(undefined * 0.10) is NaN — which went into sellerNet, the ledger
       and a wallet. */
    expect(Math.round(undefined * 0.10 * 100) / 100).toBeNaN();      /* the old behaviour */
    expect(() => release({ sellerId: "s1" })).toThrow(/refusing to release/);
  });
});
