/**
 * Unit tests — Fraud risk scoring logic
 * Tests the scoring algorithm in isolation (no Firebase dependency).
 */

"use strict";

/* ── Inline the fraud scoring logic from evaluateFraudRisk ── */

const SIGNALS = {
  BLOCKED_UID:       { score: 100, label: "blocked_uid" },
  VELOCITY_HIGH:     { score: 40,  label: "velocity_high" },
  VELOCITY_MEDIUM:   { score: 20,  label: "velocity_medium" },
  AMOUNT_LARGE:      { score: 15,  label: "amount_large" },
};

function scoreFromSignals(activeSignals) {
  return activeSignals.reduce((total, s) => total + s.score, 0);
}

function decisionFromScore(score) {
  if (score >= 61) return "block";
  if (score >= 31) return "review";
  return "allow";
}

/* ─────────────────────────────────────────────────────────────
   Signal scoring
───────────────────────────────────────────────────────────── */
describe("Fraud risk scoring", () => {
  test("no signals → score 0, decision allow", () => {
    const score = scoreFromSignals([]);
    expect(score).toBe(0);
    expect(decisionFromScore(score)).toBe("allow");
  });

  test("blocked_uid alone → score 100, decision block", () => {
    const score = scoreFromSignals([SIGNALS.BLOCKED_UID]);
    expect(score).toBe(100);
    expect(decisionFromScore(score)).toBe("block");
  });

  test("velocity_high alone → score 40, decision review", () => {
    const score = scoreFromSignals([SIGNALS.VELOCITY_HIGH]);
    expect(score).toBe(40);
    expect(decisionFromScore(score)).toBe("review");
  });

  test("velocity_medium alone → score 20, decision allow", () => {
    const score = scoreFromSignals([SIGNALS.VELOCITY_MEDIUM]);
    expect(score).toBe(20);
    expect(decisionFromScore(score)).toBe("allow");
  });

  test("amount_large alone → score 15, decision allow", () => {
    const score = scoreFromSignals([SIGNALS.AMOUNT_LARGE]);
    expect(score).toBe(15);
    expect(decisionFromScore(score)).toBe("allow");
  });

  test("velocity_high + amount_large → score 55, decision review", () => {
    const score = scoreFromSignals([SIGNALS.VELOCITY_HIGH, SIGNALS.AMOUNT_LARGE]);
    expect(score).toBe(55);
    expect(decisionFromScore(score)).toBe("review");
  });

  test("velocity_high + velocity_medium → score 60, decision review (boundary)", () => {
    const score = scoreFromSignals([SIGNALS.VELOCITY_HIGH, SIGNALS.VELOCITY_MEDIUM]);
    expect(score).toBe(60);
    expect(decisionFromScore(score)).toBe("review");
  });

  test("velocity_high + velocity_medium + amount_large → score 75, decision block", () => {
    const score = scoreFromSignals([SIGNALS.VELOCITY_HIGH, SIGNALS.VELOCITY_MEDIUM, SIGNALS.AMOUNT_LARGE]);
    expect(score).toBe(75);
    expect(decisionFromScore(score)).toBe("block");
  });
});

/* ─────────────────────────────────────────────────────────────
   Decision threshold boundaries
───────────────────────────────────────────────────────────── */
describe("Decision thresholds", () => {
  const cases = [
    [0,   "allow"],
    [30,  "allow"],
    [31,  "review"],
    [60,  "review"],
    [61,  "block"],
    [100, "block"],
  ];

  test.each(cases)("score %i → %s", (score, expected) => {
    expect(decisionFromScore(score)).toBe(expected);
  });
});

/* ─────────────────────────────────────────────────────────────
   Input validation for evaluateFraudRisk
───────────────────────────────────────────────────────────── */
describe("Input validation", () => {
  function validateFraudInput(data) {
    if (!data || typeof data !== "object") return { valid: false, error: "invalid_input" };
    if (data.amount !== undefined && (typeof data.amount !== "number" || data.amount < 0)) {
      return { valid: false, error: "invalid_amount" };
    }
    if (data.phone !== undefined && !/^2547\d{8}$/.test(String(data.phone))) {
      return { valid: false, error: "invalid_phone" };
    }
    return { valid: true };
  }

  test("accepts valid input with amount and phone", () => {
    expect(validateFraudInput({ amount: 5000, phone: "254712345678" }).valid).toBe(true);
  });

  test("accepts input with no amount or phone (all optional)", () => {
    expect(validateFraudInput({}).valid).toBe(true);
  });

  test("rejects negative amount", () => {
    expect(validateFraudInput({ amount: -1 }).valid).toBe(false);
  });

  test("rejects non-numeric amount", () => {
    expect(validateFraudInput({ amount: "5000" }).valid).toBe(false);
  });

  test("rejects phone not starting with 2547", () => {
    expect(validateFraudInput({ phone: "0712345678" }).valid).toBe(false);
    expect(validateFraudInput({ phone: "254612345678" }).valid).toBe(false);
  });

  test("accepts valid Kenyan phone (2547XXXXXXXX)", () => {
    expect(validateFraudInput({ phone: "254712345678" }).valid).toBe(true);
    expect(validateFraudInput({ phone: "254799999999" }).valid).toBe(true);
  });

  test("rejects null input", () => {
    expect(validateFraudInput(null).valid).toBe(false);
  });
});
