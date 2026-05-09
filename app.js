// app.js - Complete Updated File

// ============================================
// APP CONFIGURATION & STATE
// ============================================
const CONFIG = {
  DB_NAME: 'PharmaGuardDB',
  DB_VERSION: 1,
  EXPIRY_SOON_DAYS: 90
};

const App = {
  masterIndex: new Map(),
  masterRMS: new Map(),
  settings: {
    apiEnabled: true
  }
};

// ============================================
// DATABASE (IndexedDB Wrapper)
// ============================================
const DB = {
  async _tx(storeName, mode, callback) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath: 'barcode' });
        }
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        
        let result;
        try {
          result = callback(store);
        } catch (err) {
          reject(err);
          return;
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      };

      request.onerror = () => reject(request.error);
    });
  },

  // Master Data Store
  async clearMaster() {
    return this._tx('master', 'readwrite', s => s.clear());
  },

  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      request.onsuccess = (event) => {
        const db = event.target.result;
        const tx = db.transaction('master', 'readwrite');
        const store = tx.objectStore('master');
        
        let count = 0;
        items.forEach(item => {
          if (item && item.barcode) {
            store.put(item);
            count++;
          }
        });
        
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
      };
    });
  },

  // Settings
  async getSetting(key, defaultValue = null) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  },

  // History (Stubbed for basic operations)
  async deleteHistory(id) {
    return this._tx('history', 'readwrite', s => s.delete(id));
  }
};

// ============================================
// GS1 BARCODE PARSER
// ============================================
const GS1 = {
  _normalize(code) {
    return (code || '').trim().replace(/[\r\n\t]/g, '');
  },

  _extractAIs(code) {
    const fields = {};
    let input = this._normalize(code).replace(/\u001d/g, String.fromCharCode(29));

    // Support human-readable GS1 format e.g. (01)...(17)...(10)...
    const bracketRegex = /\((\d{2})\)([^\(]*)/g;
    let match;
    while ((match = bracketRegex.exec(input)) !== null) {
      fields[match[1]] = (match[2] || '').trim();
    }
    if (Object.keys(fields).length > 0) return fields;

    // Parse compact GS1 string with AIs and FNC1 separators
    if (input.startsWith('01') && input.length >= 16) {
      fields['01'] = input.slice(2, 16);
      input = input.slice(16);
    }

    const variableAIs = new Set(['10', '21']);

    while (input.length >= 2) {
      const ai = input.slice(0, 2);
      input = input.slice(2);

      if (ai === '17') {
        fields[ai] = input.slice(0, 6);
        input = input.slice(6);
        continue;
      }

      if (variableAIs.has(ai)) {
        const stop = input.search(String.fromCharCode(29));
        if (stop === -1) {
          fields[ai] = input;
          break;
        }
        fields[ai] = input.slice(0, stop);
        input = input.slice(stop + 1);
        continue;
      }

      break;
    }

    return fields;
  },

  parse(code) {
    const result = {
      raw: code || '',
      gtin: '',
      expiry: '',
      expiryISO: '',
      expiryDisplay: '',
      batch: '',
      serial: '',
      qty: 1,
      isGS1: false
    };

    if (!code || typeof code !== 'string') return result;

    code = this._normalize(code);

    // Check for GS1 format (contains AIs)
    const hasAI = code.includes('(') || /^01\d{14}/.test(code);

    if (!hasAI) {
      // Plain barcode
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) {
        result.gtin = digits.padStart(14, '0');
      }
      return result;
    }

    result.isGS1 = true;

    const aiFields = this._extractAIs(code);

    // Parse GTIN (01)
    if (aiFields['01'] && /^\d{14}$/.test(aiFields['01'])) {
      result.gtin = aiFields['01'];
    }

    // Parse Expiry (17)
    if (aiFields['17'] && /^\d{6}$/.test(aiFields['17'])) {
      const yymmdd = aiFields['17'];
      result.expiry = yymmdd;

      const yy = parseInt(yymmdd.substring(0, 2));
      const mm = parseInt(yymmdd.substring(2, 4));
      let dd = parseInt(yymmdd.substring(4, 6));

      const year = 2000 + yy;
      if (dd === 0) dd = new Date(year, mm, 0).getDate();

      result.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      result.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
    }

    // Parse Batch (10)
    if (aiFields['10']) {
      result.batch = aiFields['10'].replace(/[^\w\-]/g, '').substring(0, 20);
    }

    // Parse Serial (21)
    if (aiFields['21']) {
      result.serial = aiFields['21'].replace(/[^\w\-]/g, '').substring(0, 20);
    }

    return result;
  },

  getExpiryStatus(expiryISO) {
    if (!expiryISO) return 'unknown';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(expiryISO);
    expiry.setHours(0, 0, 0, 0);

    const diffDays = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return 'expired';
    if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
    return 'ok';
  }
};

// ============================================
// PRODUCT MATCHING
// ============================================
const Matcher = {
  match(gtin) {
    if (!gtin) return { name: '', rms: '', matchType: 'NONE' };

    // Exact match
    if (App.masterIndex.has(gtin)) {
      return {
        name: App.masterIndex.get(gtin),
        rms: App.masterRMS.get(gtin) || '',
        matchType: 'EXACT'
      };
    }

    // Drop leading zeros
    const stripped = gtin.replace(/^0+/, '');
    if (App.masterIndex.has(stripped)) {
      return {
        name: App.masterIndex.get(stripped),
        rms: App.masterRMS.get(stripped) || '',
        matchType: 'STRIPPED'
      };
    }

    // GTIN-13 fallback (if 14 digits)
    if (gtin.length === 14 && gtin.startsWith('0')) {
      const gtin13 = gtin.slice(1);
      if (App.masterIndex.has(gtin13)) {
        return {
          name: App.masterIndex.get(gtin13),
          rms: App.masterRMS.get(gtin13) || '',
          matchType: 'GTIN13'
        };
      }
    }

    // Last 8 digits fallback
    const last8 = gtin.slice(-8);
    if (App.masterIndex.has(last8)) {
      return {
        name: App.masterIndex.get(last8),
        rms: App.masterRMS.get(last8) || '',
        matchType: 'LAST8'
      };
    }

    return { name: '', rms: '', matchType: 'NONE' };
  }
};

// ============================================
// EXTERNAL API LOOKUPS
// ============================================
const API = {
  _cleanName(value) {
    return typeof value === 'string' ? value.trim() : '';
  },

  async lookup(gtin) {
    if (!App.settings.apiEnabled || !navigator.onLine) return null;

    const cleanGtin = gtin.replace(/\D/g, '').padStart(14, '0');

    // Try Brocade (best for medicines)
    let result = await this.brocade(cleanGtin);
    if (result) return result;

    // Try OpenFoodFacts
    result = await this.openFoodFacts(cleanGtin);
    if (result) return result;

    // Try UPCitemdb
    result = await this.upcItemDb(cleanGtin);
    if (result) return result;

    return null;
  },

  async brocade(gtin) {
    try {
      const res = await fetch(`https://www.brocade.io/api/items/${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      const name = this._cleanName(data.name || data.description || data.title || data.product_name);
      if (name) {
        return { name, source: 'Brocade' };
      }
    } catch (e) {
      console.log('Brocade API:', e.message);
    }
    return null;
  },

  async openFoodFacts(gtin) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.status === 1 && data.product) {
        const product = data.product;
        const name = this._cleanName(
          product.product_name ||
          product.product_name_en ||
          product.generic_name ||
          product.brands
        );
        if (name) {
          return { name, source: 'OpenFoodFacts' };
        }
      }
    } catch (e) {
      console.log('OpenFoodFacts API:', e.message);
    }
    return null;
  },

  async upcItemDb(gtin) {
    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.code === 'OK' && data.items?.[0]) {
        const item = data.items[0];
        const name = this._cleanName(item.title || item.description || item.brand);
        if (name) {
          return { name, source: 'UPCitemdb' };
        }
      }
    } catch (e) {
      console.log('UPCitemdb API:', e.message);
    }
    return null;
  }
};

// ============================================
// BARCODE PROCESSING & UI FEEDBACK
// ============================================
async function processBarcode(code, options = {}) {
  const { silent = false, skipRefresh = false } = options;

  if (!code || typeof code !== 'string') return null;
  code = code.trim();
  if (!code) return null;

  // Parse GS1
  const parsed = GS1.parse(code);

  // If no GTIN found, try to use raw as barcode
  if (!parsed.gtin) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8) {
      parsed.gtin = digits.padStart(14, '0');
    } else {
      if (!silent) toast('Invalid barcode format', 'error');
      return null;
    }
  }

  // Find Match in internal data
  const matched = Matcher.match(parsed.gtin);
  let productName = matched.name;
  let rmsCode = matched.rms;
  let source = matched.matchType !== 'NONE' ? 'Internal DB' : '';

  // API Lookup if not found internally
  if (!productName) {
    const apiResult = await API.lookup(parsed.gtin);
    if (apiResult) {
      productName = apiResult.name;
      source = apiResult.source;
    } else {
      productName = 'Unknown Product';
      source = 'Manual Entry Needed';
    }
  }

  const scanRecord = {
    barcode: parsed.gtin,
    rawInput: parsed.raw,
    name: productName,
    rms: rmsCode,
    expiryDisplay: parsed.expiryDisplay,
    expiryISO: parsed.expiryISO,
    expiryStatus: GS1.getExpiryStatus(parsed.expiryISO),
    batch: parsed.batch,
    serial: parsed.serial,
    source: source,
    timestamp: new Date().toISOString()
  };

  // Save to history db
  await DB._tx('history', 'readwrite', s => s.put(scanRecord));

  if (!skipRefresh) {
    await refreshUI();
  }

  if (!silent) toast(`Scanned: ${productName}`, 'success');
  return scanRecord;
}

// ============================================
// MASTER DATA MANAGEMENT
// ============================================
function detectMasterDelimiter(headerLine) {
  const options = ['\t', ',', ';', '|'];
  let best = ',';
  let maxCount = -1;

  for (const delim of options) {
    const count = headerLine.split(delim).length;
    if (count > maxCount) {
      maxCount = count;
      best = delim;
    }
  }

  return best;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells.map(cell => cell.replace(/^['"]|['"]$/g, '').trim());
}

async function uploadMaster(file, append = false) {
  showLoading('Uploading...');

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length < 2) {
      toast('Invalid file format', 'error');
      hideLoading();
      return;
    }

    // Parse header with robust delimiter and quoted cell support
    const delimiter = detectMasterDelimiter(lines[0]);
    const cols = parseDelimitedLine(lines[0].toLowerCase(), delimiter);

    // Find columns
    const barcodeIdx = cols.findIndex(c => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(c));
    const nameIdx = cols.findIndex(c => ['name', 'description', 'product', 'productname', 'item description'].includes(c));
    const rmsIdx = cols.findIndex(c => ['rms', 'rmscode', 'rms code', 'rms_code'].includes(c));

    if (barcodeIdx === -1) {
      toast('No barcode column found (need: barcode, gtin, ean, or code)', 'error');
      hideLoading();
      return;
    }

    if (!append) {
      await DB.clearMaster();
      App.masterIndex.clear();
      App.masterRMS.clear();
    }

    // Parse rows
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseDelimitedLine(lines[i], delimiter);
      const barcode = (row[barcodeIdx] || '').replace(/\s+/g, '');
      const name = nameIdx >= 0 ? (row[nameIdx] || '') : '';
      const rms = rmsIdx >= 0 ? (row[rmsIdx] || '') : '';

      if (barcode && barcode.length >= 8) {
        items.push({ barcode, name, rms });
        App.masterIndex.set(barcode, name);
        if (rms) App.masterRMS.set(barcode, rms);
      }
    }

    const count = await DB.bulkAddMaster(items);
    await refreshMasterCount();

    toast(`${append ? 'Appended' : 'Uploaded'} ${count} products`, 'success');
  } catch (e) {
    console.error('Upload error:', e);
    toast('Upload failed: ' + e.message, 'error');
  }

  hideLoading();
}

async function resetMaster() {
  if (!confirm('Reset all product data? This cannot be undone.')) return;

  await DB.clearMaster();
  App.masterIndex.clear();
  App.masterRMS.clear();
  await refreshMasterCount();
  toast('Master data cleared', 'success');
}

// ============================================
// UI FEEDBACK UTILITIES (Stubs for PWA integration)
// ============================================
function toast(msg, type = 'info') {
  console.log(`[Toast - ${type.toUpperCase()}]: ${msg}`);
  // Implement your custom UI alert/toast logic here
}

function showLoading(msg) {
  console.log(`[Loading Start]: ${msg}`);
  // Implement UI loading indicator show logic here
}

function hideLoading() {
  console.log(`[Loading End]`);
  // Implement UI loading indicator hide logic here
}

async function refreshMasterCount() {
  try {
    let count = 0;
    await DB._tx('master', 'readonly', s => {
      const req = s.count();
      req.onsuccess = () => { count = req.result; };
    });
    console.log(`Current Master Data Count: ${count}`);
    // Update your UI counter element here
  } catch (e) {
    console.error('Failed to refresh master count', e);
  }
}

async function refreshUI() {
  // Pull scan history and update your main lists/tables
  console.log('Refreshing main UI elements...');
}

// ============================================
// APP INITIALIZATION
// ============================================
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Load existing master data from IndexedDB into memory maps
    await DB._tx('master', 'readonly', s => {
      const req = s.getAll();
      req.onsuccess = () => {
        if (req.result) {
          req.result.forEach(item => {
            App.masterIndex.set(item.barcode, item.name);
            if (item.rms) App.masterRMS.set(item.barcode, item.rms);
          });
        }
      };
    });
    await refreshMasterCount();
    await refreshUI();
    console.log('App initialized successfully.');
  } catch (err) {
    console.error('Initialization error:', err);
  }
});
