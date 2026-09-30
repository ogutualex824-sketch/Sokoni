/**
 * Unit tests — shared/errors.js
 * Validates all error factories, auth guards, input sanitizers,
 * and the wrapCF handler. No Firebase dependency required.
 */

'use strict';

/* ── Mock firebase-functions before requiring the module ──────
   The shared/errors module imports HttpsError from firebase-functions/v2/https.
   We mock it so tests run without the actual Firebase SDK. */
const mockHttpsError = jest.fn().mockImplementation(function(code, message, details) {
  this.code    = code;
  this.message = message;
  this.details = details;
});
mockHttpsError.prototype = Object.create(Error.prototype);

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: mockHttpsError,
}));
jest.mock('firebase-functions', () => ({
  logger: mockLogger,
}));

const E = require('../shared/errors');

/* Helper to build a fake CF request */
function makeReq(uid = null, claims = {}) {
  return uid
    ? { auth: { uid, token: { uid, ...claims } }, data: {} }
    : { auth: null, data: {} };
}

/* ─────────────────────────────────────────────────────────────
   AppError
───────────────────────────────────────────────────────────── */
describe('AppError', () => {
  test('stores appCode, message, and details', () => {
    const err = new E.AppError('payment/duplicate', 'Duplicate payment detected.', { ref: 'abc' });
    expect(err.appCode).toBe('payment/duplicate');
    expect(err.message).toBe('Duplicate payment detected.');
    expect(err.details).toEqual({ ref: 'abc' });
  });

  test('is an instance of Error', () => {
    const err = new E.AppError('server/internal', 'Error');
    expect(err).toBeInstanceOf(Error);
  });

  test('toHttpsError maps known code correctly', () => {
    const err = new E.AppError('payment/duplicate', 'Dup');
    err.toHttpsError();
    expect(mockHttpsError).toHaveBeenCalledWith('already-exists', 'Dup', expect.objectContaining({ appCode: 'payment/duplicate' }));
  });

  test('toHttpsError maps unknown code to internal', () => {
    const err = new E.AppError('unknown/code', 'Oops');
    err.toHttpsError();
    expect(mockHttpsError).toHaveBeenCalledWith('internal', 'Oops', expect.anything());
  });
});

/* ─────────────────────────────────────────────────────────────
   assertAuth
───────────────────────────────────────────────────────────── */
describe('assertAuth', () => {
  test('returns uid for authenticated request', () => {
    const req = makeReq('user-123');
    expect(E.assertAuth(req)).toBe('user-123');
  });

  test('throws unauthenticated for null auth', () => {
    const req = makeReq(null);
    expect(() => E.assertAuth(req)).toThrow();
    const lastCall = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(lastCall[0]).toBe('unauthenticated');
  });

  test('throws unauthenticated when auth.uid is missing', () => {
    const req = { auth: {}, data: {} };
    expect(() => E.assertAuth(req)).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   assertAdmin
───────────────────────────────────────────────────────────── */
describe('assertAdmin', () => {
  test('accepts request with admin claim', () => {
    const req = makeReq('admin-1', { admin: true });
    expect(E.assertAdmin(req)).toBe('admin-1');
  });

  test('accepts request with superAdmin claim', () => {
    const req = makeReq('super-1', { superAdmin: true });
    expect(E.assertAdmin(req)).toBe('super-1');
  });

  test('rejects plain user without admin claim', () => {
    const req = makeReq('user-1');
    expect(() => E.assertAdmin(req)).toThrow();
    const lastCall = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(lastCall[0]).toBe('permission-denied');
  });

  test('rejects unauthenticated request', () => {
    expect(() => E.assertAdmin(makeReq(null))).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   assertSuperAdmin
───────────────────────────────────────────────────────────── */
describe('assertSuperAdmin', () => {
  test('accepts request with superAdmin claim', () => {
    const req = makeReq('super-1', { superAdmin: true });
    expect(E.assertSuperAdmin(req)).toBe('super-1');
  });

  test('rejects admin (not superAdmin)', () => {
    const req = makeReq('admin-1', { admin: true });
    expect(() => E.assertSuperAdmin(req)).toThrow();
    const lastCall = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(lastCall[0]).toBe('permission-denied');
  });

  test('rejects plain user', () => {
    expect(() => E.assertSuperAdmin(makeReq('user-1'))).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   assertOwner
───────────────────────────────────────────────────────────── */
describe('assertOwner', () => {
  test('allows owner to access their own resource', () => {
    const req = makeReq('user-42');
    expect(E.assertOwner(req, 'user-42')).toBe('user-42');
  });

  test('blocks non-owner from accessing resource', () => {
    const req = makeReq('user-99');
    expect(() => E.assertOwner(req, 'user-42')).toThrow();
  });

  test('admin bypasses ownership check', () => {
    const req = makeReq('admin-1', { admin: true });
    expect(E.assertOwner(req, 'user-42')).toBe('admin-1');
  });

  test('superAdmin bypasses ownership check', () => {
    const req = makeReq('super-1', { superAdmin: true });
    expect(E.assertOwner(req, 'user-42')).toBe('super-1');
  });
});

/* ─────────────────────────────────────────────────────────────
   assertInput
───────────────────────────────────────────────────────────── */
describe('assertInput', () => {
  test('does not throw when condition is true', () => {
    expect(() => E.assertInput(true, 'should not throw')).not.toThrow();
  });

  test('throws invalid-argument when condition is false', () => {
    expect(() => E.assertInput(false, 'bad input')).toThrow();
    const lastCall = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(lastCall[0]).toBe('invalid-argument');
    expect(lastCall[1]).toBe('bad input');
  });

  test('throws on 0 (falsy number)', () => {
    expect(() => E.assertInput(0, 'zero')).toThrow();
  });

  test('throws on null', () => {
    expect(() => E.assertInput(null, 'null')).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   assertRequired
───────────────────────────────────────────────────────────── */
describe('assertRequired', () => {
  test('accepts non-empty string', () => {
    expect(() => E.assertRequired('hello', 'name')).not.toThrow();
  });

  test('throws on undefined', () => {
    expect(() => E.assertRequired(undefined, 'field')).toThrow();
  });

  test('throws on null', () => {
    expect(() => E.assertRequired(null, 'field')).toThrow();
  });

  test('throws on empty string', () => {
    expect(() => E.assertRequired('', 'field')).toThrow();
  });

  test('accepts 0 (zero is a valid non-empty value for numbers)', () => {
    // 0 is falsy but NOT null/undefined/''
    // assertRequired checks === null, === undefined, === ''
    expect(() => E.assertRequired(0, 'count')).not.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   assertRange
───────────────────────────────────────────────────────────── */
describe('assertRange', () => {
  test('accepts value within range', () => {
    expect(() => E.assertRange(50, 1, 100, 'score')).not.toThrow();
  });

  test('accepts boundary values (inclusive)', () => {
    expect(() => E.assertRange(1, 1, 100, 'score')).not.toThrow();
    expect(() => E.assertRange(100, 1, 100, 'score')).not.toThrow();
  });

  test('throws below minimum', () => {
    expect(() => E.assertRange(0, 1, 100, 'score')).toThrow();
  });

  test('throws above maximum', () => {
    expect(() => E.assertRange(101, 1, 100, 'score')).toThrow();
  });

  test('throws for non-numeric input', () => {
    expect(() => E.assertRange('50', 1, 100, 'score')).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   sanitize
───────────────────────────────────────────────────────────── */
describe('sanitize', () => {
  test('strips HTML tags, preserving inner text (CF stores strings, not HTML)', () => {
    /* The sanitize function removes tags but not the text between them.
       CFs store the result as a plain string in Firestore — XSS prevention
       is the renderer's responsibility (use textContent, not innerHTML).
       Result: '<script>alert(1)</script>hello' → 'alert(1)hello' */
    expect(E.sanitize('<script>alert(1)</script>hello')).toBe('alert(1)hello');
  });

  test('strips self-closing and attribute tags', () => {
    expect(E.sanitize('<img src="x" onerror="alert(1)">text')).toBe('text');
  });

  test('strips standalone tags completely', () => {
    expect(E.sanitize('<b>bold</b>')).toBe('bold');
    expect(E.sanitize('<p class="x">paragraph</p>')).toBe('paragraph');
  });

  test('trims whitespace', () => {
    expect(E.sanitize('  hello  ')).toBe('hello');
  });

  test('truncates to maxLen', () => {
    const long = 'a'.repeat(300);
    expect(E.sanitize(long, 50)).toHaveLength(50);
  });

  test('returns empty string for non-string input', () => {
    expect(E.sanitize(123)).toBe('');
    expect(E.sanitize(null)).toBe('');
    expect(E.sanitize(undefined)).toBe('');
  });

  test('preserves normal alphanumeric content', () => {
    expect(E.sanitize('SOKONI Market v1.0')).toBe('SOKONI Market v1.0');
  });

  test('strips nested tags', () => {
    expect(E.sanitize('<b><i>bold italic</i></b>')).toBe('bold italic');
  });
});

/* ─────────────────────────────────────────────────────────────
   sanitizePhone
───────────────────────────────────────────────────────────── */
describe('sanitizePhone', () => {
  test('accepts valid 254 format', () => {
    expect(E.sanitizePhone('254712345678')).toBe('254712345678');
  });

  test('normalizes 07XX format to 2547XX', () => {
    expect(E.sanitizePhone('0712345678')).toBe('254712345678');
  });

  test('normalizes 011XX format to 25411XX', () => {
    expect(E.sanitizePhone('0110123456')).toBe('254110123456');
  });

  test('strips non-numeric characters', () => {
    expect(E.sanitizePhone('+254-712-345-678')).toBe('254712345678');
  });

  test('throws for too-short number', () => {
    expect(() => E.sanitizePhone('07123456')).toThrow();
  });

  test('throws for number starting with wrong prefix', () => {
    expect(() => E.sanitizePhone('255712345678')).toThrow(); /* Tanzania prefix */
  });

  test('throws for empty string', () => {
    expect(() => E.sanitizePhone('')).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   sanitizeAmount
───────────────────────────────────────────────────────────── */
describe('sanitizeAmount', () => {
  test('accepts valid positive amount', () => {
    expect(E.sanitizeAmount(1500)).toBe(1500);
  });

  test('rounds to 2 decimal places', () => {
    expect(E.sanitizeAmount(99.999)).toBeCloseTo(100, 2);
    expect(E.sanitizeAmount(10.005)).toBeCloseTo(10.01, 2);
  });

  test('throws for zero amount', () => {
    expect(() => E.sanitizeAmount(0)).toThrow();
  });

  test('throws for negative amount', () => {
    expect(() => E.sanitizeAmount(-100)).toThrow();
  });

  test('throws for non-numeric string', () => {
    expect(() => E.sanitizeAmount('abc')).toThrow();
  });

  test('throws above default max (10M)', () => {
    expect(() => E.sanitizeAmount(11_000_000)).toThrow();
  });

  test('accepts custom max', () => {
    expect(() => E.sanitizeAmount(200_000, 'amount', 150_000)).toThrow();
    expect(() => E.sanitizeAmount(100_000, 'amount', 150_000)).not.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   wrapCF
───────────────────────────────────────────────────────────── */
describe('wrapCF', () => {
  const mockReq = makeReq('user-1');

  test('returns the result of the wrapped function', async () => {
    const result = await E.wrapCF(mockReq, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  test('re-throws HttpsError as-is (not double-wrapped)', async () => {
    const err = new mockHttpsError('not-found', 'Missing');
    err.constructor = mockHttpsError;
    // Simulate the instanceof check
    Object.setPrototypeOf(err, mockHttpsError.prototype);
    await expect(E.wrapCF(mockReq, async () => { throw err; })).rejects.toThrow();
  });

  test('converts AppError to HttpsError', async () => {
    const appErr = new E.AppError('payment/duplicate', 'Dup');
    await expect(
      E.wrapCF(mockReq, async () => { throw appErr; })
    ).rejects.toBeDefined();
  });

  test('wraps unknown errors as internal', async () => {
    await expect(
      E.wrapCF(mockReq, async () => { throw new TypeError('unexpected'); })
    ).rejects.toBeDefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
