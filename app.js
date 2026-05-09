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
