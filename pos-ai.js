/* SOKONI SmartPOS — AI Product Import Engine v1.0
   Handles: Excel/CSV (SheetJS), PDF (pdf.js), Images (Claude API via Cloud Function)
   Smart column mapping, preview + edit before commit, auto barcode generation. */

'use strict';

const PosAI = (() => {

  let _preview = [];   // staged products awaiting confirmation
  let _onConfirmCb = null;

  /* ── Entry point ────────────────────────────────────────────────── */
  async function importFile(file, onConfirm) {
    _onConfirmCb = onConfirm || null;
    const ext = file.name.split('.').pop().toLowerCase();
    let products;

    _setStatus('Detecting file format...', 'info');

    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      products = await _importExcel(file);
    } else if (ext === 'pdf') {
      products = await _importPDF(file);
    } else if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp'].includes(ext)) {
      products = await _importImage(file);
    } else {
      throw new Error('Unsupported format. Use Excel (.xlsx/.csv), PDF, or an image of a price list.');
    }

    if (!products || !products.length) throw new Error('No products could be extracted from this file.');
    _setStatus(`Found ${products.length} products — review before importing`, 'success');
    _showPreview(products);
  }

  /* ── Excel / CSV import via SheetJS ─────────────────────────────── */
  async function _importExcel(file) {
    _setStatus('Loading spreadsheet...', 'info');

    if (!window.XLSX) {
      _setStatus('Downloading Excel parser...', 'info');
      await _loadScript('https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js');
    }

    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];

    /* Try JSON first (handles merged cells better) */
    const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (jsonRows.length > 0) {
      return _jsonRowsToProducts(jsonRows);
    }

    /* Fallback to array-of-arrays */
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (aoa.length < 2) throw new Error('Spreadsheet is empty or has only one row.');

    /* Find header row */
    let hIdx = 0;
    for (let i = 0; i < Math.min(6, aoa.length); i++) {
      if (aoa[i].filter(c => String(c).trim().length > 0).length >= 2) { hIdx = i; break; }
    }

    const headers = aoa[hIdx].map(h => String(h || '').trim().toLowerCase());
    const dataRows = aoa.slice(hIdx + 1).filter(r => r.some(c => c !== ''));
    return _mapRowsToProducts(headers, dataRows);
  }

  function _jsonRowsToProducts(rows) {
    if (!rows.length) return [];
    /* Get all keys and normalize */
    const sampleKeys = Object.keys(rows[0]).map(k => k.trim().toLowerCase());
    const map = {
      name:     _findKey(sampleKeys, ['name','product','item','description','desc','product name','item name','maelezo','jina']),
      price:    _findKey(sampleKeys, ['price','selling price','retail','sell','bei','unit price','rate','amount']),
      cost:     _findKey(sampleKeys, ['cost','buy price','purchase','buying','cost price','wholesale']),
      barcode:  _findKey(sampleKeys, ['barcode','ean','upc','code','sku','product code','item code','part no']),
      stock:    _findKey(sampleKeys, ['stock','qty','quantity','units','pieces','available','on hand','inventory','stock qty']),
      category: _findKey(sampleKeys, ['category','type','dept','department','section','group','cat']),
      unit:     _findKey(sampleKeys, ['unit','uom','measure','per','unit of measure']),
      expiry:   _findKey(sampleKeys, ['expiry','expiration','exp','best before','expire','use by','bb date']),
      taxRate:  _findKey(sampleKeys, ['tax','vat','tax rate','vat rate']),
    };

    const allKeys = Object.keys(rows[0]);

    return rows
      .map(row => {
        const get = key => key ? String(row[allKeys.find(k => k.trim().toLowerCase() === key) || ''] || '').trim() : '';
        const name = get(map.name);
        if (!name || name.toLowerCase() === 'name') return null;

        const price = _parseNum(get(map.price));
        return {
          name,
          price:     price || 0,
          cost:      _parseNum(get(map.cost)) || 0,
          barcode:   get(map.barcode) || null,
          stock:     Math.max(0, parseInt(get(map.stock)) || 0),
          category:  _mapCategory(get(map.category)),
          unit:      _normalizeUnit(get(map.unit)),
          expiryDate:_parseDate(get(map.expiry)),
          taxRate:   _parseNum(get(map.taxRate)) || 0,
        };
      })
      .filter(Boolean);
  }

  function _mapRowsToProducts(headers, rows) {
    const map = {
      name:     _findColIdx(headers, ['name','product','item','description','desc','product name','item name','maelezo']),
      price:    _findColIdx(headers, ['price','selling price','retail','sell','bei','unit price','rate']),
      cost:     _findColIdx(headers, ['cost','buy price','purchase','buying','cost price','wholesale']),
      barcode:  _findColIdx(headers, ['barcode','ean','upc','code','sku','product code','item code']),
      stock:    _findColIdx(headers, ['stock','qty','quantity','units','pieces','available','on hand','inventory']),
      category: _findColIdx(headers, ['category','type','dept','department','section','group']),
      unit:     _findColIdx(headers, ['unit','uom','measure','per']),
      expiry:   _findColIdx(headers, ['expiry','expiration','exp','best before','expire']),
    };

    return rows.map(row => {
      const get = idx => idx >= 0 ? String(row[idx] || '').trim() : '';
      const name = get(map.name);
      if (!name) return null;
      return {
        name,
        price:     _parseNum(get(map.price)) || 0,
        cost:      _parseNum(get(map.cost))  || 0,
        barcode:   get(map.barcode) || null,
        stock:     Math.max(0, parseInt(get(map.stock)) || 0),
        category:  _mapCategory(get(map.category)),
        unit:      _normalizeUnit(get(map.unit)),
        expiryDate:_parseDate(get(map.expiry)),
        taxRate:   0,
      };
    }).filter(Boolean);
  }

  /* ── PDF import via pdf.js ────────────────────────────────────────── */
  async function _importPDF(file) {
    _setStatus('Loading PDF parser...', 'info');

    if (!window.pdfjsLib) {
      await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    _setStatus('Extracting text from PDF...', 'info');
    const ab = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      /* Reconstruct lines by y-position grouping */
      const byY = {};
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        if (!byY[y]) byY[y] = [];
        byY[y].push(item.str);
      }
      const lines = Object.keys(byY)
        .sort((a, b) => Number(b) - Number(a))
        .map(y => byY[y].join(' ').trim());
      fullText += lines.join('\n') + '\n';
    }

    return _parsePDFText(fullText);
  }

  function _parsePDFText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    const products = [];
    const skipPatterns = /^(date|total|tax|vat|invoice|receipt|page|subtotal|discount|amount due|s\/no|no\.|sn|qty|unit price|description|particulars|product|item)/i;
    const priceRx = /(?:KE?S?\.?\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;

    for (const line of lines) {
      if (skipPatterns.test(line)) continue;
      if (line.length < 4 || /^\d+$/.test(line)) continue;

      /* Find all number-like values in the line */
      const nums = [...line.matchAll(priceRx)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => n >= 1 && n < 1000000);
      if (!nums.length) continue;

      /* Extract name: text before the first large number */
      const nameMatch = line.match(/^([A-Za-z][^\d]{3,60})/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim().replace(/[,;:|*-]+$/, '').trim();
      if (name.length < 3 || /^\d/.test(name)) continue;

      /* Price = largest number; cost = second largest if different */
      const sorted = [...nums].sort((a, b) => b - a);
      const price = sorted[0] || 0;
      const cost  = sorted.length > 1 && sorted[1] < price ? sorted[1] : 0;

      products.push({ name, price, cost, stock: 0, category: 'cat_general', unit: 'piece', taxRate: 0 });
    }

    /* Deduplicate by name */
    const seen = new Set();
    return products.filter(p => { if (seen.has(p.name.toLowerCase())) return false; seen.add(p.name.toLowerCase()); return true; });
  }

  /* ── Image / invoice import via Claude API Cloud Function ──────── */
  async function _importImage(file) {
    _setStatus('Uploading image for AI analysis...', 'info');

    if (!window.firebaseApp) throw new Error('Image import requires internet connection. Please connect and try again.');

    const base64 = await _fileToBase64(file);

    const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const functions = getFunctions(window.firebaseApp);
    const fn = httpsCallable(functions, 'posExtractProductsFromImage');

    _setStatus('AI reading your price list...', 'info');
    const result = await fn({ imageBase64: base64.split(',')[1], mimeType: file.type });

    if (!result.data?.products?.length) {
      throw new Error('Could not extract products from image. Try a clearer photo or use Excel/CSV instead.');
    }

    return result.data.products.map(p => ({
      name:       p.name || '',
      price:      _parseNum(p.price) || 0,
      cost:       _parseNum(p.cost)  || 0,
      barcode:    p.barcode || null,
      stock:      parseInt(p.stock)  || 0,
      category:   _mapCategory(p.category || ''),
      unit:       _normalizeUnit(p.unit || ''),
      taxRate:    0,
    })).filter(p => p.name && p.price > 0);
  }

  /* ── Preview UI ───────────────────────────────────────────────────── */
  function _showPreview(products) {
    _preview = products.map((p, i) => ({ ...p, _idx: i, _include: true }));

    const container = document.getElementById('ai-preview-body');
    if (!container) return;

    const cats = [
      ['cat_food','🍎 Food'],['cat_electronics','💻 Electronics'],['cat_pharma','💊 Pharmacy'],
      ['cat_cleaning','🧹 Cleaning'],['cat_personal','🪥 Personal Care'],['cat_stationery','📝 Stationery'],
      ['cat_clothing','👕 Clothing'],['cat_wholesale','🏭 Wholesale'],['cat_general','📦 General'],
    ];
    const units = ['piece','kg','g','litre','ml','packet','bottle','box','bag','strip','bar','pair','dozen','carton'];

    container.innerHTML = `
      <div class="ai-preview-summary">
        <span class="ai-count-badge">${products.length} products detected</span>
        <span style="color:var(--txt2);font-size:11px">Edit any field, uncheck items to skip, then click Import.</span>
      </div>
      <div style="overflow-x:auto;max-height:380px;overflow-y:auto">
        <table class="data-table ai-preview-table">
          <thead style="position:sticky;top:0;z-index:2;background:var(--surface)">
            <tr>
              <th><input type="checkbox" id="ai-check-all" checked onchange="PosAI.toggleAll(this.checked)" style="accent-color:var(--green)"></th>
              <th>Name</th><th>Price</th><th>Cost</th><th>Stock</th><th>Barcode</th><th>Category</th><th>Unit</th><th>Tax%</th>
            </tr>
          </thead>
          <tbody id="ai-preview-rows">
            ${products.map((p, i) => `
              <tr id="ai-row-${i}">
                <td><input type="checkbox" class="ai-check" data-idx="${i}" checked style="accent-color:var(--green)"></td>
                <td><input class="ai-cell ai-cell-name" value="${_esc(p.name)}" oninput="PosAI.updateField(${i},'name',this.value)" placeholder="Product name"></td>
                <td><input class="ai-cell" type="number" value="${p.price||0}" step="0.01" min="0" oninput="PosAI.updateField(${i},'price',+this.value)" style="width:80px"></td>
                <td><input class="ai-cell" type="number" value="${p.cost||0}" step="0.01" min="0" oninput="PosAI.updateField(${i},'cost',+this.value)" style="width:80px"></td>
                <td><input class="ai-cell" type="number" value="${p.stock||0}" min="0" oninput="PosAI.updateField(${i},'stock',+this.value)" style="width:60px"></td>
                <td><input class="ai-cell" value="${p.barcode||''}" oninput="PosAI.updateField(${i},'barcode',this.value)" style="width:110px;font-family:monospace;font-size:11px" placeholder="Auto-generate"></td>
                <td><select class="ai-cell" onchange="PosAI.updateField(${i},'category',this.value)">${cats.map(([v,l])=>`<option value="${v}" ${v===(p.category||'cat_general')?'selected':''}>${l}</option>`).join('')}</select></td>
                <td><select class="ai-cell" onchange="PosAI.updateField(${i},'unit',this.value)">${units.map(u=>`<option value="${u}" ${u===(p.unit||'piece')?'selected':''}>${u}</option>`).join('')}</select></td>
                <td><input class="ai-cell" type="number" value="${p.taxRate||0}" min="0" max="100" oninput="PosAI.updateField(${i},'taxRate',+this.value)" style="width:50px"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
        <button class="modal-btn modal-btn-ghost" style="font-size:12px" onclick="PosAI.addBlankRow()">+ Add Row</button>
        <span id="ai-import-count" style="font-size:12px;color:var(--txt2)">${products.length} selected</span>
      </div>
    `;

    /* Bind selection counter */
    container.addEventListener('change', e => {
      if (e.target.classList.contains('ai-check')) {
        const idx = parseInt(e.target.dataset.idx);
        _preview[idx]._include = e.target.checked;
        _updateImportCount();
      }
    });

    document.getElementById('ai-import-modal')?.classList.add('open');
  }

  function _updateImportCount() {
    const checked = _preview.filter(p => p._include).length;
    const el = document.getElementById('ai-import-count');
    if (el) el.textContent = checked + ' selected';
  }

  function toggleAll(checked) {
    document.querySelectorAll('.ai-check').forEach(c => { c.checked = checked; });
    _preview.forEach(p => p._include = checked);
    _updateImportCount();
  }

  function updateField(idx, field, value) {
    if (_preview[idx]) _preview[idx][field] = value;
  }

  function addBlankRow() {
    const i = _preview.length;
    _preview.push({ name: '', price: 0, cost: 0, stock: 0, barcode: null, category: 'cat_general', unit: 'piece', taxRate: 0, _idx: i, _include: true });
    const tbody = document.getElementById('ai-preview-rows');
    if (!tbody) return;
    const cats = [
      ['cat_food','🍎 Food'],['cat_electronics','💻 Electronics'],['cat_pharma','💊 Pharmacy'],
      ['cat_cleaning','🧹 Cleaning'],['cat_personal','🪥 Personal Care'],['cat_stationery','📝 Stationery'],
      ['cat_clothing','👕 Clothing'],['cat_wholesale','🏭 Wholesale'],['cat_general','📦 General'],
    ];
    const units = ['piece','kg','g','litre','ml','packet','bottle','box','bag','strip','bar','pair','dozen','carton'];
    const row = document.createElement('tr');
    row.id = `ai-row-${i}`;
    row.innerHTML = `
      <td><input type="checkbox" class="ai-check" data-idx="${i}" checked style="accent-color:var(--green)"></td>
      <td><input class="ai-cell ai-cell-name" placeholder="Product name" oninput="PosAI.updateField(${i},'name',this.value)"></td>
      <td><input class="ai-cell" type="number" value="0" step="0.01" min="0" oninput="PosAI.updateField(${i},'price',+this.value)" style="width:80px"></td>
      <td><input class="ai-cell" type="number" value="0" step="0.01" min="0" oninput="PosAI.updateField(${i},'cost',+this.value)" style="width:80px"></td>
      <td><input class="ai-cell" type="number" value="0" min="0" oninput="PosAI.updateField(${i},'stock',+this.value)" style="width:60px"></td>
      <td><input class="ai-cell" oninput="PosAI.updateField(${i},'barcode',this.value)" style="width:110px;font-family:monospace;font-size:11px" placeholder="Auto-gen"></td>
      <td><select class="ai-cell" onchange="PosAI.updateField(${i},'category',this.value)">${cats.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></td>
      <td><select class="ai-cell" onchange="PosAI.updateField(${i},'unit',this.value)">${units.map(u=>`<option value="${u}">${u}</option>`).join('')}</select></td>
      <td><input class="ai-cell" type="number" value="0" min="0" max="100" oninput="PosAI.updateField(${i},'taxRate',+this.value)" style="width:50px"></td>
    `;
    tbody.appendChild(row);
  }

  /* ── Confirm and commit import ────────────────────────────────────── */
  async function confirmImport() {
    const toImport = _preview.filter(p => p._include && p.name && p.name.trim().length > 0);
    if (!toImport.length) {
      (window._skToast||alert)('Please select at least one product with a name to import.');
      return;
    }

    const btn = document.getElementById('ai-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }

    let imported = 0, updated = 0, skipped = 0;
    const all = await PosDB.products.getAll();
    const barcodeSet = new Set(all.map(p => p.barcode).filter(Boolean));
    const nameSet    = new Map(all.map(p => [p.name.toLowerCase(), p.id]));

    for (const p of toImport) {
      const { _idx, _include, ...product } = p;

      /* Update existing if same name */
      if (nameSet.has(product.name.toLowerCase())) {
        product.id = nameSet.get(product.name.toLowerCase());
        await PosDB.products.save(product);
        updated++;
        continue;
      }

      /* Auto-generate barcode if missing or duplicate */
      if (!product.barcode || barcodeSet.has(product.barcode)) {
        product.barcode = PosBarcode.generateProductBarcode(all.length + imported + 1001);
      }
      barcodeSet.add(product.barcode);

      await PosDB.products.save(product);
      imported++;
    }

    document.getElementById('ai-import-modal')?.classList.remove('open');
    if (btn) { btn.disabled = false; btn.textContent = 'Import Products'; }

    const msg = `✓ Imported ${imported} new, updated ${updated}${skipped ? `, skipped ${skipped}` : ''}`;
    if (window.SPos) SPos.toast(msg, 'success');
    else (window._skToast||alert)(msg);

    if (_onConfirmCb) _onConfirmCb(imported, updated, skipped);
  }

  /* ── Status helper ───────────────────────────────────────────────── */
  function _setStatus(msg, type) {
    const el = document.getElementById('ai-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'ai-status-' + type;
  }

  /* ── Utilities ───────────────────────────────────────────────────── */
  function _findKey(keys, synonyms) {
    for (const syn of synonyms) {
      const k = keys.find(k => k.includes(syn));
      if (k) return k;
    }
    return null;
  }

  function _findColIdx(headers, synonyms) {
    for (const syn of synonyms) {
      const idx = headers.findIndex(h => h.includes(syn));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function _parseNum(raw) {
    if (raw === null || raw === undefined) return 0;
    return parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
  }

  function _mapCategory(raw) {
    if (!raw) return 'cat_general';
    const r = raw.toLowerCase();
    if (['food','grocery','groceries','fresh','drink','beverage','fmcg','mkate','unga','sukari'].some(k => r.includes(k))) return 'cat_food';
    if (['pharma','medicine','drug','health','medical','dawa'].some(k => r.includes(k))) return 'cat_pharma';
    if (['elect','tech','gadget','phone','computer','laptop','tv'].some(k => r.includes(k))) return 'cat_electronics';
    if (['cloth','apparel','fashion','wear','shoe','nguo'].some(k => r.includes(k))) return 'cat_clothing';
    if (['clean','detergent','wash','hygien','sabuni'].some(k => r.includes(k))) return 'cat_cleaning';
    if (['personal','beauty','care','cosmetic'].some(k => r.includes(k))) return 'cat_personal';
    if (['stationer','paper','pen','book','school'].some(k => r.includes(k))) return 'cat_stationery';
    if (['whole','bulk','kg','distributor'].some(k => r.includes(k))) return 'cat_wholesale';
    return 'cat_general';
  }

  function _normalizeUnit(raw) {
    if (!raw) return 'piece';
    const r = raw.toLowerCase().trim();
    if (['kg','kilo','kilogram'].some(k => r === k)) return 'kg';
    if (['g','gram','grams'].some(k => r === k)) return 'g';
    if (['l','litre','liter','lt'].some(k => r === k)) return 'litre';
    if (['ml','millilitre'].some(k => r === k)) return 'ml';
    if (['pkt','packet','pack'].some(k => r === k)) return 'packet';
    if (['btl','bottle'].some(k => r === k)) return 'bottle';
    if (['box','carton'].some(k => r === k)) return 'box';
    if (['bag','sack'].some(k => r === k)) return 'bag';
    if (['doz','dozen'].some(k => r === k)) return 'dozen';
    if (['bar'].some(k => r === k)) return 'bar';
    if (['pair','pr'].some(k => r === k)) return 'pair';
    if (['strip','tab'].some(k => r === k)) return 'strip';
    return 'piece';
  }

  function _parseDate(raw) {
    if (!raw) return null;
    const d = new Date(String(raw).replace(/[\/\\]/g, '-'));
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _fileToBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function _loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s  = document.createElement('script');
      s.src    = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  return { importFile, toggleAll, updateField, addBlankRow, confirmImport };
})();

window.PosAI = PosAI;

