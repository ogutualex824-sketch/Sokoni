# Foundation Media Pipeline

> Status (2026-10-03): **built, tested, NOT deployed.** Branch `feat/foundation-on-3a38f35` (merged from `feat/foundation-media-worker-on-3b56f40`).
> Related: [[SOKONI_FOUNDATION]] · [[FINANCIAL_PARTNER_WORKSPACE]] · [[BANKING_HUB_FOUNDATION_CERTIFICATION_2026-10-01]]

## Flow
UPLOAD → QUARANTINE → VALIDATE → TRANSCODE/COMPRESS → THUMBNAIL → SAFE STORAGE → PUBLISHABLE ASSET

1. **Upload.** The browser uploads to `foundation-media/{uid}/…` (testimonials) or `foundation-media/admin/…` (Media House).
   - Storage rules allow images up to 15 MB and videos up to 80 MB.
   - Uploads are private: nothing is readable through the rules.
2. **Worker.** `foundationMediaProcess` (codebase `media-worker`, storage finalize trigger) runs in its own functions codebase, so ffmpeg never enters the main functions images. It records `foundationMedia/{sha256(path)[0:32]}`, which only the worker writes, with the states UPLOADED → PROCESSING → READY | FAILED | REJECTED.
   - Validation checks magic bytes first, then ffprobe. Extension and MIME type are not trusted.
   - **Video:** container mp4/mov/webm/mkv; codec h264, hevc, vp8, vp9 or av1; duration 1–600 s; resolution ≤ 3840 px.
   - **Image:** real JPEG, PNG or WebP; ≤ 8000 px.
   - **Output, video:** H.264 High + AAC, ≤ 1280 px, CRF 28, faststart, metadata stripped.
   - **Output, image:** WebP, ≤ 1600 px, upright, EXIF and GPS removed.
   - **Thumbnail:** JPEG, ≤ 640 px.
   - Derivatives are measured again before the record is marked READY, and are stored at `foundation-processed/{owner}/{file}/{generation}/`. The source is never modified.
   - The worker is idempotent per object generation, holds a lease, allows at most 3 attempts, and a superseded run cannot write READY.
3. **Publish** (`foundationContentDispatch.adminPublish`):
   - It is **refused** unless every attached item's record is READY. PROCESSING reads "still processing"; REJECTED/FAILED shows the reason.
   - It copies the **derivative** (main + thumbnail) to `foundation-published/{storyId}/…` with a download token. The original upload is never published.
   - `foundationStoryMediaGuard` deletes the public copies on any non-published state (unpublish, archive, remove, consent withdrawal).
4. **Public pages** consume only those READY derivative copies.

## Limits
The 80 MB upload cap stays until the worker is proven in Cloud. Raising it needs measured memory, timeout and cost data (owner brief §19).

## Deploy
`firebase deploy --only functions:media-worker:foundationMediaProcess` (named codebase scope).
- The trigger region must match the bucket's region.
- Deploy `--only storage` for the rules: `foundation-processed/` is closed to every client.
- Never run a bare `--only functions`; it would now deploy both codebases.

## Evidence
- `scripts/test-foundation-media-worker.js`: 42/0, including 11 REAL ffmpeg 9.0.1 runs (with `SOKONI_FFMPEG`/`SOKONI_FFPROBE` set; without them the real cases report BLOCKED, never PASS).
- `scripts/test-foundation-content.js`: 29/0. M1–M3 cover the READY gate and derivative-only publishing. Sabotaging the READY gate was caught by M1/M3.
- **UNPROVEN:**
  - no Cloud run of the worker
  - the Storage emulator suite has not been run (RAM)
