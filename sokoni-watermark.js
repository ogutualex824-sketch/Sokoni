/* ═══════════════════════════════════════════════════════════════════════════
   creator-watermark.js — PURE watermark logic for Creator Hub playback.

   The server builds the watermark payload when it authorises a session
   (functions/creator-hub.js authorizePlayback); the player (creator.html)
   renders it. Both load THIS file, so the position schedule the page draws is
   the schedule the server can reconstruct when a leaked recording is traced.

   WHAT IT IS — and is not (said plainly, per §12/§13):
   - A VISIBLE, moving, per-session overlay: masked viewer identity + a session
     code + an entitlement fragment + time. It deters casual re-recording and
     identifies the authorised session a leak came from.
   - A FORENSIC session code tiled faintly across the frame, whose placement is
     a deterministic function of the session seed and time.
   - It is NOT burned into the video pixels. A determined attacker with
     devtools can hide an overlay; a camera pointed at a screen defeats every
     web control. Nothing here makes a film "copy-proof".

   PII: only MASKED identifiers ever reach the payload. The full email/phone is
   never sent to the client for rendering.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniWatermark = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICK_MS = 20000;          /* the visible label moves every 20 s */
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   /* no 0/O/1/I/L */

  function maskEmail(email) {
    const s = String(email || '').trim();
    const at = s.lastIndexOf('@');
    if (at < 1) return null;
    const local = s.slice(0, at), domain = s.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    if (dot < 1) return null;
    const host = domain.slice(0, dot), tld = domain.slice(dot);
    const l = local.length <= 2 ? local[0] + '*' : local[0] + '***' + local[local.length - 1];
    return l + '@' + host[0] + '***' + tld;
  }

  function maskPhone(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 7) return null;
    return '•••' + d.slice(-3);
  }

  /** First word of a display name, capped — a name, not a dossier. */
  function shortName(name) {
    const w = String(name || '').trim().split(/\s+/)[0] || '';
    return w.replace(/[^\p{L}\p{N}'-]/gu, '').slice(0, 16) || null;
  }

  /** Session code from server randomness (hex/any string) → 10 readable chars. */
  function sessionCode(seed) {
    const s = String(seed || '');
    if (s.length < 16) throw new Error('session seed too short');
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519) >>> 0;
    }
    let out = '', a = h1, b = h2;
    for (let i = 0; i < 10; i++) {
      const v = (i < 5 ? a : b) % CODE_ALPHABET.length;
      out += CODE_ALPHABET[v];
      if (i < 5) a = Math.floor(a / CODE_ALPHABET.length) ^ (b << 3); else b = Math.floor(b / CODE_ALPHABET.length) ^ (a << 5);
      a >>>= 0; b >>>= 0;
    }
    return out;
  }

  /**
   * Build the payload the player renders. Inputs are what the SERVER knows;
   * output contains masked values only.
   */
  function buildPayload({ displayName, email, phone, entitlementId, sessionSeed, issuedAtMs }) {
    const code = sessionCode(sessionSeed);
    const ident = maskEmail(email) || maskPhone(phone) || 'viewer';
    const name = shortName(displayName);
    const ent = String(entitlementId || '').slice(-6).toUpperCase();
    return {
      v: 1,
      label: (name ? name + ' · ' : '') + ident,
      sessionCode: code,
      entitlementTag: ent ? 'E-' + ent : null,
      issuedAtMs: Number(issuedAtMs) || 0,
      tickMs: TICK_MS,
    };
  }

  /* mulberry32 over (seed hash + tick): deterministic, cheap, reproducible
     server-side for forensic tracing. Not a security primitive. */
  function _rng(seedStr, tick) {
    let h = 2166136261;
    const s = seedStr + ':' + tick;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    let t = h >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Where the visible label sits during tick `tick` (fractions of the frame). */
  function positionAt(sessionCodeStr, tick) {
    const r = _rng(String(sessionCodeStr), Number(tick) | 0);
    return { x: 0.04 + r() * 0.62, y: 0.06 + r() * 0.78, rotateDeg: Math.round((r() - 0.5) * 16) };
  }

  function tickAt(issuedAtMs, nowMs) { return Math.max(0, Math.floor((nowMs - issuedAtMs) / TICK_MS)); }

  /** Faint forensic tile grid: offsets shift per tick so a static crop cannot avoid it. */
  function forensicGrid(sessionCodeStr, tick, cols = 3, rows = 3) {
    const r = _rng('grid:' + sessionCodeStr, Number(tick) | 0);
    const ox = r() / cols, oy = r() / rows;
    const cells = [];
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) cells.push({ x: (i / cols + ox) % 1, y: (j / rows + oy) % 1 });
    return cells;
  }

  return { TICK_MS, maskEmail, maskPhone, shortName, sessionCode, buildPayload, positionAt, tickAt, forensicGrid };
}));
