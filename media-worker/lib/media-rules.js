/* ============================================================================
   SOKONI media worker — the pure rules (no I/O, no binaries)
   ----------------------------------------------------------------------------
   What a Foundation upload must BE before anything decodes it beyond a probe, and what the
   derivative must look like. Everything here is a pure function so the decisions can be tested
   without ffmpeg, Storage or Firestore.

   Format is decided by the BYTES (magic numbers) and then by the PROBE — never by the file
   extension, never by the Content-Type the browser sent. A file whose magic bytes are not one of
   the five accepted families is REJECTED without being probed or decoded at all.

   The record id is sha256(sourcePath) first 32 hex. functions/foundation-content.js computes the
   same id (separate codebase, so the one-liner is duplicated deliberately); the tests pin that the
   two agree.
   ============================================================================ */
'use strict';
const crypto = require('crypto');

const COLLECTION = 'foundationMedia';
const STATES = Object.freeze({ UPLOADED: 'UPLOADED', PROCESSING: 'PROCESSING', READY: 'READY', FAILED: 'FAILED', REJECTED: 'REJECTED' });
const TERMINAL = new Set([STATES.READY, STATES.FAILED, STATES.REJECTED]);

const MB = 1024 * 1024;
const LIMITS = Object.freeze({
  video: { maxBytes: 80 * MB, minSec: 1, maxSec: 600, maxDim: 3840, minDim: 16 },
  image: { maxBytes: 15 * MB, maxDim: 8000, minDim: 1 },
  out: { videoLong: 1280, imageLong: 1600, thumbLong: 640, crf: 28 },
});
const VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
const VIDEO_CONTAINERS = ['mp4', 'mov', 'webm', 'matroska'];
/* ISO-BMFF major brands accepted as MP4 / QuickTime. HEIF/AVIF still images and 3GP are NOT. */
const MP4_BRANDS = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'M4VH', 'dash', 'mmp4', 'MSNV', 'XAVC', 'av01', 'hvc1', 'f4v '];
const MOV_BRANDS = ['qt  '];
const HEIF_BRANDS = ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'avif', 'avis'];

/* upload layout (matches storage.rules): foundation-media/{uid|admin}/{filename} — exactly two
   segments below the prefix, conservative characters only. */
const UPLOAD_RE = /^foundation-media\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/;

const mediaId = (sourcePath) => crypto.createHash('sha256').update(String(sourcePath)).digest('hex').slice(0, 32);
const isFoundationUpload = (name) => typeof name === 'string' && name.startsWith('foundation-media/');
function parseUploadPath(name) {
  const m = UPLOAD_RE.exec(String(name || ''));
  if (!m || name.includes('..')) return null;
  return { owner: m[1], filename: m[2], sub: m[1] + '/' + m[2] };
}
/* Derivatives are keyed by the source GENERATION, so a re-upload at the same path can never
   overwrite the bytes a story was approved / published with. */
const derivativePrefix = (sub, generation) => 'foundation-processed/' + sub + '/' + String(generation) + '/';

/* ── Magic bytes ─────────────────────────────────────────────────────────────────────────── */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { family: 'jpeg', kind: 'image', demuxer: 'jpeg_pipe' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return { family: 'png', kind: 'image', demuxer: 'png_pipe' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { family: 'webp', kind: 'image', demuxer: 'webp_pipe' };
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { family: 'isobmff', kind: 'video', demuxer: 'mov', brand: buf.toString('latin1', 8, 12) };
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { family: 'ebml', kind: 'video', demuxer: 'matroska' };
  return null;
}

/* ── Probe normalisation (ffprobe -print_format json -show_format -show_streams) ─────────── */
function rotationOf(stream) {
  if (!stream) return 0;
  let r = 0;
  for (const sd of stream.side_data_list || []) if (sd && sd.rotation != null && Number.isFinite(Number(sd.rotation))) r = Number(sd.rotation);
  if (!r && stream.tags && stream.tags.rotate != null && Number.isFinite(Number(stream.tags.rotate))) r = Number(stream.tags.rotate);
  return ((Math.round(r) % 360) + 360) % 360;
}
function containerOf(formatName, brand, vcodec) {
  const f = String(formatName || '');
  if (/(^|,)(mov|mp4)(,|$)/.test(f)) {
    const b = String(brand || '');
    if (HEIF_BRANDS.includes(b.trim()) || HEIF_BRANDS.includes(b)) return 'heif';
    if (MOV_BRANDS.includes(b)) return 'mov';
    if (MP4_BRANDS.includes(b)) return 'mp4';
    return 'unknown';
  }
  if (/(^|,)(matroska|webm)(,|$)/.test(f)) return ['vp8', 'vp9', 'av1'].includes(vcodec) ? 'webm' : 'matroska';
  if (/jpeg_pipe|png_pipe|webp_pipe|image2/.test(f)) return f.replace(/_pipe$/, '');
  return f || 'unknown';
}
function normalizeProbe(json, sizeBytes) {
  const j = json || {};
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const fmt = j.format || {};
  const videos = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const v = videos[0] || null;
  const a = streams.find((s) => s.codec_type === 'audio') || null;
  const rotation = rotationOf(v);
  const width = v ? Number(v.width) || null : null;
  const height = v ? Number(v.height) || null : null;
  const swap = rotation === 90 || rotation === 270;
  const dur = Number(fmt.duration);
  const sdur = v ? Number(v.duration) : NaN;
  const brand = fmt.tags && typeof fmt.tags.major_brand === 'string' ? fmt.tags.major_brand : null;
  const vcodec = v ? String(v.codec_name || '') || null : null;
  return {
    container: containerOf(fmt.format_name, brand, vcodec),
    formatName: fmt.format_name || null,
    majorBrand: brand,
    vcodec,
    vprofile: v && v.profile ? String(v.profile) : null,
    acodec: a ? String(a.codec_name || '') || null : null,
    width, height, rotation,
    displayWidth: swap ? height : width,
    displayHeight: swap ? width : height,
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : (Number.isFinite(sdur) && sdur > 0 ? sdur : null),
    videoStreams: videos.length,
    sizeBytes: Number.isFinite(Number(sizeBytes)) ? Number(sizeBytes) : (Number(fmt.size) || null),
  };
}
/* what the processing record keeps (the owner's schema) */
const recordProbe = (p) => ({ container: p.container, vcodec: p.vcodec, acodec: p.acodec, width: p.width, height: p.height, durationSec: p.durationSec, sizeBytes: p.sizeBytes });

/* ── Validation ──────────────────────────────────────────────────────────────────────────── */
const REASONS = Object.freeze({
  empty: 'The file is empty.',
  unsafe_path: 'The file name or location is not allowed.',
  unrecognised_format: 'Only JPEG, PNG or WebP photos and MP4, MOV or WebM videos are accepted.',
  unreadable: 'The file could not be read as a photo or video.',
  too_large: 'Videos must be 80 MB or smaller and photos 15 MB or smaller.',
  unsupported_container: 'That video container is not accepted (MP4, MOV, WebM or MKV only).',
  format_mismatch: 'The file contents do not match a supported format.',
  unsupported_codec: 'That video codec is not accepted (H.264, HEVC, VP8, VP9 or AV1 only).',
  duration_out_of_range: 'Videos must be between 1 second and 10 minutes long.',
  resolution_out_of_range: 'The picture size is outside the accepted range (videos up to 3840 px, photos up to 8000 px).',
  no_video_stream: 'The file has no picture in it.',
});
const reject = (reason, detail) => ({ ok: false, reason, message: REASONS[reason] || 'The file was not accepted.', detail: detail || null });

/* Size can be judged before a byte is downloaded (the object metadata is server-side truth). */
function precheckSize(sizeBytes) {
  const n = Number(sizeBytes);
  if (!(n > 0)) return reject('empty');
  if (n > LIMITS.video.maxBytes) return reject('too_large', { sizeBytes: n });
  return { ok: true };
}

function validate({ sniffed, probe, sizeBytes }) {
  const n = Number(sizeBytes);
  if (!(n > 0)) return reject('empty');
  if (!sniffed) return reject('unrecognised_format');
  if (!probe) return reject('unreadable');
  if (sniffed.kind === 'image') {
    const L = LIMITS.image;
    if (n > L.maxBytes) return reject('too_large', { sizeBytes: n });
    const want = { jpeg: 'mjpeg', png: 'png', webp: 'webp' }[sniffed.family];
    if (probe.videoStreams !== 1 || probe.vcodec !== want) return reject('format_mismatch', { family: sniffed.family, vcodec: probe.vcodec });
    if (!(probe.width >= L.minDim && probe.height >= L.minDim && probe.width <= L.maxDim && probe.height <= L.maxDim)) return reject('resolution_out_of_range', { width: probe.width, height: probe.height });
    return { ok: true, kind: 'image' };
  }
  const L = LIMITS.video;
  if (n > L.maxBytes) return reject('too_large', { sizeBytes: n });
  if (probe.container === 'heif') return reject('unsupported_container', { brand: probe.majorBrand });
  if (!VIDEO_CONTAINERS.includes(probe.container)) return reject('unsupported_container', { container: probe.container, brand: probe.majorBrand });
  const familyOk = sniffed.family === 'isobmff' ? ['mp4', 'mov'].includes(probe.container) : ['webm', 'matroska'].includes(probe.container);
  if (!familyOk) return reject('format_mismatch', { family: sniffed.family, container: probe.container });
  if (!probe.videoStreams || !probe.vcodec) return reject('no_video_stream');
  if (!VIDEO_CODECS.includes(probe.vcodec)) return reject('unsupported_codec', { vcodec: probe.vcodec });
  if (!(probe.durationSec >= L.minSec && probe.durationSec <= L.maxSec)) return reject('duration_out_of_range', { durationSec: probe.durationSec });
  if (!(probe.width >= L.minDim && probe.height >= L.minDim && probe.width <= L.maxDim && probe.height <= L.maxDim)) return reject('resolution_out_of_range', { width: probe.width, height: probe.height });
  return { ok: true, kind: 'video' };
}

/* ── Output geometry ─────────────────────────────────────────────────────────────────────── */
/* Fit inside a long-side limit, keep aspect, never upscale. `even` rounds down to even numbers
   (yuv420p / H.264 need even dimensions). */
function fitDims(w, h, maxLong, even) {
  const W = Number(w), H = Number(h);
  if (!(W > 0 && H > 0)) throw new Error('fitDims: bad source dimensions');
  const f = Math.max(W, H) > maxLong ? maxLong / Math.max(W, H) : 1;
  let tw = Math.max(1, Math.round(W * f)), th = Math.max(1, Math.round(H * f));
  if (even) { tw = Math.max(2, tw - (tw % 2)); th = Math.max(2, th - (th % 2)); }
  return { width: tw, height: th };
}
/* Expected output check — the derivative is MEASURED, not assumed. */
function checkVideoOutput(p, faststart) {
  const errs = [];
  if (!p || p.vcodec !== 'h264') errs.push('video codec is not h264');
  if (p && !/high/i.test(p.vprofile || '')) errs.push('h264 profile is not High');
  if (p && Math.max(p.displayWidth || 0, p.displayHeight || 0) > LIMITS.out.videoLong) errs.push('long side exceeds ' + LIMITS.out.videoLong);
  if (p && p.acodec && p.acodec !== 'aac') errs.push('audio codec is not aac');
  if (p && p.container !== 'mp4') errs.push('container is not mp4');
  if (faststart !== true) errs.push('moov atom is not before mdat (no faststart)');
  return errs;
}
function checkImageOutput(p) {
  const errs = [];
  if (!p || p.vcodec !== 'webp') errs.push('image codec is not webp');
  if (p && Math.max(p.width || 0, p.height || 0) > LIMITS.out.imageLong) errs.push('long side exceeds ' + LIMITS.out.imageLong);
  return errs;
}
function checkThumbOutput(p) {
  const errs = [];
  if (!p || p.vcodec !== 'mjpeg') errs.push('thumbnail is not jpeg');
  if (p && Math.max(p.width || 0, p.height || 0) > LIMITS.out.thumbLong) errs.push('thumbnail long side exceeds ' + LIMITS.out.thumbLong);
  return errs;
}

/* ── JPEG EXIF orientation (applied explicitly so stripping EXIF never leaves a photo sideways) ── */
function jpegOrientation(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return 1;
    const marker = buf[o + 1];
    if (marker === 0xd9 || marker === 0xda) return 1;
    const len = buf.readUInt16BE(o + 2);
    if (len < 2) return 1;
    if (marker === 0xe1 && o + 10 <= buf.length && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      const t = o + 10;
      if (t + 8 > buf.length) return 1;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const r16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
      const r32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      const ifd = t + r32(t + 4);
      if (ifd + 2 > buf.length) return 1;
      const count = r16(ifd);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) return 1;
        if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}
/* EXIF orientation → ffmpeg filters, and whether width/height swap. */
const ORIENT_FILTERS = { 1: [], 2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'], 5: ['transpose=0'], 6: ['transpose=1'], 7: ['transpose=3'], 8: ['transpose=2'] };
const orientationSwaps = (o) => o >= 5 && o <= 8;

module.exports = {
  COLLECTION, STATES, TERMINAL, LIMITS, REASONS, VIDEO_CODECS, VIDEO_CONTAINERS,
  mediaId, isFoundationUpload, parseUploadPath, derivativePrefix,
  sniff, normalizeProbe, recordProbe, precheckSize, validate, fitDims,
  checkVideoOutput, checkImageOutput, checkThumbOutput,
  jpegOrientation, ORIENT_FILTERS, orientationSwaps,
};
