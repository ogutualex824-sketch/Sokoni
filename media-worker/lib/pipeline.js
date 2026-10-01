/* ============================================================================
   SOKONI media worker — the pipeline / state machine
   ----------------------------------------------------------------------------
   UPLOAD → QUARANTINE → VALIDATE → TRANSCODE/COMPRESS → THUMBNAIL → SAFE STORAGE → READY

     UPLOAD      the browser writes foundation-media/{uid|admin}/{file}. storage.rules: private
                 (read: false) — the upload path IS the quarantine; nothing public ever points at it.
     QUARANTINE  the worker downloads exactly the GENERATION named by the event into a private temp
                 dir. The source object is never modified, moved or deleted.
     VALIDATE    magic bytes → (only if a known family) ffprobe with a FORCED demuxer → rules.
                 Unknown bytes are REJECTED without being probed or decoded.
     TRANSCODE   video → H.264 High + AAC ≤1280px +faststart; image → WebP ≤1600px, EXIF/GPS gone.
     THUMBNAIL   JPEG ≤640px.
     VERIFY      the derivative is PROBED again; a derivative that does not measure right is FAILED.
     STORE       foundation-processed/{uid|admin}/{file}/{generation}/main.mp4|main.webp + thumb.jpg
                 (closed to clients; only download-token copies made at publish time are public).
     READY       written LAST, in a transaction that still owns the claim.

   Record foundationMedia/{sha256(path)[0:32]} — written ONLY here (admin SDK; no rules match):
       UPLOADED → PROCESSING → READY | FAILED | REJECTED
   Idempotent: a terminal record for the SAME object generation is never reprocessed; a
   PROCESSING record with a live lease is left alone (duplicate delivery); an event for an OLDER
   generation than the record is ignored; a NEW generation (delete + re-upload at the same path)
   starts again from PROCESSING with the derivatives cleared.
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./media-rules');

const LEASE_MS = 10 * 60 * 1000;   /* > the 540 s function timeout */
const MAX_ATTEMPTS = 3;

const genNum = (g) => { try { return BigInt(String(g)); } catch (_) { return null; } };
const isAlreadyExists = (e) => e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(e.message || ''));

async function processObject(deps, obj) {
  const { db, bucket, FieldValue } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const name = obj && obj.name;
  if (!R.isFoundationUpload(name)) return { skipped: 'not_foundation_media' };
  const gen = String(obj.generation == null ? '' : obj.generation);
  const id = R.mediaId(name);
  const ref = db.collection(R.COLLECTION).doc(id);
  const parsed = R.parseUploadPath(name);
  const ts = () => FieldValue.serverTimestamp();

  /* 1. first sight: UPLOADED (create — never get()+set()) */
  try {
    await ref.create({
      sourcePath: name, uploaderUid: parsed ? (parsed.owner === 'admin' ? 'admin' : parsed.owner) : null,
      kind: null, state: R.STATES.UPLOADED, generation: gen, probe: null, derivatives: null, error: null,
      attempts: 0, leaseUntil: null, createdAt: ts(), updatedAt: ts(),
    });
  } catch (e) { if (!isAlreadyExists(e)) throw e; }

  /* 2. claim: → PROCESSING */
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const r = s.data() || {};
    if (r.sourcePath && r.sourcePath !== name) return { skip: 'id_collision' };
    const rg = genNum(r.generation), eg = genNum(gen);
    if (rg !== null && eg !== null && eg < rg) return { skip: 'stale_generation' };
    const sameGen = String(r.generation) === gen;
    if (sameGen && R.TERMINAL.has(r.state)) return { skip: 'terminal:' + r.state };
    if (sameGen && r.state === R.STATES.PROCESSING && Number(r.leaseUntil) > now()) return { skip: 'in_progress' };
    const attempts = sameGen ? (Number(r.attempts) || 0) + 1 : 1;
    if (attempts > MAX_ATTEMPTS) {
      tx.update(ref, { state: R.STATES.FAILED, error: { reason: 'too_many_attempts', message: 'Processing did not finish after ' + MAX_ATTEMPTS + ' attempts.' }, leaseUntil: null, updatedAt: ts() });
      return { skip: 'gave_up' };
    }
    tx.update(ref, {
      state: R.STATES.PROCESSING, previousState: r.state || null, generation: gen, attempts,
      leaseUntil: now() + LEASE_MS, error: null,
      ...(sameGen ? {} : { kind: null, probe: null, derivatives: null }),
      updatedAt: ts(),
    });
    return { attempts };
  });
  if (claim.skip) { log.info('[media-worker] skip', { id, reason: claim.skip }); return { id, skipped: claim.skip }; }

  /* every later write must still own the claim (same generation, same attempt, still PROCESSING) */
  async function finish(state, fields) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const r = s.data() || {};
      if (String(r.generation) !== gen || r.state !== R.STATES.PROCESSING || Number(r.attempts) !== claim.attempts) return false;
      tx.update(ref, { ...fields, state, leaseUntil: null, updatedAt: ts(), finishedAt: ts() });
      return true;
    });
  }
  const rejectWith = async (v, extra) => {
    const ok = await finish(R.STATES.REJECTED, { error: { reason: v.reason, message: v.message, detail: v.detail || null }, ...(extra || {}) });
    log.info('[media-worker] rejected', { id, reason: v.reason });
    return { id, state: ok ? R.STATES.REJECTED : 'superseded', reason: v.reason };
  };

  if (!parsed) return rejectWith({ reason: 'unsafe_path', message: R.REASONS.unsafe_path });
  const pre = R.precheckSize(obj.size);
  if (!pre.ok) return rejectWith(pre);

  const work = fs.mkdtempSync(path.join(deps.tmpRoot || os.tmpdir(), 'fmw-'));
  try {
    const src = path.join(work, 'source');   /* no extension: nothing downstream may trust one */
    await bucket.file(name, gen ? { generation: gen } : undefined).download({ destination: src });
    const size = fs.statSync(src).size;
    const head = Buffer.alloc(Math.min(65536, size));
    if (head.length) { const fd = fs.openSync(src, 'r'); try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); } }
    const sniffed = R.sniff(head);
    if (!sniffed) return await rejectWith(R.validate({ sniffed: null, probe: null, sizeBytes: size }));

    let probe;
    try { probe = await deps.tools.probe(src, sniffed.demuxer); }
    catch (e) {
      if (e && e.code === 'UNREADABLE') return await rejectWith({ reason: 'unreadable', message: R.REASONS.unreadable });
      throw e;   /* a missing binary / timeout is OUR failure, not the uploader's */
    }
    const v = R.validate({ sniffed, probe, sizeBytes: size });
    if (!v.ok) return await rejectWith(v, { kind: sniffed.kind, probe: R.recordProbe(probe) });

    const prefix = R.derivativePrefix(parsed.sub, gen || 'nogen');
    let derivatives;
    if (v.kind === 'video') {
      const mainOut = path.join(work, 'main.mp4'), thumbOut = path.join(work, 'thumb.jpg');
      await deps.tools.transcodeVideo(src, sniffed.demuxer, probe, mainOut);
      await deps.tools.videoThumb(mainOut, probe.durationSec, probe.displayWidth, probe.displayHeight, thumbOut);
      const pm = await deps.tools.probe(mainOut, 'mov');
      const errs = R.checkVideoOutput(pm, deps.tools.isFaststart(mainOut)).concat(R.checkThumbOutput(await deps.tools.probe(thumbOut, 'jpeg_pipe')));
      if (errs.length) throw Object.assign(new Error('derivative check failed: ' + errs.join('; ')), { code: 'OUTPUT_INVALID' });
      derivatives = {
        main: { path: prefix + 'main.mp4', contentType: 'video/mp4', size: fs.statSync(mainOut).size, width: pm.displayWidth, height: pm.displayHeight, durationSec: pm.durationSec },
        thumb: { path: prefix + 'thumb.jpg', contentType: 'image/jpeg', size: fs.statSync(thumbOut).size },
      };
      await upload(bucket, mainOut, derivatives.main);
      await upload(bucket, thumbOut, derivatives.thumb);
    } else {
      const mainOut = path.join(work, 'main.webp'), thumbOut = path.join(work, 'thumb.jpg');
      const orientation = sniffed.family === 'jpeg' ? R.jpegOrientation(head) : 1;
      await deps.tools.transcodeImage(src, sniffed.demuxer, probe, orientation, mainOut, thumbOut);
      const pm = await deps.tools.probe(mainOut, 'webp_pipe');
      const errs = R.checkImageOutput(pm).concat(R.checkThumbOutput(await deps.tools.probe(thumbOut, 'jpeg_pipe')));
      if (errs.length) throw Object.assign(new Error('derivative check failed: ' + errs.join('; ')), { code: 'OUTPUT_INVALID' });
      derivatives = {
        main: { path: prefix + 'main.webp', contentType: 'image/webp', size: fs.statSync(mainOut).size, width: pm.width, height: pm.height },
        thumb: { path: prefix + 'thumb.jpg', contentType: 'image/jpeg', size: fs.statSync(thumbOut).size },
      };
      await upload(bucket, mainOut, derivatives.main);
      await upload(bucket, thumbOut, derivatives.thumb);
    }
    const ok = await finish(R.STATES.READY, { kind: v.kind, probe: R.recordProbe(probe), derivatives, error: null });
    log.info('[media-worker] ready', { id, kind: v.kind, written: ok });
    return { id, state: ok ? R.STATES.READY : 'superseded', kind: v.kind, derivatives };
  } catch (e) {
    const reason = e && e.code === 'OUTPUT_INVALID' ? 'output_invalid'
      : e && e.code === 'TIMEOUT' ? 'timeout'
      : e && e.code === 'FFMPEG_FAILED' ? 'transcode_failed'
      : e && e.code === 'TOOL_MISSING' ? 'encoder_unavailable' : 'internal';
    log.error('[media-worker] failed', { id, reason, err: String(e && e.message || e).slice(0, 300), stderr: String(e && e.stderrTail || '').slice(-600) });
    let ok = false;
    try { ok = await finish(R.STATES.FAILED, { error: { reason, message: 'The file could not be processed. Upload it again or try a different file.' } }); }
    catch (e2) { log.error('[media-worker] could not record FAILED', { id, err: e2.message }); }
    return { id, state: ok ? R.STATES.FAILED : 'superseded', reason };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* tmp is per-instance */ }
  }
}

async function upload(bucket, local, d) {
  await bucket.upload(local, {
    destination: d.path, resumable: false,
    metadata: { contentType: d.contentType, cacheControl: 'private, max-age=0, no-store' },
  });
}

module.exports = { processObject, LEASE_MS, MAX_ATTEMPTS };
