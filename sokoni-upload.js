/* ================================================================
   SOKONI — Media Upload Helper  (sokoni-upload.js)
   Handles video & image uploads to Firebase Storage with progress.
   Works on mobile: uses createObjectURL for preview (no RAM spike),
   then uploads the raw File to Storage on submit.
================================================================ */
import { storage } from './firebase.js';
import {
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

/**
 * Upload a File to Firebase Storage.
 * @param {File}     file       — the File object from an <input type="file">
 * @param {string}   path       — storage path, e.g. "videos/bnb/1234.mp4"
 * @param {Function} onProgress — optional callback(percent 0-100)
 * @returns {Promise<string>}   — download URL
 */
export async function uploadToStorage(file, path, onProgress) {
  const storageRef = ref(storage, path);
  const task       = uploadBytesResumable(storageRef, file);

  return new Promise((resolve, reject) => {
    task.on(
      'state_changed',
      snap => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
        if (onProgress) onProgress(pct);
      },
      err => reject(err),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve(url);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * Safe video preview — uses createObjectURL (zero memory overhead on mobile).
 * Call this instead of FileReader.readAsDataURL for any video element.
 * @param {File}            file      — video File
 * @param {HTMLVideoElement} videoEl  — the <video> element to preview into
 * @param {number}          maxMB     — max file size in MB (default 500)
 * @returns {{ ok: boolean, blobUrl: string, error?: string }}
 */
export function previewVideoFile(file, videoEl, maxMB = 500) {
  if (!file) return { ok: false, error: 'No file selected' };
  if (!file.type.startsWith('video/')) return { ok: false, error: 'Not a video file' };
  if (file.size > maxMB * 1024 * 1024) {
    return { ok: false, error: `Video must be under ${maxMB} MB` };
  }

  /* Revoke old blob URL if one exists */
  if (videoEl.src && videoEl.src.startsWith('blob:')) {
    URL.revokeObjectURL(videoEl.src);
  }

  const blobUrl = URL.createObjectURL(file);
  videoEl.src  = blobUrl;
  videoEl.load();

  return { ok: true, blobUrl };
}

/**
 * Show an inline upload progress bar.
 * Injects / updates a progress element inside containerEl.
 */
export function showUploadProgress(containerEl, percent) {
  let bar = containerEl.querySelector('.sokoni-upload-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'sokoni-upload-progress';
    bar.style.cssText = 'margin-top:10px;';
    bar.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);margin-bottom:4px;">
        <span>Uploading video…</span><span class="sup-pct">0%</span>
      </div>
      <div style="height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">
        <div class="sup-fill" style="height:100%;background:linear-gradient(90deg,#71ff00,#4fc800);border-radius:3px;width:0;transition:width .3s;"></div>
      </div>`;
    containerEl.appendChild(bar);
  }
  bar.querySelector('.sup-pct').textContent  = percent + '%';
  bar.querySelector('.sup-fill').style.width = percent + '%';
  if (percent >= 100) setTimeout(() => bar.remove(), 1000);
}

/* ================================================================
   PHASE 7 — Storage Optimization
   Image compression, WebP conversion, and responsive sizes
   before upload. Reduces Storage bandwidth and CDN egress costs.
================================================================ */

/**
 * Compress and convert an image File to WebP (or JPEG fallback).
 * Uses the Canvas API — works in all modern browsers and PWAs.
 *
 * @param {File}   file        — original image File
 * @param {object} opts
 *   maxW     {number}  max width in px  (default 1200)
 *   maxH     {number}  max height in px (default 1200)
 *   quality  {number}  0–1 WebP quality (default 0.82)
 *   format   {string}  'webp'|'jpeg'    (default 'webp')
 * @returns {Promise<Blob>}  compressed image blob
 */
export function compressImage(file, opts = {}) {
  const {
    maxW    = 1200,
    maxH    = 1200,
    quality = 0.82,
    format  = 'webp',
  } = opts;

  const mime = format === 'webp' ? 'image/webp' : 'image/jpeg';

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { naturalWidth: w, naturalHeight: h } = img;
      const ratio = Math.min(maxW / w, maxH / h, 1); // never upscale
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);

      const canvas  = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        blob => {
          if (!blob) reject(new Error('Canvas compression failed'));
          else       resolve(blob);
        },
        mime,
        quality
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

/**
 * Upload an image with automatic compression + WebP conversion.
 * Falls back to uploading the original file if compression fails.
 *
 * @param {File}     file
 * @param {string}   storagePath  — e.g. "product-images/uid/photo.webp"
 * @param {object}   opts         — same as compressImage options
 * @param {Function} onProgress   — optional(pct 0-100)
 * @returns {Promise<string>}     — download URL
 */
export async function uploadImage(file, storagePath, opts = {}, onProgress) {
  /* Only compress actual images */
  if (!file.type.startsWith('image/')) {
    return uploadToStorage(file, storagePath, onProgress);
  }

  let blob;
  try {
    blob = await compressImage(file, opts);
  } catch {
    /* Compression failed — upload original */
    blob = file;
  }

  /* Replace extension with .webp in the path */
  const finalPath = opts.format === 'jpeg'
    ? storagePath.replace(/\.[^.]+$/, '.jpg')
    : storagePath.replace(/\.[^.]+$/, '.webp');

  const compressedFile = new File([blob], finalPath.split('/').pop(), { type: blob.type });
  return uploadToStorage(compressedFile, finalPath, onProgress);
}

/**
 * Generate three responsive WebP sizes for a product/listing image.
 * Uploads: thumb (320px), medium (640px), large (1200px).
 *
 * @param {File}     file
 * @param {string}   basePath    — e.g. "product-images/uid/item123"
 * @param {Function} onProgress  — optional(overall pct 0-100)
 * @returns {Promise<{thumb, medium, large}>}  — three download URLs
 */
export async function uploadResponsiveImage(file, basePath, onProgress) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }

  const sizes = [
    { key: 'thumb',  maxW: 320,  maxH: 320,  quality: 0.75 },
    { key: 'medium', maxW: 640,  maxH: 640,  quality: 0.80 },
    { key: 'large',  maxW: 1200, maxH: 1200, quality: 0.85 },
  ];

  const urls    = {};
  const total   = sizes.length;
  let   doneIdx = 0;

  for (const size of sizes) {
    const blob = await compressImage(file, { ...size, format: 'webp' });
    const path = `${basePath}_${size.key}.webp`;
    const f    = new File([blob], path.split('/').pop(), { type: 'image/webp' });

    urls[size.key] = await uploadToStorage(f, path, pct => {
      if (onProgress) onProgress(Math.round((doneIdx / total + pct / 100 / total) * 100));
    });
    doneIdx++;
    if (onProgress) onProgress(Math.round((doneIdx / total) * 100));
  }

  return urls; // { thumb, medium, large }
}

/* Expose for non-module inline scripts via window */
window.SokoniUpload = { uploadToStorage, previewVideoFile, showUploadProgress, compressImage, uploadImage, uploadResponsiveImage };
window.dispatchEvent(new CustomEvent('sokoniUploadReady'));
