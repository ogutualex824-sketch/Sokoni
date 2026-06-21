/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — AI Import Engine
   Supports: CSV, JSON, Google Sheets (URL), supplier catalog URLs.
   AI maps columns, deduplicates, validates, and commits in batches.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin  = require('firebase-admin');
const https  = require('https');

const { assertAuth } = require('./shared/errors');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CF_OPTS = { region: 'us-central1', memory: '1GiB', timeoutSeconds: 300, secrets: [ANTHROPIC_API_KEY] };
const AI_MODEL = 'claude-haiku-4-5-20251001';

const PRODUCT_SCHEMA = {
  name       : { required: true,  type: 'string',  aliases: ['product name', 'item name', 'description', 'item'] },
  sku        : { required: false, type: 'string',  aliases: ['sku', 'code', 'item code', 'product code', 'barcode'] },
  category   : { required: false, type: 'string',  aliases: ['category', 'dept', 'department', 'type'] },
  costPrice  : { required: false, type: 'number',  aliases: ['cost', 'buying price', 'purchase price', 'cost price', 'unit cost'] },
  sellingPrice:{ required: false, type: 'number',  aliases: ['price', 'selling price', 'sale price', 'retail price', 'mrp'] },
  qty        : { required: false, type: 'number',  aliases: ['qty', 'quantity', 'stock', 'on hand', 'opening stock', 'units'] },
  unit       : { required: false, type: 'string',  aliases: ['unit', 'uom', 'unit of measure', 'pack size'] },
  supplier   : { required: false, type: 'string',  aliases: ['supplier', 'vendor', 'manufacturer', 'brand'] },
  reorderPoint:{required: false, type: 'number',  aliases: ['reorder point', 'min stock', 'minimum', 'reorder level'] },
  barcode    : { required: false, type: 'string',  aliases: ['barcode', 'ean', 'upc', 'isbn', 'gtin'] },
  expiryDate : { required: false, type: 'date',   aliases: ['expiry', 'expiry date', 'best before', 'use by'] },
  notes      : { required: false, type: 'string',  aliases: ['notes', 'remarks', 'comments', 'description'] },
};

function _autoMapColumns(headers) {
  const mappings = {};
  const lowHeaders = headers.map(h => h.toLowerCase().trim());
  Object.entries(PRODUCT_SCHEMA).forEach(([field, def]) => {
    for (const alias of def.aliases) {
      const idx = lowHeaders.findIndex(h => h.includes(alias) || alias.includes(h));
      if (idx !== -1) { mappings[field] = headers[idx]; break; }
    }
  });
  return mappings;
}

function callAnthropic(apiKey, messages, system, maxTokens = 800) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, system, messages });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw).content?.[0]?.text || ''); } catch { resolve(''); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── AI column mapping ───────────────────────────────────────────── */
exports.inventoryImportAiMap = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { headers, sampleRows } = req.data;
  if (!headers?.length) throw new Error('No headers provided');

  const apiKey = ANTHROPIC_API_KEY.value();
  const auto   = _autoMapColumns(headers);
  const unmapped = Object.keys(PRODUCT_SCHEMA).filter(f => !auto[f]);

  if (!unmapped.length) return { mappings: auto, confidence: 1, aiUsed: false };

  const system = `You are a data mapping assistant for inventory systems. Return ONLY valid JSON, no explanations.`;
  const prompt = `Map these CSV headers to inventory schema fields.

CSV Headers: ${JSON.stringify(headers)}
Sample row: ${JSON.stringify(sampleRows?.[0] || {})}

Schema fields available: ${unmapped.join(', ')}
Already mapped: ${JSON.stringify(auto)}

Return JSON: { "mappings": { "schemaField": "csvHeader" }, "confidence": 0.0-1.0, "warnings": [] }
Only map fields you're confident about. Skip ambiguous ones.`;

  let aiMappings = {};
  let confidence = 0.7;
  try {
    const raw = await callAnthropic(apiKey, [{ role: 'user', content: prompt }], system, 600);
    const parsed = JSON.parse(raw);
    aiMappings = parsed.mappings || {};
    confidence  = parsed.confidence || 0.7;
  } catch (_) {}

  return { mappings: { ...auto, ...aiMappings }, confidence, aiUsed: true };
});

/* ── Preview import (validate before commit) ─────────────────────── */
exports.inventoryImportPreview = onCall({ region: 'us-central1', memory: '512MiB', timeoutSeconds: 60 }, async req => {
  const uid = assertAuth(req);
  const { tenantId, rows, mappings } = req.data;
  const resolvedTenant = tenantId || uid;

  if (!rows?.length) throw new Error('No rows provided');

  const results  = { valid: [], invalid: [], duplicates: [], total: rows.length };

  /* Load existing barcodes/SKUs for dedup check */
  const existingSnap = await db.collection(`tenants/${resolvedTenant}/inventory_products`)
    .select(['sku', 'barcode', 'name']).limit(5000).get();
  const existingSkus     = new Set(existingSnap.docs.map(d => d.data().sku).filter(Boolean));
  const existingBarcodes = new Set(existingSnap.docs.map(d => d.data().barcode).filter(Boolean));
  const existingNames    = new Set(existingSnap.docs.map(d => d.data().name?.toLowerCase()).filter(Boolean));

  for (const row of rows.slice(0, 200)) {
    const mapped = {};
    Object.entries(mappings || {}).forEach(([field, header]) => { mapped[field] = row[header]; });

    const errors = [];
    if (!mapped.name?.trim())       errors.push('Name is required');
    if (mapped.costPrice   && isNaN(Number(mapped.costPrice)))    errors.push('Cost price must be a number');
    if (mapped.sellingPrice && isNaN(Number(mapped.sellingPrice))) errors.push('Selling price must be a number');
    if (mapped.qty         && isNaN(Number(mapped.qty)))          errors.push('Quantity must be a number');

    const isDupSku     = mapped.sku     && existingSkus.has(mapped.sku);
    const isDupBarcode = mapped.barcode && existingBarcodes.has(mapped.barcode);
    const isDupName    = mapped.name    && existingNames.has(mapped.name?.toLowerCase());

    const clean = {
      name        : mapped.name?.trim(),
      sku         : mapped.sku?.trim() || null,
      barcode     : mapped.barcode?.trim() || null,
      category    : mapped.category?.trim() || 'General',
      costPrice   : Number(mapped.costPrice)    || 0,
      sellingPrice: Number(mapped.sellingPrice) || 0,
      qty         : Number(mapped.qty)          || 0,
      unit        : mapped.unit?.trim()         || 'pcs',
      supplier    : mapped.supplier?.trim()     || null,
      reorderPoint: Number(mapped.reorderPoint) || 5,
      notes       : mapped.notes?.trim()        || null,
    };

    if (errors.length) { results.invalid.push({ row, errors }); continue; }
    if (isDupSku || isDupBarcode || isDupName) {
      results.duplicates.push({ row: clean, reason: isDupSku ? 'SKU exists' : isDupBarcode ? 'Barcode exists' : 'Name exists' });
      continue;
    }
    results.valid.push(clean);
  }

  /* Store preview job */
  const jobRef = db.collection(`tenants/${resolvedTenant}/inventory_import_jobs`).doc();
  await jobRef.set({
    status     : 'preview',
    filename   : req.data.filename || 'import',
    total      : results.total,
    valid      : results.valid.length,
    invalid    : results.invalid.length,
    duplicates : results.duplicates.length,
    mappings,
    validRows  : results.valid,
    userId     : uid,
    createdAt  : admin.firestore.FieldValue.serverTimestamp(),
  });

  return { jobId: jobRef.id, ...results, previewOnly: true };
});

/* ── Commit import ───────────────────────────────────────────────── */
exports.inventoryImportCommit = onCall({ region: 'us-central1', memory: '1GiB', timeoutSeconds: 300 }, async req => {
  const uid = assertAuth(req);
  const { jobId, tenantId } = req.data;
  const resolvedTenant = tenantId || uid;

  const jobRef  = db.collection(`tenants/${resolvedTenant}/inventory_import_jobs`).doc(jobId);
  const jobDoc  = await jobRef.get();
  if (!jobDoc.exists) throw new Error('Import job not found');
  const job = jobDoc.data();
  if (job.status !== 'preview') throw new Error('Job must be in preview state to commit');

  await jobRef.update({ status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() });

  const rows      = job.validRows || [];
  const BATCH_SZ  = 400;
  let   imported  = 0;
  let   errors    = 0;

  for (let i = 0; i < rows.length; i += BATCH_SZ) {
    const chunk = rows.slice(i, i + BATCH_SZ);
    const batch = db.batch();
    const now   = admin.firestore.Timestamp.now();

    chunk.forEach(row => {
      const prodRef = db.collection(`tenants/${resolvedTenant}/inventory_products`).doc();
      batch.set(prodRef, {
        ...row,
        tenantId  : resolvedTenant,
        active    : true,
        source    : 'import',
        importJobId: jobId,
        createdAt : now,
        updatedAt : now,
      });

      /* Opening stock movement */
      if (row.qty > 0) {
        const mvRef = db.collection(`tenants/${resolvedTenant}/inventory_movements`).doc();
        batch.set(mvRef, {
          productId   : prodRef.id,
          warehouseId : 'default',
          type        : 'opening_stock',
          qty         : row.qty,
          reason      : `Imported from ${job.filename}`,
          importJobId : jobId,
          userId      : uid,
          ts          : now,
        });
        /* Set opening stock level */
        const lvlRef = db.collection(`tenants/${resolvedTenant}/inventory_levels`).doc(`${prodRef.id}:base:default`);
        batch.set(lvlRef, {
          productId   : prodRef.id,
          variantId   : 'base',
          warehouseId : 'default',
          available   : row.qty,
          reserved    : 0,
          incoming    : 0,
          damaged     : 0,
          updatedAt   : now,
        });
      }
      imported++;
    });

    try { await batch.commit(); }
    catch (err) { errors += chunk.length; imported -= chunk.length; console.error('Batch commit error:', err.message); }
  }

  await jobRef.update({
    status     : errors > 0 ? 'partial' : 'completed',
    imported,
    errors,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { jobId, imported, errors, status: errors > 0 ? 'partial' : 'completed' };
});

/* ── Get Import Jobs ─────────────────────────────────────────────── */
exports.inventoryGetImportJobs = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  const uid = assertAuth(req);
  const { tenantId, limit = 10 } = req.data;
  const resolvedTenant = tenantId || uid;

  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_import_jobs`)
    .orderBy('createdAt', 'desc').limit(limit).get();

  return { jobs: snap.docs.map(d => ({ id: d.id, ...d.data(), validRows: undefined })) };
});
