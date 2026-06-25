#!/usr/bin/env node
'use strict';
const https = require('https');
const fs    = require('fs');

const KEY  = process.env.TYPESENSE_ADMIN_KEY;
const HOST = '4kn6y5bfcxv8o702p-1.a2.typesense.net';
const OUT  = process.env.OUTPUT || '/tmp/typesense-snapshot.json';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: HOST, port: 443, path,
      headers: { 'X-TYPESENSE-API-KEY': KEY } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
  });
}

async function run() {
  const collections = await get('/collections');
  const snapshot = {
    timestamp:   new Date().toISOString(),
    collections: collections.map(c => ({
      name:            c.name,
      num_documents:   c.num_documents,
      fields:          c.fields,
      default_sorting_field: c.default_sorting_field,
    })),
    aliases: (await get('/aliases')).aliases || [],
  };
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`✅ Typesense snapshot: ${collections.length} collections → ${OUT}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
