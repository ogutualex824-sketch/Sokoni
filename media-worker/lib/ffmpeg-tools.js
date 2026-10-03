/* ============================================================================
   SOKONI media worker — the ffmpeg / ffprobe adapter
   ----------------------------------------------------------------------------
   Lessons carried over from the Stream packaging worker (8b78db3, feat/stream-media-delivery):
     * spawn and read BOTH streams regardless of exit code — ffmpeg reports on stderr and a
       successful run that is read with execFileSync returns nothing;
     * never parse ffmpeg's human stderr for facts — this adapter asks ffprobe for JSON instead
       (8b78db3's stderr regex broke on "yuv420p(tv, progressive)");
     * every output path is absolute inside a per-job temp directory, and the process runs with
       that directory as cwd, so nothing can be written outside the sandbox.

   Hardening for hostile input:
     * the demuxer is FORCED from the magic-byte family (-f mov / matroska / jpeg_pipe / …), so a
       crafted file cannot steer ffmpeg into a playlist/concat demuxer;
     * -protocol_whitelist file: no network or pipe protocols can be opened from inside a file;
     * hard wall-clock timeout per process (SIGKILL), bounded stdout/stderr capture.

   Binaries: ffmpeg-static and @ffprobe-installer/ffprobe (platform-specific optional packages, so
   only the linux-x64 ffprobe lands in the deployed image). SOKONI_FFMPEG / SOKONI_FFPROBE override
   the binaries for local development ONLY — they are ignored when running on Cloud Run (K_SERVICE).
   ============================================================================ */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('./media-rules');

function resolveBinaries() {
  const local = !process.env.K_SERVICE;
  let ffmpeg = local && process.env.SOKONI_FFMPEG ? process.env.SOKONI_FFMPEG : null;
  let ffprobe = local && process.env.SOKONI_FFPROBE ? process.env.SOKONI_FFPROBE : null;
  if (!ffmpeg) { try { ffmpeg = require('ffmpeg-static'); } catch (_) { ffmpeg = null; } }
  if (!ffprobe) { try { ffprobe = require('@ffprobe-installer/ffprobe').path; } catch (_) { ffprobe = null; } }
  return { ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : null, ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null };
}

class ToolError extends Error {
  constructor(code, message, stderrTail) { super(message); this.code = code; this.stderrTail = stderrTail || ''; }
}

function run(bin, args, { cwd, timeoutMs = 120000, maxOut = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '', killed = false;
    let child;
    try { child = cp.spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new ToolError('TOOL_MISSING', 'could not start ' + path.basename(String(bin)) + ': ' + e.message)); return; }
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < maxOut) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 16384) err = err.slice(-8192); });
    child.on('error', (e) => { clearTimeout(timer); reject(new ToolError(e.code === 'ENOENT' ? 'TOOL_MISSING' : 'TOOL_ERROR', e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new ToolError('TIMEOUT', path.basename(String(bin)) + ' exceeded ' + Math.round(timeoutMs / 1000) + 's', err.slice(-2000)));
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/* Top-level ISO-BMFF boxes: is `moov` before `mdat`? (what +faststart guarantees) */
function isFaststart(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const h = Buffer.alloc(16);
    let off = 0, moov = -1, mdat = -1, guard = 0;
    while (off + 8 <= size && guard++ < 4096) {
      fs.readSync(fd, h, 0, 16, off);
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (len === 1) len = Number(h.readBigUInt64BE(8));
      else if (len === 0) len = size - off;
      if (type === 'moov' && moov < 0) moov = off;
      if (type === 'mdat' && mdat < 0) mdat = off;
      if (len < 8) break;
      off += len;
    }
    return moov >= 0 && mdat >= 0 && moov < mdat;
  } finally { fs.closeSync(fd); }
}

function makeTools(opts = {}) {
  const bins = opts.binaries || resolveBinaries();
  const need = (k) => { if (!bins[k]) throw new ToolError('TOOL_MISSING', k + ' binary is not available'); return bins[k]; };
  const T = opts.timeouts || { probe: 60000, transcode: 470000, thumb: 60000 };

  async function probe(file, demuxer) {
    const args = ['-v', 'error', '-protocol_whitelist', 'file'];
    if (demuxer) args.push('-f', demuxer);
    args.push('-print_format', 'json', '-show_format', '-show_streams', file);
    const r = await run(need('ffprobe'), args, { cwd: path.dirname(file), timeoutMs: T.probe });
    let json = null;
    try { json = JSON.parse(r.stdout || '{}'); } catch (_) { json = null; }
    if (r.code !== 0 || !json || !Array.isArray(json.streams) || !json.streams.length) {
      throw new ToolError('UNREADABLE', 'ffprobe could not read the file', r.stderr.slice(-1000));
    }
    return R.normalizeProbe(json, fs.statSync(file).size);
  }

  async function ffmpeg(args, timeoutMs, cwd) {
    const r = await run(need('ffmpeg'), ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { cwd, timeoutMs });
    if (r.code !== 0) throw new ToolError('FFMPEG_FAILED', 'ffmpeg exited with code ' + r.code, r.stderr.slice(-2000));
    return r;
  }

  /* H.264 High + AAC, long side ≤ 1280 (no upscale), CRF 28, +faststart, metadata stripped.
     ffmpeg auto-rotates video by its display matrix, so the target size is computed from the
     DISPLAY dimensions. */
  async function transcodeVideo(src, demuxer, probeIn, out) {
    const d = R.fitDims(probeIn.displayWidth, probeIn.displayHeight, R.LIMITS.out.videoLong, true);
    await ffmpeg([
      '-protocol_whitelist', 'file', '-f', demuxer, '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', '-t', String(R.LIMITS.video.maxSec),
      '-vf', 'scale=' + d.width + ':' + d.height + ':flags=lanczos,setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', String(R.LIMITS.out.crf),
      '-maxrate', '4M', '-bufsize', '8M',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', '-sn', '-dn',
      '-movflags', '+faststart', '-f', 'mp4', out,
    ], T.transcode, path.dirname(out));
    return d;
  }
  /* Thumbnail from the CLEAN derivative (known codec), at ~1 s (or mid-point of a short clip). */
  async function videoThumb(mainMp4, durationSec, displayW, displayH, out) {
    const at = Math.max(0, Math.min(1, (Number(durationSec) || 0) / 2));
    const d = R.fitDims(displayW, displayH, R.LIMITS.out.thumbLong, true);
    await ffmpeg([
      '-protocol_whitelist', 'file', '-ss', at.toFixed(3), '-f', 'mp4', '-i', mainMp4,
      '-frames:v', '1', '-vf', 'scale=' + d.width + ':' + d.height + ':flags=lanczos',
      '-q:v', '4', '-map_metadata', '-1', '-c:v', 'mjpeg', '-f', 'image2', out,
    ], T.thumb, path.dirname(out));
    return d;
  }
  /* WebP, long side ≤ 1600, EXIF/GPS dropped. Auto-rotation is OFF and the JPEG EXIF orientation is
     applied explicitly, so the result is upright on every ffmpeg version and carries no metadata. */
  async function transcodeImage(src, demuxer, probeIn, orientation, out, thumbOut) {
    const o = orientation || 1;
    const sw = R.orientationSwaps(o);
    const W = sw ? probeIn.height : probeIn.width, H = sw ? probeIn.width : probeIn.height;
    const rot = R.ORIENT_FILTERS[o] || [];
    const main = R.fitDims(W, H, R.LIMITS.out.imageLong, false);
    const th = R.fitDims(W, H, R.LIMITS.out.thumbLong, true);
    const input = ['-noautorotate', '-protocol_whitelist', 'file', '-f', demuxer, '-i', src];
    await ffmpeg([...input, '-frames:v', '1', '-vf', [...rot, 'scale=' + main.width + ':' + main.height + ':flags=lanczos'].join(','),
      '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', out], T.transcode, path.dirname(out));
    await ffmpeg([...input, '-frames:v', '1', '-vf', [...rot, 'scale=' + th.width + ':' + th.height + ':flags=lanczos', 'format=yuvj420p'].join(','),
      '-q:v', '4', '-map_metadata', '-1', '-c:v', 'mjpeg', '-f', 'image2', thumbOut], T.thumb, path.dirname(thumbOut));
    return { main, thumb: th };
  }

  return { binaries: bins, probe, transcodeVideo, videoThumb, transcodeImage, isFaststart };
}

module.exports = { makeTools, resolveBinaries, isFaststart, run, ToolError };
