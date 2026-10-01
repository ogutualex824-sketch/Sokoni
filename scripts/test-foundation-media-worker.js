#!/usr/bin/env node
'use strict';
/* ============================================================================
   media-worker (foundationMediaProcess) — validator, state machine, and one REAL ffmpeg run
     U  pure rules: magic bytes, probe normalisation, validation limits, geometry, EXIF orientation
     S  state machine on the in-memory Firestore fake + a fake bucket + STUB tools (no binaries)
     R  REAL: ffmpeg generates tiny clips/photos, the pipeline processes them with real ffprobe/ffmpeg,
        and the derivatives are MEASURED. Runs only when both binaries resolve (media-worker/node_modules,
        or SOKONI_FFMPEG + SOKONI_FFPROBE locally) — otherwise reported BLOCKED, never as a pass.
   node scripts/test-foundation-media-worker.js
   ============================================================================ */
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MW = path.join(ROOT, 'media-worker');
const R = require(path.join(MW, 'lib', 'media-rules.js'));
const { processObject, MAX_ATTEMPTS } = require(path.join(MW, 'lib', 'pipeline.js'));
const T = require(path.join(MW, 'lib', 'ffmpeg-tools.js'));
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let pass = 0, fail = 0, blocked = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 500) : '')); } };
const MB = 1024 * 1024;

/* ── fakes ─────────────────────────────────────────────────────────────────────────────── */
function fakeBucket() {
  const objects = new Map();   /* name → { bytes, generation } */
  const calls = { download: 0, upload: 0, del: 0 };
  return {
    objects, calls,
    put(name, bytes, generation) { objects.set(name, { bytes: Buffer.from(bytes), generation: String(generation) }); },
    file(name, opts) {
      return {
        download: async ({ destination }) => {
          calls.download++;
          const o = objects.get(name);
          if (!o) throw new Error('No such object');
          if (opts && opts.generation && String(opts.generation) !== o.generation) throw new Error('No such object (generation)');
          fs.writeFileSync(destination, o.bytes);
        },
        delete: async () => { calls.del++; objects.delete(name); },
      };
    },
    upload: async (local, { destination, metadata }) => { calls.upload++; objects.set(destination, { bytes: fs.readFileSync(local), generation: '1', contentType: metadata.contentType, cacheControl: metadata.cacheControl }); },
  };
}
const GOOD_SRC = { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', vcodec: 'h264', vprofile: 'Main', acodec: 'aac', width: 1920, height: 1080, rotation: 0, displayWidth: 1920, displayHeight: 1080, durationSec: 12, videoStreams: 1, sizeBytes: 1000 };
const GOOD_MAIN = { ...GOOD_SRC, vprofile: 'High', width: 1280, height: 720, displayWidth: 1280, displayHeight: 720 };
const GOOD_THUMB = { container: 'jpeg', vcodec: 'mjpeg', width: 640, height: 360, displayWidth: 640, displayHeight: 360, videoStreams: 1 };
function stubTools(over = {}) {
  const calls = { probe: 0, transcodeVideo: 0, transcodeImage: 0, thumb: 0 };
  return {
    calls,
    probe: async (file) => {
      calls.probe++;
      const b = path.basename(file);
      if (b === 'source') { if (over.probeThrows) throw over.probeThrows; return over.src || GOOD_SRC; }
      if (b === 'main.mp4') return over.main || GOOD_MAIN;
      if (b === 'main.webp') return over.mainImg || { container: 'webp', vcodec: 'webp', width: 1600, height: 1200, videoStreams: 1 };
      return over.thumb || GOOD_THUMB;
    },
    transcodeVideo: async (src, dmx, p, out) => { calls.transcodeVideo++; if (over.transcodeThrows) throw over.transcodeThrows; if (over.onTranscode) await over.onTranscode(); fs.writeFileSync(out, 'MP4'); },
    videoThumb: async (m, d, w, h, out) => { calls.thumb++; fs.writeFileSync(out, 'JPG'); },
    transcodeImage: async (src, dmx, p, o, out, th) => { calls.transcodeImage++; calls.lastOrientation = o; fs.writeFileSync(out, 'WEBP'); fs.writeFileSync(th, 'JPG'); },
    isFaststart: () => (over.faststart === undefined ? true : over.faststart),
  };
}
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmw-test-'));

function env(over) {
  let now = Date.parse('2026-10-01T10:00:00Z');
  const F = makeFakeFirestore({ clock: () => now });
  const bucket = fakeBucket();
  const tools = stubTools(over);
  const deps = { db: F.db, bucket, FieldValue: F.FieldValue, tools, now: () => now, tmpRoot: TMP };
  const rec = async (name) => { const s = await F.db.collection('foundationMedia').doc(R.mediaId(name)).get(); return s.exists ? s.data() : null; };
  return { F, bucket, tools, deps, rec, tick: (ms) => { now += ms; } };
}

(async () => {
  console.log('media-worker — Foundation media pipeline\n');

  /* ── U: pure rules ── */
  const s = (b) => (R.sniff(b) || {}).family || null;
  ck('U1 magic bytes: JPEG / PNG / WebP / ISO-BMFF / EBML recognised; text and empty are not',
    s(JPEG_HEAD) === 'jpeg' && s(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === 'png'
    && s(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')) === 'webp' && s(MP4_HEAD) === 'isobmff' && s(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])) === 'ebml'
    && s(Buffer.from('hello this is a text file pretending to be a video')) === null && s(Buffer.alloc(0)) === null
    && s(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === null && s(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')) === null);
  const vid = { family: 'isobmff', kind: 'video' };
  const V = (p, size = 10 * MB, sn = vid) => R.validate({ sniffed: sn, probe: { ...GOOD_SRC, ...p }, sizeBytes: size });
  ck('U2 a good H.264 MP4 is accepted as video', V({}).ok === true && V({}).kind === 'video');
  ck('U3 video rejects: avi container / mpeg4 codec / 0.5 s / 601 s / 4096 px / 81 MB / HEIF brand / no video stream',
    V({ container: 'avi' }).reason === 'unsupported_container' && V({ vcodec: 'mpeg4' }).reason === 'unsupported_codec'
    && V({ durationSec: 0.5 }).reason === 'duration_out_of_range' && V({ durationSec: 601 }).reason === 'duration_out_of_range'
    && V({ durationSec: null }).reason === 'duration_out_of_range'
    && V({ width: 4096 }).reason === 'resolution_out_of_range' && V({}, 81 * MB).reason === 'too_large'
    && V({ container: 'heif' }).reason === 'unsupported_container' && V({ videoStreams: 0, vcodec: null }).reason === 'no_video_stream');
  ck('U4 the BYTES and the probe must agree: EBML bytes probed as MP4 → format_mismatch; JPEG bytes probed as PNG → format_mismatch',
    V({}, 1000, { family: 'ebml', kind: 'video' }).reason === 'format_mismatch'
    && R.validate({ sniffed: { family: 'jpeg', kind: 'image' }, probe: { videoStreams: 1, vcodec: 'png', width: 10, height: 10 }, sizeBytes: 1000 }).reason === 'format_mismatch');
  const I = (p, size = MB) => R.validate({ sniffed: { family: 'jpeg', kind: 'image' }, probe: { videoStreams: 1, vcodec: 'mjpeg', width: 4000, height: 3000, ...p }, sizeBytes: size });
  ck('U5 image: accepted ≤15 MB / ≤8000 px; refused at 16 MB, 8001 px; unknown bytes → unrecognised_format',
    I({}).ok && I({}).kind === 'image' && I({}, 16 * MB).reason === 'too_large' && I({ width: 8001 }).reason === 'resolution_out_of_range'
    && R.validate({ sniffed: null, probe: null, sizeBytes: 5 }).reason === 'unrecognised_format');
  ck('U6 container from ffprobe: qt brand → mov, isom → mp4, heic → heif, 3gp4 → unknown; matroska+vp9 → webm, matroska+h264 → matroska',
    R.normalizeProbe({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } }, streams: [{ codec_type: 'video', codec_name: 'h264' }] }).container === 'mov'
    && R.normalizeProbe({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } }, streams: [] }).container === 'mp4'
    && R.normalizeProbe({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'heic' } }, streams: [] }).container === 'heif'
    && R.normalizeProbe({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: '3gp4' } }, streams: [] }).container === 'unknown'
    && R.normalizeProbe({ format: { format_name: 'matroska,webm' }, streams: [{ codec_type: 'video', codec_name: 'vp9' }] }).container === 'webm'
    && R.normalizeProbe({ format: { format_name: 'matroska,webm' }, streams: [{ codec_type: 'video', codec_name: 'h264' }] }).container === 'matroska');
  const rot = R.normalizeProbe({ format: { format_name: 'mov,mp4', duration: '3.0' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }, { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] });
  ck('U7 rotation -90 → display 1080x1920; cover art (attached_pic) is not counted as a video stream', rot.rotation === 270 && rot.displayWidth === 1080 && rot.displayHeight === 1920 && rot.videoStreams === 1, rot);
  const f1 = R.fitDims(1920, 1080, 1280, true), f2 = R.fitDims(640, 360, 1280, true), f3 = R.fitDims(1080, 1920, 1280, true), f4 = R.fitDims(1001, 333, 1280, true);
  ck('U8 geometry: 1920x1080→1280x720; 640x360 not upscaled; portrait 1080x1920→720x1280; odd sizes rounded to even',
    f1.width === 1280 && f1.height === 720 && f2.width === 640 && f2.height === 360 && f3.width === 720 && f3.height === 1280 && f4.width === 1000 && f4.height === 332, { f1, f2, f3, f4 });
  ck('U9 upload paths: only foundation-media/{owner}/{file}; no deeper, no "..", no odd characters',
    !!R.parseUploadPath('foundation-media/u1/clip.mp4') && R.parseUploadPath('foundation-media/admin/v.mov').owner === 'admin'
    && !R.parseUploadPath('foundation-media/u1/a/b.mp4') && !R.parseUploadPath('foundation-media/u1/..mp4') && !R.parseUploadPath('foundation-media/u1/a b.mp4')
    && !R.parseUploadPath('foundation-media/u1/.hidden') && !R.parseUploadPath('foundation-published/x/y'));
  const exif = (o, le) => {
    const tiff = Buffer.alloc(26);
    if (le) { tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(o, 18); }
    else { tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(o, 18); }
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPSLatitude-SOKONI-SECRET', 'latin1')]);
    const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([seg, body]);
  };
  const withExif = (o, le) => Buffer.concat([Buffer.from([0xff, 0xd8]), exif(o, le), Buffer.from([0xff, 0xda, 0, 2])]);
  ck('U10 JPEG EXIF orientation read in both byte orders; absent / corrupt → 1', R.jpegOrientation(withExif(6, true)) === 6 && R.jpegOrientation(withExif(8, false)) === 8
    && R.jpegOrientation(JPEG_HEAD) === 1 && R.jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1])) === 1 && R.jpegOrientation(Buffer.from('nope')) === 1);
  ck('U11 derivative checks: non-High profile, >1280, mp3 audio, no faststart each fail',
    R.checkVideoOutput(GOOD_MAIN, true).length === 0 && R.checkVideoOutput({ ...GOOD_MAIN, vprofile: 'Main' }, true).length === 1
    && R.checkVideoOutput({ ...GOOD_MAIN, displayWidth: 1920 }, true).length === 1 && R.checkVideoOutput({ ...GOOD_MAIN, acodec: 'mp3' }, true).length === 1
    && R.checkVideoOutput(GOOD_MAIN, false).length === 1);

  /* ── S: state machine (stub tools) ── */
  const NAME = 'foundation-media/u1/clip.mp4';
  {
    const E = env();
    E.bucket.put(NAME, MP4_HEAD, 100);
    const r = await processObject(E.deps, { name: NAME, generation: '100', size: 30 * MB });
    const x = await E.rec(NAME);
    ck('S1 a valid video: UPLOADED → PROCESSING → READY, owner + probe recorded, derivatives under foundation-processed/{owner}/{file}/{generation}/',
      r.state === 'READY' && x.state === 'READY' && x.previousState === 'UPLOADED' && x.uploaderUid === 'u1' && x.kind === 'video' && x.sourcePath === NAME
      && x.derivatives.main.path === 'foundation-processed/u1/clip.mp4/100/main.mp4' && x.derivatives.thumb.path === 'foundation-processed/u1/clip.mp4/100/thumb.jpg'
      && x.derivatives.main.contentType === 'video/mp4' && x.probe.vcodec === 'h264' && x.probe.width === 1920 && x.leaseUntil === null
      && E.bucket.objects.has(x.derivatives.main.path) && E.bucket.objects.has(x.derivatives.thumb.path), { r, x });
    ck('S2 the source upload is untouched (nothing deleted, nothing copied out of quarantine)', E.bucket.objects.has(NAME) && E.bucket.calls.del === 0);
    ck('S3 derivatives are private objects (no download token, no-store)', E.bucket.objects.get(x.derivatives.main.path).cacheControl === 'private, max-age=0, no-store');
    const before = E.tools.calls.transcodeVideo;
    const r2 = await processObject(E.deps, { name: NAME, generation: '100', size: 30 * MB });
    ck('S4 the same event again (retry / duplicate delivery) → skipped, NOT re-transcoded', r2.skipped === 'terminal:READY' && E.tools.calls.transcodeVideo === before, r2);
    const r3 = await processObject(E.deps, { name: NAME, generation: '99', size: 30 * MB });
    ck('S5 a late event for an OLDER generation is ignored', r3.skipped === 'stale_generation' && (await E.rec(NAME)).generation === '100', r3);
    E.bucket.put(NAME, MP4_HEAD, 200);
    const r4 = await processObject(E.deps, { name: NAME, generation: '200', size: 30 * MB });
    const x4 = await E.rec(NAME);
    ck('S6 re-upload at the same path (new generation) → reprocessed into a NEW derivative path; the old one is not overwritten',
      r4.state === 'READY' && x4.generation === '200' && x4.attempts === 1 && x4.derivatives.main.path === 'foundation-processed/u1/clip.mp4/200/main.mp4' && E.bucket.objects.has('foundation-processed/u1/clip.mp4/100/main.mp4'), x4);
  }
  {
    const E = env();
    await E.F.db.collection('foundationMedia').doc(R.mediaId(NAME)).set({ sourcePath: NAME, state: 'PROCESSING', generation: '5', attempts: 1, leaseUntil: Date.parse('2026-10-01T10:05:00Z') });
    E.bucket.put(NAME, MP4_HEAD, 5);
    const r = await processObject(E.deps, { name: NAME, generation: '5', size: MB });
    ck('S7 PROCESSING with a live lease → left alone (no double processing)', r.skipped === 'in_progress' && E.tools.calls.transcodeVideo === 0, r);
    E.tick(11 * 60 * 1000);
    const r2 = await processObject(E.deps, { name: NAME, generation: '5', size: MB });
    ck('S8 …an EXPIRED lease (worker died) is reclaimed and finishes', r2.state === 'READY' && (await E.rec(NAME)).attempts === 2, r2);
  }
  {
    const E = env();
    await E.F.db.collection('foundationMedia').doc(R.mediaId(NAME)).set({ sourcePath: NAME, state: 'PROCESSING', generation: '5', attempts: MAX_ATTEMPTS, leaseUntil: 0 });
    E.bucket.put(NAME, MP4_HEAD, 5);
    const r = await processObject(E.deps, { name: NAME, generation: '5', size: MB });
    const x = await E.rec(NAME);
    ck('S9 attempts are bounded: after ' + MAX_ATTEMPTS + ' the record goes FAILED (too_many_attempts), not an endless loop', r.skipped === 'gave_up' && x.state === 'FAILED' && x.error.reason === 'too_many_attempts', x);
  }
  {
    const E = env();
    const N = 'foundation-media/u1/notes.mp4';
    E.bucket.put(N, 'This is a plain text file renamed to .mp4 by someone hoping we trust the extension.', 7);
    const r = await processObject(E.deps, { name: N, generation: '7', size: 90, contentType: 'video/mp4' });
    const x = await E.rec(N);
    ck('S10 text renamed .mp4 (browser said video/mp4) → REJECTED unrecognised_format; never probed, never transcoded, no derivative',
      r.state === 'REJECTED' && x.state === 'REJECTED' && x.error.reason === 'unrecognised_format' && E.tools.calls.probe === 0 && E.tools.calls.transcodeVideo === 0 && E.bucket.calls.upload === 0 && !x.derivatives, { r, x });
  }
  {
    const E = env({ src: { ...GOOD_SRC, vcodec: 'mpeg4' } });
    E.bucket.put(NAME, MP4_HEAD, 8);
    const r = await processObject(E.deps, { name: NAME, generation: '8', size: MB });
    const x = await E.rec(NAME);
    ck('S11 real MP4 bytes but an MPEG-4 Part 2 stream → REJECTED unsupported_codec (with the probe recorded); not transcoded',
      r.state === 'REJECTED' && x.error.reason === 'unsupported_codec' && x.probe.vcodec === 'mpeg4' && E.tools.calls.transcodeVideo === 0, x);
  }
  {
    const E = env({ probeThrows: Object.assign(new Error('x'), { code: 'UNREADABLE' }) });
    E.bucket.put(NAME, MP4_HEAD, 9);
    const r = await processObject(E.deps, { name: NAME, generation: '9', size: MB });
    ck('S12 right magic bytes but ffprobe cannot read it → REJECTED unreadable', r.state === 'REJECTED' && (await E.rec(NAME)).error.reason === 'unreadable', r);
  }
  {
    const E = env({ transcodeThrows: Object.assign(new Error('boom'), { code: 'FFMPEG_FAILED', stderrTail: 'Invalid data' }) });
    E.bucket.put(NAME, MP4_HEAD, 10);
    const r = await processObject(E.deps, { name: NAME, generation: '10', size: MB });
    const x = await E.rec(NAME);
    ck('S13 ffmpeg fails → FAILED transcode_failed; no derivative stored; error text is generic (no stderr/paths in the record)',
      r.state === 'FAILED' && x.state === 'FAILED' && x.error.reason === 'transcode_failed' && !x.derivatives && E.bucket.calls.upload === 0 && !/Invalid data|u1|foundation-media/.test(JSON.stringify(x.error)), x);
  }
  {
    const E = env({ main: { ...GOOD_MAIN, vprofile: 'Baseline' }, faststart: false });
    E.bucket.put(NAME, MP4_HEAD, 11);
    const r = await processObject(E.deps, { name: NAME, generation: '11', size: MB });
    ck('S14 a derivative that does not MEASURE right (wrong profile, no faststart) → FAILED output_invalid, never READY', r.state === 'FAILED' && (await E.rec(NAME)).error.reason === 'output_invalid' && E.bucket.calls.upload === 0, r);
  }
  {
    const E = env({ probeThrows: Object.assign(new Error('spawn ENOENT'), { code: 'TOOL_MISSING' }) });
    E.bucket.put(NAME, MP4_HEAD, 12);
    const r = await processObject(E.deps, { name: NAME, generation: '12', size: MB });
    ck('S15 missing encoder binary → FAILED encoder_unavailable (our fault, not REJECTED as the uploader\'s)', r.state === 'FAILED' && r.reason === 'encoder_unavailable', r);
  }
  {
    const E = env();
    const r = await processObject(E.deps, { name: 'products/u1/p.jpg', generation: '1', size: MB });
    const r2 = await processObject(E.deps, { name: 'foundation-processed/u1/clip.mp4/1/main.mp4', generation: '1', size: MB });
    ck('S16 objects outside foundation-media/ (incl. our own derivatives) are ignored: no record, no download', r.skipped && r2.skipped && E.F.db._store.size === 0 && E.bucket.calls.download === 0);
    const N = 'foundation-media/u1/a/b.mp4';
    const r3 = await processObject(E.deps, { name: N, generation: '1', size: MB });
    ck('S17 a foundation-media path with an unexpected shape → REJECTED unsafe_path, never downloaded', r3.state === 'REJECTED' && (await E.rec(N)).error.reason === 'unsafe_path' && E.bucket.calls.download === 0, r3);
    const N2 = 'foundation-media/u1/big.mp4';
    const r4 = await processObject(E.deps, { name: N2, generation: '1', size: 81 * MB });
    ck('S18 81 MB (object metadata) → REJECTED too_large BEFORE download', r4.state === 'REJECTED' && r4.reason === 'too_large' && E.bucket.calls.download === 0, r4);
  }
  {
    let E;
    E = env({ onTranscode: async () => { await E.F.db.collection('foundationMedia').doc(R.mediaId(NAME)).update({ generation: '14', state: 'PROCESSING', attempts: 1 }); } });
    E.bucket.put(NAME, MP4_HEAD, 13);
    const r = await processObject(E.deps, { name: NAME, generation: '13', size: MB });
    const x = await E.rec(NAME);
    ck('S19 superseded mid-flight (a newer generation claimed the record) → the old run cannot write READY', r.state === 'superseded' && x.state === 'PROCESSING' && x.generation === '14', { r, x });
  }
  {
    const E = env({ src: { container: 'jpeg', vcodec: 'mjpeg', width: 4000, height: 3000, videoStreams: 1 } });
    const N = 'foundation-media/admin/visit.jpg';
    E.bucket.put(N, withExif(6, true), 3);
    const r = await processObject(E.deps, { name: N, generation: '3', size: 4 * MB });
    const x = await E.rec(N);
    ck('S20 admin photo → image pipeline (WebP main + JPEG thumb), EXIF orientation passed to the encoder, uploaderUid "admin"',
      r.state === 'READY' && x.kind === 'image' && x.uploaderUid === 'admin' && x.derivatives.main.path === 'foundation-processed/admin/visit.jpg/3/main.webp' && x.derivatives.main.contentType === 'image/webp' && E.tools.calls.lastOrientation === 6, x);
  }

  /* ── R: real ffmpeg ── */
  const bins = T.resolveBinaries();
  let freeMb = null;
  try { freeMb = Math.round(os.freemem() / MB); } catch (_) { /* unknown */ }
  if (!bins.ffmpeg || !bins.ffprobe) {
    blocked++; console.log('  BLOCKED  R*  real ffmpeg run — binaries not resolvable (npm install in media-worker/, or SOKONI_FFMPEG + SOKONI_FFPROBE). NOT a pass.');
  } else if (freeMb !== null && freeMb < 120) {
    blocked++; console.log('  BLOCKED  R*  real ffmpeg run — only ' + freeMb + ' MB free RAM. NOT a pass.');
  } else {
    const tools = T.makeTools({ binaries: bins });
    const work = fs.mkdtempSync(path.join(TMP, 'real-'));
    const gen = async (args) => { const r = await T.run(bins.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { cwd: work, timeoutMs: 120000 }); if (r.code !== 0) throw new Error('fixture ffmpeg failed: ' + r.stderr.slice(-400)); };
    const F = makeFakeFirestore();
    const bucket = fakeBucket();
    const deps = { db: F.db, bucket, FieldValue: F.FieldValue, tools, tmpRoot: TMP };
    const rec = async (name) => (await F.db.collection('foundationMedia').doc(R.mediaId(name)).get()).data();
    const fetchOut = (p, ext) => { const f = path.join(work, 'out-' + Math.random().toString(36).slice(2) + ext); fs.writeFileSync(f, bucket.objects.get(p).bytes); return f; };
    try {
      /* R1: 2 s 1920x1080 H.264 Main + AAC with a GPS location tag */
      const clip = path.join(work, 'clip.mp4');
      await gen(['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        '-metadata', 'location=+01.2921+036.8219/', '-metadata', 'title=SECRET-TITLE', '-movflags', 'use_metadata_tags', clip]);
      const N1 = 'foundation-media/u7/clip.mp4';
      bucket.put(N1, fs.readFileSync(clip), 1);
      const r1 = await processObject(deps, { name: N1, generation: '1', size: fs.statSync(clip).size });
      const x1 = await rec(N1);
      if (r1.state !== 'READY') console.log('     (R1 detail) ' + JSON.stringify({ r1, err: x1 && x1.error }));
      const main1 = x1 && x1.derivatives ? fetchOut(x1.derivatives.main.path, '.mp4') : null;
      const p1 = main1 ? await tools.probe(main1, 'mov') : null;
      ck('R1 REAL: 2 s 1080p clip → READY; derivative MEASURED as H.264 High 1280x720 + AAC in MP4', r1.state === 'READY' && p1 && p1.vcodec === 'h264' && /High/.test(p1.vprofile) && p1.width === 1280 && p1.height === 720 && p1.acodec === 'aac' && p1.container === 'mp4', { r1, p1 });
      ck('R2 REAL: +faststart — moov precedes mdat in the derivative (and NOT in the generated source)', main1 && T.isFaststart(main1) === true && T.isFaststart(clip) === false);
      const raw1 = main1 ? fs.readFileSync(main1).toString('latin1') : '';
      ck('R3 REAL: metadata stripped — no GPS location, no title in the derivative bytes', main1 && raw1.length > 0 && !/036\.8219|SECRET-TITLE/.test(raw1) && /036\.8219/.test(fs.readFileSync(clip).toString('latin1')));
      const th1 = x1 && x1.derivatives ? fetchOut(x1.derivatives.thumb.path, '.jpg') : null;
      const pt1 = th1 ? await tools.probe(th1, 'jpeg_pipe') : null;
      ck('R4 REAL: thumbnail exists, is a JPEG, 640x360', pt1 && pt1.vcodec === 'mjpeg' && pt1.width === 640 && pt1.height === 360, pt1);
      ck('R5 REAL: the record\'s probe describes the SOURCE (1920x1080, h264, aac, ~2 s, mp4)', x1 && x1.probe.width === 1920 && x1.probe.vcodec === 'h264' && x1.probe.acodec === 'aac' && Math.abs(x1.probe.durationSec - 2) < 0.2 && x1.probe.container === 'mp4', x1 && x1.probe);

      /* R6: plain text renamed .mp4 */
      const N2 = 'foundation-media/u7/fake.mp4';
      bucket.put(N2, 'Just some text, renamed to look like a video.\n'.repeat(20), 1);
      const r2 = await processObject(deps, { name: N2, generation: '1', size: 920 });
      ck('R6 REAL: a .txt renamed .mp4 → REJECTED unrecognised_format', r2.state === 'REJECTED' && (await rec(N2)).error.reason === 'unrecognised_format', r2);

      /* R7: valid magic bytes, garbage after — ffprobe must not accept it */
      const N3 = 'foundation-media/u7/trunc.mp4';
      bucket.put(N3, Buffer.concat([MP4_HEAD, Buffer.from('garbage'.repeat(50))]), 1);
      const r3 = await processObject(deps, { name: N3, generation: '1', size: 400 });
      ck('R7 REAL: an "ftyp" header followed by garbage → REJECTED (unreadable / no video), never READY', r3.state === 'REJECTED', { r3, e: (await rec(N3)).error });

      /* R8: 0.5 s clip → duration rejection by the REAL probe */
      const short = path.join(work, 'short.mp4');
      await gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', short]);
      const N4 = 'foundation-media/u7/short.mp4';
      bucket.put(N4, fs.readFileSync(short), 1);
      const r4 = await processObject(deps, { name: N4, generation: '1', size: fs.statSync(short).size });
      ck('R8 REAL: a 0.5 s clip → REJECTED duration_out_of_range', r4.state === 'REJECTED' && r4.reason === 'duration_out_of_range', r4);

      /* R9: small VP8 WebM → READY, not upscaled */
      const webm = path.join(work, 'small.webm');
      await gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1.5', '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', webm]);
      const N5 = 'foundation-media/u7/small.webm';
      bucket.put(N5, fs.readFileSync(webm), 1);
      const r5 = await processObject(deps, { name: N5, generation: '1', size: fs.statSync(webm).size });
      const x5 = await rec(N5);
      const p5 = x5 && x5.derivatives ? await tools.probe(fetchOut(x5.derivatives.main.path, '.mp4'), 'mov') : null;
      ck('R9 REAL: a VP8 WebM (no audio) → READY as H.264 MP4 at 320x240 (no upscale), source container recorded as webm',
        r5.state === 'READY' && x5.probe.container === 'webm' && x5.probe.vcodec === 'vp8' && p5 && p5.vcodec === 'h264' && p5.width === 320 && p5.height === 240 && !p5.acodec, { r5, p5, e: x5 && x5.error });

      /* R10: JPEG with EXIF orientation 6 + a GPS marker string → upright WebP, no EXIF */
      const jpg = path.join(work, 'photo.jpg');
      await gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1', '-frames:v', '1', '-q:v', '4', jpg]);
      const jb = fs.readFileSync(jpg);
      const withE = Buffer.concat([jb.subarray(0, 2), exif(6, false), jb.subarray(2)]);
      const N6 = 'foundation-media/u7/photo.jpg';
      bucket.put(N6, withE, 1);
      const r6 = await processObject(deps, { name: N6, generation: '1', size: withE.length });
      const x6 = await rec(N6);
      const m6 = x6 && x6.derivatives ? fetchOut(x6.derivatives.main.path, '.webp') : null;
      const p6 = m6 ? await tools.probe(m6, 'webp_pipe') : null;
      const b6 = m6 ? fs.readFileSync(m6).toString('latin1') : '';
      ck('R10 REAL: JPEG with EXIF orientation 6 → READY WebP rotated upright (240x320), EXIF/GPS gone from the derivative',
        r6.state === 'READY' && p6 && p6.vcodec === 'webp' && p6.width === 240 && p6.height === 320 && b6.length > 0 && !/Exif|EXIF|GPSLatitude/.test(b6), { r6, p6, e: x6 && x6.error });
      const t6 = x6 && x6.derivatives ? await tools.probe(fetchOut(x6.derivatives.thumb.path, '.jpg'), 'jpeg_pipe') : null;
      ck('R11 REAL: photo thumbnail is a JPEG ≤640 px, also upright', t6 && t6.vcodec === 'mjpeg' && t6.width === 240 && t6.height === 320, t6);
    } catch (e) {
      fail++; console.log('  FAIL  R*  real run crashed: ' + (e && e.stack || e));
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${pass} passed, ${fail} failed, ${blocked} blocked`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
