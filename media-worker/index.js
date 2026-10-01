/* ============================================================================
   SOKONI media worker codebase (firebase.json → functions[codebase="media-worker"])
   ----------------------------------------------------------------------------
   A SEPARATE functions codebase so the ffmpeg/ffprobe binaries (~80 MB) never enter the images of
   the ~1,700 main functions. Deploy ONLY this function:

       firebase deploy --only functions:media-worker:foundationMediaProcess

   foundationMediaProcess — Storage finalize trigger on the default bucket. It acts ONLY on
   foundation-media/** and returns immediately for every other object (the event filter cannot be
   narrowed to a prefix; see docs/FOUNDATION_MEDIA_PIPELINE.md for the cost note). The tool chain is
   loaded lazily, after the prefix check, so unrelated uploads cost one cheap invocation.

   Region us-central1: the default bucket is the US multi-region; a Storage trigger's function must
   be in (or compatible with) the bucket's location.
   ============================================================================ */
'use strict';
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const BUCKET = 'sokoni-aeb26.firebasestorage.app';
let pipeline = null, tools = null;

exports.foundationMediaProcess = onObjectFinalized({
  bucket: BUCKET,
  region: 'us-central1',
  memory: '2GiB',
  cpu: 2,
  timeoutSeconds: 540,
  maxInstances: 3,
  concurrency: 1,
  retry: false,
}, async (event) => {
  const o = event.data || {};
  if (typeof o.name !== 'string' || !o.name.startsWith('foundation-media/')) return;
  if (!pipeline) {
    pipeline = require('./lib/pipeline');
    tools = require('./lib/ffmpeg-tools').makeTools();
  }
  const r = await pipeline.processObject({
    db: admin.firestore(),
    bucket: admin.storage().bucket(o.bucket || BUCKET),
    FieldValue: admin.firestore.FieldValue,
    tools,
    log: logger,
  }, { name: o.name, generation: o.generation, size: Number(o.size), contentType: o.contentType });
  logger.info('[media-worker] done', { id: r.id || null, state: r.state || null, skipped: r.skipped || null, reason: r.reason || null });
});
