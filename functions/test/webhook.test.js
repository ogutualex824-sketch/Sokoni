/**
 * Unit tests — Webhook parsing logic for IntaSend and M-Pesa
 * Tests payload parsing and status extraction without Firebase dependency.
 */

"use strict";

/* ── Inline the payload parsers from the Cloud Functions ── */

function parseIntasendPayload(body) {
  const inv = body && body.invoice;
  if (!inv) return null;
  return {
    invoiceId: inv.invoice_id || body.id || null,
    status:    (inv.state || body.state || "").toUpperCase() === "COMPLETE" ? "COMPLETE" : "FAILED",
    amount:    parseFloat(inv.value || 0),
    currency:  (inv.currency || "KES").toUpperCase(),
    phone:     inv.recipient_phone || "",
  };
}

function parseMpesaPayload(body) {
  const cb    = (body && body.Body && body.Body.stkCallback) || body || {};
  const code  = cb.ResultCode != null ? cb.ResultCode : 1;
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const get   = (n) => { const i = items.find((x) => x.Name === n); return i && i.Value; };
  return {
    status:     code === 0 ? "COMPLETE" : "FAILED",
    amount:     get("Amount"),
    phone:      String(get("PhoneNumber") || ""),
    mpesaCode:  get("MpesaReceiptNumber"),
    reference:  cb.CheckoutRequestID || (body && body.TransID) || "",
    resultDesc: cb.ResultDesc || "",
  };
}

/* ─────────────────────────────────────────────────────────────
   IntaSend payload parsing
───────────────────────────────────────────────────────────── */
describe("IntaSend payload parser", () => {
  const successPayload = {
    invoice: {
      invoice_id: "INV-123456",
      recipient_phone: "+254712345678",
      state: "COMPLETE",
      value: "1500.00",
      currency: "KES",
    },
    id: "EVT-001",
    state: "COMPLETE",
  };

  const failedPayload = {
    invoice: { invoice_id: "INV-123457", state: "FAILED" },
    state: "FAILED",
  };

  test("extracts invoice_id from successful payload", () => {
    const p = parseIntasendPayload(successPayload);
    expect(p.invoiceId).toBe("INV-123456");
  });

  test("sets status COMPLETE on successful payment", () => {
    const p = parseIntasendPayload(successPayload);
    expect(p.status).toBe("COMPLETE");
  });

  test("sets status FAILED on failed payment", () => {
    const p = parseIntasendPayload(failedPayload);
    expect(p.status).toBe("FAILED");
  });

  test("extracts amount as number", () => {
    const p = parseIntasendPayload(successPayload);
    expect(p.amount).toBe(1500);
  });

  test("extracts currency as uppercase", () => {
    const p = parseIntasendPayload(successPayload);
    expect(p.currency).toBe("KES");
  });

  test("extracts recipient phone", () => {
    const p = parseIntasendPayload(successPayload);
    expect(p.phone).toBe("+254712345678");
  });

  test("returns null for malformed body", () => {
    expect(parseIntasendPayload(null)).toBeNull();
    expect(parseIntasendPayload({})).toBeNull();
    expect(parseIntasendPayload({ state: "COMPLETE" })).toBeNull();
  });

  test("case-insensitive status matching", () => {
    const lower = { invoice: { invoice_id: "X", state: "complete" }, state: "complete" };
    expect(parseIntasendPayload(lower).status).toBe("COMPLETE");
  });
});

/* ─────────────────────────────────────────────────────────────
   M-Pesa (Daraja STK) payload parsing
───────────────────────────────────────────────────────────── */
describe("M-Pesa Daraja payload parser", () => {
  const successPayload = {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount",             Value: 1500 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate",    Value: 20191219102115 },
            { Name: "PhoneNumber",        Value: 254712345678 },
          ],
        },
      },
    },
  };

  const cancelledPayload = {
    Body: {
      stkCallback: {
        ResultCode: 1032,
        ResultDesc: "Request cancelled by user.",
        CheckoutRequestID: "ws_CO_191220191020363926",
      },
    },
  };

  test("sets status COMPLETE when ResultCode is 0", () => {
    expect(parseMpesaPayload(successPayload).status).toBe("COMPLETE");
  });

  test("sets status FAILED when ResultCode is non-zero", () => {
    expect(parseMpesaPayload(cancelledPayload).status).toBe("FAILED");
  });

  test("extracts Amount from CallbackMetadata", () => {
    expect(parseMpesaPayload(successPayload).amount).toBe(1500);
  });

  test("extracts MpesaReceiptNumber", () => {
    expect(parseMpesaPayload(successPayload).mpesaCode).toBe("NLJ7RT61SV");
  });

  test("extracts PhoneNumber as string", () => {
    expect(parseMpesaPayload(successPayload).phone).toBe("254712345678");
  });

  test("extracts CheckoutRequestID as reference", () => {
    expect(parseMpesaPayload(successPayload).reference).toBe("ws_CO_191220191020363925");
  });

  test("extracts ResultDesc on failure", () => {
    expect(parseMpesaPayload(cancelledPayload).resultDesc).toBe("Request cancelled by user.");
  });

  test("handles missing CallbackMetadata gracefully", () => {
    const p = parseMpesaPayload(cancelledPayload);
    expect(p.amount).toBeUndefined();
    expect(p.mpesaCode).toBeUndefined();
  });

  test("handles empty body gracefully", () => {
    const p = parseMpesaPayload({});
    expect(p.status).toBe("FAILED"); // no ResultCode → defaults to failed
    expect(p.reference).toBe("");
  });
});

/* ─────────────────────────────────────────────────────────────
   Idempotency key construction
───────────────────────────────────────────────────────────── */
describe("Webhook idempotency key construction", () => {
  function makeIdempotencyKey(provider, eventId) {
    return `${provider}::${eventId}`;
  }

  test("combines provider and eventId with ::", () => {
    expect(makeIdempotencyKey("intasend", "INV-001")).toBe("intasend::INV-001");
  });

  test("produces different keys for different providers", () => {
    const k1 = makeIdempotencyKey("intasend", "INV-001");
    const k2 = makeIdempotencyKey("mpesa", "INV-001");
    expect(k1).not.toBe(k2);
  });

  test("produces different keys for different events", () => {
    const k1 = makeIdempotencyKey("mpesa", "ws_CO_001");
    const k2 = makeIdempotencyKey("mpesa", "ws_CO_002");
    expect(k1).not.toBe(k2);
  });
});
